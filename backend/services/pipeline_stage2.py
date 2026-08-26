from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Optional

import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests

from services.pipeline_support import ts


GO_VIZ_R_TIMEOUT_SECONDS = 300  # 5 min hard cap — viz should take <30s typically


def _go_viz_rscript_path() -> Optional[Path]:
    """Return path to bundled go_viz_runner.R if both Rscript and the script are present."""
    from config import BASE_DIR

    script = BASE_DIR / "r_scripts" / "go_viz_runner.R"
    if not script.exists():
        return None
    if not shutil.which("Rscript"):
        return None
    return script


def _run_go_viz_via_r(run_dir: Path, profile: dict, log_fn: Callable[[str], None]) -> None:
    """Invoke the R-native GO heatmap renderer.

    Writes <run_dir>/<DisplayPrefix> Go/<prefix>_GO_Interactive_Heatmap.html
    and the GSA-GO-FET ... Kbest.pdf. Raises RuntimeError if the R
    subprocess is unavailable or fails — callers MUST wrap in try/except so
    a missing R env never blocks the pipeline; the matplotlib output remains
    a valid fallback."""
    script = _go_viz_rscript_path()
    if script is None:
        raise RuntimeError("R-native GO visualization is unavailable (Rscript or go_viz_runner.R missing).")

    display_prefix = profile.get("display_prefix") or profile.get("deliverable_prefix") or "Proteomics"
    prefix = profile.get("deliverable_prefix") or "PROTEOMICS"
    go_label = profile.get("go_label") or "PROTEOMICS"
    go_dir = run_dir / f"{display_prefix} Go"
    stage2_dir = run_dir / "stage2"

    config_path = run_dir / "stage2" / "go_viz_config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({
        "stage2_dir": str(stage2_dir.resolve()),
        "go_dir": str(go_dir.resolve()),
        "prefix": prefix,
        "display_prefix": display_prefix,
        "go_label": go_label,
    }, indent=2))

    log_fn(f"[{ts()}] Launching native R GO visualization")
    try:
        result = subprocess.run(
            ["Rscript", "--vanilla", str(script), str(config_path)],
            cwd=str(run_dir),
            capture_output=True,
            text=True,
            timeout=GO_VIZ_R_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"R GO visualization timed out after {GO_VIZ_R_TIMEOUT_SECONDS}s") from exc

    for line in (result.stdout or "").splitlines():
        if line.strip():
            log_fn(line.rstrip())
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log_fn(f"[r-stderr] {line.rstrip()}")
        raise RuntimeError(f"R GO visualization exited with code {result.returncode}")


def _load_gmt(gmt_path: str, log_fn: Callable[[str], None]) -> dict[str, dict]:
    """Load a GMT file and return {term_name: {category, genes}}."""
    terms: dict[str, dict] = {}
    with open(gmt_path, "r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                log_fn(
                    f"[{ts()}] WARNING: Skipping malformed GMT line "
                    f"(expected >=3 tab-separated fields, got {len(parts)}): {line.strip()[:80]!r}"
                )
                continue
            raw_name = parts[0]
            genes = set(parts[2:]) - {""}

            name_lower = raw_name.lower()
            if "gobp" in name_lower or "%go%" in name_lower.replace(" ", "") or "biological_process" in name_lower:
                category = "BP"
            elif "gomf" in name_lower or "molecular_function" in name_lower:
                category = "MF"
            elif "gocc" in name_lower or "cellular_component" in name_lower:
                category = "CC"
            elif "reactome" in name_lower or "kegg" in name_lower or "wp_" in name_lower or "pathway" in name_lower:
                category = "BP"
            else:
                category = "BP"

            display_name = raw_name.split("%")[0].replace("_", " ").strip() or raw_name
            terms[display_name] = {"category": category, "genes": genes}
    return terms


def _write_empty_go(stage_dir: Path, log_fn: Callable[[str], None], summary: dict | None = None) -> None:
    """Write empty GO outputs with the same column contract as successful runs."""
    full_header = "module,term,category,pvalue,zscore,hits,term_size,hit_genes,fdr\n"
    (stage_dir / "go_enrichment_all.csv").write_text(full_header)
    (stage_dir / "go_pvalues_matrix.csv").write_text("term\n")
    (stage_dir / "go_fdr_matrix.csv").write_text("term\n")
    (stage_dir / "go_zscore_matrix.csv").write_text("term\n")
    (stage_dir / "go_zscore_matrix_full.csv").write_text("term\n")
    for stale in ("go_enrichment_redundancy_removed.csv", "go_zscore_matrix_redundancy_removed.csv"):
        stale_path = stage_dir / stale
        if stale_path.exists():
            stale_path.unlink()
    payload = {"significant_terms": 0}
    if summary:
        payload.update(summary)
    (stage_dir / "go_summary.json").write_text(json.dumps(payload, indent=2))
    log_fn(f"[{ts()}] Written empty GO output files")


def _cohen_kappa(term_a: set[str], term_b: set[str], universe: set[str]) -> float:
    """Cohen's kappa for two gene-set membership vectors over a universe."""
    if not universe:
        return 0.0
    a = len(term_a & term_b)
    b = len(term_a - term_b)
    c = len(term_b - term_a)
    d = len(universe - term_a - term_b)
    total = a + b + c + d
    if total == 0:
        return 0.0
    observed = (a + d) / total
    expected = (((a + b) * (a + c)) + ((c + d) * (b + d))) / (total * total)
    denominator = 1 - expected
    if denominator == 0:
        return 0.0
    return float((observed - expected) / denominator)


def _select_kappa_kept_term_keys(
    go_df: pd.DataFrame,
    universe_genes: set[str],
    kappa_cut: float = 0.30,
) -> set[tuple[str, str]]:
    """Greedy kappa pruning at the GO-term level.

    GO enrichment rows are module × term tests. Redundancy, however, is a
    property of the GO term gene sets, not a property of each module-term cell.
    Use each term's best row as its representative, then keep or drop the term.
    """
    if go_df.empty or "_term_genes" not in go_df.columns:
        return set()
    representatives = (
        go_df.sort_values(["category", "fdr", "pvalue", "term"])
        .drop_duplicates(["category", "term"], keep="first")
    )
    kept_keys: set[tuple[str, str]] = set()
    kept_sets_by_category: dict[str, list[set[str]]] = {}
    for _, row in representatives.iterrows():
        category = str(row["category"])
        term_genes = set(str(row["_term_genes"]).split(";")) - {""}
        keep = True
        for kept_genes in kept_sets_by_category.get(category, []):
            if _cohen_kappa(term_genes, kept_genes, universe_genes) >= kappa_cut:
                keep = False
                break
        if keep:
            kept_keys.add((category, str(row["term"])))
            kept_sets_by_category.setdefault(category, []).append(term_genes)
    return kept_keys


def _filter_go_by_term_keys(go_df: pd.DataFrame, kept_keys: set[tuple[str, str]]) -> pd.DataFrame:
    if not kept_keys or go_df.empty:
        return go_df.head(0).copy()
    row_keys = pd.MultiIndex.from_frame(go_df[["category", "term"]].astype(str))
    keep_index = pd.MultiIndex.from_tuples(sorted(kept_keys), names=["category", "term"])
    return go_df[row_keys.isin(keep_index)].copy()


def run_stage2(
    config: dict,
    run_dir: Path,
    log_fn: Callable[[str], None],
    step_callback: Optional[Callable[[str, str, int, str], None]] = None,
) -> None:
    """Fisher's Exact Test enrichment of WGCNA modules against GO/pathway terms."""
    stage_dir = run_dir / "stage2"
    stage_dir.mkdir(parents=True, exist_ok=True)
    if step_callback:
        step_callback("goparallel", "running", 20, "Running GOparallel / pathway enrichment")

    fdr_threshold = float(config.get("fdr_threshold", 0.05))
    go_categories = config.get("go_categories", ["BP", "MF", "CC"])
    min_hits = int(config.get("min_hits_per_ontology", config.get("go_min_hits", 3)))
    gmt_file = config.get("gmt_file", None)
    background_mode = str(config.get("gmt_background_behavior", "measured_features") or "measured_features")
    redundancy_mode = str(config.get("remove_redundant_go", "kappa") or "kappa")

    module_file = run_dir / "stage1" / "module_assignments.csv"
    if not module_file.exists():
        log_fn(f"[{ts()}] WARNING: module_assignments.csv not found — writing empty GO outputs")
        _write_empty_go(
            stage_dir,
            log_fn,
            {
                "total_tested": 0,
                "unique_terms_tested": 0,
                "fdr_threshold": fdr_threshold,
                "modules_analyzed": 0,
                "zscore_method": "piano_signed_fet",
                "fdr_scope": "global",
                "background_mode": background_mode,
                "min_hits_per_ontology": min_hits,
                "redundancy_mode": redundancy_mode,
                "note": "Module assignments missing",
            },
        )
        if step_callback:
            step_callback("goparallel", "skipped", 100, "Module assignments missing")
        return

    log_fn(f"[{ts()}] Loading module assignments...")
    mod_df = pd.read_csv(module_file)

    all_gene_list = mod_df["gene"].astype(str).tolist()
    all_gene_list = [gene for gene in all_gene_list if gene not in {"nan", "NaN", "", "None"}]
    measured_feature_count = len(all_gene_list)
    measured_genes = set(all_gene_list)
    measured_gene_count = len(measured_genes)
    modules = [module for module in mod_df["module_color"].unique() if module != "grey"]

    from config import DEFAULT_GMT_FILE

    if not gmt_file:
        gmt_file = str(DEFAULT_GMT_FILE)

    gmt_path = Path(gmt_file)
    if not gmt_path.exists():
        log_fn(f"[{ts()}] ERROR: GMT file not found: {gmt_file}")
        log_fn(f"[{ts()}] Please upload a GMT file or ensure the default is installed at {DEFAULT_GMT_FILE}")
        _write_empty_go(
            stage_dir,
            log_fn,
            {
                "total_tested": 0,
                "unique_terms_tested": 0,
                "fdr_threshold": fdr_threshold,
                "modules_analyzed": len(modules),
                "gmt_source": str(gmt_file),
                "zscore_method": "piano_signed_fet",
                "fdr_scope": "global",
                "background_mode": background_mode,
                "min_hits_per_ontology": min_hits,
                "redundancy_mode": redundancy_mode,
                "note": "GO GMT file not found",
            },
        )
        if step_callback:
            step_callback("goparallel", "failed", 100, "GO GMT file not found")
        return

    log_fn(f"[{ts()}] Loading GMT database: {gmt_file}")
    try:
        go_terms = _load_gmt(gmt_file, log_fn)
        log_fn(f"[{ts()}] Loaded {len(go_terms)} gene sets from GMT file")
    except Exception as error:
        log_fn(f"[{ts()}] ERROR: GMT load failed ({error})")
        _write_empty_go(
            stage_dir,
            log_fn,
            {
                "total_tested": 0,
                "unique_terms_tested": 0,
                "fdr_threshold": fdr_threshold,
                "modules_analyzed": len(modules),
                "gmt_source": str(gmt_file),
                "zscore_method": "piano_signed_fet",
                "fdr_scope": "global",
                "background_mode": background_mode,
                "min_hits_per_ontology": min_hits,
                "redundancy_mode": redundancy_mode,
                "note": "GO database could not be loaded",
            },
        )
        if step_callback:
            step_callback("goparallel", "failed", 100, "GO database could not be loaded")
        return

    selected_gmt_genes: set[str] = set()
    for term_data in go_terms.values():
        if term_data["category"] in go_categories:
            selected_gmt_genes.update(term_data["genes"])
    gmt_universe_gene_count = len(selected_gmt_genes)
    if background_mode == "gmt_universe":
        universe_genes = set(selected_gmt_genes)
        universe_size = len(universe_genes)
    else:
        background_mode = "measured_features"
        universe_genes = set(measured_genes)
        universe_size = measured_gene_count
    module_genes_outside_universe = int(sum(1 for gene in measured_genes if gene not in universe_genes))

    log_fn(f"[{ts()}] Running GO enrichment for {len(modules)} modules × {len(go_terms)} terms...")
    results: list[dict] = []
    excluded_by_min_hits = 0
    for module_color in modules:
        mod_gene_list = mod_df[mod_df["module_color"] == module_color]["gene"].astype(str).tolist()
        mod_gene_list = [gene for gene in mod_gene_list if gene not in {"nan", "NaN", "", "None"}]
        if background_mode == "gmt_universe":
            mod_gene_list = [gene for gene in mod_gene_list if gene in universe_genes]
        mod_genes = set(mod_gene_list)
        module_size = len(mod_genes)

        for term_name, term_data in go_terms.items():
            category = term_data["category"]
            if category not in go_categories:
                continue
            term_genes_in_universe = term_data["genes"] & universe_genes
            if len(term_genes_in_universe) < min_hits:
                excluded_by_min_hits += 1
                continue

            overlap = mod_genes & term_genes_in_universe
            n_overlap = len(overlap)

            term_size = len(term_genes_in_universe)
            a = n_overlap
            b = module_size - a
            c = term_size - a
            d = universe_size - module_size - c
            if d < 0:
                d = 0

            _, p_enrich = stats.fisher_exact([[a, b], [c, d]], alternative="greater")
            _, p_deplete = stats.fisher_exact([[a, b], [c, d]], alternative="less")
            zscore_sign = 1 if p_enrich <= p_deplete else -1
            zscore_mag = stats.norm.isf(min(p_enrich, p_deplete) / 2)
            zscore = zscore_mag * zscore_sign

            results.append(
                {
                    "module": module_color,
                    "term": term_name,
                    "category": category,
                    "pvalue": float(p_enrich),
                    "zscore": float(zscore),
                    "hits": n_overlap,
                    "term_size": term_size,
                    "hit_genes": ";".join(sorted(overlap)),
                    "_term_genes": ";".join(sorted(term_genes_in_universe)),
                }
            )

    if results:
        all_pvals = [row["pvalue"] for row in results]
        _, adj_p, _, _ = multipletests(all_pvals, method="fdr_bh")
        for row, fdr_value in zip(results, adj_p):
            row["fdr"] = float(fdr_value)

    if not results:
        log_fn(f"[{ts()}] WARNING: No GO terms met minimum hit threshold — check gene names")
        _write_empty_go(
            stage_dir,
            log_fn,
            {
                "total_tested": 0,
                "unique_terms_tested": 0,
                "fdr_threshold": fdr_threshold,
                "modules_analyzed": len(modules),
                "gmt_source": str(gmt_file),
                "zscore_method": "piano_signed_fet",
                "fdr_scope": "global",
                "background_mode": background_mode,
                "universe_size": int(universe_size),
                "measured_gene_count": int(measured_gene_count),
                "measured_feature_count": int(measured_feature_count),
                "gmt_universe_gene_count": int(gmt_universe_gene_count),
                "module_genes_outside_universe": module_genes_outside_universe,
                "min_hits_per_ontology": min_hits,
                "excluded_by_min_hits": excluded_by_min_hits,
                "redundancy_mode": redundancy_mode,
                "redundancy_removed_rows": 0,
            },
        )
        if step_callback:
            step_callback("goparallel", "complete", 100, "No GO terms passed the configured thresholds")
        return

    go_df = pd.DataFrame(results)
    sig_df = go_df[go_df["fdr"] < fdr_threshold]
    public_go_df = go_df.drop(columns=["_term_genes"], errors="ignore")
    public_go_df.to_csv(stage_dir / "go_enrichment_all.csv", index=False)
    log_fn(f"[{ts()}] Written: go_enrichment_all.csv ({len(go_df)} rows, {len(sig_df)} significant)")

    all_tested_terms = go_df["term"].unique().tolist()
    pval_pivot = go_df.pivot_table(index="term", columns="module", values="pvalue", aggfunc="min").fillna(1.0)
    fdr_pivot = go_df.pivot_table(index="term", columns="module", values="fdr", aggfunc="min").fillna(1.0)
    pval_pivot.to_csv(stage_dir / "go_pvalues_matrix.csv")
    fdr_pivot.to_csv(stage_dir / "go_fdr_matrix.csv")

    zscore_full_df = go_df.pivot_table(index="term", columns="module", values="zscore", aggfunc="first").fillna(0.0)
    zscore_full_df.to_csv(stage_dir / "go_zscore_matrix_full.csv")

    redundancy_rows = 0
    visual_sig_df = sig_df
    if redundancy_mode == "kappa" and len(sig_df) > 0:
        kept_keys = _select_kappa_kept_term_keys(sig_df, universe_genes)
        pruned_sig = _filter_go_by_term_keys(sig_df, kept_keys)
        pruned = _filter_go_by_term_keys(go_df, kept_keys)
        redundancy_rows = int(len(sig_df) - len(pruned_sig))
        public_pruned = pruned.drop(columns=["_term_genes"], errors="ignore")
        public_pruned.to_csv(stage_dir / "go_enrichment_redundancy_removed.csv", index=False)
        pruned_z = public_pruned.pivot_table(index="term", columns="module", values="zscore", aggfunc="first").fillna(0.0)
        pruned_z.to_csv(stage_dir / "go_zscore_matrix_redundancy_removed.csv")
        visual_sig_df = pruned_sig
    else:
        for stale in ("go_enrichment_redundancy_removed.csv", "go_zscore_matrix_redundancy_removed.csv"):
            stale_path = stage_dir / stale
            if stale_path.exists():
                stale_path.unlink()

    if len(visual_sig_df) > 0:
        top_terms = visual_sig_df.groupby("term")["fdr"].min().nsmallest(30).index.tolist()
        zscore_df = go_df[go_df["term"].isin(top_terms)].pivot_table(
            index="term",
            columns="module",
            values="zscore",
            aggfunc="first",
        ).fillna(0.0)
        zscore_df.to_csv(stage_dir / "go_zscore_matrix.csv")
        log_fn(f"[{ts()}] Written: go_zscore_matrix.csv (top {len(top_terms)} terms)")
    else:
        (stage_dir / "go_zscore_matrix.csv").write_text("term\n")

    summary = {
        "significant_terms": int((go_df["fdr"] < fdr_threshold).sum()),
        "total_tested": len(go_df),
        "unique_terms_tested": len(all_tested_terms),
        "fdr_threshold": fdr_threshold,
        "modules_analyzed": len(modules),
        "gmt_source": str(gmt_file),
        "zscore_method": "piano_signed_fet",
        "fdr_scope": "global",
        "background_mode": background_mode,
        "universe_size": int(universe_size),
        "measured_gene_count": int(measured_gene_count),
        "measured_feature_count": int(measured_feature_count),
        "gmt_universe_gene_count": int(gmt_universe_gene_count),
        "module_genes_outside_universe": module_genes_outside_universe,
        "min_hits_per_ontology": min_hits,
        "excluded_by_min_hits": excluded_by_min_hits,
        "redundancy_mode": redundancy_mode,
        "redundancy_removed_rows": redundancy_rows,
    }
    (stage_dir / "go_summary.json").write_text(json.dumps(summary, indent=2))
    log_fn(f"[{ts()}] Stage 2 complete: {summary['significant_terms']} significant GO terms")
    if step_callback:
        step_callback("goparallel", "complete", 100, "GO enrichment outputs ready")

    # Native R visualization layer — opportunistic. Python FET above is the
    # source of truth for tables; R is invoked only for the heatmap PDF/HTML
    # to match reference deliverable aesthetics. Any failure is logged and
    # ignored so the matplotlib output emit_legacy_bundle generates remains
    # the guaranteed fallback.
    if len(sig_df) > 0:
        try:
            profile = _load_pipeline_profile(run_dir)
            if profile is not None:
                _run_go_viz_via_r(run_dir, profile, log_fn)
        except Exception as exc:  # noqa: BLE001 — viz is best-effort
            log_fn(f"[{ts()}] WARNING: native R GO visualization skipped ({exc})")


def _load_pipeline_profile(run_dir: Path) -> Optional[dict]:
    """Read pipeline_profile.json written by write_pipeline_profile(); None if missing."""
    profile_path = run_dir / "pipeline_profile.json"
    if not profile_path.exists():
        return None
    try:
        return json.loads(profile_path.read_text())
    except Exception:
        return None
