from __future__ import annotations

from typing import Any


def resolve_profile_identity(format_family: str | None, assay_level: str | None) -> dict[str, str]:
    family = str(format_family or "Generic").strip()
    family_key = family.lower()
    level = str(assay_level or "unknown").strip().lower()

    if family_key == "peaks" and level == "protein":
        return {
            "pipeline_profile": "peaks_protein",
            "deliverable_prefix": "PEAKS",
            "display_prefix": "PEAKS",
            "go_label": "PEAKS",
            "format_family": family,
            "input_level": level,
        }
    if family_key == "peaks":
        return {
            "pipeline_profile": "peaks_peptide",
            "deliverable_prefix": "PEAKS",
            "display_prefix": "PEAKS",
            "go_label": "PEAKS",
            "format_family": family,
            "input_level": level,
        }
    if family_key == "spectronaut":
        return {
            "pipeline_profile": "spectronaut_specpep",
            "deliverable_prefix": "SPEC",
            "display_prefix": "Spec Pep",
            "go_label": "SPEC-PEP",
            "format_family": family,
            "input_level": level,
        }
    if family_key == "olink":
        return {
            "pipeline_profile": "olink_npx",
            "deliverable_prefix": "OLINK",
            "display_prefix": "Olink",
            "go_label": "OLINK",
            "format_family": family,
            "input_level": level,
        }
    if family_key == "maxquant":
        return {
            "pipeline_profile": "maxquant",
            "deliverable_prefix": "MAXQUANT",
            "display_prefix": "MaxQuant",
            "go_label": "MAXQUANT",
            "format_family": family,
            "input_level": level,
        }
    if family_key in {"dia-nn", "diann"}:
        return {
            "pipeline_profile": "diann",
            "deliverable_prefix": "DIANN",
            "display_prefix": "DIA-NN",
            "go_label": "DIANN",
            "format_family": family,
            "input_level": level,
        }
    return {
        "pipeline_profile": "generic_matrix",
        "deliverable_prefix": "PROTEOMICS",
        "display_prefix": "Proteomics",
        "go_label": "PROTEOMICS",
        "format_family": family,
        "input_level": level,
    }


def recommended_defaults_for_profile(format_family: str | None, assay_level: str | None, format_detected: str | None = None) -> dict[str, Any]:
    profile = resolve_profile_identity(format_family, assay_level)
    pipeline_profile = profile["pipeline_profile"]
    detected = str(format_detected or "dataset").strip()
    sample_level = "proteins" if profile["input_level"] == "protein" else "peptides"

    defaults: dict[str, Any] = {
        "pipeline_profile": pipeline_profile,
        "parameter_overrides": {
            "normalization_method": "median",
            "log_transform": True,
            "use_adjusted_pvalue": True,
            "wgcna_power": 8,
            "min_module_size": 20,
            "deep_split": 3,
            "merge_cut_height": 0.30,
        },
        "hint_text": f"Detected {detected} with profile `{pipeline_profile}`. Review parameters before launching the run.",
        "defaults_source": "profile",
    }

    if pipeline_profile == "olink_npx":
        defaults["parameter_overrides"].update(
            {
                "normalization_method": "median",
                "log_transform": False,
                "wgcna_power": 8,
                "min_module_size": 10,
                "deep_split": 4,
                "merge_cut_height": 0.07,
            }
        )
        defaults["hint_text"] = (
            "Detected an Olink NPX dataset. NPX values are already on a log scale, so log2 transform is disabled, "
            "and the network defaults are tightened for a protein-level Olink workflow."
        )
    elif pipeline_profile == "spectronaut_specpep" and profile["input_level"] == "peptide":
        defaults["parameter_overrides"].update(
            {
                "wgcna_power": 8,
                "min_module_size": 15,
                "deep_split": 4,
                "merge_cut_height": 0.15,
            }
        )
        defaults["hint_text"] = (
            "Detected a Spectronaut peptide export. Using log2 auto-handling, BH-adjusted significance, and WGCNA defaults "
            "aligned to the Spec Pep peptide workflow."
        )
    elif pipeline_profile == "generic_matrix":
        defaults["hint_text"] = (
            f"Detected {detected} with a generic matrix profile. The app will treat the features as {sample_level} unless the analysis "
            "config or uploaded metadata indicates otherwise."
        )

    return defaults
