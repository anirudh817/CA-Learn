"""P7 integration tests — external biology database lookups.

Covers:
  1. External tool schemas are well-formed.
  2. UniProt adapter parses a response into content + resolved references.
  3. Cache — an identical second lookup is served from cache (no HTTP).
  4. Circuit breaker opens after two consecutive failures.
  5. Per-workspace daily quota exhaustion returns a fall-back result.
  6. Unknown external tool degrades gracefully.
  7. Workspace policy DENY blocks the per-conversation toggle (HTTP 403).
  8. End-to-end: the streaming loop dispatches an external lookup and emits
     a tool_result carrying the resolved references.

No network — httpx is mocked with httpx.MockTransport. Every test is
self-contained: build_app() purges + rebinds config/database/services in
sys.modules, so each test builds its own app and re-imports afterwards.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
import warnings
from datetime import datetime
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


# --- UniProt mock payload --------------------------------------------------

_UNIPROT_APOE = {
    "results": [
        {
            "primaryAccession": "P02649",
            "genes": [{"geneName": {"value": "APOE"}}],
            "proteinDescription": {
                "recommendedName": {"fullName": {"value": "Apolipoprotein E"}}
            },
            "organism": {"scientificName": "Homo sapiens"},
            "comments": [
                {
                    "commentType": "FUNCTION",
                    "texts": [{"value": "Mediates lipoprotein binding and lipid transport."}],
                },
                {
                    "commentType": "SUBCELLULAR LOCATION",
                    "subcellularLocations": [{"location": {"value": "Secreted"}}],
                },
            ],
        }
    ]
}


def _run(coro):
    # NOT asyncio.run(): that calls set_event_loop(None) on exit, leaving the
    # thread with no usable loop and breaking later test files. Run on a
    # throwaway loop, then restore a fresh open loop on the thread.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


def _reset_dispatcher(d) -> None:
    d._breakers.clear()
    d._conv_calls.clear()
    d._client = None


class ExternalSchemaTests(unittest.TestCase):
    def test_external_tool_schemas_well_formed(self):
        _ensure_backend_on_path()
        from services.ai.external_lookups.dispatcher import (
            EXTERNAL_TOOL_NAMES,
            external_tool_schemas,
        )

        schemas = external_tool_schemas()
        self.assertEqual({s["name"] for s in schemas}, EXTERNAL_TOOL_NAMES)
        for s in schemas:
            self.assertIn("description", s)
            self.assertEqual(s["input_schema"]["type"], "object")
            self.assertIn("query", s["input_schema"]["properties"])
        self.assertIn("lookup_uniprot", EXTERNAL_TOOL_NAMES)
        self.assertIn("lookup_reactome", EXTERNAL_TOOL_NAMES)


class DispatcherUnitTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        build_app(self._td.name)
        _ensure_backend_on_path()
        import database

        database.init_db()
        self.db = database.SessionLocal()
        from services.ai.external_lookups import dispatcher as d

        _reset_dispatcher(d)
        self.d = d

    def tearDown(self):
        self.db.close()
        self._td.cleanup()

    def test_uniprot_lookup_returns_resolved_references(self):
        def handler(request):
            return httpx.Response(200, json=_UNIPROT_APOE)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(self.d, "_get_client", lambda: client):
            res = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "APOE"},
                workspace_id="ws-refs", conversation_id="conv-refs",
            ))
        self.assertEqual(res.status, "ok")
        self.assertFalse(res.is_error)
        self.assertGreaterEqual(len(res.references), 1)
        ref = res.references[0]
        self.assertEqual(ref["ref_id"], "P02649")
        self.assertIn("uniprot.org", ref["url"])
        self.assertIn("APOE", res.content)

    def test_lookup_cached_second_call_skips_http(self):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return httpx.Response(200, json=_UNIPROT_APOE)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(self.d, "_get_client", lambda: client):
            first = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "CACHEGENE"},
                workspace_id="ws-cache", conversation_id="conv-cache",
            ))
            # Different casing + whitespace — must normalize to the same key.
            second = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "  cachegene "},
                workspace_id="ws-cache", conversation_id="conv-cache",
            ))
        self.assertEqual(calls["n"], 1, "second identical lookup must hit cache")
        self.assertFalse(first.cached)
        self.assertTrue(second.cached)
        self.assertEqual(first.content, second.content)

    def test_circuit_breaker_opens_after_two_failures(self):
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return httpx.Response(503, text="upstream down")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(self.d, "_get_client", lambda: client):
            r1 = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "BREAK1"},
                workspace_id="ws-cb", conversation_id="conv-cb",
            ))
            r2 = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "BREAK2"},
                workspace_id="ws-cb", conversation_id="conv-cb",
            ))
            r3 = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "BREAK3"},
                workspace_id="ws-cb", conversation_id="conv-cb",
            ))
        self.assertTrue(r1.is_error)
        self.assertTrue(r2.is_error)
        self.assertEqual(r3.error_kind, "circuit_open")
        # A 503 is a normal HTTP response (not an exception), so the adapter
        # returns once per dispatch. The breaker opens on the 2nd failed
        # dispatch, so the 3rd never reaches the network.
        self.assertEqual(calls["n"], 2)

    def test_quota_exceeded_returns_fallback(self):
        import database
        from services.ai.external_lookups import quotas as q

        self.db.add(database.ExternalLookupQuotaUsage(
            workspace_id="ws-quota",
            adapter="uniprot",
            day=datetime.utcnow().strftime("%Y-%m-%d"),
            call_count=q.DEFAULT_DAILY_LIMITS["uniprot"],
        ))
        self.db.commit()

        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return httpx.Response(200, json=_UNIPROT_APOE)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(self.d, "_get_client", lambda: client):
            res = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "QUOTAGENE"},
                workspace_id="ws-quota", conversation_id="conv-quota",
            ))
        self.assertEqual(res.status, "quota_exceeded")
        self.assertTrue(res.is_error)
        self.assertEqual(calls["n"], 0, "quota block must precede any HTTP call")

    def test_unknown_external_tool_degrades(self):
        res = _run(self.d.dispatch(
            self.db, "lookup_nonexistent", {"query": "X"},
            workspace_id="ws-x", conversation_id="conv-x",
        ))
        self.assertTrue(res.is_error)
        self.assertEqual(res.error_kind, "unknown")

    def test_uniprot_not_found_is_not_an_error(self):
        def handler(request):
            return httpx.Response(200, json={"results": []})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(self.d, "_get_client", lambda: client):
            res = _run(self.d.dispatch(
                self.db, "lookup_uniprot", {"query": "NOSUCHGENE"},
                workspace_id="ws-nf", conversation_id="conv-nf",
            ))
        self.assertEqual(res.status, "not_found")
        self.assertFalse(res.is_error)


class WorkspaceDenyTests(unittest.TestCase):
    def test_workspace_policy_deny_blocks_toggle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()
            with managed_client(app) as client:
                headers, workspace, project = bootstrap_session(client)
                uploaded = upload_primary_dataset(
                    client, headers, workspace["id"], project["id"], dataset_bytes()
                )
                import database

                db = database.SessionLocal()
                try:
                    db.add(database.Run(
                        id="RUN-DENY",
                        workspace_id=workspace["id"],
                        project_id=project["id"],
                        created_by=db.query(database.User).first().id,
                        name="deny test",
                        file_id=uploaded["dataset_id"],
                        file_name="cohort.csv",
                        status=database.RunStatus.COMPLETE,
                    ))
                    db.add(database.WorkspaceAISettings(
                        workspace_id=workspace["id"],
                        external_lookups_policy=database.ExternalLookupsPolicy.DENY,
                    ))
                    db.commit()
                finally:
                    db.close()

                conv = client.post(
                    "/api/runs/RUN-DENY/conversations", headers=headers, json={}
                ).json()
                resp = client.put(
                    f"/api/conversations/{conv['id']}/external-lookups",
                    headers=headers,
                    json={"enabled": True},
                )
                self.assertEqual(resp.status_code, 403, resp.text)


class StreamingExternalLookupTests(unittest.TestCase):
    """Drive _stream_assistant_turn with a scripted provider that calls the
    external lookup tool; assert the dispatcher fires and the tool_result
    SSE event carries the resolved references."""

    def test_streaming_dispatches_external_lookup_with_references(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()

            from services.ai.external_lookups import dispatcher as ext_d
            from services.ai.providers import anthropic_provider as ap_module

            _reset_dispatcher(ext_d)
            call_count = {"n": 0}

            async def _scripted_stream(self, **kwargs):
                call_count["n"] += 1
                if call_count["n"] == 1:
                    yield {
                        "type": "tool_call",
                        "tool_call": {
                            "id": "tu_ext",
                            "name": "lookup_uniprot",
                            "input": {"query": "APOE"},
                        },
                    }
                    yield {"type": "usage", "usage": {"input_tokens": 80, "output_tokens": 10}}
                    yield {"type": "finish", "finish_reason": "tool_use"}
                else:
                    yield {"type": "delta", "text": "APOE is secreted "}
                    yield {"type": "delta", "text": "[external], per UniProt."}
                    yield {"type": "usage", "usage": {"input_tokens": 120, "output_tokens": 20}}
                    yield {"type": "finish", "finish_reason": "end_turn"}

            def _no_op_init(self, api_key: str) -> None:
                self._sync_client = None
                self._async_client = None

            def _uniprot_handler(request):
                return httpx.Response(200, json=_UNIPROT_APOE)

            ext_client = httpx.AsyncClient(transport=httpx.MockTransport(_uniprot_handler))

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
                            id="RUN-EXT",
                            workspace_id=workspace["id"],
                            project_id=project["id"],
                            created_by=db.query(database.User).first().id,
                            name="ext test",
                            file_id=uploaded["dataset_id"],
                            file_name="cohort.csv",
                            status=database.RunStatus.COMPLETE,
                        ))
                        db.commit()
                    finally:
                        db.close()

                    client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": "sk-ant-fake-key-padding-padding-p7"},
                    )
                    conv = client.post(
                        "/api/runs/RUN-EXT/conversations", headers=headers, json={}
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
                        json={"content": "Where in the cell is APOE located?"},
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

                    tool_calls = [e for e in events if e["type"] == "tool_call"]
                    tool_results = [e for e in events if e["type"] == "tool_result"]
                    self.assertTrue(tool_calls, "expected a tool_call event")
                    self.assertTrue(tool_results, "expected a tool_result event")
                    self.assertTrue(tool_calls[0].get("external"))
                    tr = tool_results[0]
                    self.assertTrue(tr.get("external"))
                    self.assertFalse(tr.get("is_error"))
                    self.assertTrue(tr.get("references"), "external result must carry references")
                    self.assertEqual(tr["references"][0]["ref_id"], "P02649")
                    self.assertEqual(call_count["n"], 2)
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
