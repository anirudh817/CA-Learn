"""Unit tests for the pre-ETL vendor normalizers (Epic 1, all formats).

Each format has a committed fixture under tests/fixtures/ingestion/. These
fixtures are minimal, synthetic, and format-representative (they exercise the
column layout each tool emits, not real study data). They assert the normalizer
maps the raw export into the canonical wide matrix the pipeline ETL consumes.
"""

import os
import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
FIXTURES = ROOT / "tests" / "fixtures" / "ingestion"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("APP_ENV", "local")


def _normalize(fixture: str, format_family: str, assay_level: str, params=None):
    from services.ingestion.base import read_frame
    from services.ingestion.normalizers import normalizer_for

    frame = read_frame(FIXTURES / fixture)
    return normalizer_for(format_family)(frame, assay_level=assay_level, params=params or {})


class NormalizerCanonicalShapeTests(unittest.TestCase):
    """The canonical wide matrix: id column first, Gene present, numeric samples."""

    EXPECTED_SAMPLES = {"Control_1", "Control_2", "Disease_1", "Disease_2"}
    EXPECTED_GENES = {"APOE", "CLU", "C3"}

    def _assert_canonical(self, wide: pd.DataFrame, *, assay_level: str):
        id_col = "Peptide" if assay_level == "peptide" else "Accession"
        self.assertEqual(str(wide.columns[0]), id_col, f"first column should be {id_col}")
        self.assertIn("Gene", wide.columns)
        self.assertEqual(len(wide), 3, "expected 3 features")
        sample_cols = [c for c in wide.columns if c not in {"Peptide", "Gene", "Accession"}]
        self.assertEqual(set(sample_cols), self.EXPECTED_SAMPLES)
        self.assertEqual(set(wide["Gene"]), self.EXPECTED_GENES)
        for col in sample_cols:
            self.assertTrue(pd.api.types.is_numeric_dtype(pd.to_numeric(wide[col], errors="coerce")))
        # APOE row: disease values must exceed control values (sanity on the mapping).
        apoe = wide[wide["Gene"] == "APOE"].iloc[0]
        self.assertGreater(float(apoe["Disease_1"]), float(apoe["Control_1"]))

    def test_spectronaut_peptide(self):
        wide = _normalize("spectronaut_long_peptide.tsv", "Spectronaut", "peptide")
        self._assert_canonical(wide, assay_level="peptide")
        self.assertIn("APOE_PEP1", set(wide["Peptide"]))

    def test_diann_long_protein(self):
        wide = _normalize("diann_long_protein.tsv", "DIA-NN", "protein")
        self._assert_canonical(wide, assay_level="protein")

    def test_diann_matrix_protein(self):
        wide = _normalize("diann_matrix_protein.tsv", "DIA-NN", "protein")
        self._assert_canonical(wide, assay_level="protein")

    def test_maxquant_proteingroups(self):
        wide = _normalize("maxquant_proteingroups.txt", "MaxQuant", "protein")
        self._assert_canonical(wide, assay_level="protein")

    def test_maxquant_evidence_peptide(self):
        wide = _normalize("maxquant_evidence_peptide.txt", "MaxQuant", "peptide")
        self._assert_canonical(wide, assay_level="peptide")

    def test_fragpipe_prefers_maxlfq(self):
        wide = _normalize("fragpipe_combined_protein.tsv", "FragPipe", "protein")
        self._assert_canonical(wide, assay_level="protein")
        # Must use MaxLFQ Intensity (1000..), not the plain " Intensity" columns (999).
        apoe = wide[wide["Gene"] == "APOE"].iloc[0]
        self.assertEqual(float(apoe["Control_1"]), 1000.0)

    def test_proteome_discoverer_excludes_ratio(self):
        wide = _normalize("proteome_discoverer_protein.csv", "Proteome Discoverer", "protein")
        self._assert_canonical(wide, assay_level="protein")
        # The Abundance Ratio column must not leak in as a sample.
        self.assertNotIn("Abundance Ratio: (Disease) / (Control)", wide.columns)

    def test_skyline_long_protein(self):
        wide = _normalize("skyline_long_protein.csv", "Skyline", "protein")
        self._assert_canonical(wide, assay_level="protein")


class NormalizerColumnMappingTests(unittest.TestCase):
    def test_missing_columns_raise_column_mapping_required(self):
        from services.ingestion.base import ColumnMappingRequired
        from services.ingestion.normalizers import normalizer_for

        # A frame with none of Spectronaut's expected columns.
        frame = pd.DataFrame({"weird_a": [1, 2], "weird_b": [3, 4]})
        with self.assertRaises(ColumnMappingRequired) as ctx:
            normalizer_for("Spectronaut")(frame, assay_level="protein", params={})
        payload = ctx.exception.to_payload()
        self.assertTrue(payload["needs_mapping"])
        self.assertEqual(payload["format_family"], "Spectronaut")
        self.assertIn("weird_a", payload["available_columns"])

    def test_column_map_override_is_honored(self):
        from services.ingestion.normalizers import normalizer_for

        frame = pd.DataFrame(
            {
                "run": ["Control_1", "Disease_1", "Control_1", "Disease_1"],
                "prot": ["APOE", "APOE", "CLU", "CLU"],
                "abundance": [1000, 4000, 800, 2400],
            }
        )
        column_map = {"sample": "run", "feature": "prot", "value": "abundance"}
        wide = normalizer_for("Spectronaut")(frame, assay_level="protein", params={"column_map": column_map})
        self.assertEqual(set(wide["Accession"]), {"APOE", "CLU"})
        self.assertEqual(set(c for c in wide.columns if c not in {"Accession", "Gene"}), {"Control_1", "Disease_1"})


class RegistryTests(unittest.TestCase):
    def test_registry_covers_all_normalizer_families(self):
        from services.ingestion import SUPPORTED_FORMATS
        from services.ingestion.normalizers import normalizer_for

        for fmt in SUPPORTED_FORMATS:
            if fmt["routing"] == "normalizer":
                self.assertIsNotNone(normalizer_for(fmt["family"]), f"{fmt['family']} should have a normalizer")

    def test_non_normalizer_families_have_no_normalizer(self):
        from services.ingestion.normalizers import normalizer_for

        for family in ("PEAKS", "Olink", "Generic"):
            self.assertIsNone(normalizer_for(family))


if __name__ == "__main__":
    unittest.main()
