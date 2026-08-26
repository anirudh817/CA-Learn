"""P8 integration tests — STRING + PubMed adapters, parallel mode, admin.

Covers:
  1. PubMed adapter parses esearch + esummary into paper-citation references.
  2. STRING adapter parses interaction partners into references.
  3. Workspace admin GET returns per-adapter daily usage.
  4. A non-admin (MEMBER role) is blocked from workspace AI settings (403).
  5. Parallel mode dispatches multiple external lookups in one turn.

No network — httpx is mocked with httpx.MockTransport.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
import warnings
from unittest import mock

import httpx

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


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


# --- mock payloads ---------------------------------------------------------

_PUBMED_ESEARCH = {"esearchresult": {"idlist": ["38111111", "38222222"]}}
_PUBMED_ESUMMARY = {
    "result": {
        "uids": ["38111111", "38222222"],
        "38111111": {
            "title": "APOE and microglial activation in Alzheimer disease.",
            "source": "Nature Neuroscience",
            "pubdate": "2024 Mar",
            "authors": [{"name": "Smith J"}, {"name": "Doe A"}],
            "articleids": [
                {"idtype": "doi", "value": "10.1038/s41593-024-01"},
                {"idtype": "pubmed", "value": "38111111"},
            ],
        },
        "38222222": {
            "title": "Lipid transport by APOE isoforms.",
            "source": "Cell",
            "pubdate": "2023",
            "authors": [{"name": "Lee K"}],
            "articleids": [],
        },
    }
}
_STRING_PARTNERS = [
    {"preferredName_A": "APOE", "preferredName_B": "CLU",
     "stringId_B": "9606.ENSP00000405598", "score": 0.92},
    {"preferredName_A": "APOE", "preferredName_B": "LRP1",
     "stringId_B": "9606.ENSP00000243077", "score": 0.88},
]
_UNIPROT_APOE = {
    "results": [{
        "primaryAccession": "P02649",
        "genes": [{"geneName": {"value": "APOE"}}],
        "proteinDescription": {"recommendedName": {"fullName": {"value": "Apolipoprotein E"}}},
        "organism": {"scientificName": "Homo sapiens"},
        "comments": [],
    }]
}
_REACTOME_OK = {
    "results": [{
        "typeName": "Pathway",
        "entries": [{"stId": "R-HSA-8963899", "name": "Plasma lipoprotein assembly"}],
    }]
}


class AdapterUnitTests(unittest.TestCase):
    def test_pubmed_returns_paper_citations(self):
        _ensure_backend_on_path()
        from services.ai.external_lookups.pubmed import PubMedAdapter

        def handler(request):
            if "esearch" in request.url.path:
                return httpx.Response(200, json=_PUBMED_ESEARCH)
            if "esummary" in request.url.path:
                return httpx.Response(200, json=_PUBMED_ESUMMARY)
            return httpx.Response(404)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = PubMedAdapter()
        res = _run(adapter.fetch(
            adapter.normalize_args({"query": "APOE Alzheimer"}), client
        ))
        self.assertEqual(res.status, "ok")
        self.assertEqual(len(res.references), 2)
        ref = res.references[0]
        self.assertEqual(ref.ref_id, "38111111")
        self.assertEqual(ref.source, "pubmed")
        self.assertIn("pubmed.ncbi.nlm.nih.gov/38111111", ref.url)
        # Paper-citation label: author + year + title.
        self.assertIn("Smith J et al.", ref.label)
        self.assertIn("2024", ref.label)
        self.assertIn("PMID 38111111", ref.label)

    def test_string_returns_interaction_partners(self):
        _ensure_backend_on_path()
        from services.ai.external_lookups.string_db import StringAdapter

        def handler(request):
            return httpx.Response(200, json=_STRING_PARTNERS)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = StringAdapter()
        res = _run(adapter.fetch(
            adapter.normalize_args({"query": "APOE"}), client
        ))
        self.assertEqual(res.status, "ok")
        self.assertEqual(len(res.references), 2)
        self.assertIn("CLU", res.content)
        self.assertIn("LRP1", res.content)
        self.assertIn("string-db.org/network/", res.references[0].url)

    def test_pubmed_no_results_is_not_found(self):
        _ensure_backend_on_path()
        from services.ai.external_lookups.pubmed import PubMedAdapter

        def handler(request):
            return httpx.Response(200, json={"esearchresult": {"idlist": []}})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        adapter = PubMedAdapter()
        res = _run(adapter.fetch(
            adapter.normalize_args({"query": "zzzznosuchterm"}), client
        ))
        self.assertEqual(res.status, "not_found")
        self.assertFalse(res.is_error)


class WorkspaceAdminTests(unittest.TestCase):
    def test_admin_get_returns_adapter_usage(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()
            with managed_client(app) as client:
                headers, workspace, _ = bootstrap_session(client)
                resp = client.get(
                    f"/api/workspaces/{workspace['id']}/ai-settings", headers=headers
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                data = resp.json()
                self.assertIn("adapter_usage", data)
                adapters = {u["adapter"] for u in data["adapter_usage"]}
                self.assertEqual(adapters, {"uniprot", "reactome", "string", "pubmed"})
                for u in data["adapter_usage"]:
                    self.assertEqual(u["used_today"], 0)
                    self.assertGreater(u["daily_limit"], 0)

    def test_member_role_blocked_from_workspace_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()
            with managed_client(app) as client:
                headers, workspace, _ = bootstrap_session(client)
                # Demote the bootstrap user from ADMIN to MEMBER.
                import database

                db = database.SessionLocal()
                try:
                    m = (
                        db.query(database.Membership)
                        .filter(database.Membership.workspace_id == workspace["id"])
                        .first()
                    )
                    m.role = database.WorkspaceRole.MEMBER
                    db.add(m)
                    db.commit()
                finally:
                    db.close()

                got = client.get(
                    f"/api/workspaces/{workspace['id']}/ai-settings", headers=headers
                )
                self.assertEqual(got.status_code, 403, got.text)
                put = client.put(
                    f"/api/workspaces/{workspace['id']}/ai-settings",
                    headers=headers,
                    json={"parallel_tool_calls": True},
                )
                self.assertEqual(put.status_code, 403, put.text)


class ParallelModeTests(unittest.TestCase):
    """A scripted provider emits two external tool calls in one iteration;
    with parallel mode on, both are dispatched and both tool_results land."""

    def test_parallel_mode_dispatches_two_lookups(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()

            from services.ai.external_lookups import dispatcher as ext_d
            from services.ai.providers import anthropic_provider as ap_module

            ext_d._breakers.clear()
            ext_d._conv_calls.clear()
            ext_d._client = None
            call_count = {"n": 0}

            async def _scripted_stream(self, **kwargs):
                call_count["n"] += 1
                if call_count["n"] == 1:
                    yield {"type": "tool_call", "tool_call": {
                        "id": "tu_1", "name": "lookup_uniprot", "input": {"query": "APOE"}}}
                    yield {"type": "tool_call", "tool_call": {
                        "id": "tu_2", "name": "lookup_reactome", "input": {"query": "APOE"}}}
                    yield {"type": "usage", "usage": {"input_tokens": 50, "output_tokens": 8}}
                    yield {"type": "finish", "finish_reason": "tool_use"}
                else:
                    yield {"type": "delta", "text": "Combined answer [external]."}
                    yield {"type": "usage", "usage": {"input_tokens": 90, "output_tokens": 14}}
                    yield {"type": "finish", "finish_reason": "end_turn"}

            def _no_op_init(self, api_key: str) -> None:
                self._sync_client = None
                self._async_client = None

            def _ext_handler(request):
                host = request.url.host
                if "uniprot" in host:
                    return httpx.Response(200, json=_UNIPROT_APOE)
                if "reactome" in host:
                    return httpx.Response(200, json=_REACTOME_OK)
                return httpx.Response(404)

            ext_client = httpx.AsyncClient(transport=httpx.MockTransport(_ext_handler))

            patches = [
                mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
                mock.patch.object(ap_module.AnthropicProvider, "stream", _scripted_stream),
                mock.patch.object(ext_d, "_get_client", lambda: ext_client),
                mock.patch("config.AI_SECURITY_LLM_JUDGE", False),
            ]
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, workspace, project = bootstrap_session(client)
                    uploaded = upload_primary_dataset(
                        client, headers, workspace["id"], project["id"], dataset_bytes()
                    )
                    import database

                    db = database.SessionLocal()
                    try:
                        db.add(database.Run(
                            id="RUN-PAR",
                            workspace_id=workspace["id"],
                            project_id=project["id"],
                            created_by=db.query(database.User).first().id,
                            name="parallel test",
                            file_id=uploaded["dataset_id"],
                            file_name="cohort.csv",
                            status=database.RunStatus.COMPLETE,
                        ))
                        db.commit()
                    finally:
                        db.close()

                    # Admin turns on parallel mode for the workspace.
                    client.put(
                        f"/api/workspaces/{workspace['id']}/ai-settings",
                        headers=headers,
                        json={"parallel_tool_calls": True},
                    )
                    client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": "sk-ant-fake-key-padding-padding-p8"},
                    )
                    conv = client.post(
                        "/api/runs/RUN-PAR/conversations", headers=headers, json={}
                    ).json()
                    client.put(
                        f"/api/conversations/{conv['id']}/external-lookups",
                        headers=headers,
                        json={"enabled": True},
                    )

                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv['id']}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "Tell me about APOE function and pathways."},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        body = "".join(resp.iter_text())

                    events = []
                    for frame in body.split("\n\n"):
                        for line in frame.splitlines():
                            if line.startswith("data: "):
                                try:
                                    events.append(json.loads(line[len("data: "):]))
                                except json.JSONDecodeError:
                                    pass

                    tool_results = [e for e in events if e["type"] == "tool_result"]
                    self.assertEqual(len(tool_results), 2, "both external lookups must resolve")
                    self.assertTrue(all(tr.get("external") for tr in tool_results))
                    self.assertTrue(all(not tr.get("is_error") for tr in tool_results))
                    self.assertEqual(call_count["n"], 2)
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
