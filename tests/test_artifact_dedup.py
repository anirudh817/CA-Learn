"""Verify artifact_manifest dedupes subfolder copies of root-level shared files.

When per-trait subfolders (disease_status/, total_tau/, etc.) contain copies of
the top-level WGCNA QC PDFs (01_Sample_Clustering_QC, 02_Power_Selection,
03_Network_Dendrograms, Module_Eigengenes.csv, Module_Assignments.csv), the
artifact_manifest must NOT register them as separate artifacts — otherwise the
network tab shows 5-7x duplicates of every shared file."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")


class ArtifactDedupTests(unittest.TestCase):
    def test_subfolder_copies_of_shared_files_not_registered(self):
        from services.artifact_manifest import _register_remaining_tree

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            network_dir = run_dir / "05_network_CBN_median"
            network_dir.mkdir(parents=True)

            # Top-level shared file (the canonical one)
            (network_dir / "PEAKS_WGCNA_03_Network_Dendrograms.pdf").write_bytes(b"%PDF-1.4")
            (network_dir / "PEAKS_WGCNA_01_Sample_Clustering_QC.pdf").write_bytes(b"%PDF-1.4")

            # Per-trait subfolders with COPIES of the shared file + a unique per-trait file
            for folder in ("disease_status", "total_tau", "phospho_tau"):
                sub = network_dir / folder
                sub.mkdir()
                (sub / "PEAKS_WGCNA_03_Network_Dendrograms.pdf").write_bytes(b"%PDF-1.4")
                (sub / "PEAKS_WGCNA_01_Sample_Clustering_QC.pdf").write_bytes(b"%PDF-1.4")
                # Unique per-trait file (must STILL be registered)
                (sub / f"PEAKS_WGCNA_04_{folder}_Correlations.pdf").write_bytes(b"%PDF-1.4")

            entries: dict = {}
            _register_remaining_tree(
                entries,
                run_dir,
                "05_network_CBN_median",
                visual_tab="network",
                family_prefix="network.extra",
                legacy_class="legacy.network",
            )

            registered_paths = set(entries.keys())

            # Top-level shared files are registered
            self.assertIn("05_network_CBN_median/PEAKS_WGCNA_03_Network_Dendrograms.pdf", registered_paths)
            self.assertIn("05_network_CBN_median/PEAKS_WGCNA_01_Sample_Clustering_QC.pdf", registered_paths)

            # Subfolder COPIES of shared files are NOT registered (the bug fix)
            self.assertNotIn("05_network_CBN_median/disease_status/PEAKS_WGCNA_03_Network_Dendrograms.pdf", registered_paths)
            self.assertNotIn("05_network_CBN_median/total_tau/PEAKS_WGCNA_01_Sample_Clustering_QC.pdf", registered_paths)
            self.assertNotIn("05_network_CBN_median/phospho_tau/PEAKS_WGCNA_03_Network_Dendrograms.pdf", registered_paths)

            # Unique per-trait files ARE still registered
            self.assertIn("05_network_CBN_median/disease_status/PEAKS_WGCNA_04_disease_status_Correlations.pdf", registered_paths)
            self.assertIn("05_network_CBN_median/total_tau/PEAKS_WGCNA_04_total_tau_Correlations.pdf", registered_paths)

    def test_root_level_files_always_registered(self):
        """Sanity check: top-level files in the tree always get registered."""
        from services.artifact_manifest import _register_remaining_tree

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            network_dir = run_dir / "05_network_CBN_median"
            network_dir.mkdir(parents=True)

            for name in (
                "PEAKS_WGCNA_All_Hub_Proteins.csv",
                "PEAKS_WGCNA_kME_Matrix.csv",
                "PEAKS_WGCNA_Module_Assignments-3M.csv",
                "PEAKS_WGCNA_Analysis_Summary.txt",
            ):
                (network_dir / name).write_bytes(b"data")

            entries: dict = {}
            _register_remaining_tree(
                entries,
                run_dir,
                "05_network_CBN_median",
                visual_tab="network",
                family_prefix="network.extra",
                legacy_class="legacy.network",
            )
            self.assertEqual(len(entries), 4)


class BuildArtifactIndexDedupTests(unittest.TestCase):
    """End-to-end: build_artifact_index excludes subfolder duplicates from the
    network tab even when artifact_manifest.json was written by an older version
    that registered them all."""

    def test_network_tab_dedupes_subfolder_copies(self):
        from services.artifacts import build_artifact_index

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            network_dir = run_dir / "05_network_CBN_median"
            network_dir.mkdir(parents=True)

            # Top-level shared files
            (network_dir / "PEAKS_WGCNA_01_Sample_Clustering_QC.pdf").write_bytes(b"%PDF-1.4")
            (network_dir / "PEAKS_WGCNA_02_Power_Selection.pdf").write_bytes(b"%PDF-1.4")
            (network_dir / "PEAKS_WGCNA_03_Network_Dendrograms.pdf").write_bytes(b"%PDF-1.4")
            (network_dir / "PEAKS_WGCNA_04_Module_Trait_Correlations.pdf").write_bytes(b"%PDF-1.4")
            (network_dir / "PEAKS_WGCNA_05_Module_Response_Plots.pdf").write_bytes(b"%PDF-1.4")

            # Per-trait subfolders with duplicates + unique files
            for folder in ("disease_status", "total_tau", "phospho_tau", "amyloid_beta"):
                sub = network_dir / folder
                sub.mkdir()
                (sub / "PEAKS_WGCNA_01_Sample_Clustering_QC.pdf").write_bytes(b"%PDF-1.4")
                (sub / "PEAKS_WGCNA_02_Power_Selection.pdf").write_bytes(b"%PDF-1.4")
                (sub / "PEAKS_WGCNA_03_Network_Dendrograms.pdf").write_bytes(b"%PDF-1.4")
                # Unique per-trait file
                (sub / f"PEAKS_WGCNA_04_{folder}_Correlations.pdf").write_bytes(b"%PDF-1.4")

            idx = build_artifact_index("test-run", run_dir)
            # Use the flat descriptors list — every file the index knows about
            descriptor_paths = {item["rel_path"] for item in idx.get("artifacts", [])}

            # Top-level files always present
            self.assertIn("05_network_CBN_median/PEAKS_WGCNA_01_Sample_Clustering_QC.pdf", descriptor_paths)
            self.assertIn("05_network_CBN_median/PEAKS_WGCNA_03_Network_Dendrograms.pdf", descriptor_paths)
            # Unique per-trait files always present (different basename → kept)
            self.assertIn("05_network_CBN_median/disease_status/PEAKS_WGCNA_04_disease_status_Correlations.pdf", descriptor_paths)
            self.assertIn("05_network_CBN_median/total_tau/PEAKS_WGCNA_04_total_tau_Correlations.pdf", descriptor_paths)
            # Subfolder duplicates of root-level files excluded
            self.assertNotIn("05_network_CBN_median/disease_status/PEAKS_WGCNA_01_Sample_Clustering_QC.pdf", descriptor_paths)
            self.assertNotIn("05_network_CBN_median/total_tau/PEAKS_WGCNA_03_Network_Dendrograms.pdf", descriptor_paths)
            self.assertNotIn("05_network_CBN_median/phospho_tau/PEAKS_WGCNA_02_Power_Selection.pdf", descriptor_paths)
            self.assertNotIn("05_network_CBN_median/amyloid_beta/PEAKS_WGCNA_03_Network_Dendrograms.pdf", descriptor_paths)

            # Total: 5 root-level + 4 unique per-trait = 9 (was 5 + 4*4 = 21 before fix)
            self.assertEqual(len(descriptor_paths), 9, f"Expected 9 total descriptors, got {len(descriptor_paths)}: {sorted(descriptor_paths)}")


if __name__ == "__main__":
    unittest.main()
