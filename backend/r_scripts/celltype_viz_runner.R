#!/usr/bin/env Rscript
# celltype_viz_runner.R — native R visualization for Stage 3 CellType FET.
#
# Same pattern as go_viz_runner.R: Python FET writes the source-of-truth
# table (celltype_FDR_matrix.csv) and this script renders the publication-
# quality static heatmap (PDF) plus an interactive plotly htmlwidget (HTML),
# directly into the deliverable CellTypeFET directory at the canonical paths
# the artifact_manifest routes for `cells.heatmap`.
#
# Invoked as:  Rscript celltype_viz_runner.R <config.json>
# Config keys: stage3_dir, cell_dir, prefix, display_prefix, input_level
#
# input_level controls the deliverable filename suffix ("Peptides" vs
# "Proteins") to match the reference deliverable file naming.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat("ERROR: celltype_viz_runner.R requires a config JSON path argument\n", file = stderr())
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
required <- c("stage3_dir", "cell_dir", "prefix")
for (k in required) {
  if (is.null(cfg[[k]])) {
    cat(sprintf("ERROR: config missing required key: %s\n", k), file = stderr())
    quit(status = 4)
  }
}

display_prefix <- if (!is.null(cfg$display_prefix)) cfg$display_prefix else cfg$prefix
input_level <- if (!is.null(cfg$input_level)) tolower(cfg$input_level) else "unknown"
data_type_label <- if (input_level == "protein") "Proteins" else "Peptides"

stage3_dir <- normalizePath(cfg$stage3_dir, mustWork = FALSE)
cell_dir <- cfg$cell_dir
dir.create(cell_dir, recursive = TRUE, showWarnings = FALSE)

fdr_path <- file.path(stage3_dir, "celltype_FDR_matrix.csv")
if (!file.exists(fdr_path)) {
  cat(sprintf("ERROR: celltype FDR matrix not found at %s\n", fdr_path), file = stderr())
  quit(status = 5)
}

m <- tryCatch(
  read.csv(fdr_path, header = TRUE, check.names = FALSE, stringsAsFactors = FALSE),
  error = function(e) {
    cat(sprintf("ERROR: could not read FDR matrix: %s\n", conditionMessage(e)), file = stderr())
    quit(status = 6)
  }
)

if (ncol(m) < 2 || nrow(m) == 0) {
  cat("ERROR: celltype FDR matrix is empty (need at least one module and one cell type)\n", file = stderr())
  quit(status = 7)
}

# First column is the module label; the rest are cell types with -log10(FDR) values.
module_col <- colnames(m)[1]
modules <- as.character(m[[module_col]])
mat <- as.matrix(m[, -1, drop = FALSE])
rownames(mat) <- modules
mode(mat) <- "numeric"
mat[is.na(mat)] <- 0

# All non-negative (these are -log10 FDR), so palette is sequential not diverging.
max_v <- max(mat, na.rm = TRUE)
# Cap at the 99th percentile to keep one outlier from washing out the palette.
cap <- max(quantile(mat, probs = 0.99, na.rm = TRUE), 1.301)  # ~p<0.05
breaks <- seq(0, cap, length.out = 101)
palette_fn <- colorRampPalette(RColorBrewer::brewer.pal(9, "YlGnBu"))
cols <- palette_fn(100)

# ── PDF — overlap heatmap ───────────────────────────────────────────────
pdf_path <- file.path(cell_dir, sprintf("%s_%s_CellTypeFET.Overlap.pdf", cfg$prefix, data_type_label))
fig_w <- max(7, 0.55 * ncol(mat) + 4)
fig_h <- max(6, 0.4 * nrow(mat) + 3)
tryCatch({
  pheatmap::pheatmap(
    mat,
    color = cols,
    breaks = breaks,
    cluster_rows = nrow(mat) > 2,
    cluster_cols = ncol(mat) > 2,
    fontsize_row = 9,
    fontsize_col = 9,
    angle_col = 45,
    main = sprintf("%s — Cell-type FET overlap (-log10 FDR)", display_prefix),
    border_color = "white",
    treeheight_row = 16,
    treeheight_col = 14,
    filename = pdf_path,
    width = fig_w,
    height = fig_h,
    silent = TRUE,
  )
  cat(sprintf("[celltype_viz] wrote %s\n", pdf_path))
}, error = function(e) {
  cat(sprintf("ERROR: pheatmap failed: %s\n", conditionMessage(e)), file = stderr())
  quit(status = 8)
})

# ── PDF — bar chart overview (top hits per module) ──────────────────────
bar_path <- file.path(cell_dir, sprintf("%s_%s_CellTypeFET_barChart.Overlap.pdf", cfg$prefix, data_type_label))
tryCatch({
  pdf(bar_path, width = max(8, 0.45 * nrow(mat) + 4), height = 6)
  on.exit(while (!is.null(dev.list())) dev.off(), add = TRUE)
  par(mar = c(7, 5, 3, 1))
  # For each module, the top-1 cell type's -log10 FDR.
  top_per_module <- apply(mat, 1, max)
  top_celltype <- apply(mat, 1, function(r) colnames(mat)[which.max(r)])
  # Color each bar by the cell type that won
  ct_colors <- setNames(
    colorRampPalette(RColorBrewer::brewer.pal(8, "Set2"))(length(unique(top_celltype))),
    unique(top_celltype)
  )
  bar_cols <- ct_colors[top_celltype]
  barplot(
    top_per_module,
    names.arg = rownames(mat),
    las = 2,
    col = bar_cols,
    border = NA,
    ylab = "-log10(FDR) of top cell type per module",
    main = sprintf("%s — Top cell-type per module", display_prefix),
    cex.names = 0.85,
  )
  legend("topright", legend = names(ct_colors), fill = ct_colors, bty = "n", cex = 0.75)
  cat(sprintf("[celltype_viz] wrote %s\n", bar_path))
}, error = function(e) {
  cat(sprintf("WARNING: bar chart failed: %s\n", conditionMessage(e)), file = stderr())
  # Bar chart is best-effort — don't fail the whole script.
})

# ── Interactive HTML (plotly) ───────────────────────────────────────────
html_path <- file.path(cell_dir, sprintf("%s_CellTypeFET_Interactive_Heatmap.html", cfg$prefix))
tryCatch({
  row_ord <- if (nrow(mat) > 2) hclust(dist(mat))$order else seq_len(nrow(mat))
  col_ord <- if (ncol(mat) > 2) hclust(dist(t(mat)))$order else seq_len(ncol(mat))
  ordered <- mat[row_ord, col_ord, drop = FALSE]

  # Star significance markers for cells where -log10(FDR) >= 1.301 (VIZ-02)
  star_mat <- matrix("", nrow = nrow(ordered), ncol = ncol(ordered),
                     dimnames = dimnames(ordered))
  star_mat[ordered >= 3.0] <- "***"
  star_mat[ordered >= 2.0 & ordered < 3.0] <- "**"
  star_mat[ordered >= 1.301 & ordered < 2.0] <- "*"

  fig <- plotly::plot_ly(
    x = colnames(ordered),
    y = rownames(ordered),
    z = ordered,
    type = "heatmap",
    colors = cols,
    zmin = 0,
    zmax = cap,
    hovertemplate = paste0(
      "Module: %{y}<br>",
      "Cell type: %{x}<br>",
      "-log10(FDR): %{z:.2f}<extra></extra>"
    ),
    colorbar = list(title = "-log10(FDR)", thickness = 14),
    text = star_mat,
    texttemplate = "%{text}",
    textfont = list(size = 10, color = "black")
  )
  fig <- plotly::layout(
    fig,
    title = list(text = sprintf("%s — Cell-type FET overlap", display_prefix), x = 0.02),
    xaxis = list(title = "Cell type", tickangle = -45, automargin = TRUE),
    yaxis = list(title = "Module", automargin = TRUE, autorange = "reversed"),
    margin = list(l = 120, r = 60, t = 70, b = 110)
  )
  htmlwidgets::saveWidget(fig, html_path, selfcontained = TRUE, libdir = NULL)
  cat(sprintf("[celltype_viz] wrote %s\n", html_path))
}, error = function(e) {
  cat(sprintf("WARNING: plotly htmlwidget save failed: %s\n", conditionMessage(e)), file = stderr())
})

cat("[celltype_viz] complete\n")
