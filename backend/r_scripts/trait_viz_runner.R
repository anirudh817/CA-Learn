#!/usr/bin/env Rscript
# trait_viz_runner.R — native R per-trait WGCNA visualization.
#
# Renders per-trait correlation heatmaps (PDF, via WGCNA::labeledHeatmap) and
# per-trait response plots (multi-page PDF, scatter with regression line) into
# the trait subfolders under <network_dir>. Mirrors the Eisai reference
# `peaks_WGCNA_Standard.R:372-670`.
#
# Python remains source-of-truth for tables; this script handles ONLY the
# visualization layer. Any failure exits non-zero so the Python caller can
# fall back to the existing matplotlib helpers.
#
# Invoked as:  Rscript trait_viz_runner.R <config.json>
# Config keys: stage1_dir, network_dir, prefix, display_prefix,
#              trait_buckets (object: folder -> [trait_names]),
#              all_traits ([trait_names])

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat("ERROR: trait_viz_runner.R requires a config JSON path argument\n", file = stderr())
  quit(status = 2)
}

required_pkgs <- c("jsonlite", "WGCNA")
missing_pkgs <- required_pkgs[!vapply(required_pkgs, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing_pkgs) > 0) {
  cat(sprintf("ERROR: missing R packages: %s\n", paste(missing_pkgs, collapse = ", ")), file = stderr())
  quit(status = 3)
}

suppressPackageStartupMessages({
  library(jsonlite)
  library(WGCNA)
})

cfg <- jsonlite::fromJSON(args[1])
required <- c("stage1_dir", "network_dir", "prefix", "trait_buckets")
for (k in required) {
  if (is.null(cfg[[k]])) {
    cat(sprintf("ERROR: config missing required key: %s\n", k), file = stderr())
    quit(status = 4)
  }
}

stage1_dir <- normalizePath(cfg$stage1_dir, mustWork = FALSE)
network_dir <- cfg$network_dir
prefix <- cfg$prefix
display_prefix <- if (!is.null(cfg$display_prefix)) cfg$display_prefix else prefix

me_path <- file.path(stage1_dir, "module_eigengenes.csv")
traits_path <- file.path(stage1_dir, "expanded_traits.csv")
if (!file.exists(traits_path)) {
  traits_path <- file.path(dirname(stage1_dir), "input", "traits.csv")
}
if (!file.exists(me_path) || !file.exists(traits_path)) {
  cat(sprintf("ERROR: required input(s) missing: me_path=%s traits_path=%s\n", me_path, traits_path), file = stderr())
  quit(status = 5)
}

mes_df <- tryCatch(
  read.csv(me_path, header = TRUE, stringsAsFactors = FALSE, check.names = FALSE),
  error = function(e) {
    cat(sprintf("ERROR: failed to read MEs: %s\n", conditionMessage(e)), file = stderr())
    quit(status = 6)
  }
)
traits_df <- tryCatch(
  read.csv(traits_path, header = TRUE, stringsAsFactors = FALSE, check.names = FALSE),
  error = function(e) {
    cat(sprintf("ERROR: failed to read traits: %s\n", conditionMessage(e)), file = stderr())
    quit(status = 6)
  }
)

# MEs file has columns: sample_name, group, ME<color>, ...
sample_col <- if ("sample_name" %in% colnames(mes_df)) "sample_name" else colnames(mes_df)[1]
sample_ids <- as.character(mes_df[[sample_col]])
me_cols <- setdiff(colnames(mes_df), c(sample_col, "group"))
MEs <- as.matrix(mes_df[, me_cols, drop = FALSE])
rownames(MEs) <- sample_ids
mode(MEs) <- "numeric"
MEsNoGrey <- MEs[, !grepl("^MEgrey$", colnames(MEs)), drop = FALSE]

trait_sample_col <- if ("Sample" %in% colnames(traits_df)) "Sample" else if ("sample" %in% colnames(traits_df)) "sample" else if ("SAMPLE_ID" %in% colnames(traits_df)) "SAMPLE_ID" else colnames(traits_df)[1]
trait_ids <- as.character(traits_df[[trait_sample_col]])
common <- intersect(sample_ids, trait_ids)
if (length(common) < 4) {
  cat(sprintf("ERROR: too few samples in common (%d); cannot render trait viz\n", length(common)), file = stderr())
  quit(status = 7)
}
MEsAligned <- MEsNoGrey[common, , drop = FALSE]
traits_aligned <- traits_df[match(common, trait_ids), , drop = FALSE]
rownames(traits_aligned) <- common

cat(sprintf("[trait_viz] aligned %d samples; rendering for %d folders\n",
            length(common), length(cfg$trait_buckets)))

# Folder names → label fragment for the PDF filename
.label_for <- function(folder) {
  named <- list(
    "disease_status" = "Disease",
    "total_tau" = "Total_Tau",
    "phospho_tau" = "Phospho_Tau",
    "amyloid_beta" = "Amyloid",
    "ad_pathology_composite" = "AD_Pathology",
    "all_traits_comprehensive" = "All_Traits"
  )
  if (folder %in% names(named)) named[[folder]] else folder
}

# Per the spec, the runner skips disease_status response plots (no scatter in
# reference); ad_pathology_composite/all_traits_comprehensive get no per-trait
# 04/05 PDFs at all.
.skip_response <- function(folder) folder %in% c("disease_status", "ad_pathology_composite", "all_traits_comprehensive")
.skip_correlation <- function(folder) folder %in% c("ad_pathology_composite")

folders <- names(cfg$trait_buckets)
for (folder in folders) {
  trait_cols <- cfg$trait_buckets[[folder]]
  trait_cols <- trait_cols[trait_cols %in% colnames(traits_aligned)]
  if (length(trait_cols) == 0) {
    cat(sprintf("[trait_viz] %s: no matching trait columns, skipping\n", folder))
    next
  }

  trait_dir <- file.path(network_dir, folder)
  dir.create(trait_dir, recursive = TRUE, showWarnings = FALSE)

  trait_matrix <- as.matrix(traits_aligned[, trait_cols, drop = FALSE])
  mode(trait_matrix) <- "numeric"

  # ── Correlation heatmap PDF ───────────────────────────────────────────
  if (!.skip_correlation(folder)) {
    pdf_name <- sprintf("%s_WGCNA_04_%s_Correlations.pdf", prefix, .label_for(folder))
    pdf_path <- file.path(trait_dir, pdf_name)
    tryCatch({
      cor_mat <- WGCNA::cor(MEsAligned, trait_matrix, use = "pairwise.complete.obs")
      n_eff <- nrow(MEsAligned)
      pval_mat <- WGCNA::corPvalueStudent(cor_mat, n_eff)
      text_mat <- paste(signif(cor_mat, 2), "\n(", signif(pval_mat, 1), ")", sep = "")
      dim(text_mat) <- dim(cor_mat)

      pdf_w <- max(6, length(trait_cols) * 2)
      pdf_h <- max(8, ncol(MEsAligned) * 0.28 + 3)
      pdf(pdf_path, width = pdf_w, height = pdf_h)
      par(mar = c(7, 9, 3, 3))
      WGCNA::labeledHeatmap(
        Matrix = cor_mat,
        xLabels = colnames(cor_mat),
        yLabels = colnames(MEsAligned),
        ySymbols = colnames(MEsAligned),
        colorLabels = FALSE,
        colors = WGCNA::greenWhiteRed(50),
        textMatrix = text_mat,
        setStdMargins = FALSE,
        cex.text = 0.85,
        zlim = c(-1, 1),
        main = sprintf("Module-%s Correlations", .label_for(folder))
      )
      dev.off()
      cat(sprintf("[trait_viz] wrote %s\n", pdf_path))
    }, error = function(e) {
      try(dev.off(), silent = TRUE)
      cat(sprintf("WARNING: correlation PDF failed for %s: %s\n", folder, conditionMessage(e)), file = stderr())
    })
  }

  # ── Per-trait response scatter PDF ────────────────────────────────────
  if (!.skip_response(folder)) {
    response_pdf <- sprintf("%s_WGCNA_05_%s_Response_Plots.pdf", prefix, .label_for(folder))
    response_path <- file.path(trait_dir, response_pdf)
    tryCatch({
      pdf(response_path, width = 12, height = 16)
      par(mfrow = c(5, 3), mar = c(4, 4, 3, 1))
      group_col <- if ("group" %in% colnames(mes_df)) {
        as.character(mes_df$group[match(common, sample_ids)])
      } else {
        rep("sample", length(common))
      }
      for (me_name in colnames(MEsAligned)) {
        for (trait_col in trait_cols) {
          y <- MEsAligned[, me_name]
          x <- trait_matrix[, trait_col]
          valid_idx <- is.finite(x) & is.finite(y)
          if (sum(valid_idx) < 4) next
          xv <- x[valid_idx]
          yv <- y[valid_idx]
          gv <- group_col[valid_idx]
          colors <- ifelse(toupper(gv) == "AD" | toupper(gv) == "DISEASE", "red", "blue")
          ct <- tryCatch(cor.test(xv, yv), error = function(e) NULL)
          plot(xv, yv,
               xlab = gsub("_", "-", trait_col),
               ylab = "Module Eigengene",
               main = sprintf("%s vs %s", me_name, gsub("_", "-", trait_col)),
               pch = 19, cex = 1.0, col = colors)
          if (length(unique(xv)) > 1) {
            try(abline(lm(yv ~ xv), col = "black", lwd = 1.5), silent = TRUE)
          }
          if (!is.null(ct)) {
            legend("topright",
                   legend = paste0("r = ", round(ct$estimate, 3),
                                   "\np = ", signif(ct$p.value, 3)),
                   bty = "n", cex = 0.85)
          }
        }
      }
      dev.off()
      cat(sprintf("[trait_viz] wrote %s\n", response_path))
    }, error = function(e) {
      try(dev.off(), silent = TRUE)
      cat(sprintf("WARNING: response PDF failed for %s: %s\n", folder, conditionMessage(e)), file = stderr())
    })
  }
}

cat("[trait_viz] complete\n")
