"""Tests for VIZ-03: artifact_priority() gives pheatmap PDFs priority over Plotly HTMLs."""
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

os.environ.setdefault("INLINE_RUNS", "1")

from services.artifacts import artifact_priority  # noqa: E402


class ArtifactPriorityVizTests(unittest.TestCase):
    def test_pdf_ranks_before_html_go_heatmap(self):
        pdf_p = artifact_priority("x.pdf", "pdf", "pdf", tab="go", family="go.heatmap", canonical=False)
        html_p = artifact_priority("x.html", "html", "html", tab="go", family="go.heatmap", canonical=False)
        self.assertLess(pdf_p, html_p)

    def test_pdf_ranks_before_html_cells_heatmap(self):
        pdf_p = artifact_priority("x.pdf", "pdf", "pdf", tab="cells", family="cells.heatmap", canonical=False)
        html_p = artifact_priority("x.html", "html", "html", tab="cells", family="cells.heatmap", canonical=False)
        self.assertLess(pdf_p, html_p)

    def test_pdf_gap_is_50_for_go_heatmap(self):
        pdf_p = artifact_priority("x.pdf", "pdf", "pdf", tab="go", family="go.heatmap", canonical=False)
        html_p = artifact_priority("x.html", "html", "html", tab="go", family="go.heatmap", canonical=False)
        self.assertEqual(html_p - pdf_p, 50)

    def test_pdf_gap_is_50_for_cells_heatmap(self):
        pdf_p = artifact_priority("x.pdf", "pdf", "pdf", tab="cells", family="cells.heatmap", canonical=False)
        html_p = artifact_priority("x.html", "html", "html", tab="cells", family="cells.heatmap", canonical=False)
        self.assertEqual(html_p - pdf_p, 50)

    def test_pdf_html_parity_for_other_families(self):
        pdf_p = artifact_priority("x.pdf", "pdf", "pdf", tab="network", family="network.dendrogram", canonical=False)
        html_p = artifact_priority("x.html", "html", "html", tab="network", family="network.dendrogram", canonical=False)
        self.assertEqual(pdf_p, html_p)

    def test_html_still_above_csv_go_heatmap(self):
        html_p = artifact_priority("x.html", "html", "html", tab="go", family="go.heatmap", canonical=False)
        csv_p = artifact_priority("x.csv", "csv", "table", tab="go", family="go.heatmap", canonical=False)
        self.assertLess(html_p, csv_p)


if __name__ == "__main__":
    unittest.main()
