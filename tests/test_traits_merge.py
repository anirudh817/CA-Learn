"""Tests for clinical traits merge wiring: synonym normalization and bundle merge (TRAIT-01, TRAIT-02, TRAIT-03)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")

from services.pipeline import (  # noqa: E402
    _merge_user_clinical_traits,
    _normalize_biomarker_synonyms,
    write_trait_associated_modules,
)


class SynonymNormalizationTests(unittest.TestCase):
    def test_tau_synonym_maps_to_T_TAU(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "tau_total": [1.0]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("T_TAU", out.columns)
        self.assertNotIn("tau_total", out.columns)

    def test_ptau_synonym_maps_to_P_TAU(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "ptau181": [0.5]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("P_TAU", out.columns)
        self.assertNotIn("ptau181", out.columns)

    def test_abeta_synonym_maps_to_ABETA42(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "ab42": [1200.0]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("ABETA42", out.columns)
        self.assertNotIn("ab42", out.columns)

    def test_canonical_name_not_renamed(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "T_TAU": [1.0]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("T_TAU", out.columns)
        self.assertEqual(list(out.columns), list(df.columns))

    def test_non_biomarker_column_passthrough(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "AGE": [65]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("AGE", out.columns)
        self.assertEqual(list(out.columns), list(df.columns))

    def test_case_insensitive_match(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "Tau_Total": [1.0]})
        out = _normalize_biomarker_synonyms(df)
        self.assertIn("T_TAU", out.columns)
        self.assertNotIn("Tau_Total", out.columns)

    def test_does_not_mutate_input(self):
        df = pd.DataFrame({"SAMPLE_ID": ["S1"], "tau_total": [1.0]})
        original_cols = list(df.columns)
        _ = _normalize_biomarker_synonyms(df)
        self.assertEqual(list(df.columns), original_cols)


class MergeUserClinicalTraitsTests(unittest.TestCase):
    def setUp(self):
        self._logs = []
        self._log = self._logs.append

    def _make_bundle(self, samples=("SCA_1", "SCA_2", "SCA_3")):
        return {
            "traits": pd.DataFrame({
                "SAMPLE_ID": list(samples),
                "GROUP": ["AD", "AD", "CTL"],
                "BATCH": [1, 1, 2],
            }),
            "matrix": pd.DataFrame(),
            "sample_metadata": pd.DataFrame(),
            "manifest": {},
        }

    def test_merges_biomarker_columns(self):
        bundle = self._make_bundle()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write("SAMPLE_ID,T_TAU,P_TAU,ABETA42\n")
            f.write("SCA_1,100,20,800\n")
            f.write("SCA_2,150,30,900\n")
            f.write("SCA_3,80,15,1100\n")
            fname = f.name
        self.addCleanup(os.unlink, fname)
        _merge_user_clinical_traits(bundle, {"traits_file_path": fname}, self._log)
        self.assertIn("T_TAU", bundle["traits"].columns)
        self.assertIn("P_TAU", bundle["traits"].columns)
        self.assertIn("ABETA42", bundle["traits"].columns)

    def test_merges_synonym_columns(self):
        bundle = self._make_bundle()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write("SAMPLE_ID,tau_total\n")
            f.write("SCA_1,100\n")
            f.write("SCA_2,150\n")
            f.write("SCA_3,80\n")
            fname = f.name
        self.addCleanup(os.unlink, fname)
        _merge_user_clinical_traits(bundle, {"traits_file_path": fname}, self._log)
        self.assertIn("T_TAU", bundle["traits"].columns)

    def test_noop_when_no_traits_file_path(self):
        bundle = self._make_bundle()
        original_cols = list(bundle["traits"].columns)
        _merge_user_clinical_traits(bundle, {}, self._log)
        self.assertEqual(list(bundle["traits"].columns), original_cols)

    def test_noop_when_file_not_found(self):
        bundle = self._make_bundle()
        original_cols = list(bundle["traits"].columns)
        _merge_user_clinical_traits(bundle, {"traits_file_path": "/nonexistent/path/traits.csv"}, self._log)
        self.assertEqual(list(bundle["traits"].columns), original_cols)
        self.assertTrue(any("WARNING" in msg for msg in self._logs))

    def test_noop_when_bundle_traits_none(self):
        bundle = self._make_bundle()
        bundle["traits"] = None
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write("SAMPLE_ID,T_TAU\n")
            f.write("SCA_1,100\n")
            fname = f.name
        self.addCleanup(os.unlink, fname)
        try:
            _merge_user_clinical_traits(bundle, {"traits_file_path": fname}, self._log)
        except Exception as exc:
            self.fail(f"_merge_user_clinical_traits raised unexpectedly with None traits: {exc}")
        self.assertIsNone(bundle["traits"])

    def test_sample_id_join_is_correct(self):
        bundle = self._make_bundle(samples=("SCA_1", "SCA_2", "SCA_3"))
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            f.write("SAMPLE_ID,T_TAU\n")
            f.write("SCA_3,999\n")
            f.write("SCA_1,111\n")
            f.write("SCA_2,555\n")
            fname = f.name
        self.addCleanup(os.unlink, fname)
        _merge_user_clinical_traits(bundle, {"traits_file_path": fname}, self._log)
        result = bundle["traits"].set_index("SAMPLE_ID")
        self.assertEqual(result.loc["SCA_1", "T_TAU"], 111)
        self.assertEqual(result.loc["SCA_2", "T_TAU"], 555)
        self.assertEqual(result.loc["SCA_3", "T_TAU"], 999)


class TraitAssociatedModulesTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._logs = []
        self._log = self._logs.append
        stage1_dir = Path(self._tmpdir.name) / "stage1"
        stage1_dir.mkdir(parents=True, exist_ok=True)
        self._stage1 = stage1_dir

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_expanded_variants_produce_csvs(self):
        cor_df = pd.DataFrame({
            "module_color": ["blue", "turquoise", "brown"],
            "cor_T_TAU_raw": [0.8, -0.5, 0.1],
            "p_T_TAU_raw": [0.001, 0.03, 0.8],
        })
        cor_df.to_csv(self._stage1 / "module_trait_cor.csv", index=False)
        write_trait_associated_modules(Path(self._tmpdir.name), self._log)
        out = self._stage1 / "trait_associations" / "T_TAU_raw_Associated_Modules.csv"
        self.assertTrue(out.exists(), f"Expected {out} to exist")
        result = pd.read_csv(out)
        self.assertIn("Module", result.columns)
        modules = list(result["Module"])
        self.assertIn("blue", modules)
        self.assertIn("turquoise", modules)

    def test_no_csv_when_no_significant_correlation(self):
        cor_df = pd.DataFrame({
            "module_color": ["blue", "turquoise", "brown"],
            "cor_T_TAU_raw": [0.1, -0.2, 0.05],
            "p_T_TAU_raw": [0.5, 0.4, 0.9],
        })
        cor_df.to_csv(self._stage1 / "module_trait_cor.csv", index=False)
        write_trait_associated_modules(Path(self._tmpdir.name), self._log)
        out = self._stage1 / "trait_associations" / "T_TAU_raw_Associated_Modules.csv"
        self.assertFalse(out.exists(), "No CSV expected when no module clears the |cor|>=0.3 + p<0.05 threshold")

    def test_no_module_trait_cor_is_noop(self):
        try:
            write_trait_associated_modules(Path(self._tmpdir.name), self._log)
        except Exception as exc:
            self.fail(f"write_trait_associated_modules raised unexpectedly with missing module_trait_cor.csv: {exc}")


if __name__ == "__main__":
    unittest.main()
