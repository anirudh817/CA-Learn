#!/usr/bin/env Rscript
# go_viz_runner.R — native R visualization for Stage 2 GO enrichment.
#
# Produces a publication-quality static heatmap (PDF) and an interactive
# plotly htmlwidget (HTML) from a Stage 2 z-score matrix written by the
# Python FET. The Python FET remains the source of truth for tables;
# this script handles ONLY the visual layer that the matplotlib output
# was approximating.
#
# Invoked as:  Rscript go_viz_runner.R <config.json>
# Config keys: stage2_dir, go_dir, prefix, display_prefix, go_label
#
# All R deps required: jsonlite, pheatmap, plotly, htmlwidgets,
#   RColorBrewer. Each is checked at the top; if any is missing the
#   script exits non-zero with a diagnostic so the Python caller can
#   fall back gracefully.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat("ERROR: go_viz_runner.R requires a config JSON path argument\n", file = stderr())
  quit(status = 2)
}

required_pkgs <- c("jsonlite", "pheatmap", "plotly", "htmlwidgets", "RColorBrewer")
missing_pkgs <- required_pkgs[!vapply(required_pkgs, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing_pkgs) > 0) {
  cat(sprintf("ERROR: missing R packages: %s\n", paste(missing_pkgs, collapse = ", ")), file = stderr())
  quit(status = 3)
}

suppressPackageStartupMessages({
  library(jsonlite)
  library(pheatmap)
  library(plotly)
  library(htmlwidgets)
  library(RColorBrewer)
})

cfg <- jsonlite::fromJSON(args[1])
required <- c("stage2_dir", "go_dir", "prefix")
for (k in required) {
  if (is.null(cfg[[k]])) {
    cat(sprintf("ERROR: config missing required key: %s\n", k), file = stderr())
    quit(status = 4)
  }
}

display_prefix <- if (!is.null(cfg$display_prefix)) cfg$display_prefix else cfg$prefix
go_label <- if (!is.null(cfg$go_label)) cfg$go_label else "PROTEOMICS"

stage2_dir <- normalizePath(cfg$stage2_dir, mustWork = FALSE)
go_dir <- cfg$go_dir
dir.create(go_dir, recursive = TRUE, showWarnings = FALSE)

zscore_path <- file.path(stage2_dir, "go_zscore_matrix.csv")
if (!file.exists(zscore_path)) {
  cat(sprintf("ERROR: stage2 z-score matrix not found at %s\n", zscore_path), file = stderr())
  quit(status = 5)
}

z <- tryCatch(
  read.csv(zscore_path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE),
  error = function(e) {
    cat(sprintf("ERROR: could not read z-score matrix: %s\n", conditionMessage(e)), file = stderr())
    quit(status = 6)
  }
)

# First column is the term; the rest are modules. Some files use "term"
# or unnamed first column — handle both.
if (ncol(z) < 2 || nrow(z) == 0) {
  cat("ERROR: z-score matrix is empty (need at least one term and one module)\n", file = stderr())
  quit(status = 7)
}
term_col <- colnames(z)[1]
terms <- as.character(z[[term_col]])
mat <- as.matrix(z[, -1, drop = FALSE])
rownames(mat) <- terms
mode(mat) <- "numeric"
mat[is.na(mat)] <- 0

# Filter rows whose absolute max is below the noise floor — keeps the
# heatmap focused on signal-bearing terms (matches piano/GOparallel default).
noise_floor <- 1.96  # ~p<0.05 two-sided
strong_rows <- apply(mat, 1, function(r) max(abs(r), na.rm = TRUE) >= noise_floor)
if (sum(strong_rows) > 1) {
  mat <- mat[strong_rows, , drop = FALSE]
}

# Limit to top N terms by max |z| so the heatmap stays legible.
top_n <- 60
if (nrow(mat) > top_n) {
  ranks <- order(-apply(abs(mat), 1, max))
  mat <- mat[ranks[seq_len(top_n)], , drop = FALSE]
}

# Symmetric color scale anchored at zero, capped at the 99th percentile
# of the data so a single outlier doesn't wash out the rest.
abs_cap <- quantile(abs(mat), probs = 0.99, na.rm = TRUE)
abs_cap <- max(abs_cap, 2.5)
breaks <- seq(-abs_cap, abs_cap, length.out = 101)
palette_fn <- colorRampPalette(rev(RColorBrewer::brewer.pal(11, "RdBu")))
cols <- palette_fn(100)

# ── PDF (publication style) ─────────────────────────────────────────────
pdf_path <- file.path(go_dir, sprintf("GSA-GO-FET_%s_Proteomics_GO-redundancyRemoved.Kbest.pdf", go_label))
fig_w <- max(8, 0.55 * ncol(mat) + 4)
fig_h <- max(7, 0.18 * nrow(mat) + 3)
tryCatch({
  pheatmap::pheatmap(
    mat,
    color = cols,
    breaks = breaks,
    cluster_rows = nrow(mat) > 2,
    cluster_cols = ncol(mat) > 2,
    fontsize_row = 8,
    fontsize_col = 9,
    angle_col = 45,
    main = sprintf("%s — GO enrichment (signed z-scores)", display_prefix),
    border_color = NA,
    treeheight_row = 18,
    treeheight_col = 14,
    filename = pdf_path,
    width = fig_w,
    height = fig_h,
    silent = TRUE,
  )
  cat(sprintf("[go_viz] wrote %s\n", pdf_path))
}, error = function(e) {
  cat(sprintf("ERROR: pheatmap failed: %s\n", conditionMessage(e)), file = stderr())
  quit(status = 8)
})

# ── Interactive HTML (plotly htmlwidget) ────────────────────────────────
html_path <- file.path(go_dir, sprintf("%s_GO_Interactive_Heatmap.html", cfg$prefix))
tryCatch({
  # Cluster ordering for nicer interactive layout.
  row_ord <- if (nrow(mat) > 2) hclust(dist(mat))$order else seq_len(nrow(mat))
  col_ord <- if (ncol(mat) > 2) hclust(dist(t(mat)))$order else seq_len(ncol(mat))
  ordered <- mat[row_ord, col_ord, drop = FALSE]

  # Text annotations for cells with |z| >= 1.96 (VIZ-01)
  ann_mat <- matrix("", nrow = nrow(ordered), ncol = ncol(ordered),
                    dimnames = dimnames(ordered))
  sig_cells <- abs(ordered) >= 1.96
  ann_mat[sig_cells] <- sprintf("%.2f", ordered[sig_cells])

  fig <- plotly::plot_ly(
    x = colnames(ordered),
    y = rownames(ordered),
    z = ordered,
    type = "heatmap",
    colors = cols,
    zmin = -abs_cap,
    zmax = abs_cap,
    hovertemplate = paste0(
      "Module: %{x}<br>",
      "Term: %{y}<br>",
      "z-score: %{z:.2f}<extra></extra>"
    ),
    colorbar = list(title = "z-score", thickness = 14),
    text = ann_mat,
    texttemplate = "%{text}",
    textfont = list(size = 8, color = "black")
  )
  fig <- plotly::layout(
    fig,
    title = list(text = sprintf("%s — GO enrichment", display_prefix), x = 0.02),
    xaxis = list(title = "Module", tickangle = -45, automargin = TRUE),
    yaxis = list(title = "", automargin = TRUE, autorange = "reversed"),
    margin = list(l = 220, r = 60, t = 70, b = 110)
  )
  htmlwidgets::saveWidget(fig, html_path, selfcontained = TRUE, libdir = NULL)
  cat(sprintf("[go_viz] wrote %s\n", html_path))
}, error = function(e) {
  cat(sprintf("ERROR: plotly htmlwidget save failed: %s\n", conditionMessage(e)), file = stderr())
  # Don't fail the whole run if only the HTML breaks — PDF is the canonical fallback.
})

cat("[go_viz] complete\n")
