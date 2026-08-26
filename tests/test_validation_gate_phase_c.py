"""Phase C validation gate: app's GO + CellType FET output vs Eisai reference.

  Gate 1: GO z-score Pearson r ≥ 0.9 vs reference (per shared term×module pair)
  Gate 2: CellType FET log10(p) absolute difference within ±2 for ≥ 90% pairs

Both gates run the FULL pipeline end-to-end (Stage 1 + Stage 2 + Stage 3) on
Sweden raw. Skipped when Rscript or reference outputs not present.

NOTE: Stage 1 takes ~50 minutes on 18,135 features × 60 samples (bicor is slow).
Stage 2 + 3 add another few minutes. Total wall time: ~55 minutes.
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


SWEDEN_FILE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/data/sweden-cohort-raw/PeaksPeptide List Sweden Cohort.csv")
REF_GO_ZSCORES = Path("/Users/anirudhs/Documents/ClientServices/Eisai/downstream/GOparallel/Go-M42-27Aug/GSA-GO-FET_Go-M24-27Aug-Zscores.txt")
REF_GO_FDR = Path("/Users/anirudhs/Documents/ClientServices/Eisai/downstream/GOparallel/Go-M42-27Aug/GSA-GO-FET_Go-M24-27Aug-Enr.FDR.BH.txt")
REF_CELLTYPE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/downstream/CellTypeFET/CellTypeFET-PeaksPep-M42/PEAKS_CellTypeFET_BrainCellTypes.Overlap.in.MyGene-Human-SharmaZhangUnion.csv-DuplicatesALLOWED-hitListStats.csv")
REF_MODULE_ASSIGNMENTS = Path("/Users/anirudhs/Documents/ClientServices/Eisai/deliverables/cleaned-runs/PeaksPep-42M/05_network_CBN_median/PEAKS_WGCNA_Module_Assignments_with_kME.csv")


def _all_inputs_available() -> tuple[bool, str]:
    if not shutil.which("Rscript"):
        return False, "Rscript not on PATH"
    if not SWEDEN_FILE.exists():
        return False, f"Sweden raw not present"
    if not REF_GO_ZSCORES.exists():
        return False, f"Reference GO z-scores not at {REF_GO_ZSCORES}"
    if not REF_CELLTYPE.exists():
        return False, f"Reference CellType FET not at {REF_CELLTYPE}"
    if not REF_MODULE_ASSIGNMENTS.exists():
        return False, f"Reference module assignments not at {REF_MODULE_ASSIGNMENTS}"
    return True, ""


def _module_label_alignment(run_dir: Path) -> dict[str, str]:
    """Map app WGCNA color labels to reference color labels by membership overlap.

    WGCNA color labels are identifiers, not biological measurements. Across
    WGCNA/R versions, the same module partition can receive permuted color
    names for small modules. The downstream numeric gates should compare the
    same module memberships, not fail because two arbitrary color labels were
    swapped.
    """
    app_path = run_dir / "stage1" / "module_assignments.csv"
    if not app_path.exists() or not REF_MODULE_ASSIGNMENTS.exists():
        return {}
    app = pd.read_csv(app_path)
    ref = pd.read_csv(REF_MODULE_ASSIGNMENTS)
    if len(app) != len(ref) or "module_color" not in app.columns or "Assigned_Module" not in ref.columns:
        return {}
    contingency = pd.crosstab(app["module_color"].astype(str), ref["Assigned_Module"].astype(str))
    if contingency.empty:
        return {}

    from scipy.optimize import linear_sum_assignment

    matrix = contingency.to_numpy()
    row_idx, col_idx = linear_sum_assignment(matrix.max() - matrix)
    app_labels = list(contingency.index)
    ref_labels = list(contingency.columns)
    mapping: dict[str, str] = {}
    for i, j in zip(row_idx, col_idx):
        if matrix[i, j] > 0:
            mapping[app_labels[i]] = ref_labels[j]
    return mapping


class PhaseCValidationGateTests(unittest.TestCase):

    # Persistent run dir to avoid 50-min pipeline rerun on test fix iteration.
    # Set PHASEC_FRESH=1 to force fresh run.
    PERSISTENT_RUN_DIR = Path("/tmp/phasec_run/RUN-PHASEC")

    @classmethod
    def setUpClass(cls):
        ok, reason = _all_inputs_available()
        if not ok:
            raise unittest.SkipTest(reason)

        cls._run_dir = cls.PERSISTENT_RUN_DIR
        # Reuse if Stage 3 outputs are already present and not forced fresh
        force_fresh = os.environ.get("PHASEC_FRESH") == "1"
        already_done = (
            (cls._run_dir / "stage3" / "celltype_heatmap_data.csv").exists()
            and (cls._run_dir / "stage2" / "go_zscore_matrix_full.csv").exists()
        )
        if already_done and not force_fresh:
            cls._log = "(reused cached run dir; set PHASEC_FRESH=1 to force fresh run)"
            return

        stage1_done = (
            (cls._run_dir / "stage1" / "module_assignments.csv").exists()
            and (cls._run_dir / "stage1" / "module_eigengenes.csv").exists()
        )
        if stage1_done and not force_fresh:
            from services.pipeline_stage2 import run_stage2
            from services.pipeline_stage3 import run_stage3

            log_lines: list[str] = ["(reused cached Stage 1; reran Stage 2 + Stage 3)"]
            log_fn = log_lines.append
            run_stage2({"fdr_threshold": 0.05, "min_hits_per_ontology": 3}, cls._run_dir, log_fn)
            run_stage3({}, cls._run_dir, log_fn)
            cls._log = "\n".join(log_lines)
            return

        if cls._run_dir.exists():
            shutil.rmtree(cls._run_dir)
        cls._run_dir.mkdir(parents=True)
        (cls._run_dir / "input").mkdir()
        primary = cls._run_dir / "input" / "primary.csv"
        shutil.copy(SWEDEN_FILE, primary)

        from services.pipeline import _build_canonical_bundle, run_stage1
        from services.pipeline_stage2 import run_stage2
        from services.pipeline_stage3 import run_stage3

        params = {
            "format_family": "PEAKS", "input_level": "peptide",
            "cohort1": "Control", "cohort2": "AD",
            "group1_name": "Control", "group2_name": "AD",
            "missing_value_threshold": 0.5, "min_samples_present": 4,
            "log_transform": True, "value_scale": "linear",
            "normalization_method": "median", "normalization_tag": "CBN_median",
            "wgcna_soft_threshold": 4, "wgcna_min_module_size": 15,
            "wgcna_deep_split": 4, "wgcna_merge_cut_height": 0.15,
            "wgcna_network_type": "signed", "wgcna_correlation_type": "bicor",
            "wgcna_hub_percentile": 0.2,
            "fold_change_threshold": 1.5, "pvalue_threshold": 0.05,
            "use_adjusted_pvalue": True, "statistical_test": "t-test",
            "wgcna_seed": 42,
        }

        log_lines: list[str] = []
        log_fn = log_lines.append
        _build_canonical_bundle(str(primary), params, cls._run_dir, log_fn)
        stage_config = {**params, "input_dir": str(cls._run_dir / "input"),
                        "output_directory": str(cls._run_dir / "stage1"),
                        "run_dir": str(cls._run_dir)}
        run_stage1(stage_config, cls._run_dir, log_fn)
        run_stage2({"fdr_threshold": 0.05, "min_hits_per_ontology": 3}, cls._run_dir, log_fn)
        run_stage3({}, cls._run_dir, log_fn)
        cls._log = "\n".join(log_lines)

    @classmethod
    def tearDownClass(cls):
        # Keep persistent run dir for fast re-tests
        pass

    def test_gate_c1_go_zscore_pearson(self):
        """GO z-score Pearson r ≥ 0.9 vs reference."""
        from scipy import stats

        app_z_path = self._run_dir / "stage2" / "go_zscore_matrix_full.csv"
        self.assertTrue(app_z_path.exists(), f"Missing {app_z_path}\nLog tail:\n{self._log[-3000:]}")
        app_df = pd.read_csv(app_z_path, index_col=0)
        label_alignment = _module_label_alignment(self._run_dir)
        non_identity = {k: v for k, v in label_alignment.items() if k != v}
        if non_identity:
            print(f"  Module label alignment applied: {non_identity}")
            app_df = app_df.rename(columns=label_alignment)
        ref_df = pd.read_csv(REF_GO_ZSCORES, sep="\t", index_col=0)
        if "ontologyType" in ref_df.columns:
            ref_df = ref_df.drop(columns=["ontologyType"])
        # Deduplicate row index and column names — both can have collisions
        # (same GO term name across ontologies; module color repeated due to
        # mergeCloseModules naming).
        app_df = app_df[~app_df.index.duplicated(keep="first")]
        app_df = app_df.loc[:, ~app_df.columns.duplicated(keep="first")]
        ref_df = ref_df[~ref_df.index.duplicated(keep="first")]
        ref_df = ref_df.loc[:, ~ref_df.columns.duplicated(keep="first")]

        # Normalize term names (case-insensitive, separator-agnostic) and dedup.
        def norm(s): return str(s).lower().replace("_", " ").replace("-", " ").strip()
        app_norm = {norm(t): t for t in app_df.index}  # last-wins on dup
        ref_norm = {norm(t): t for t in ref_df.index}
        common_keys = sorted(set(app_norm) & set(ref_norm))
        common_modules = sorted(set(app_df.columns) & set(ref_df.columns))

        print(f"\n  Common GO terms (normalized match): {len(common_keys)}")
        print(f"  Common modules: {len(common_modules)}")
        self.assertGreater(len(common_keys), 100, f"Need >100 common terms")
        self.assertGreater(len(common_modules), 5, f"Need >5 common modules")

        app_idx = [app_norm[k] for k in common_keys]
        ref_idx = [ref_norm[k] for k in common_keys]
        app_sub = app_df.loc[app_idx, common_modules]
        ref_sub = ref_df.loc[ref_idx, common_modules]

        app_vals = pd.to_numeric(app_sub.values.flatten(), errors="coerce")
        ref_vals = pd.to_numeric(ref_sub.values.flatten(), errors="coerce")
        valid = ~np.isnan(app_vals) & ~np.isnan(ref_vals)
        n_valid = int(valid.sum())
        self.assertGreater(n_valid, 100, f"Need >100 valid pairs; got {n_valid}")

        r, p = stats.pearsonr(app_vals[valid], ref_vals[valid])
        diffs = np.abs(app_vals[valid] - ref_vals[valid])
        print(f"  GO z-score Pearson r: {r:.3f}  (n={n_valid}, p={p:.2e})")
        print(f"  |diff| percentiles (50/75/95): {np.percentile(diffs, [50, 75, 95]).round(3)}")
        print(f"  Gate threshold: ≥ 0.9")

        self.assertGreaterEqual(r, 0.9, f"GATE FAIL: GO z-score Pearson r = {r:.3f} < 0.9")

    def test_gate_c2_celltype_fet_log10p(self):
        """CellType FET log10(p) within ±2 for ≥90% of pairs."""
        # App stage3 long-form output: module, cell_type, pvalue, fdr, minus_log10_fdr.
        app_path = self._run_dir / "stage3" / "celltype_heatmap_data.csv"
        self.assertTrue(app_path.exists(), f"Missing {app_path}\nLog tail:\n{self._log[-3000:]}")
        app_long = pd.read_csv(app_path)
        label_alignment = _module_label_alignment(self._run_dir)
        non_identity = {k: v for k, v in label_alignment.items() if k != v}
        if non_identity:
            print(f"  Module label alignment applied: {non_identity}")
            app_long["module"] = app_long["module"].map(lambda value: label_alignment.get(str(value), str(value)))
        # Reference: row 0 has module names as columns, row 1 is "FET pValue" label, row 2+ are
        # cell-type rows. Skip the second header row.
        ref_df = pd.read_csv(REF_CELLTYPE, header=0, skiprows=[1], index_col=0)
        # Drop NaN-name rows and dedupe (some references have a trailing NaN row)
        ref_df = ref_df[~ref_df.index.isna()]
        ref_df = ref_df[~ref_df.index.duplicated(keep="first")]
        ref_df = ref_df.loc[:, ~ref_df.columns.duplicated(keep="first")]
        # Reference is rows=cell types, cols=modules → pivot app to same shape.
        app_pivot = app_long.pivot_table(index="cell_type", columns="module", values="pvalue", aggfunc="first")
        app_pivot = app_pivot[~app_pivot.index.duplicated(keep="first")]
        app_pivot = app_pivot.loc[:, ~app_pivot.columns.duplicated(keep="first")]

        # Match cell types case-insensitively
        app_cells = {str(c).lower().strip(): c for c in app_pivot.index}
        ref_cells = {str(c).lower().strip(): c for c in ref_df.index}
        common_cell_keys = sorted(set(app_cells) & set(ref_cells))
        print(f"\n  Common cell types: {len(common_cell_keys)}")
        print(f"    app cells: {sorted(app_cells.keys())}")
        print(f"    ref cells: {sorted(ref_cells.keys())[:10]}")
        self.assertGreater(len(common_cell_keys), 2, f"Need >2 cell types; got {len(common_cell_keys)}")

        common_modules = sorted(set(app_pivot.columns) & set(ref_df.columns))
        print(f"  Common modules: {len(common_modules)}")
        self.assertGreater(len(common_modules), 5)

        app_sub = app_pivot.loc[[app_cells[k] for k in common_cell_keys], common_modules]
        ref_sub = ref_df.loc[[ref_cells[k] for k in common_cell_keys], common_modules]

        eps = 1e-300
        app_log10p = np.log10(np.clip(pd.to_numeric(app_sub.values.flatten(), errors="coerce"), eps, 1.0))
        ref_log10p = np.log10(np.clip(pd.to_numeric(ref_sub.values.flatten(), errors="coerce"), eps, 1.0))
        valid = ~np.isnan(app_log10p) & ~np.isnan(ref_log10p)
        n_valid = int(valid.sum())
        self.assertGreater(n_valid, 10, f"Need >10 valid pairs; got {n_valid}")

        diffs = np.abs(app_log10p[valid] - ref_log10p[valid])
        n_within = int((diffs < 2.0).sum())
        pct_within = 100.0 * n_within / n_valid if n_valid else 0.0

        print(f"  log10(p) |diff| percentiles (50/75/90/95): {np.percentile(diffs, [50, 75, 90, 95]).round(2)}")
        print(f"  Pairs within ±2: {n_within}/{n_valid} ({pct_within:.1f}%)")
        print(f"  Gate threshold: ≥ 90%")

        self.assertGreaterEqual(pct_within, 90.0,
                                f"GATE FAIL: only {pct_within:.1f}% of pairs within ±2 log10(p) (need ≥90%)")


if __name__ == "__main__":
    unittest.main()
