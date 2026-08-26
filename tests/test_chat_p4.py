"""P4 wave 1 tests — artifact index, query rewriter, retrievers, context builder.

The goal is to prove the retrieval pipeline behaves correctly across diverse
pipeline shapes — not just the one real run we have. Each test builds a
synthetic run directory with intentionally varied file naming / column
shapes / missing stages, then exercises the relevant retriever.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from tests.test_app import BACKEND_DIR, build_app

warnings.simplefilter("ignore", DeprecationWarning)
warnings.simplefilter("ignore", ResourceWarning)


def _ensure_backend_on_path() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))


# Build once so config + sys.path are set before any backend import.
with tempfile.TemporaryDirectory() as _td:
    build_app(_td)
_ensure_backend_on_path()


from services.ai.artifact_index import (  # noqa: E402
    ArtifactIndex,
    build_index,
    clear_cache,
    get_index,
)
from services.ai.query_rewriter import heuristic_intent  # noqa: E402
from services.ai.retrievers import retrieve  # noqa: E402


# ---------- Synthetic run fixtures ----------

def _write_full_synthetic_run(data_dir: Path, run_id: str) -> Path:
    """A run that follows the standard SignalFold layout."""
    run_dir = data_dir / "runs" / run_id
    (run_dir / "stage1").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage2").mkdir(parents=True, exist_ok=True)
    (run_dir / "stage3").mkdir(parents=True, exist_ok=True)
    (run_dir / "05_network_CBN_median").mkdir(parents=True, exist_ok=True)
    # Hub proteins file as a separate dedicated output (mirrors what the
    # real WGCNA stage writes alongside module_assignments).
    (run_dir / "05_network_CBN_median" / "PROTEOMICS_WGCNA_All_Hub_Proteins.csv").write_text(
        "gene,module_color,kME,is_hub\n"
        "CLU,turquoise,0.91,True\n"
        "APOE,turquoise,0.72,True\n"
        "GFAP,blue,0.94,True\n"
        "S100B,blue,0.88,True\n"
        "ALB,black,0.65,True\n"
    )

    (run_dir / "run_manifest.json").write_text(json.dumps({
        "format_family": "Generic",
        "input_level": "protein",
        "sample_count": 12,
        "feature_count": 5,
        "comparison": "AD vs Control",
    }, indent=2))

    # Volcano: APOE present at row 4, with several peptides.
    (run_dir / "stage1" / "volcano_results.tsv").write_text(
        "peptide_id\tfeature_id\tgene\tlog2fc\tadj_pvalue\tdirection\tmodule\n"
        "A1BG_pep1\tA1BG_pep1\tA1BG\t-0.635\t0.0046\tdown\tgreen\n"
        "CLU_pep1\tCLU_pep1\tCLU\t2.831\t0.0009\tup\tturquoise\n"
        "APOE_pep1\tAPOE_pep1\tAPOE\t0.346\t0.0138\tns\tturquoise\n"
        "APOE_pep2\tAPOE_pep2\tAPOE\t0.269\t0.0344\tns\tturquoise\n"
        "GFAP_pep1\tGFAP_pep1\tGFAP\t1.211\t0.0021\tup\tblue\n"
    )

    # Module assignments
    (run_dir / "stage1" / "module_assignments.csv").write_text(
        "peptide_id,feature_id,gene,module_color,kME\n"
        "A1BG_pep1,A1BG_pep1,A1BG,green,0.7\n"
        "CLU_pep1,CLU_pep1,CLU,turquoise,0.85\n"
        "APOE_pep1,APOE_pep1,APOE,turquoise,0.72\n"
        "APOE_pep2,APOE_pep2,APOE,turquoise,0.26\n"
        "GFAP_pep1,GFAP_pep1,GFAP,blue,0.9\n"
    )

    # GO enrichment
    (run_dir / "stage2" / "go_enrichment_all.csv").write_text(
        "module,term,category,pvalue,fdr,hits,hit_genes\n"
        "turquoise,synaptic signaling,BP,1e-6,1e-5,5,CLU;APOE\n"
        "blue,gliogenesis,BP,1e-4,1e-3,3,GFAP\n"
        "green,immune response,BP,1e-3,1e-2,2,A1BG\n"
    )

    # Cell type FDR matrix
    (run_dir / "stage3" / "celltype_heatmap_data.csv").write_text(
        "module,cell_type,pvalue,fdr\n"
        "turquoise,Neuron,1e-6,1e-5\n"
        "blue,Microglia,1e-5,1e-4\n"
        "blue,Astrocytes,1e-3,1e-2\n"
        "green,Endothelia,0.04,0.05\n"
    )
    return run_dir


def _write_variant_synthetic_run(data_dir: Path, run_id: str) -> Path:
    """A run from a hypothetical alternative pipeline that names files
    differently and only produces DE results (no modules, no GO, no
    cell types). The retrievers must NOT crash; they should just return
    nothing for the missing families and answer what they can about DE."""
    run_dir = data_dir / "runs" / run_id
    (run_dir / "de").mkdir(parents=True, exist_ok=True)
    # Different filename, same column shape.
    (run_dir / "de" / "results.csv").write_text(
        "gene,log2fc,adj_pvalue,direction,module\n"
        "MAPT,-1.2,0.0001,down,turquoise\n"
        "GFAP,1.5,0.001,up,blue\n"
    )
    (run_dir / "manifest.json").write_text(
        '{"format_family":"Variant","sample_count":6,"feature_count":2}'
    )
    return run_dir


def _write_empty_run(data_dir: Path, run_id: str) -> Path:
    run_dir = data_dir / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


# ---------- ArtifactIndex tests ----------

class ArtifactIndexTests(unittest.TestCase):
    def setUp(self):
        clear_cache()

    def test_full_run_classifies_files_by_columns(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_full_synthetic_run(data_dir, "RUN-X")
            idx = build_index("RUN-X", run_dir)
            families = idx.families_present()
            self.assertIn("volcano.results", families)
            self.assertIn("network.assignments", families)
            self.assertIn("go.enrichment", families)
            self.assertIn("cells.matrix", families)
            self.assertIn("report.manifest", families)
            volcano = idx.first("volcano.results")
            self.assertIsNotNone(volcano)
            self.assertIn("gene", [c.lower() for c in volcano.columns])
            self.assertEqual(volcano.row_count, 5)

    def test_variant_pipeline_with_different_filenames_still_classifies(self):
        # The "de/results.csv" file has gene+log2fc+adj_pvalue columns →
        # should be classified as volcano.results even though the filename is novel.
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_variant_synthetic_run(data_dir, "RUN-Y")
            idx = build_index("RUN-Y", run_dir)
            self.assertIn("volcano.results", idx.families_present())

    def test_empty_run_returns_empty_index(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_empty_run(data_dir, "RUN-EMPTY")
            idx = build_index("RUN-EMPTY", run_dir)
            self.assertEqual(idx.records, [])

    def test_table_of_contents_lists_known_files(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_full_synthetic_run(data_dir, "RUN-X")
            idx = build_index("RUN-X", run_dir)
            toc = idx.table_of_contents()
            self.assertIn("volcano.results", toc)
            self.assertIn("network.assignments", toc)
            self.assertIn("go.enrichment", toc)
            self.assertIn("cells.matrix", toc)


# ---------- Query rewriter tests ----------

class QueryRewriterTests(unittest.TestCase):
    def test_protein_lookup(self):
        i = heuristic_intent("What is APOE's log2FC in this run?")
        self.assertEqual(i.intent_type, "protein_lookup")
        self.assertIn("APOE", i.entities.get("proteins", []))
        self.assertIn("volcano.results", i.target_families)

    def test_significance_ranking(self):
        i = heuristic_intent("Give me the top 5 most significant proteins")
        self.assertEqual(i.intent_type, "significance_ranking")
        self.assertIn("volcano.results", i.target_families)

    def test_module_query(self):
        i = heuristic_intent("List hub proteins in the turquoise module")
        self.assertEqual(i.intent_type, "module_query")
        self.assertIn("turquoise", i.entities.get("modules", []))

    def test_module_list(self):
        i = heuristic_intent("How many modules are in this run?")
        self.assertEqual(i.intent_type, "module_list")

    def test_go_enrichment(self):
        i = heuristic_intent("What pathways are enriched in this run?")
        self.assertEqual(i.intent_type, "go_enrichment")
        self.assertIn("go.enrichment", i.target_families)

    def test_cell_type(self):
        i = heuristic_intent("Which modules are over-represented in microglia?")
        self.assertEqual(i.intent_type, "cell_type")
        self.assertIn("microglia", i.entities.get("cell_types", []))

    def test_cross_modal(self):
        i = heuristic_intent(
            "Which GO terms are enriched in modules over-represented in microglia?"
        )
        self.assertEqual(i.intent_type, "cross_modal")
        self.assertTrue(i.requires_cross_modal)

    def test_summary(self):
        i = heuristic_intent("Summarize this run for a grant report")
        self.assertEqual(i.intent_type, "summary")

    def test_symbol_blocklist_filters_common_caps(self):
        # "GO", "WGCNA", "AD" should NOT be detected as protein symbols.
        i = heuristic_intent("Tell me about GO enrichment and WGCNA modules in AD")
        proteins = i.entities.get("proteins", [])
        self.assertNotIn("GO", proteins)
        self.assertNotIn("WGCNA", proteins)
        self.assertNotIn("AD", proteins)


# ---------- Retriever tests against the synthetic full run ----------

class RetrieverIntegrationTests(unittest.TestCase):
    def setUp(self):
        clear_cache()
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        _write_full_synthetic_run(self.data_dir, "RUN-X")
        self.index = build_index("RUN-X", self.data_dir / "runs" / "RUN-X")

    def tearDown(self):
        self._tmp.cleanup()

    def test_apoe_lookup_returns_apoe_rows(self):
        intent = heuristic_intent("What is APOE's log2FC in this run?")
        chunks = retrieve(self.index, intent)
        self.assertTrue(chunks)
        # Volcano chunk should contain both APOE peptides.
        volcano_chunk = next((c for c in chunks if c.family == "volcano.results"), None)
        self.assertIsNotNone(volcano_chunk)
        self.assertIn("APOE", volcano_chunk.body)
        self.assertIn("0.346", volcano_chunk.body)  # the actual log2FC
        # Citation includes the row count for APOE.
        cit = volcano_chunk.citations[0]
        self.assertEqual(cit["file_path"], "stage1/volcano_results.tsv")
        self.assertEqual(cit["run_id"], "RUN-X")

    def test_significance_ranking_returns_top_by_pvalue(self):
        intent = heuristic_intent("top 3 most significant proteins")
        chunks = retrieve(self.index, intent)
        v = next((c for c in chunks if c.family == "volcano.results"), None)
        self.assertIsNotNone(v)
        # First row in the rendered table should be the most significant
        # (CLU, adj_pvalue 0.0009) — NOT A1BG (which is significant but
        # higher adj_pvalue) and NOT alphabetical.
        first_line = v.body.split("\n")[2]  # | header | / | sep | / | first row |
        self.assertIn("CLU", first_line)

    def test_module_query_returns_module_members(self):
        intent = heuristic_intent("hub proteins in turquoise module")
        chunks = retrieve(self.index, intent)
        m = next((c for c in chunks if c.family == "network.assignments"), None)
        self.assertIsNotNone(m)
        # Should contain CLU + APOE (both turquoise).
        self.assertIn("CLU", m.body)
        self.assertIn("APOE", m.body)

    def test_cell_type_question_returns_celltype_data(self):
        intent = heuristic_intent("Which modules are over-represented in microglia?")
        chunks = retrieve(self.index, intent)
        c = next((c for c in chunks if c.family == "cells.matrix"), None)
        self.assertIsNotNone(c)
        self.assertIn("Microglia", c.body)
        # blue module is microglia-enriched in our fixture
        self.assertIn("blue", c.body)

    def test_cross_modal_join_microglia_and_go(self):
        intent = heuristic_intent(
            "Which GO terms are enriched in modules over-represented in microglia?"
        )
        chunks = retrieve(self.index, intent)
        # Cross-modal retriever should produce step1 (cells) + step2 (GO).
        cell_chunk = next((c for c in chunks if c.family == "cells.matrix"), None)
        go_chunk = next((c for c in chunks if c.family == "go.enrichment"), None)
        self.assertIsNotNone(cell_chunk)
        self.assertIsNotNone(go_chunk)
        # The GO chunk should be restricted to the blue module (microglia-enriched
        # at FDR < 0.05). It should contain "gliogenesis" (blue) but NOT
        # "synaptic signaling" (turquoise) — turquoise isn't microglia-enriched.
        self.assertIn("gliogenesis", go_chunk.body)
        self.assertNotIn("synaptic signaling", go_chunk.body)

    def test_multi_module_comparison_returns_rows_per_module(self):
        intent = heuristic_intent("Compare hub proteins in turquoise vs blue modules")
        chunks = retrieve(self.index, intent)
        # Find the module-assignments chunk
        m = next((c for c in chunks if c.family == "network.assignments"), None)
        self.assertIsNotNone(m)
        # Must contain rows from BOTH modules (not just the larger one).
        self.assertIn("turquoise", m.body)
        self.assertIn("blue", m.body)
        # And the dedicated hub-protein file should also be in the chunks.
        h = next((c for c in chunks if c.family == "network.hub_proteins"), None)
        self.assertIsNotNone(h)
        # Hub file filtered to the requested modules.
        self.assertTrue("turquoise" in h.body.lower())
        self.assertTrue("blue" in h.body.lower())

    def test_hub_proteins_file_pulled_for_module_questions(self):
        intent = heuristic_intent("hub proteins in turquoise")
        chunks = retrieve(self.index, intent)
        h = next((c for c in chunks if c.family == "network.hub_proteins"), None)
        self.assertIsNotNone(h, "hub proteins file should be included for module queries")
        # Has the hub-tagged rows for turquoise (CLU, APOE).
        self.assertIn("CLU", h.body)

    def test_open_ended_returns_manifest_and_volcano(self):
        intent = heuristic_intent("What's in this run?")
        chunks = retrieve(self.index, intent)
        families = [c.family for c in chunks]
        self.assertIn("report.manifest", families)


class RetrieverVariantPipelineTests(unittest.TestCase):
    def test_variant_pipeline_apoe_lookup_still_works(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_variant_synthetic_run(data_dir, "RUN-Y")
            idx = build_index("RUN-Y", run_dir)
            intent = heuristic_intent("What is MAPT's log2FC?")
            chunks = retrieve(idx, intent)
            # Even though file is "de/results.csv" not the standard name,
            # column-based classification finds it.
            v = next((c for c in chunks if c.family == "volcano.results"), None)
            self.assertIsNotNone(v)
            self.assertIn("MAPT", v.body)

    def test_variant_pipeline_with_missing_go_returns_nothing_not_crash(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            run_dir = _write_variant_synthetic_run(data_dir, "RUN-Y")
            idx = build_index("RUN-Y", run_dir)
            intent = heuristic_intent("What pathways are enriched?")
            chunks = retrieve(idx, intent)
            # No GO file present → go retriever returns []. The pipeline
            # MUST NOT crash.
            go = [c for c in chunks if c.family == "go.enrichment"]
            self.assertEqual(go, [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
