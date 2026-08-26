"""P0 integration tests for the AI Biological Inference Chat.

Covers:
    1. Create conversation → send (mocked-provider) message → reload.
    2. Legacy /api/ai/query returns HTTP 410.
    3. PUT /api/settings/ai accepts keys and never leaks them on GET.
    4. Crypto round-trip (encrypt → decrypt) succeeds and tolerates corruption.
    5. Platform-key quota returns HTTP 429 with BYOK hint.

Tests intentionally avoid hitting any real provider — we monkeypatch
``AnthropicProvider.complete`` so the suite runs offline and deterministically.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient as FastAPITestClient

# Reuse the existing test harness for app build + auth bootstrap.
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


class FakeAnthropicResult:
    """Stand-in for the dict returned by AnthropicProvider.complete()."""

    @staticmethod
    def ok(text: str = "Mocked assistant response.", tool_calls=None) -> dict:
        return {
            "text": text,
            "tool_calls": tool_calls or [],
            "usage": {"input_tokens": 123, "output_tokens": 45},
            "finish_reason": "end_turn",
        }


async def fake_complete_ok(self, **kwargs):
    return FakeAnthropicResult.ok()


def _stub_anthropic_provider():
    """Patch the AnthropicProvider so .complete() returns a deterministic answer
    AND construction does not require a real anthropic SDK call.
    """
    _ensure_backend_on_path()
    from services.ai.providers import anthropic_provider as ap_module

    def _no_op_init(self, api_key: str) -> None:
        self._sync_client = None
        self._async_client = None

    return [
        mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
        mock.patch.object(ap_module.AnthropicProvider, "complete", fake_complete_ok),
    ]


def _enter_patches(patches):
    started = []
    for p in patches:
        started.append(p.__enter__())
    return started, patches


def _exit_patches(patches):
    for p in patches:
        try:
            p.__exit__(None, None, None)
        except Exception:
            pass


def _ensure_run_dir(data_dir_root: str, run_id: str) -> Path:
    """Create a minimal stage1/volcano_results.tsv so the P0 minimal context
    builder has something to attach to the prompt. We do NOT touch pipeline
    code — just write files under data/runs/{run_id}/ as Codex's pipeline would."""
    run_dir = Path(data_dir_root) / "data" / "runs" / run_id
    (run_dir / "stage1").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage1" / "volcano_results.tsv").write_text(
        "gene\tlog2fc\tadj_pvalue\tdirection\tmodule\n"
        "APOE\t3.4\t0.0001\tupregulated\tM1\n"
        "CLU\t2.8\t0.0009\tupregulated\tM1\n"
    )
    return run_dir


class ChatP0CreateAndSendTests(unittest.TestCase):
    def test_create_conversation_send_message_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            patches = _stub_anthropic_provider()
            _, started = _enter_patches(patches)
            try:
                with managed_client(app) as client:
                    headers, workspace, project = bootstrap_session(client)

                    # Need a completed run to create a conversation on. Use the
                    # smallest synthetic dataset; the existing pipeline runs
                    # inline in tests (INLINE_RUNS=1).
                    uploaded = upload_primary_dataset(
                        client, headers, workspace["id"], project["id"], dataset_bytes()
                    )
                    run_response = client.post(
                        "/api/runs",
                        headers=headers,
                        json={
                            "workspace_id": workspace["id"],
                            "project_id": project["id"],
                            "name": "Chat P0",
                            "dataset_id": uploaded["dataset_id"],
                        },
                    )
                    self.assertEqual(run_response.status_code, 200, run_response.text)
                    run_id = run_response.json()["run_id"]

                    # Paste a key so the chat resolves a provider.
                    setres = client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": "sk-ant-fake-key-for-tests"},
                    )
                    self.assertEqual(setres.status_code, 200, setres.text)
                    self.assertTrue(setres.json()["has_anthropic_key"])

                    # Create conversation on the run.
                    create = client.post(
                        f"/api/runs/{run_id}/conversations",
                        headers=headers,
                        json={"title": "First chat"},
                    )
                    self.assertEqual(create.status_code, 200, create.text)
                    conv = create.json()
                    self.assertEqual(conv["title"], "First chat")
                    self.assertEqual(conv["provider"], "anthropic")
                    conv_id = conv["id"]

                    # List shows it.
                    listed = client.get(
                        f"/api/runs/{run_id}/conversations", headers=headers
                    )
                    self.assertEqual(listed.status_code, 200)
                    ids = [c["id"] for c in listed.json()]
                    self.assertIn(conv_id, ids)

                    # Send a message.
                    sent = client.post(
                        f"/api/conversations/{conv_id}/messages",
                        headers=headers,
                        json={"content": "What is APOE log2FC in this run?"},
                    )
                    self.assertEqual(sent.status_code, 200, sent.text)
                    payload = sent.json()
                    self.assertEqual(payload["user_message"]["role"], "user")
                    self.assertEqual(payload["assistant_message"]["role"], "assistant")
                    self.assertEqual(
                        payload["assistant_message"]["content"],
                        "Mocked assistant response.",
                    )
                    self.assertEqual(payload["assistant_message"]["provider"], "anthropic")
                    self.assertEqual(payload["assistant_message"]["input_tokens"], 123)
                    self.assertEqual(payload["assistant_message"]["output_tokens"], 45)

                    # Reload conversation — both messages persisted.
                    reload = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    )
                    self.assertEqual(reload.status_code, 200, reload.text)
                    msgs = reload.json()["messages"]
                    self.assertEqual(len(msgs), 2)
                    self.assertEqual(msgs[0]["role"], "user")
                    self.assertEqual(msgs[1]["role"], "assistant")

                    # Clear messages but keep conversation.
                    cleared = client.post(
                        f"/api/conversations/{conv_id}/clear", headers=headers
                    )
                    self.assertEqual(cleared.status_code, 200)
                    after_clear = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    ).json()
                    self.assertEqual(len(after_clear["messages"]), 0)

                    # Delete conversation cascades.
                    deleted = client.delete(
                        f"/api/conversations/{conv_id}", headers=headers
                    )
                    self.assertEqual(deleted.status_code, 200)
                    gone = client.get(
                        f"/api/conversations/{conv_id}", headers=headers
                    )
                    self.assertEqual(gone.status_code, 404)
            finally:
                _exit_patches(started)


class ChatP0LegacyDeprecationTests(unittest.TestCase):
    def test_legacy_ai_query_returns_410(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, _, _ = bootstrap_session(client)
                resp = client.post(
                    "/api/ai/query",
                    headers=headers,
                    json={"question": "anything", "run_ids": []},
                )
                self.assertEqual(resp.status_code, 410, resp.text)
                detail = resp.json()["detail"]
                self.assertIn("migrate_to", detail)
                migrate = " ".join(detail["migrate_to"])
                self.assertIn("/api/conversations/", migrate)


class ChatP0SettingsTests(unittest.TestCase):
    def test_settings_put_get_never_leaks_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, _, _ = bootstrap_session(client)

                fake_key = "sk-ant-extremely-secret-do-not-leak-1234567890"
                put_resp = client.put(
                    "/api/settings/ai",
                    headers=headers,
                    json={"anthropic_key": fake_key},
                )
                self.assertEqual(put_resp.status_code, 200, put_resp.text)
                put_payload = put_resp.json()
                self.assertTrue(put_payload["has_anthropic_key"])
                # No raw-key field in the response at all.
                self.assertNotIn("anthropic_key", put_payload)
                self.assertNotIn(fake_key, put_resp.text)

                get_resp = client.get("/api/settings/ai", headers=headers)
                self.assertEqual(get_resp.status_code, 200)
                get_payload = get_resp.json()
                self.assertTrue(get_payload["has_anthropic_key"])
                self.assertNotIn(fake_key, get_resp.text)
                self.assertEqual(get_payload["provider"], "anthropic")

                # Provider catalog endpoint works — v1 is Anthropic-only.
                cat = client.get("/api/settings/ai/providers", headers=headers)
                self.assertEqual(cat.status_code, 200)
                ids = [entry["id"] for entry in cat.json()]
                self.assertEqual(set(ids), {"anthropic"})

                # Clear the key.
                clear = client.delete(
                    "/api/settings/ai/keys/anthropic", headers=headers
                )
                self.assertEqual(clear.status_code, 200)
                self.assertFalse(clear.json()["has_anthropic_key"])


class ChatP0CryptoTests(unittest.TestCase):
    def test_key_encryption_roundtrip(self) -> None:
        # Trigger config import via build_app so SESSION_SECRET is set first.
        with tempfile.TemporaryDirectory() as temp_dir:
            build_app(temp_dir)
            _ensure_backend_on_path()
            from services.ai import crypto

            payload = {
                "anthropic": "sk-ant-aaa",
                "openai": "sk-openai-bbb",
                "google": "AIzaSyCccc",
            }
            blob = crypto.encrypt_dict(payload)
            self.assertIsInstance(blob, str)
            self.assertNotIn("sk-ant-aaa", blob)
            decrypted = crypto.decrypt_dict(blob)
            self.assertEqual(decrypted, payload)

            # Empty blob → empty dict.
            self.assertEqual(crypto.decrypt_dict(""), {})
            # Corrupted blob → empty dict (fail-closed, no exception).
            self.assertEqual(crypto.decrypt_dict("not-a-valid-fernet-token"), {})

            # Provider auto-detection — v1 only recognizes Anthropic prefixes.
            self.assertEqual(crypto.detect_provider_from_key("sk-ant-something"), "anthropic")
            self.assertIsNone(crypto.detect_provider_from_key("sk-openai-something"))
            self.assertIsNone(crypto.detect_provider_from_key("AIzaSyabc"))
            self.assertIsNone(crypto.detect_provider_from_key(""))


class ChatP0QuotaTests(unittest.TestCase):
    def test_platform_quota_exceeded_returns_429(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            # Force a 1-req daily limit BEFORE build_app() imports config.
            os.environ["AI_PLATFORM_DAILY_REQS"] = "1"
            os.environ["AI_PLATFORM_DAILY_TOKENS"] = "1000000"
            # Set a platform Anthropic key so we exercise the "platform" path.
            os.environ["ANTHROPIC_API_KEY"] = "sk-ant-platform-key-for-tests"
            try:
                app = build_app(temp_dir)
                patches = _stub_anthropic_provider()
                _, started = _enter_patches(patches)
                try:
                    with managed_client(app) as client:
                        headers, workspace, project = bootstrap_session(client)

                        uploaded = upload_primary_dataset(
                            client,
                            headers,
                            workspace["id"],
                            project["id"],
                            dataset_bytes(),
                        )
                        run_response = client.post(
                            "/api/runs",
                            headers=headers,
                            json={
                                "workspace_id": workspace["id"],
                                "project_id": project["id"],
                                "name": "Quota Test",
                                "dataset_id": uploaded["dataset_id"],
                            },
                        )
                        self.assertEqual(run_response.status_code, 200, run_response.text)
                        run_id = run_response.json()["run_id"]

                        # DO NOT set a user key — falls through to platform key.
                        conv = client.post(
                            f"/api/runs/{run_id}/conversations",
                            headers=headers,
                            json={},
                        ).json()
                        conv_id = conv["id"]

                        # First message consumes the 1-req quota.
                        first = client.post(
                            f"/api/conversations/{conv_id}/messages",
                            headers=headers,
                            json={"content": "first ping"},
                        )
                        self.assertEqual(first.status_code, 200, first.text)

                        # Second message must trigger 429.
                        second = client.post(
                            f"/api/conversations/{conv_id}/messages",
                            headers=headers,
                            json={"content": "second ping"},
                        )
                        self.assertEqual(second.status_code, 429, second.text)
                        detail = second.json()["detail"]
                        self.assertIn("quota", detail["message"].lower())
                        self.assertIn("Settings", detail["remedy"])
                finally:
                    _exit_patches(started)
            finally:
                os.environ.pop("AI_PLATFORM_DAILY_REQS", None)
                os.environ.pop("AI_PLATFORM_DAILY_TOKENS", None)
                os.environ.pop("ANTHROPIC_API_KEY", None)


class ChatP0KeyValidationTests(unittest.TestCase):
    def test_short_key_rejected_with_400(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, _, _ = bootstrap_session(client)
                resp = client.put(
                    "/api/settings/ai",
                    headers=headers,
                    json={"anthropic_key": "sk-ant-short"},
                )
                self.assertEqual(resp.status_code, 400, resp.text)
                self.assertIn("too short", resp.json()["detail"].lower())

    def test_wrong_prefix_rejected_with_400(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, _, _ = bootstrap_session(client)
                resp = client.put(
                    "/api/settings/ai",
                    headers=headers,
                    json={"anthropic_key": "sk-openai-1234567890abcdefghij"},
                )
                self.assertEqual(resp.status_code, 400, resp.text)
                self.assertIn("sk-ant-", resp.json()["detail"])

    def test_whitespace_is_trimmed_on_save(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            with managed_client(app) as client:
                headers, _, _ = bootstrap_session(client)
                # Trailing newline + leading space — the classic copy-paste artifact.
                resp = client.put(
                    "/api/settings/ai",
                    headers=headers,
                    json={"anthropic_key": "  sk-ant-padded-padded-padded-padded-padded-12345  \n"},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                # Decrypt server-side via the same code path and verify trim.
                _ensure_backend_on_path()
                from services.ai import crypto
                from services.ai.key_resolver import _user_settings
                from database import SessionLocal
                db = SessionLocal()
                try:
                    me = client.get("/api/auth/me", headers=headers).json()["user"]["id"]
                    row = _user_settings(db, me)
                    keys = crypto.decrypt_dict(row.encrypted_keys_json)
                    saved = keys.get("anthropic", "")
                    self.assertFalse(saved.startswith(" "))
                    self.assertFalse(saved.endswith("\n") or saved.endswith(" "))
                    self.assertTrue(saved.startswith("sk-ant-"))
                finally:
                    db.close()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
