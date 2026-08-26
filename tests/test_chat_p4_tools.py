"""P4 wave 2 tests — tool registry, dispatcher safety, and the multi-iteration
streaming loop. The end-to-end loop test uses a mocked provider that mimics
Anthropic's two-turn tool-use flow.
"""
from __future__ import annotations

import asyncio
import json
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


# Build app once so env is set before backend imports.
with tempfile.TemporaryDirectory() as _td:
    build_app(_td)
_ensure_backend_on_path()


from services.ai import tools as tools_module  # noqa: E402
from services.ai.tools import (  # noqa: E402
    MAX_RESULT_CHARS,
    MAX_ROWS,
    TOOL_SCHEMAS,
    ToolExecutionResult,
    _safe_resolve,
    dispatch,
)


# ---------- Fixture: write a small run on disk ----------

def _write_minimal_run(data_dir: Path, run_id: str) -> Path:
    """Reuse the P4-wave-1 synthetic run layout but as a smaller fixture
    here so the tests are self-contained."""
    run_dir = data_dir / "runs" / run_id
    (run_dir / "stage1").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage2").mkdir(parents=True, exist_ok=True)
    (run_dir / "run_manifest.json").write_text(
        '{"format_family":"Generic","input_level":"protein","sample_count":6,"feature_count":3}'
    )
    (run_dir / "stage1" / "volcano_results.tsv").write_text(
        "gene\tlog2fc\tadj_pvalue\tdirection\tmodule\n"
        "APOE\t0.346\t0.014\tns\tturquoise\n"
        "CLU\t2.831\t0.0009\tup\tturquoise\n"
        "GFAP\t1.211\t0.002\tup\tblue\n"
    )
    (run_dir / "stage1" / "module_assignments.csv").write_text(
        "gene,module_color,kME\nAPOE,turquoise,0.72\nCLU,turquoise,0.85\nGFAP,blue,0.9\n"
    )
    (run_dir / "stage2" / "go_enrichment_all.csv").write_text(
        "module,term,category,pvalue,fdr,hits,hit_genes\n"
        "turquoise,synaptic signaling,BP,1e-6,1e-5,2,CLU;APOE\n"
        "blue,gliogenesis,BP,1e-4,1e-3,1,GFAP\n"
    )
    return run_dir


# ---------- Safety: path resolution ----------

class SafePathResolveTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._td.name) / "data"
        self.run_dir = _write_minimal_run(self.data_dir, "RUN-SAFE")

    def tearDown(self):
        self._td.cleanup()

    def test_normal_relative_path_resolves(self):
        p = _safe_resolve("stage1/volcano_results.tsv", self.run_dir)
        self.assertIsNotNone(p)
        self.assertTrue(p.exists())

    def test_traversal_blocked(self):
        for evil in [
            "../../../../etc/passwd",
            "stage1/../../etc/passwd",
            "stage1/../../../",
            "/etc/passwd",
            "/../etc/passwd",
        ]:
            with self.subTest(evil=evil):
                self.assertIsNone(_safe_resolve(evil, self.run_dir), f"should block {evil!r}")

    def test_null_byte_blocked(self):
        self.assertIsNone(_safe_resolve("stage1/\x00.tsv", self.run_dir))

    def test_empty_rejected(self):
        self.assertIsNone(_safe_resolve("", self.run_dir))


# ---------- Tool schemas ----------

class ToolSchemaTests(unittest.TestCase):
    def test_all_tool_schemas_are_well_formed(self):
        for sch in TOOL_SCHEMAS:
            self.assertIn("name", sch)
            self.assertIn("description", sch)
            self.assertIn("input_schema", sch)
            self.assertEqual(sch["input_schema"].get("type"), "object")

    def test_expected_tools_present(self):
        names = {s["name"] for s in TOOL_SCHEMAS}
        self.assertEqual(names, {"list_files", "read_file_slice", "lookup_protein", "lookup_module"})


# ---------- Dispatcher: list_files / read_file_slice / lookup_protein / lookup_module ----------

class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._td.name) / "data"
        _write_minimal_run(self.data_dir, "RUN-T")
        self.runs_dir = self.data_dir / "runs"

    def tearDown(self):
        self._td.cleanup()

    def _run(self, name, args):
        return asyncio.get_event_loop().run_until_complete(
            dispatch(name=name, args=args, run_id="RUN-T", runs_dir=self.runs_dir)
        )

    def test_list_files_returns_toc(self):
        r = self._run("list_files", {})
        self.assertFalse(r.is_error)
        self.assertIn("volcano.results", r.content)
        self.assertIn("network.assignments", r.content)
        self.assertIn("go.enrichment", r.content)
        self.assertGreater(r.rows_returned, 0)

    def test_read_file_slice_full_file(self):
        r = self._run("read_file_slice", {"rel_path": "stage1/volcano_results.tsv"})
        self.assertFalse(r.is_error)
        self.assertIn("APOE", r.content)
        self.assertIn("CLU", r.content)
        self.assertEqual(r.cited_files, ["stage1/volcano_results.tsv"])

    def test_read_file_slice_filter(self):
        r = self._run(
            "read_file_slice",
            {"rel_path": "stage1/volcano_results.tsv", "filter": "APOE"},
        )
        self.assertFalse(r.is_error)
        self.assertIn("APOE", r.content)
        self.assertNotIn("GFAP", r.content)

    def test_read_file_slice_path_traversal_blocked(self):
        r = self._run("read_file_slice", {"rel_path": "../../../../etc/passwd"})
        self.assertTrue(r.is_error)
        self.assertEqual(r.error_kind, "path_blocked")
        self.assertIn("blocked", r.content.lower())

    def test_read_file_slice_missing_file(self):
        r = self._run("read_file_slice", {"rel_path": "stage1/nope.tsv"})
        self.assertTrue(r.is_error)
        self.assertEqual(r.error_kind, "not_found")

    def test_read_file_slice_max_rows_capped(self):
        r = self._run(
            "read_file_slice",
            {"rel_path": "stage1/volcano_results.tsv", "max_rows": 50_000},
        )
        # Our fixture only has 3 data rows; the cap doesn't matter for output
        # but the function must NOT raise on absurd max_rows.
        self.assertFalse(r.is_error)

    def test_read_file_slice_json_file(self):
        r = self._run("read_file_slice", {"rel_path": "run_manifest.json"})
        self.assertFalse(r.is_error)
        self.assertIn("format_family", r.content)

    def test_lookup_protein_returns_de_and_modules(self):
        r = self._run("lookup_protein", {"symbol": "APOE"})
        self.assertFalse(r.is_error)
        self.assertIn("APOE", r.content)
        self.assertIn("Differential expression", r.content)
        self.assertIn("Module assignments", r.content)

    def test_lookup_module_returns_members_and_go(self):
        r = self._run("lookup_module", {"module": "turquoise"})
        self.assertFalse(r.is_error)
        self.assertIn("turquoise", r.content.lower())
        # Should pull GO terms for the module.
        self.assertIn("synaptic signaling", r.content)

    def test_unknown_tool(self):
        r = self._run("definitely_not_a_tool", {})
        self.assertTrue(r.is_error)
        self.assertEqual(r.error_kind, "exec_error")

    def test_unknown_run(self):
        async def go():
            return await dispatch(
                name="list_files",
                args={},
                run_id="RUN-DOES-NOT-EXIST",
                runs_dir=self.runs_dir,
            )

        r = asyncio.get_event_loop().run_until_complete(go())
        self.assertTrue(r.is_error)
        self.assertEqual(r.error_kind, "not_found")


# ---------- Timeout enforcement ----------

class TimeoutTests(unittest.TestCase):
    def test_dispatch_enforces_timeout(self):
        async def slow_tool(args, *, index, run_dir):
            await asyncio.sleep(10)
            return ToolExecutionResult(name="slow", content="too late")

        with mock.patch.dict(tools_module._TOOLS, {"slow": slow_tool}, clear=False):
            with tempfile.TemporaryDirectory() as td:
                data_dir = Path(td) / "data"
                _write_minimal_run(data_dir, "RUN-T")
                r = asyncio.get_event_loop().run_until_complete(
                    dispatch(name="slow", args={}, run_id="RUN-T", runs_dir=data_dir / "runs", timeout_s=0.05)
                )
                self.assertTrue(r.is_error)
                self.assertEqual(r.error_kind, "timeout")


# ---------- End-to-end agentic loop ----------

class StreamingToolLoopTests(unittest.TestCase):
    """Drive the route's _stream_assistant_turn end-to-end with a mocked
    provider that emits tool_call → expects the tool to fire → continues
    with a final text answer. Verifies the loop wires correctly."""

    def test_full_loop_streams_tool_call_then_continues(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            _ensure_backend_on_path()
            # Write the run fixture INSIDE the app's data dir.
            from config import RUNS_DIR

            _write_minimal_run(Path(RUNS_DIR.parent), "RUN-TL")

            from services.ai.providers import anthropic_provider as ap_module

            # Scripted provider: first stream yields a tool_call; second
            # stream yields text + finish. Counts calls so we can assert
            # the loop iterated twice (and exactly twice).
            call_count = {"n": 0}

            async def _scripted_stream(self, **kwargs):
                call_count["n"] += 1
                if call_count["n"] == 1:
                    # Iteration 1: ask for a tool call.
                    yield {
                        "type": "tool_call",
                        "tool_call": {
                            "id": "tu_abc",
                            "name": "lookup_protein",
                            "input": {"symbol": "APOE"},
                        },
                    }
                    yield {"type": "usage", "usage": {"input_tokens": 100, "output_tokens": 20}}
                    yield {"type": "finish", "finish_reason": "tool_use"}
                else:
                    # Iteration 2: produce the final answer using the result.
                    yield {"type": "delta", "text": "APOE was looked up; "}
                    yield {"type": "delta", "text": "log2FC = 0.346 (ns)."}
                    yield {"type": "usage", "usage": {"input_tokens": 200, "output_tokens": 30}}
                    yield {"type": "finish", "finish_reason": "end_turn"}

            def _no_op_init(self, api_key: str) -> None:
                self._sync_client = None
                self._async_client = None

            patches = [
                mock.patch.object(ap_module.AnthropicProvider, "__init__", _no_op_init),
                mock.patch.object(ap_module.AnthropicProvider, "stream", _scripted_stream),
            ]
            for p in patches:
                p.__enter__()

            try:
                with managed_client(app) as client:
                    headers, workspace, project = bootstrap_session(client)
                    # Create the run row so the conversation can attach to it.
                    # We don't need the actual pipeline to run — we wrote
                    # the files manually under data/runs/RUN-TL/.
                    # Create a quick dummy run row pointing at our run_id.
                    from database import SessionLocal, Run, RunStatus
                    db = SessionLocal()
                    try:
                        # Need at minimum a Run row with id matching our fixture.
                        # Create a dataset row + a Run row by-hand.
                        uploaded = upload_primary_dataset(
                            client, headers, workspace["id"], project["id"], dataset_bytes()
                        )
                        # Run via the real pipeline would be slow; create a
                        # Run row directly tied to our fixture run_id.
                        run = Run(
                            id="RUN-TL",
                            workspace_id=workspace["id"],
                            project_id=project["id"],
                            created_by=db.query(__import__("database").User).first().id,
                            name="loop test",
                            file_id=uploaded["dataset_id"],
                            file_name="cohort.csv",
                            status=RunStatus.COMPLETE,
                        )
                        db.add(run)
                        db.commit()
                    finally:
                        db.close()

                    # Paste a key so streaming proceeds.
                    client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": "sk-ant-fake-tool-loop-test-padding"},
                    )
                    conv = client.post(
                        "/api/runs/RUN-TL/conversations",
                        headers=headers,
                        json={"title": "loop"},
                    ).json()

                    with client.stream(
                        "POST",
                        f"/api/conversations/{conv['id']}/messages",
                        headers={**headers, "Accept": "text/event-stream"},
                        json={"content": "What is APOE log2FC?"},
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

                    types = [e["type"] for e in events]
                    # Must include start, tool_call, tool_result, delta, finish.
                    self.assertIn("start", types)
                    self.assertIn("tool_call", types)
                    self.assertIn("tool_result", types)
                    self.assertIn("delta", types)
                    self.assertIn("finish", types)
                    # Provider was called exactly twice (iter 1 emits tool_call,
                    # iter 2 produces text). Anything more = runaway loop.
                    self.assertEqual(call_count["n"], 2)
            finally:
                for p in reversed(patches):
                    try:
                        p.__exit__(None, None, None)
                    except Exception:
                        pass


# ---------- Security: internal-methodology files must never be readable ----------

class InternalFileBlockingTests(unittest.TestCase):
    """read_file_slice lives inside the run dir but must refuse files that
    encode HOW the pipeline works (stage configs, R/Python source, logs,
    parity scripts) — they are the IP the confidentiality layer protects."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._td.name) / "data"
        _write_minimal_run(self.data_dir, "RUN-SEC")
        self.runs_dir = self.data_dir / "runs"
        run_dir = self.runs_dir / "RUN-SEC"
        # Plant internal-methodology files inside the (path-safe) run dir.
        (run_dir / "config_stage1.json").write_text('{"norm": "CBN", "power": 4}')
        (run_dir / "stats_control_audit.json").write_text('{"requested": {}}')
        (run_dir / "stage1_parity.R").write_text("library(WGCNA)\nbicor(x)\n")
        (run_dir / "run.log").write_text("[ts] running TAMPOR normalization\n")
        (run_dir / "helper.py").write_text("def secret(): pass\n")

    def tearDown(self):
        self._td.cleanup()

    def _run(self, name, args):
        return asyncio.get_event_loop().run_until_complete(
            dispatch(name=name, args=args, run_id="RUN-SEC", runs_dir=self.runs_dir)
        )

    def test_internal_files_are_blocked(self):
        for rel in (
            "config_stage1.json",
            "stats_control_audit.json",
            "stage1_parity.R",
            "run.log",
            "helper.py",
        ):
            r = self._run("read_file_slice", {"rel_path": rel})
            self.assertTrue(r.is_error, f"{rel} should be blocked")
            self.assertEqual(r.error_kind, "path_blocked", f"{rel} wrong error_kind")
            # Must not leak any file body.
            self.assertNotIn("WGCNA", r.content)
            self.assertNotIn("TAMPOR", r.content)
            self.assertNotIn("CBN", r.content)

    def test_normal_data_files_still_readable(self):
        r = self._run("read_file_slice", {"rel_path": "stage1/volcano_results.tsv"})
        self.assertFalse(r.is_error)
        self.assertIn("APOE", r.content)


# ---------- .txt table-vs-prose heuristic in read_file_slice (GO-FET fix) ----------

class TxtHeuristicTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._td.name) / "data"
        _write_minimal_run(self.data_dir, "RUN-TXT")
        self.runs_dir = self.data_dir / "runs"
        run_dir = self.runs_dir / "RUN-TXT"
        (run_dir / "stage2").mkdir(parents=True, exist_ok=True)
        # A tab-delimited GO-FET .txt (extension implies comma — the prod bug).
        go = ["GO_term\tmodule\tpvalue\tfdr"]
        go += [f"GO:00000{i:02d}\tturquoise\t0.0{i}\t0.1{i}" for i in range(25)]
        (run_dir / "stage2" / "GSA-GO-FET.txt").write_text("\n".join(go))
        # A prose summary .txt — must NOT be mangled into a table.
        (run_dir / "stage2" / "Summary.txt").write_text(
            "This run analyzed 60 samples.\nThe turquoise module dominated.\n"
            "Synaptic proteins were enriched.\n"
        )

    def tearDown(self):
        self._td.cleanup()

    def _run(self, args):
        return asyncio.get_event_loop().run_until_complete(
            dispatch(name="read_file_slice", args=args, run_id="RUN-TXT", runs_dir=self.runs_dir)
        )

    def test_tabular_txt_returns_rows(self):
        r = self._run({"rel_path": "stage2/GSA-GO-FET.txt"})
        self.assertFalse(r.is_error)
        self.assertGreater(r.rows_returned, 0)
        self.assertIn("|", r.content)  # rendered as a markdown table
        self.assertNotIn("raw text", r.content)

    def test_prose_txt_returns_raw_text_not_a_table(self):
        r = self._run({"rel_path": "stage2/Summary.txt"})
        self.assertFalse(r.is_error)
        self.assertEqual(r.rows_returned, 0)
        self.assertIn("raw text", r.content)
        self.assertIn("turquoise module dominated", r.content)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
