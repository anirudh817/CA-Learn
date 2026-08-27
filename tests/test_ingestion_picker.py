"""Epic 1: manual format/assay picker plumbing + end-to-end vendor ingestion.

Reuses the app-build + bootstrap harness from test_app so these run under the
same INLINE_RUNS=1 synchronous pipeline the rest of the suite uses.
"""

import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
TESTS_DIR = Path(__file__).resolve().parent
for _p in (str(TESTS_DIR), str(BACKEND_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
os.environ.setdefault("APP_ENV", "local")

from test_app import TestClient, bootstrap_session, build_app  # noqa: E402


def _generic_csv() -> bytes:
    lines = ["Protein,Control_1,Control_2,Disease_1,Disease_2"]
    for i in range(1, 6):
        lines.append(f"GENE{i:03d},{10 + i},{10 + i},{20 + i},{20 + i}")
    return ("\n".join(lines) + "\n").encode()


def _maxquant_wide_csv() -> bytes:
    header = "Protein IDs,Gene names,LFQ intensity Control_1,LFQ intensity Control_2,LFQ intensity Disease_1,LFQ intensity Disease_2"
    lines = [header]
    for i in range(1, 6):
        lines.append(f"P{i:05d},GENE{i:03d},{1000 + i},{1010 + i},{4000 + i},{4010 + i}")
    return ("\n".join(lines) + "\n").encode()


def _spectronaut_long_tsv(n_features: int = 30) -> bytes:
    header = "R.FileName\tPG.Genes\tPG.ProteinGroups\tPG.Quantity"
    rows = [header]
    samples = [("Control_1", 1.0), ("Control_2", 1.02), ("Control_3", 0.98),
               ("Disease_1", 1.0), ("Disease_2", 1.03), ("Disease_3", 0.97)]
    for i in range(1, n_features + 1):
        gene = f"GENE{i:03d}"
        acc = f"P{i:05d}"
        control_base = 1000 + i * 25
        disease_base = control_base * (3.5 if i % 3 == 0 else 1.05)
        for sample, jitter in samples:
            base = control_base if sample.startswith("Control") else disease_base
            rows.append(f"{sample}\t{gene}\t{acc}\t{base * jitter:.1f}")
    return ("\n".join(rows) + "\n").encode()


def _upload(client, headers, workspace_id, project_id, content, filename, *, format_family=None, assay_level=None):
    data = {"workspace_id": workspace_id, "project_id": project_id, "file_kind": "primary"}
    if format_family:
        data["format_family"] = format_family
    if assay_level:
        data["assay_level"] = assay_level
    resp = client.post(
        "/api/uploads",
        headers=headers,
        data=data,
        files={"file": (filename, content, "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


class FormatCatalogTests(unittest.TestCase):
    def test_formats_endpoint_lists_all_supported_families(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, _, _ = bootstrap_session(client)
                resp = client.get("/api/formats", headers=headers)
                self.assertEqual(resp.status_code, 200, resp.text)
                families = {f["family"] for f in resp.json()["formats"]}
                for expected in ["PEAKS", "Spectronaut", "DIA-NN", "MaxQuant", "FragPipe", "Proteome Discoverer", "Skyline"]:
                    self.assertIn(expected, families)


class FormatOverrideTests(unittest.TestCase):
    def test_upload_time_override_is_authoritative(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, ws, proj = bootstrap_session(client)
                data = _upload(client, headers, ws["id"], proj["id"], _generic_csv(), "matrix.csv",
                               format_family="DIA-NN", assay_level="protein")
                self.assertEqual(data["format_family"], "DIA-NN")
                self.assertEqual(data["assay_level"], "protein")
                self.assertEqual(data["pipeline_profile"], "diann")

    def test_patch_override_updates_dataset_and_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, ws, proj = bootstrap_session(client)
                data = _upload(client, headers, ws["id"], proj["id"], _maxquant_wide_csv(), "proteinGroups.csv")
                resp = client.patch(
                    f"/api/datasets/{data['dataset_id']}/format",
                    headers=headers,
                    json={"format_family": "MaxQuant", "assay_level": "protein"},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                body = resp.json()
                self.assertEqual(body["format_family"], "MaxQuant")
                self.assertEqual(body["pipeline_profile"], "maxquant")
                self.assertFalse(body["validation"]["needs_mapping"])
                self.assertTrue(body["run_ready"])

    def test_patch_to_format_with_missing_columns_requests_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, ws, proj = bootstrap_session(client)
                # A generic matrix has none of Spectronaut's expected columns.
                data = _upload(client, headers, ws["id"], proj["id"], _generic_csv(), "matrix.csv")
                resp = client.patch(
                    f"/api/datasets/{data['dataset_id']}/format",
                    headers=headers,
                    json={"format_family": "Spectronaut", "assay_level": "peptide"},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                body = resp.json()
                self.assertTrue(body["validation"]["needs_mapping"])
                self.assertFalse(body["run_ready"])
                self.assertIn("Protein", str(body["validation"]["available_columns"]))

    def test_patch_with_column_map_clears_mapping_requirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, ws, proj = bootstrap_session(client)
                data = _upload(client, headers, ws["id"], proj["id"], _generic_csv(), "matrix.csv")
                # Without a mapping, DIA-NN cannot recognize the generic "Protein"
                # id column -> needs mapping.
                unmapped = client.patch(
                    f"/api/datasets/{data['dataset_id']}/format",
                    headers=headers,
                    json={"format_family": "DIA-NN", "assay_level": "protein"},
                )
                self.assertTrue(unmapped.json()["validation"]["needs_mapping"])
                # Supplying a manual column map (feature -> Protein) lets DIA-NN
                # treat it as a matrix export and clears the requirement.
                mapped = client.patch(
                    f"/api/datasets/{data['dataset_id']}/format",
                    headers=headers,
                    json={"format_family": "DIA-NN", "assay_level": "protein", "column_map": {"feature": "Protein"}},
                )
                self.assertEqual(mapped.status_code, 200, mapped.text)
                self.assertFalse(mapped.json()["validation"]["needs_mapping"])
                self.assertTrue(mapped.json()["run_ready"])


class EndToEndVendorRunTests(unittest.TestCase):
    def _run_and_wait(self, client, headers, ws, proj, dataset_id, name):
        resp = client.post(
            "/api/runs",
            headers=headers,
            json={
                "workspace_id": ws["id"],
                "project_id": proj["id"],
                "name": name,
                "dataset_id": dataset_id,
                "cohort1": "Control",
                "cohort2": "Disease",
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def test_spectronaut_end_to_end_run_completes(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = build_app(tmp)
            with TestClient(app) as client:
                headers, ws, proj = bootstrap_session(client)
                data = _upload(
                    client, headers, ws["id"], proj["id"],
                    _spectronaut_long_tsv(), "spec.tsv",
                    format_family="Spectronaut", assay_level="protein",
                )
                self.assertEqual(data["format_family"], "Spectronaut")
                run = self._run_and_wait(client, headers, ws, proj, data["dataset_id"], "Spectronaut E2E")
                self.assertEqual(run["status"], "complete", run)
                detail = client.get(f"/api/runs/{run['run_id']}", headers=headers).json()
                self.assertEqual(detail["status"], "complete")
                # The vendor normalizer must have produced the canonical bundle.
                self.assertTrue(any(f["rel_path"] == "input/dataset_manifest.json" for f in detail["files"]))
                volcano = client.get(f"/api/results/{run['run_id']}/volcano", headers=headers).json()
                self.assertGreater(len(volcano.get("x", [])), 0)


if __name__ == "__main__":
    unittest.main()
