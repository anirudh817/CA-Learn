"""P2 integration tests for attachments + vision.

Covers:
    1. Upload + GET + DELETE round-trip for a tabular file (CSV).
    2. PDF text extraction lands in Attachment.preview_text.
    3. Image attachment reaches the provider as a vision `image` part.
    4. File-size and image-count caps are enforced.
    5. Text attachment content gets injected into the user turn the
       provider receives.
"""
from __future__ import annotations

import base64
import io
import os
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

from tests.test_app import (
    BACKEND_DIR,
    bootstrap_session,
    build_app,
    dataset_bytes,
    managed_client,
    upload_primary_dataset,
)


warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


# ---------- Minimal-but-valid binary fixtures ----------

def _png_1x1() -> bytes:
    # 1x1 transparent PNG (67 bytes), inlined to avoid Pillow.
    return base64.b64decode(
        b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )


def _trivial_pdf() -> bytes:
    """A minimal hand-rolled PDF with the literal 'APOE in modules' as text.
    pypdf can extract text from it without any external dep.
    """
    # The simplest possible single-page PDF embedding a text stream.
    body = b"""%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj
4 0 obj <</Length 60>> stream
BT /F1 24 Tf 20 100 Td (APOE up in module M1) Tj ET
endstream endobj
5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000054 00000 n
0000000101 00000 n
0000000207 00000 n
0000000316 00000 n
trailer <</Size 6 /Root 1 0 R>>
startxref
379
%%EOF
"""
    return body


# ---------- Fake provider plumbing ----------

class CapturingState:
    """Holds the provider call args from the last invocation so the test
    can introspect what the message body actually looked like.
    """

    last_messages = None


def _patch_anthropic_capture():
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap_module

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    async def _complete_capture(self, **kwargs):
        CapturingState.last_messages = kwargs.get("messages")
        return {
            "text": "captured",
            "tool_calls": [],
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "finish_reason": "end_turn",
        }

    # The P12 LLM-judge gates (input + output classifiers) each make their
    # own provider.complete() call. The output classifier runs after the
    # main turn and would overwrite CapturingState.last_messages, so this
    # suite — which introspects the chat turn, not security — disables them.
    return [
        mock.patch("config.AI_SECURITY_LLM_JUDGE", False),
        mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap_module.AnthropicProvider, "complete", _complete_capture),
    ]


def _enter(patches):
    for p in patches:
        p.__enter__()


def _exit(patches):
    for p in reversed(patches):
        try:
            p.__exit__(None, None, None)
        except Exception:
            pass


def _bootstrap_with_run(client):
    headers, workspace, project = bootstrap_session(client)
    uploaded = upload_primary_dataset(
        client, headers, workspace["id"], project["id"], dataset_bytes()
    )
    run = client.post(
        "/api/runs",
        headers=headers,
        json={
            "workspace_id": workspace["id"],
            "project_id": project["id"],
            "name": "P2",
            "dataset_id": uploaded["dataset_id"],
        },
    ).json()
    client.put(
        "/api/settings/ai",
        headers=headers,
        json={"anthropic_key": "sk-ant-fake-key-padding-padding-padding-p2"},
    )
    conv = client.post(
        f"/api/runs/{run['run_id']}/conversations",
        headers=headers,
        json={},
    ).json()
    return headers, conv["id"]


# ---------- Tests ----------

class ChatP2UploadRoundTrip(unittest.TestCase):
    def test_upload_get_delete_csv_attachment(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_with_run(client)
                csv_bytes = b"gene,log2fc,adj_pvalue\nAPOE,3.4,0.0001\n"
                resp = client.post(
                    f"/api/conversations/{conv_id}/attachments",
                    headers=headers,
                    files={"files": ("apoe.csv", csv_bytes, "text/csv")},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                created = resp.json()
                self.assertEqual(len(created), 1)
                att_id = created[0]["id"]
                self.assertEqual(created[0]["kind"], "file")

                got = client.get(f"/api/attachments/{att_id}", headers=headers)
                self.assertEqual(got.status_code, 200)
                self.assertEqual(got.json()["filename"], "apoe.csv")

                deleted = client.delete(f"/api/attachments/{att_id}", headers=headers)
                self.assertEqual(deleted.status_code, 200)
                gone = client.get(f"/api/attachments/{att_id}", headers=headers)
                self.assertEqual(gone.status_code, 404)


class ChatP2PdfExtraction(unittest.TestCase):
    def test_pdf_attachment_extracts_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_with_run(client)
                resp = client.post(
                    f"/api/conversations/{conv_id}/attachments",
                    headers=headers,
                    files={"files": ("notes.pdf", _trivial_pdf(), "application/pdf")},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                att_id = resp.json()[0]["id"]

                # Reach into the row to verify preview_text was extracted.
                _ensure_backend_on_path()
                from database import Attachment, SessionLocal

                db = SessionLocal()
                try:
                    row = db.query(Attachment).filter(Attachment.id == att_id).first()
                    self.assertIsNotNone(row)
                    self.assertIn("APOE", row.preview_text)
                finally:
                    db.close()


class ChatP2ImageVision(unittest.TestCase):
    def test_image_attachment_reaches_provider_as_image_part(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_capture()
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    resp = client.post(
                        f"/api/conversations/{conv_id}/attachments",
                        headers=headers,
                        files={"files": ("blot.png", _png_1x1(), "image/png")},
                    )
                    self.assertEqual(resp.status_code, 200, resp.text)
                    att_id = resp.json()[0]["id"]
                    self.assertEqual(resp.json()[0]["kind"], "image")

                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={
                            "content": "Does this blot match the LFQ trend?",
                            "attachment_ids": [att_id],
                        },
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)

                    # Inspect what the provider actually saw.
                    self.assertIsNotNone(CapturingState.last_messages)
                    last_user = CapturingState.last_messages[-1]
                    self.assertEqual(last_user["role"], "user")
                    parts = last_user["content"]
                    types = [p["type"] for p in parts]
                    self.assertIn("image", types)
                    img_part = next(p for p in parts if p["type"] == "image")
                    self.assertEqual(img_part["mime"], "image/png")
                    self.assertTrue(img_part["data_b64"])
                    # Linked to the user message on persist.
                    detail = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    ).json()
                    user_msg = next(m for m in detail["messages"] if m["role"] == "user")
                    self.assertEqual(len(user_msg["attachments"]), 1)
                    self.assertEqual(user_msg["attachments"][0]["id"], att_id)
            finally:
                _exit(patches)


class ChatP2TextAttachmentInProviderContext(unittest.TestCase):
    def test_text_attachment_content_reaches_provider_user_turn(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _patch_anthropic_capture()
            _enter(patches)
            try:
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    # Attach a CSV.
                    csv = b"gene,log2fc\nAPOE,3.4\nCLU,2.8\n"
                    up = client.post(
                        f"/api/conversations/{conv_id}/attachments",
                        headers=headers,
                        files={"files": ("apoe.csv", csv, "text/csv")},
                    )
                    self.assertEqual(up.status_code, 200, up.text)
                    aid = up.json()[0]["id"]
                    # Send a message referencing it.
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "summarize this", "attachment_ids": [aid]},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    # The provider saw text parts including the file content.
                    last_user = CapturingState.last_messages[-1]
                    user_text = "\n".join(
                        p["text"] for p in last_user["content"] if p["type"] == "text"
                    )
                    self.assertIn("apoe.csv", user_text)
                    self.assertIn("APOE", user_text)
                    self.assertIn("CLU", user_text)
                    self.assertIn("ATTACHMENT START", user_text)
            finally:
                _exit(patches)


class ChatP2CapsEnforced(unittest.TestCase):
    def test_file_too_large_is_413(self):
        os.environ["AI_ATTACHMENT_MAX_FILE_MB"] = "1"  # 1 MB cap
        os.environ["AI_ATTACHMENT_MAX_IMAGE_MB"] = "1"
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                app = build_app(temp_dir)
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    too_big = b"x" * (2 * 1024 * 1024)
                    resp = client.post(
                        f"/api/conversations/{conv_id}/attachments",
                        headers=headers,
                        files={"files": ("big.csv", too_big, "text/csv")},
                    )
                    self.assertEqual(resp.status_code, 413, resp.text)
        finally:
            os.environ.pop("AI_ATTACHMENT_MAX_FILE_MB", None)
            os.environ.pop("AI_ATTACHMENT_MAX_IMAGE_MB", None)

    def test_too_many_images_per_turn_is_413(self):
        os.environ["AI_ATTACHMENT_MAX_IMAGES_PER_TURN"] = "1"
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                app = build_app(temp_dir)
                with managed_client(app) as client:
                    headers, conv_id = _bootstrap_with_run(client)
                    png = _png_1x1()
                    # Two images in one upload exceeds the cap.
                    resp = client.post(
                        f"/api/conversations/{conv_id}/attachments",
                        headers=headers,
                        files=[
                            ("files", ("a.png", png, "image/png")),
                            ("files", ("b.png", png, "image/png")),
                        ],
                    )
                    self.assertEqual(resp.status_code, 413, resp.text)
        finally:
            os.environ.pop("AI_ATTACHMENT_MAX_IMAGES_PER_TURN", None)

    def test_disallowed_extension_is_400(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, conv_id = _bootstrap_with_run(client)
                resp = client.post(
                    f"/api/conversations/{conv_id}/attachments",
                    headers=headers,
                    files={"files": ("evil.exe", b"\x00\x01\x02", "application/octet-stream")},
                )
                self.assertEqual(resp.status_code, 400, resp.text)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
