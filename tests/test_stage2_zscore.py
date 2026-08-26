"""
Phase 3 GO Scientific Parity — test scaffold for GOSA-01 and GOSA-02.

Tests are intentionally written RED (before the production fix) so they fail
against the current pipeline code and pass after Plan 02 applies the fix.

GOSA-01: Piano-style signed FET z-scores (positive = over-represented,
         negative = under-represented) instead of row-standardised -log10(FDR).
GOSA-02: Global BH FDR correction (across all modules × terms) instead of
         per-module correction.
"""

import csv
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Clear cached modules so pipeline re-imports cleanly
for _mod in list(sys.modules):
    if _mod in {"config", "database", "deps"} or _mod.startswith("services") or _mod.startswith("routes"):
        sys.modules.pop(_mod, None)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _make_synthetic_gmt(gmt_path: Path) -> None:
    """Write a 3-term GMT file to gmt_path.

    Term layout:
      PATHWAY_ALPHA  (category BP) — 5 genes overlapping heavily with module "blue"
      PATHWAY_BETA   (category MF) — 5 genes overlapping heavily with module "brown"
      PATHWAY_GAMMA  (category CC) — 5 genes; minimal overlap with either module

    GMT format per line:
      TERMNAME%CATEGORY%CATEGORY\\tna\\tGENE1\\tGENE2\\t...
    The %GOBP%GOBP suffix makes _load_gmt classify the term as BP because
    'gobp' appears in the lower-cased raw name.
    """
    lines = [
        "PATHWAY_ALPHA%GOBP%GOBP\tna\tGENE_A\tGENE_B\tGENE_C\tGENE_D\tGENE_E\n",
        "PATHWAY_BETA%GOMF%GOMF\tna\tGENE_F\tGENE_G\tGENE_H\tGENE_I\tGENE_J\n",
        "PATHWAY_GAMMA%GOCC%GOCC\tna\tGENE_K\tGENE_L\tGENE_M\tGENE_N\tGENE_O\n",
    ]
    gmt_path.write_text("".join(lines))


def _make_synthetic_modules(run_dir: Path) -> None:
    """Create run_dir/stage1/module_assignments.csv with two non-grey modules.

    Module "blue":  6 genes — 4 overlap with PATHWAY_ALPHA -> strong BP enrichment
    Module "brown": 6 genes — 4 overlap with PATHWAY_BETA  -> strong MF enrichment
    Module "grey":  2 genes — excluded by run_stage2 (grey is always skipped)
    """
    stage1_dir = run_dir / "stage1"
    stage1_dir.mkdir(parents=True, exist_ok=True)

    rows = [
        ("GENE_A", "blue"),
        ("GENE_B", "blue"),
        ("GENE_C", "blue"),
        ("GENE_D", "blue"),
        ("GENE_P", "blue"),
        ("GENE_Q", "blue"),
        ("GENE_F", "brown"),
        ("GENE_G", "brown"),
        ("GENE_H", "brown"),
        ("GENE_I", "brown"),
        ("GENE_R", "brown"),
        ("GENE_S", "brown"),
        ("GENE_T", "grey"),
        ("GENE_U", "grey"),
    ]

    assignments_path = stage1_dir / "module_assignments.csv"
    with open(assignments_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["gene", "module_color"])
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------

class Stage2ZscoreTests(unittest.TestCase):
    """Unit and integration tests for GOSA-01 (piano z-scores) and GOSA-02 (global FDR)."""

    # ------------------------------------------------------------------
    # GOSA-01 unit: test_piano_zscore_enriched
    # ------------------------------------------------------------------

    def test_piano_zscore_enriched(self):
        """Over-represented term (p_enrich << p_deplete) must yield a positive z-score.

        Piano formula:
            sign = +1 when p_enrich < p_deplete
            mag  = norm.isf(p_enrich / 2)
            z    = sign * mag
        """
        from scipy.stats import norm

        p_enrich = 0.001
        p_deplete = 0.999

        sign = 1 if p_enrich < p_deplete else -1
        mag = norm.isf(p_enrich / 2)
        expected_z = sign * mag

        self.assertGreater(expected_z, 0,
                           msg="Over-represented term must produce a positive piano z-score")
        self.assertAlmostEqual(expected_z, norm.isf(0.001 / 2) * 1, places=6,
                               msg="z-score magnitude must equal norm.isf(p_enrich/2)")

    # ------------------------------------------------------------------
    # GOSA-01 unit: test_piano_zscore_depleted
    # ------------------------------------------------------------------

    def test_piano_zscore_depleted(self):
        """Under-represented term (p_deplete << p_enrich) must yield a negative z-score.

        Piano formula:
            sign = -1 when p_deplete < p_enrich
            mag  = norm.isf(p_deplete / 2)
            z    = sign * mag
        """
        from scipy.stats import norm

        p_enrich = 0.999
        p_deplete = 0.001

        sign = 1 if p_enrich < p_deplete else -1
        mag = norm.isf(p_deplete / 2)
        expected_z = sign * mag

        self.assertLess(expected_z, 0,
                        msg="Under-represented term must produce a negative piano z-score")

    # ------------------------------------------------------------------
    # GOSA-01 integration: test_run_stage2_signed_zscores
    # ------------------------------------------------------------------

    def test_run_stage2_signed_zscores(self):
        """With a SINGLE module, run_stage2 must produce a go_zscore_matrix.csv
        containing non-zero z-scores for enriched terms.

        Row-standardisation of a 1-column matrix always yields 0 (mean == the
        single value; std == 0).  Piano signed FET z-scores are independent of
        the number of modules and must be non-zero for a term with p_enrich << 0.5.

        This test is expected to FAIL against the pre-fix code because the current
        implementation applies row-standardisation (producing all zeros) rather
        than piano signed z-scores.

        Setup: one non-grey module ("blue") with strong overlap with PATHWAY_ALPHA.
        The z-score matrix will have exactly one column ("blue"). Any non-zero
        entry proves piano z-scores were used; all-zero entries prove the old
        row-standardisation is still in place.
        """
        import csv as _csv
        import pandas as pd
        from services import pipeline

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)

            # Single-module setup: "blue" (6 genes) + 14 "grey" background genes.
            # Grey genes are included in the universe (N=20) but excluded from
            # module analysis. PATHWAY_ALPHA overlaps 4/6 blue genes and 1 grey
            # gene (GENE_E), giving a non-degenerate FET contingency table:
            #   a=4 (overlap), b=2 (blue \ term), c=1 (term \ blue), d=13 (other)
            # => p-value ~0.014, well below fdr_threshold=0.05.
            stage1_dir = run_dir / "stage1"
            stage1_dir.mkdir(parents=True, exist_ok=True)
            single_module_rows = [
                ("GENE_A", "blue"),
                ("GENE_B", "blue"),
                ("GENE_C", "blue"),
                ("GENE_D", "blue"),
                ("GENE_P", "blue"),
                ("GENE_Q", "blue"),
                # Background (grey) — universe expanders, not analysed as a module
                ("GENE_E", "grey"),   # 1 PATHWAY_ALPHA gene outside blue
                ("GENE_F", "grey"),
                ("GENE_G", "grey"),
                ("GENE_H", "grey"),
                ("GENE_I", "grey"),
                ("GENE_J", "grey"),
                ("GENE_K", "grey"),
                ("GENE_L", "grey"),
                ("GENE_M", "grey"),
                ("GENE_N", "grey"),
                ("GENE_O", "grey"),
                ("GENE_R", "grey"),
                ("GENE_S", "grey"),
                ("GENE_T", "grey"),
            ]
            assignments_path = stage1_dir / "module_assignments.csv"
            with open(assignments_path, "w", newline="") as fh:
                writer = _csv.writer(fh)
                writer.writerow(["gene", "module_color"])
                writer.writerows(single_module_rows)

            gmt_path = run_dir / "test_terms.gmt"
            _make_synthetic_gmt(gmt_path)

            config = {
                "fdr_threshold": 0.05,         # PATHWAY_ALPHA p~0.014 is significant
                "go_categories": ["BP", "MF", "CC"],
                "min_hits_per_ontology": 3,
                "gmt_file": str(gmt_path),
            }

            pipeline.run_stage2(config, run_dir, lambda msg: None)

            zscore_csv = run_dir / "stage2" / "go_zscore_matrix.csv"
            self.assertTrue(zscore_csv.exists(),
                            msg="go_zscore_matrix.csv must be written by run_stage2")

            df = pd.read_csv(zscore_csv, index_col=0)
            self.assertGreater(df.size, 0,
                               msg="go_zscore_matrix.csv must contain data rows")

            values = df.values.astype(float)

            # With a single column, row-standardisation always produces 0.
            # Piano z-scores for the enriched term (PATHWAY ALPHA overlaps 4/6 blue
            # genes) must be non-zero (> 0 for over-represented).
            self.assertTrue(
                (values != 0).any(),
                msg=(
                    "go_zscore_matrix.csv must contain non-zero z-scores for a "
                    "single-module run (row-standardisation of a 1-column matrix "
                    "always yields 0; piano signed FET z-scores must be non-zero)"
                ),
            )

    # ------------------------------------------------------------------
    # GOSA-01 smoke: test_no_row_standardization
    # ------------------------------------------------------------------

    def test_no_row_standardization(self):
        """The old row-standardisation variables must not exist in run_stage2 source.

        Checks that the following identifiers are absent from run_stage2's source:
          - ml_mean   (mean of -log10(FDR) per row)
          - ml_std    (std of -log10(FDR) per row)
          - ml =      (assignment to the -log10(FDR) matrix variable)

        This test will FAIL against the pre-fix code (which still contains all three).
        """
        from services import pipeline

        source = inspect.getsource(pipeline.run_stage2)

        self.assertNotIn("ml_mean", source,
                         msg="ml_mean (row-standardisation mean) must be removed from run_stage2")
        self.assertNotIn("ml_std", source,
                         msg="ml_std (row-standardisation std) must be removed from run_stage2")
        self.assertNotIn("ml =", source,
                         msg="'ml =' variable assignment must be removed from run_stage2")

    # ------------------------------------------------------------------
    # GOSA-02 unit: test_global_fdr_more_conservative
    # ------------------------------------------------------------------

    def test_global_fdr_more_conservative(self):
        """Global BH FDR correction is more conservative than per-module correction.

        Create 2 modules with 5 tests each (10 total). Running multipletests on
        each module separately (per-module) produces lower adjusted p-values than
        running multipletests on all 10 combined (global).

        At least one test in the combined correction must have a higher adjusted
        p-value than it had under the per-module correction.
        """
        from statsmodels.stats.multitest import multipletests

        # p-values for module A (5 tests) and module B (5 tests)
        pvals_a = [0.001, 0.005, 0.01, 0.04, 0.08]
        pvals_b = [0.002, 0.007, 0.015, 0.03, 0.09]

        # Per-module BH correction (each set of 5 corrected independently)
        _, adj_a_per, _, _ = multipletests(pvals_a, method="fdr_bh")
        _, adj_b_per, _, _ = multipletests(pvals_b, method="fdr_bh")

        # Global BH correction (all 10 p-values corrected together)
        all_pvals = pvals_a + pvals_b
        _, adj_all_global, _, _ = multipletests(all_pvals, method="fdr_bh")
        adj_a_global = adj_all_global[:5]
        adj_b_global = adj_all_global[5:]

        # At least one test must have a higher (more conservative) FDR globally
        any_more_conservative = any(
            g > p for g, p in zip(list(adj_a_global) + list(adj_b_global),
                                  list(adj_a_per) + list(adj_b_per))
        )
        self.assertTrue(any_more_conservative,
                        msg="Global BH FDR must be more conservative (higher) than "
                            "per-module BH FDR for at least one test")

    # ------------------------------------------------------------------
    # GOSA-02 integration: test_run_stage2_global_fdr
    # ------------------------------------------------------------------

    def test_run_stage2_global_fdr(self):
        """After run_stage2, go_enrichment_all.csv must have a 'zscore' column,
        all 'fdr' values must be in [0, 1], and go_summary.json must record
        the piano z-score method and global FDR scope.

        Expected to FAIL against the pre-fix code because:
          - 'zscore' column is not added by the current implementation
          - go_summary.json does not contain 'zscore_method' or 'fdr_scope'
        """
        import pandas as pd
        from services import pipeline

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            _make_synthetic_modules(run_dir)

            gmt_path = run_dir / "test_terms.gmt"
            _make_synthetic_gmt(gmt_path)

            config = {
                "fdr_threshold": 1.0,
                "go_categories": ["BP", "MF", "CC"],
                "min_hits_per_ontology": 3,
                "gmt_file": str(gmt_path),
            }

            pipeline.run_stage2(config, run_dir, lambda msg: None)

            # --- go_enrichment_all.csv assertions ---
            enrichment_csv = run_dir / "stage2" / "go_enrichment_all.csv"
            self.assertTrue(enrichment_csv.exists(),
                            msg="go_enrichment_all.csv must be written by run_stage2")

            enrich_df = pd.read_csv(enrichment_csv)

            self.assertIn("zscore", enrich_df.columns,
                          msg="go_enrichment_all.csv must have a 'zscore' column "
                              "(added by piano z-score implementation)")

            self.assertIn("fdr", enrich_df.columns,
                          msg="go_enrichment_all.csv must have a 'fdr' column")

            fdr_values = enrich_df["fdr"].dropna().values
            if len(fdr_values) > 0:
                self.assertTrue((fdr_values >= 0).all() and (fdr_values <= 1).all(),
                                msg="All fdr values must be in the range [0, 1]")

            # --- go_summary.json assertions ---
            summary_json = run_dir / "stage2" / "go_summary.json"
            self.assertTrue(summary_json.exists(),
                            msg="go_summary.json must be written by run_stage2")

            summary = json.loads(summary_json.read_text())

            self.assertIn("zscore_method", summary,
                          msg="go_summary.json must contain 'zscore_method' key")
            self.assertEqual(summary.get("zscore_method"), "piano_signed_fet",
                             msg="zscore_method must be 'piano_signed_fet'")

            self.assertIn("fdr_scope", summary,
                          msg="go_summary.json must contain 'fdr_scope' key")
            self.assertEqual(summary.get("fdr_scope"), "global",
                             msg="fdr_scope must be 'global'")


if __name__ == "__main__":
    unittest.main()
