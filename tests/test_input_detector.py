import csv
import os
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("APP_ENV", "local")


def _df(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


class InputDetectorTests(unittest.TestCase):
    def test_detector_identifies_supported_vendor_families_with_evidence(self):
        from database import UploadKind
        from services.input_detector import detect_input_format

        cases = [
            (
                "olink_npx.csv",
                _df(
                    [
                        {"SampleID": "S1", "OlinkID": "OID1", "UniProt": "P1", "Assay": "GFAP", "Panel": "Neuro", "PlateID": "P01", "NPX": 2.1, "SampleType": "SAMPLE", "AssayType": "assay"},
                        {"SampleID": "S2", "OlinkID": "OID1", "UniProt": "P1", "Assay": "GFAP", "Panel": "Neuro", "PlateID": "P01", "NPX": 2.5, "SampleType": "SAMPLE", "AssayType": "assay"},
                    ]
                ),
                ("Olink", "protein", "olink_npx"),
            ),
            (
                "spectronaut_peptide.csv",
                _df(
                    [
                        {"R.FileName": "Control_1.raw", "PEP.GroupingKey": "PEPTIDE_A", "PEP.Quantity": 1000.0, "PEP.AllOccurringProteinAccessions": "P02649"},
                        {"R.FileName": "Disease_1.raw", "PEP.GroupingKey": "PEPTIDE_A", "PEP.Quantity": 2200.0, "PEP.AllOccurringProteinAccessions": "P02649"},
                    ]
                ),
                ("Spectronaut", "peptide", "spectronaut_specpep"),
            ),
            (
                "spectronaut_protein.csv",
                _df(
                    [
                        {"R.FileName": "Control_1.raw", "PG.ProteinGroups": "P02649", "PG.Genes": "APOE", "PG.Quantity": 1000.0},
                        {"R.FileName": "Disease_1.raw", "PG.ProteinGroups": "P02649", "PG.Genes": "APOE", "PG.Quantity": 2200.0},
                    ]
                ),
                ("Spectronaut", "protein", "spectronaut_specpep"),
            ),
            (
                "proteinGroups.txt",
                _df(
                    [
                        {"Protein IDs": "P02649", "Majority protein IDs": "P02649", "Gene names": "APOE", "LFQ intensity Control_1": 10_000.0, "LFQ intensity Disease_1": 20_000.0},
                        {"Protein IDs": "P10909", "Majority protein IDs": "P10909", "Gene names": "CLU", "LFQ intensity Control_1": 8_000.0, "LFQ intensity Disease_1": 9_000.0},
                    ]
                ),
                ("MaxQuant", "protein", "maxquant"),
            ),
            (
                "evidence.txt",
                _df(
                    [
                        {"Raw file": "Control_1.raw", "Sequence": "PEPTIDEA", "Proteins": "P02649", "Protein group IDs": "1", "Intensity": 10_000.0},
                        {"Raw file": "Disease_1.raw", "Sequence": "PEPTIDEA", "Proteins": "P02649", "Protein group IDs": "1", "Intensity": 20_000.0},
                    ]
                ),
                ("MaxQuant", "peptide", "maxquant"),
            ),
            (
                "diann_report.tsv",
                _df(
                    [
                        {"Run": "Control_1.raw", "Protein.Group": "P02649", "Genes": "APOE", "Precursor.Id": "PEPTIDEA2", "PG.MaxLFQ": 10_000.0},
                        {"Run": "Disease_1.raw", "Protein.Group": "P02649", "Genes": "APOE", "Precursor.Id": "PEPTIDEA2", "PG.MaxLFQ": 20_000.0},
                    ]
                ),
                ("DIA-NN", "protein", "diann"),
            ),
            (
                "study.pg_matrix.tsv",
                _df(
                    [
                        {"Protein.Group": "P02649", "Genes": "APOE", "Control_1": 10_000.0, "Disease_1": 20_000.0},
                        {"Protein.Group": "P10909", "Genes": "CLU", "Control_1": 8_000.0, "Disease_1": 9_000.0},
                    ]
                ),
                ("DIA-NN", "protein", "diann"),
            ),
            (
                "peaks_peptides.csv",
                _df(
                    [
                        {"Peptide": "PEPTIDEA", "Accession": "P02649", "-10lgP": 55.0, "Area Control_1": 10_000.0, "Area Disease_1": 20_000.0},
                        {"Peptide": "PEPTIDEB", "Accession": "P10909", "-10lgP": 45.0, "Area Control_1": 8_000.0, "Area Disease_1": 9_000.0},
                    ]
                ),
                ("PEAKS", "peptide", "peaks_peptide"),
            ),
        ]

        for filename, frame, expected in cases:
            with self.subTest(filename=filename):
                detected = detect_input_format(frame, filename=filename, file_kind=UploadKind.PRIMARY)
                self.assertEqual(detected["format_family"], expected[0])
                self.assertEqual(detected["assay_level"], expected[1])
                self.assertGreaterEqual(detected["confidence"], 0.90)
                self.assertTrue(detected["run_ready"])
                self.assertTrue(detected["evidence"])

                from services.profile_defaults import recommended_defaults_for_profile

                defaults = recommended_defaults_for_profile(
                    detected["format_family"],
                    detected["assay_level"],
                    detected["format_detected"],
                )
                self.assertEqual(defaults["pipeline_profile"], expected[2])

    def test_detector_flags_olink_quant_exports_as_detected_but_not_run_ready(self):
        from database import UploadKind
        from services.input_detector import detect_input_format

        frame = _df(
            [
                {"SampleID": "S1", "OlinkID": "OID1", "Assay": "GFAP", "QuantifiedValue": 120.0, "Unit": "pg/mL", "SampleType": "SAMPLE"},
                {"SampleID": "S2", "OlinkID": "OID1", "Assay": "GFAP", "QuantifiedValue": 140.0, "Unit": "pg/mL", "SampleType": "SAMPLE"},
            ]
        )
        detected = detect_input_format(frame, filename="olink_quant.csv", file_kind=UploadKind.PRIMARY)

        self.assertEqual(detected["format_family"], "Olink")
        self.assertEqual(detected["format_detected"], "Olink Quant Long Table")
        self.assertFalse(detected["run_ready"])
        self.assertTrue(detected["manual_override_recommended"])
        self.assertTrue(detected["warnings"])

    def test_canonicalizer_accepts_maxquant_evidence_and_diann_long_reports(self):
        from services.pipeline import _canonicalize_input

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            maxquant_path = tmp_path / "evidence.txt"
            with open(maxquant_path, "w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["Raw file", "Sequence", "Proteins", "Gene names", "Intensity"], delimiter="\t")
                writer.writeheader()
                writer.writerows(
                    [
                        {"Raw file": "Control_1.raw", "Sequence": "PEPTIDEA", "Proteins": "P02649", "Gene names": "APOE", "Intensity": 10_000},
                        {"Raw file": "Disease_1.raw", "Sequence": "PEPTIDEA", "Proteins": "P02649", "Gene names": "APOE", "Intensity": 20_000},
                    ]
                )

            maxquant = _canonicalize_input(
                str(maxquant_path),
                {"format_family": "MaxQuant", "input_level": "peptide", "cohort1": "Control", "cohort2": "Disease"},
                lambda _msg: None,
            )
            self.assertEqual(maxquant["manifest"]["format_family"], "MaxQuant")
            self.assertEqual(maxquant["manifest"]["assay_level"], "peptide")
            self.assertEqual(maxquant["manifest"]["sample_count"], 2)
            self.assertIn("APOE|P02649|PEPTIDEA", set(maxquant["matrix"]["feature_id"]))

            diann_path = tmp_path / "diann_report.tsv"
            with open(diann_path, "w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["Run", "Protein.Group", "Genes", "PG.MaxLFQ"], delimiter="\t")
                writer.writeheader()
                writer.writerows(
                    [
                        {"Run": "Control_1.raw", "Protein.Group": "P02649", "Genes": "APOE", "PG.MaxLFQ": 10_000},
                        {"Run": "Disease_1.raw", "Protein.Group": "P02649", "Genes": "APOE", "PG.MaxLFQ": 20_000},
                    ]
                )

            diann = _canonicalize_input(
                str(diann_path),
                {"format_family": "DIA-NN", "input_level": "protein", "cohort1": "Control", "cohort2": "Disease"},
                lambda _msg: None,
            )
            self.assertEqual(diann["manifest"]["format_family"], "DIA-NN")
            self.assertEqual(diann["manifest"]["assay_level"], "protein")
            self.assertEqual(diann["manifest"]["sample_count"], 2)
            self.assertIn("APOE|P02649", set(diann["matrix"]["feature_id"]))

    def test_required_reference_assets_are_present_and_nonempty(self):
        from config import DEFAULT_CELLTYPE_MARKERS, DEFAULT_CELLTYPE_MARKERS_MOUSE, DEFAULT_GMT_FILE, DEFAULT_UNIPROT_GENE_LOOKUP

        for path in [DEFAULT_GMT_FILE, DEFAULT_CELLTYPE_MARKERS, DEFAULT_CELLTYPE_MARKERS_MOUSE, DEFAULT_UNIPROT_GENE_LOOKUP]:
            with self.subTest(path=str(path)):
                self.assertTrue(Path(path).exists(), f"{path} should exist")
                self.assertGreater(Path(path).stat().st_size, 0, f"{path} should not be empty")


class SwedenPeaksRegressionTests(unittest.TestCase):
    """Regression: the Sweden cohort PEAKS DB file must classify as PEAKS."""

    SWEDEN_FILE = Path("/Users/anirudhs/Documents/ClientServices/Eisai/data/sweden-cohort-raw/PeaksPeptide List Sweden Cohort.csv")

    def test_sweden_peaks_file_detected_as_peaks(self):
        if not self.SWEDEN_FILE.exists():
            self.skipTest(f"Sweden raw file not present at {self.SWEDEN_FILE}")
        from services.input_detector import detect_input_format
        from database import UploadKind

        # Read just the header + first 100 rows for detection (full file is 39K rows)
        df = pd.read_csv(self.SWEDEN_FILE, nrows=100)
        result = detect_input_format(df, filename=self.SWEDEN_FILE.name, file_kind=UploadKind.PRIMARY)
        self.assertEqual(result["format_family"], "PEAKS",
                         f"Expected PEAKS, got {result['format_family']}; evidence: {result.get('evidence')}")
        self.assertEqual(result["assay_level"], "peptide")


if __name__ == "__main__":
    unittest.main()
