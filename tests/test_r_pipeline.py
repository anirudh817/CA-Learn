import json
import os
import signal
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Clear cached modules so pipeline re-imports cleanly
for _mod in list(sys.modules):
    if _mod in {"config", "database", "deps"} or _mod.startswith("services") or _mod.startswith("routes"):
        sys.modules.pop(_mod, None)


class RStage1Tests(unittest.TestCase):
    """Unit tests for R pipeline integration (Phase 2)."""

    # --- RPIP-07: R unavailability raises RuntimeError ---

    def test_run_stage1_raises_when_rscript_not_in_path(self):
        """When Rscript is not in PATH, run_stage1 must raise RuntimeError mentioning 'Rscript'."""
        from services import pipeline
        with patch.object(pipeline, "_stage1_rscript_path", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                with tempfile.TemporaryDirectory() as tmp:
                    pipeline.run_stage1({}, Path(tmp), lambda msg: None)
            self.assertIn("unavailable", str(ctx.exception).lower())

    def test_run_stage1_raises_when_script_missing(self):
        """When stage1_parity.R does not exist, run_stage1 must raise RuntimeError."""
        from services import pipeline
        with patch.object(pipeline, "_stage1_rscript_path", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                with tempfile.TemporaryDirectory() as tmp:
                    pipeline.run_stage1({}, Path(tmp), lambda msg: None)
            self.assertIn("unavailable", str(ctx.exception).lower())

    def test_stage1_rscript_path_returns_none_when_rscript_missing(self):
        """_stage1_rscript_path returns None when Rscript binary is not found."""
        from services import pipeline
        with patch("shutil.which", return_value=None):
            result = pipeline._stage1_rscript_path()
        self.assertIsNone(result)

    # --- RPIP-06: Seed generation in _run_stage1_via_r ---

    def test_seed_injected_into_r_config(self):
        """_run_stage1_via_r must write wgcna_seed into config_stage1_r.json."""
        from services import pipeline
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "input").mkdir()
            (run_dir / "stage1").mkdir()

            # Mock the subprocess to exit immediately with success
            mock_process = MagicMock()
            mock_process.stdout = iter([])  # empty output
            mock_process.wait.return_value = 0
            mock_process.pid = 99999

            # Create required output files so the function does not raise
            for fname in ["normalized_matrix.csv", "volcano_results.tsv",
                          "module_assignments.csv"]:
                (run_dir / "stage1" / fname).write_text("placeholder")
            (run_dir / "stage1" / "analysis_summary.json").write_text('{"wgcna_modules": 5}')

            with patch.object(pipeline, "_stage1_rscript_path", return_value=Path("/fake/stage1_parity.R")):
                with patch("subprocess.Popen", return_value=mock_process):
                    pipeline._run_stage1_via_r({}, run_dir, lambda msg: None)

            config_path = run_dir / "config_stage1_r.json"
            self.assertTrue(config_path.exists(), "config_stage1_r.json must be written")
            config_data = json.loads(config_path.read_text())
            self.assertIn("wgcna_seed", config_data)
            self.assertIsInstance(config_data["wgcna_seed"], int)
            self.assertGreater(config_data["wgcna_seed"], 0)
            self.assertLessEqual(config_data["wgcna_seed"], 1_000_000)

    def test_seed_preserved_when_already_in_config(self):
        """If config already has wgcna_seed, _run_stage1_via_r must not overwrite it."""
        from services import pipeline
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "input").mkdir()
            (run_dir / "stage1").mkdir()

            mock_process = MagicMock()
            mock_process.stdout = iter([])
            mock_process.wait.return_value = 0
            mock_process.pid = 99999

            for fname in ["normalized_matrix.csv", "volcano_results.tsv",
                          "module_assignments.csv"]:
                (run_dir / "stage1" / fname).write_text("placeholder")
            (run_dir / "stage1" / "analysis_summary.json").write_text('{"wgcna_modules": 5}')

            with patch.object(pipeline, "_stage1_rscript_path", return_value=Path("/fake/stage1_parity.R")):
                with patch("subprocess.Popen", return_value=mock_process):
                    pipeline._run_stage1_via_r({"wgcna_seed": 42}, run_dir, lambda msg: None)

            config_data = json.loads((run_dir / "config_stage1_r.json").read_text())
            self.assertEqual(config_data["wgcna_seed"], 42)

    # --- RPIP-08: Timeout kills process ---

    def test_timeout_raises_runtime_error(self):
        """A hanging R process must be killed after timeout and raise RuntimeError with '2-hour' message."""
        from services import pipeline
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "input").mkdir()
            (run_dir / "stage1").mkdir()

            # Mock a process that hangs: stdout blocks, wait() blocks
            mock_process = MagicMock()
            hang_event = threading.Event()

            def blocking_iter():
                # yield makes this a generator; hang_event simulates a blocking R process
                hang_event.wait(timeout=10)  # block until killed or test timeout
                return
                yield  # noqa: unreachable -- required to make function a generator

            # Use MagicMock for stdout so .close can be set freely
            mock_stdout = MagicMock()
            mock_stdout.__iter__ = MagicMock(side_effect=blocking_iter)
            mock_process.stdout = mock_stdout
            mock_process.wait.return_value = -9  # SIGKILL exit code
            mock_process.pid = 99999
            mock_process.start_new_session = True

            # Override STAGE1_R_TIMEOUT_SECONDS to 0.1s for fast test
            with patch.object(pipeline, "_stage1_rscript_path", return_value=Path("/fake/stage1_parity.R")):
                with patch("subprocess.Popen", return_value=mock_process):
                    with patch.object(pipeline, "STAGE1_R_TIMEOUT_SECONDS", 0.1):
                        with self.assertRaises(RuntimeError) as ctx:
                            pipeline._run_stage1_via_r({}, run_dir, lambda msg: None)
                        self.assertIn("2-hour", str(ctx.exception))

    # --- RPIP-05/06: Static validation of R script ---

    def test_stage1_parity_r_contains_set_seed(self):
        """stage1_parity.R must call set.seed() for WGCNA reproducibility (RPIP-06)."""
        r_script_path = ROOT / "backend" / "r_scripts" / "stage1_parity.R"
        self.assertTrue(r_script_path.exists(), "stage1_parity.R must exist")
        source = r_script_path.read_text()
        self.assertIn("set.seed", source,
                       "stage1_parity.R must call set.seed() for reproducibility (RPIP-06)")

    def test_stage1_parity_r_contains_signedKME(self):
        """stage1_parity.R must contain a signedKME() call to produce kME values."""
        r_script_path = ROOT / "backend" / "r_scripts" / "stage1_parity.R"
        self.assertTrue(r_script_path.exists(), "stage1_parity.R must exist")
        source = r_script_path.read_text()
        self.assertIn("signedKME", source,
                       "stage1_parity.R must call signedKME() to produce kME values (RPIP-05)")


class GoVizRTests(unittest.TestCase):
    """Native R GO heatmap visualization (Gap 2)."""

    def test_go_viz_runner_r_script_exists(self):
        """A go_viz_runner.R must be bundled in backend/r_scripts/."""
        script = ROOT / "backend" / "r_scripts" / "go_viz_runner.R"
        self.assertTrue(script.exists(), "backend/r_scripts/go_viz_runner.R must exist")

    def test_go_viz_rscript_path_returns_none_when_rscript_missing(self):
        """_go_viz_rscript_path() returns None when Rscript binary not in PATH."""
        from services import pipeline_stage2
        with patch("shutil.which", return_value=None):
            self.assertIsNone(pipeline_stage2._go_viz_rscript_path())

    def test_run_go_viz_via_r_raises_when_rscript_missing(self):
        """When R is unavailable, _run_go_viz_via_r raises a clear RuntimeError."""
        from services import pipeline_stage2
        with patch.object(pipeline_stage2, "_go_viz_rscript_path", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(RuntimeError) as ctx:
                    pipeline_stage2._run_go_viz_via_r(Path(tmp), {"deliverable_prefix": "X", "display_prefix": "X"}, lambda _line: None)
                self.assertIn("unavailable", str(ctx.exception).lower())

    def test_stage2_continues_when_go_viz_fails(self):
        """If GO viz subprocess fails, run_stage2 must NOT raise — matplotlib output stands.

        Stage 2 runs Python FET (source of truth) and then opportunistically
        invokes the native R viz. A viz failure is a soft fail: log it and move on.
        """
        from services import pipeline_stage2

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            stage2 = run_dir / "stage2"
            stage2.mkdir(parents=True)
            stage1 = run_dir / "stage1"
            stage1.mkdir()
            # Minimal module assignments so run_stage2 can do its thing
            (stage1 / "module_assignments.csv").write_text(
                "peptide_id,gene,module_color\nP1,APOE,blue\nP2,CLU,green\n", encoding="utf-8"
            )

            # Force the GO viz helper to raise — pipeline must catch
            with patch.object(pipeline_stage2, "_run_go_viz_via_r", side_effect=RuntimeError("R viz crashed")):
                # Should NOT raise even though viz failed
                pipeline_stage2.run_stage2({}, run_dir, lambda _line: None)

            # The Python FET output must still be there (or empty fallback per existing logic)
            self.assertTrue((stage2).exists())

    def test_run_go_viz_via_r_produces_html_and_pdf_when_r_available(self):
        """When R + go_viz_runner.R are available, _run_go_viz_via_r produces HTML and PDF
        in the deliverable GO directory."""
        import shutil as _shutil
        if _shutil.which("Rscript") is None:
            self.skipTest("Rscript not available in this environment")

        from services import pipeline_stage2
        from config import BASE_DIR

        if not (BASE_DIR / "r_scripts" / "go_viz_runner.R").exists():
            self.skipTest("go_viz_runner.R not yet bundled")

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            stage2 = run_dir / "stage2"
            stage2.mkdir(parents=True)
            # Realistic z-score matrix: terms × modules, with one strong + one weak
            (stage2 / "go_zscore_matrix.csv").write_text(
                "term,blue,green,red\n"
                "GO:positive_regulation_of_apoptosis,4.5,1.1,-0.2\n"
                "GO:synaptic_signaling,-1.2,3.8,0.5\n"
                "GO:complement_activation,2.1,-0.9,4.2\n"
                "GO:axon_guidance,0.4,2.7,-1.5\n"
                "GO:neuroinflammation,3.3,0.8,1.9\n",
                encoding="utf-8",
            )
            (stage2 / "go_enrichment_all.csv").write_text(
                "module,term,category,pvalue,fdr,zscore,hits,term_size,hit_genes\n"
                "blue,GO:positive_regulation_of_apoptosis,BP,0.0001,0.001,4.5,12,80,APOE;CLU\n",
                encoding="utf-8",
            )
            profile = {"deliverable_prefix": "TEST", "display_prefix": "TestPrefix"}

            pipeline_stage2._run_go_viz_via_r(run_dir, profile, lambda _line: None)

            go_dir = run_dir / "TestPrefix Go"
            self.assertTrue(go_dir.is_dir(), f"GO deliverable dir not created at {go_dir}")
            html_files = list(go_dir.glob("*.html"))
            pdf_files = list(go_dir.glob("*.pdf"))
            self.assertGreaterEqual(len(html_files), 1, "Native R GO heatmap HTML not produced")
            self.assertGreaterEqual(len(pdf_files), 1, "Native R GO heatmap PDF not produced")


class CellTypeVizRTests(unittest.TestCase):
    """Native R CellTypeFET heatmap visualization (Gap 3)."""

    def test_celltype_viz_runner_r_script_exists(self):
        script = ROOT / "backend" / "r_scripts" / "celltype_viz_runner.R"
        self.assertTrue(script.exists(), "backend/r_scripts/celltype_viz_runner.R must exist")

    def test_celltype_viz_rscript_path_returns_none_when_rscript_missing(self):
        from services import pipeline_stage3
        with patch("shutil.which", return_value=None):
            self.assertIsNone(pipeline_stage3._celltype_viz_rscript_path())

    def test_run_celltype_viz_via_r_raises_when_rscript_missing(self):
        from services import pipeline_stage3
        with patch.object(pipeline_stage3, "_celltype_viz_rscript_path", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(RuntimeError) as ctx:
                    pipeline_stage3._run_celltype_viz_via_r(
                        Path(tmp),
                        {"deliverable_prefix": "X", "display_prefix": "X", "input_level": "peptide"},
                        lambda _line: None,
                    )
                self.assertIn("unavailable", str(ctx.exception).lower())

    def test_stage3_continues_when_celltype_viz_fails(self):
        """Stage 3 must NOT raise when the native R viz fails — Python FET output stands."""
        from services import pipeline_stage3

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            stage1 = run_dir / "stage1"
            stage3 = run_dir / "stage3"
            stage1.mkdir(parents=True)
            stage3.mkdir(parents=True)
            # Module assignments missing → run_stage3 short-circuits to empty output, no R call.
            # Provide minimal assignments so Python FET runs at least the module pass.
            (stage1 / "module_assignments.csv").write_text(
                "peptide_id,gene,module_color\nP1,APOE,blue\nP2,CLU,green\n", encoding="utf-8"
            )
            with patch.object(pipeline_stage3, "_run_celltype_viz_via_r", side_effect=RuntimeError("R viz crashed")):
                # Should NOT raise even though viz failed
                pipeline_stage3.run_stage3({}, run_dir, lambda _line: None)
            self.assertTrue(stage3.exists())

    def test_run_celltype_viz_via_r_produces_html_and_pdf_when_r_available(self):
        import shutil as _shutil
        if _shutil.which("Rscript") is None:
            self.skipTest("Rscript not available in this environment")

        from services import pipeline_stage3
        from config import BASE_DIR

        if not (BASE_DIR / "r_scripts" / "celltype_viz_runner.R").exists():
            self.skipTest("celltype_viz_runner.R not yet bundled")

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            stage3 = run_dir / "stage3"
            stage3.mkdir(parents=True)
            # FDR matrix: rows = modules, columns = cell types, values = -log10(FDR)
            (stage3 / "celltype_FDR_matrix.csv").write_text(
                "module,Microglia,Astrocyte,Neuron,Oligo,Endothelial\n"
                "blue,4.5,0.3,0.1,1.2,0.5\n"
                "green,0.4,3.8,0.5,0.2,0.7\n"
                "red,1.1,0.9,4.2,0.4,0.3\n"
                "yellow,0.5,0.6,0.7,3.5,0.4\n",
                encoding="utf-8",
            )
            (stage3 / "celltype_heatmap_data.csv").write_text(
                "module,cell_type,pvalue,fdr,minus_log10_fdr\n"
                "blue,Microglia,0.0001,0.001,4.5\n"
                "green,Astrocyte,0.0001,0.001,3.8\n",
                encoding="utf-8",
            )
            profile = {
                "deliverable_prefix": "TEST",
                "display_prefix": "TestPrefix",
                "input_level": "peptide",
            }

            pipeline_stage3._run_celltype_viz_via_r(run_dir, profile, lambda _line: None)

            cell_dir = run_dir / "TestPrefix CellTypeFET"
            self.assertTrue(cell_dir.is_dir(), f"CellType deliverable dir not created at {cell_dir}")
            html_files = list(cell_dir.glob("*.html"))
            pdf_files = list(cell_dir.glob("*.pdf"))
            self.assertGreaterEqual(len(html_files), 1, "Native R CellType heatmap HTML not produced")
            self.assertGreaterEqual(len(pdf_files), 1, "Native R CellType heatmap PDF not produced")


class DeliverableParityIntegrationTests(unittest.TestCase):
    """All three parity gaps wired together against realistic synthetic stage outputs.

    Validates that after stage 2 + stage 3 run, the deliverable directory
    contains: (a) generic trait WGCNA subfolders for every continuous trait,
    (b) native R GO heatmap HTML+PDF, (c) native R CellType heatmap HTML+PDF.
    Acts as the loop's exit gate — if this passes the build is shippable."""

    def test_full_deliverable_parity_on_realistic_synthetic_run(self) -> None:
        import shutil as _shutil
        if _shutil.which("Rscript") is None:
            self.skipTest("Rscript required for native viz integration test")

        from services import pipeline_stage2, pipeline_stage3
        from services.deliverables import emit_trait_specific_wgcna_bundle
        from config import BASE_DIR

        if not (BASE_DIR / "r_scripts" / "go_viz_runner.R").exists():
            self.skipTest("go_viz_runner.R not bundled")
        if not (BASE_DIR / "r_scripts" / "celltype_viz_runner.R").exists():
            self.skipTest("celltype_viz_runner.R not bundled")

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            stage1 = run_dir / "stage1"
            stage2 = run_dir / "stage2"
            stage3 = run_dir / "stage3"
            input_dir = run_dir / "input"
            network_dir = run_dir / "05_network_CBN_median"
            for d in (stage1, stage2, stage3, input_dir, network_dir):
                d.mkdir(parents=True)

            # Pipeline profile (what write_pipeline_profile would write)
            (run_dir / "pipeline_profile.json").write_text(json.dumps({
                "deliverable_prefix": "TEST",
                "display_prefix": "TestRun",
                "go_label": "TEST",
                "input_level": "peptide",
                "normalization_tag": "CBN_median",
            }))

            # Realistic stage 1 outputs — module_trait_cor.csv mixes AD-pattern
            # traits AND novel traits to verify both code paths in one shot.
            (stage1 / "module_trait_cor.csv").write_text(
                "module_color,cor_t-tau,p_t-tau,cor_BMI,p_BMI,cor_age,p_age\n"
                "MEblue,0.62,0.001,0.41,0.008,-0.31,0.05\n"
                "MEgreen,-0.45,0.003,-0.22,0.18,0.55,0.001\n"
                "MEred,0.51,0.002,0.18,0.30,-0.42,0.01\n",
                encoding="utf-8",
            )
            (stage1 / "module_eigengenes.csv").write_text(
                "sample_name,group,MEblue,MEgreen,MEred\n"
                "S1,Control,0.10,-0.20,0.15\n"
                "S2,Control,0.12,-0.18,0.18\n"
                "S3,Control,0.08,-0.22,0.13\n"
                "S4,Disease,0.45,-0.50,0.42\n"
                "S5,Disease,0.52,-0.55,0.48\n"
                "S6,Disease,0.48,-0.52,0.45\n",
                encoding="utf-8",
            )
            (input_dir / "traits.csv").write_text(
                "SAMPLE_ID,GROUP,t-tau,BMI,age\n"
                "S1,Control,200,22.1,25\n"
                "S2,Control,220,24.5,28\n"
                "S3,Control,210,23.0,26\n"
                "S4,Disease,700,28.4,72\n"
                "S5,Disease,760,29.1,75\n"
                "S6,Disease,720,28.8,73\n",
                encoding="utf-8",
            )
            (stage1 / "module_assignments.csv").write_text(
                "peptide_id,gene,module_color\n"
                "P1,APOE,blue\nP2,CLU,blue\nP3,C3,blue\n"
                "P4,GFAP,green\nP5,VIM,green\n"
                "P6,SYP,red\nP7,SNAP25,red\n",
                encoding="utf-8",
            )
            for name in [
                "TEST_WGCNA_01_Sample_Clustering_QC.pdf",
                "TEST_WGCNA_02_Power_Selection.pdf",
                "TEST_WGCNA_03_Network_Dendrograms.pdf",
                "TEST_WGCNA_04_Module_Trait_Correlations.pdf",
                "TEST_WGCNA_05_Module_Response_Plots.pdf",
            ]:
                (network_dir / name).write_bytes(b"%PDF-1.4\n")
            (network_dir / "TEST_WGCNA_Module_Assignments_with_kME.csv").write_text(
                "peptide_id,gene,module_color,kME\nP1,APOE,blue,0.9\n", encoding="utf-8"
            )
            (network_dir / "TEST_WGCNA_Module_Eigengenes.csv").write_text(
                "sample_name,MEblue\nS1,0.1\n", encoding="utf-8"
            )

            # Realistic stage 2 z-score matrix (terms × modules)
            (stage2 / "go_zscore_matrix.csv").write_text(
                "term,blue,green,red\n"
                "GO:positive_regulation_of_apoptosis,4.5,1.1,-0.2\n"
                "GO:synaptic_signaling,-1.2,3.8,4.2\n"
                "GO:complement_activation,3.7,-0.9,0.5\n"
                "GO:axon_guidance,0.4,2.7,3.9\n"
                "GO:neuroinflammation,3.3,0.8,1.9\n",
                encoding="utf-8",
            )
            (stage2 / "go_enrichment_all.csv").write_text(
                "module,term,category,pvalue,fdr,zscore,hits,term_size,hit_genes\n"
                "blue,GO:positive_regulation_of_apoptosis,BP,0.0001,0.001,4.5,12,80,APOE;CLU\n"
                "green,GO:synaptic_signaling,BP,0.0002,0.002,3.8,9,60,SYP\n",
                encoding="utf-8",
            )

            # Realistic stage 3 cell-type FDR matrix (modules × cell types)
            (stage3 / "celltype_FDR_matrix.csv").write_text(
                "module,Microglia,Astrocyte,Neuron,Oligo,Endothelial\n"
                "blue,4.5,0.3,0.1,1.2,0.5\n"
                "green,0.4,3.8,0.5,0.2,0.7\n"
                "red,0.5,0.6,4.2,0.4,0.3\n",
                encoding="utf-8",
            )
            (stage3 / "celltype_heatmap_data.csv").write_text(
                "module,cell_type,pvalue,fdr,minus_log10_fdr\n"
                "blue,Microglia,0.0001,0.001,4.5\n",
                encoding="utf-8",
            )

            profile = {
                "deliverable_prefix": "TEST",
                "display_prefix": "TestRun",
                "go_label": "TEST",
                "input_level": "peptide",
                "normalization_tag": "CBN_median",
            }

            logs: list[str] = []
            log_fn = logs.append

            # GAP 1 — generic trait subfolders
            emit_trait_specific_wgcna_bundle(run_dir, profile, log_fn)

            # GAP 2 — native R GO viz
            pipeline_stage2._run_go_viz_via_r(run_dir, profile, log_fn)

            # GAP 3 — native R CellType viz
            pipeline_stage3._run_celltype_viz_via_r(run_dir, profile, log_fn)

            # ── ASSERTIONS ─────────────────────────────────────────────────

            # GAP 1: AD bucket folder for t-tau + generic folders for BMI/age
            self.assertTrue((network_dir / "total_tau").is_dir(),
                            "AD-bucket total_tau/ missing")
            self.assertTrue((network_dir / "bmi").is_dir(),
                            "Generic bmi/ subfolder missing")
            self.assertTrue((network_dir / "age").is_dir(),
                            "Generic age/ subfolder missing")
            self.assertTrue((network_dir / "all_traits_comprehensive").is_dir(),
                            "all_traits_comprehensive/ missing")
            self.assertFalse((network_dir / "ad_pathology_composite").is_dir(),
                             "ad_pathology_composite/ should be skipped (only 1 AD-bucket trait)")

            # Per-trait deliverable trio
            for slug, trait in [("total_tau", "Total_Tau"), ("bmi", "BMI"), ("age", "Age")]:
                trait_dir = network_dir / slug
                self.assertTrue(
                    any(p.name.startswith("TEST_WGCNA_04_") and p.name.endswith("_Correlations.pdf") for p in trait_dir.iterdir()),
                    f"{slug}/: correlation heatmap PDF missing",
                )
                self.assertTrue(
                    any(p.name.startswith("TEST_WGCNA_05_") and p.name.endswith("_Response_Plots.pdf") for p in trait_dir.iterdir()),
                    f"{slug}/: response plots PDF missing",
                )
                self.assertTrue(
                    any(p.name.endswith("_Associated_Modules.csv") for p in trait_dir.iterdir()),
                    f"{slug}/: Associated_Modules CSV missing",
                )

            # GAP 2: native R GO viz outputs
            go_dir = run_dir / "TestRun Go"
            self.assertTrue(go_dir.is_dir(), "GO deliverable dir not created")
            self.assertTrue(
                (go_dir / "TEST_GO_Interactive_Heatmap.html").exists(),
                "Native R GO interactive HTML missing",
            )
            self.assertTrue(
                (go_dir / "GSA-GO-FET_TEST_Proteomics_GO-redundancyRemoved.Kbest.pdf").exists(),
                "Native R GO heatmap PDF missing",
            )

            # GAP 3: native R CellType viz outputs
            cell_dir = run_dir / "TestRun CellTypeFET"
            self.assertTrue(cell_dir.is_dir(), "CellType deliverable dir not created")
            self.assertTrue(
                (cell_dir / "TEST_CellTypeFET_Interactive_Heatmap.html").exists(),
                "Native R CellType interactive HTML missing",
            )
            self.assertTrue(
                (cell_dir / "TEST_Peptides_CellTypeFET.Overlap.pdf").exists(),
                "Native R CellType overlap PDF missing",
            )


if __name__ == "__main__":
    unittest.main()
