#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(jsonlite)
  library(WGCNA)
  library(limma)
  library(dynamicTreeCut)
})

options(stringsAsFactors = FALSE)
allowWGCNAThreads()

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  stop("Usage: Rscript stage1_parity.R <config.json>")
}

config_path <- args[1]
if (!file.exists(config_path)) {
  stop(paste("Config file not found:", config_path))
}

CONFIG <- fromJSON(config_path, simplifyVector = TRUE)

msg <- function(text) {
  cat(sprintf("[%s] %s\n", format(Sys.time(), "%H:%M:%S"), text))
  flush.console()
}

# -- RPIP-06: WGCNA reproducibility seed ------------------------------------------
wgcna_seed <- if (!is.null(CONFIG$wgcna_seed) && !is.na(CONFIG$wgcna_seed)) {
  as.integer(CONFIG$wgcna_seed)
} else {
  sample.int(1e6, 1)
}
set.seed(wgcna_seed)
msg(sprintf("WGCNA seed: %d", wgcna_seed))

safe_numeric <- function(df) {
  out <- as.data.frame(
    lapply(df, function(col) suppressWarnings(as.numeric(as.character(col)))),
    check.names = FALSE,
    stringsAsFactors = FALSE
  )
  colnames(out) <- colnames(df)
  out
}

read_json_if_exists <- function(path) {
  if (!file.exists(path)) {
    return(list())
  }
  fromJSON(path, simplifyVector = TRUE)
}

first_existing <- function(values, choices) {
  matches <- choices[choices %in% values]
  if (length(matches) == 0) {
    return(NULL)
  }
  matches[[1]]
}

quantile_normalize_matrix <- function(data_matrix) {
  normalized <- data_matrix
  sorted_matrix <- apply(data_matrix, 2, sort, na.last = TRUE)
  row_means <- rowMeans(sorted_matrix, na.rm = TRUE)
  for (j in seq_len(ncol(data_matrix))) {
    ranks <- rank(data_matrix[, j], ties.method = "average", na.last = "keep")
    normalized[, j] <- row_means[pmax(1, pmin(length(row_means), ceiling(ranks)))]
  }
  normalized
}

column_normalize_log2 <- function(log2_matrix, method) {
  if (method == "median") {
    sample_stats <- apply(log2_matrix, 2, median, na.rm = TRUE)
    global_stat <- median(sample_stats, na.rm = TRUE)
    return(sweep(log2_matrix, 2, global_stat - sample_stats, "+"))
  }
  if (method == "mean") {
    sample_stats <- apply(log2_matrix, 2, mean, na.rm = TRUE)
    global_stat <- mean(sample_stats, na.rm = TRUE)
    return(sweep(log2_matrix, 2, global_stat - sample_stats, "+"))
  }
  if (method == "quantile") {
    return(quantile_normalize_matrix(log2_matrix))
  }
  if (method == "zscore") {
    sample_means <- apply(log2_matrix, 2, mean, na.rm = TRUE)
    sample_sds <- apply(log2_matrix, 2, sd, na.rm = TRUE)
    sample_sds[is.na(sample_sds) | sample_sds == 0] <- 1
    return(sweep(sweep(log2_matrix, 2, sample_means, "-"), 2, sample_sds, "/"))
  }
  log2_matrix
}

total_intensity_normalize <- function(raw_matrix, constant = 1) {
  totals <- colSums(raw_matrix, na.rm = TRUE)
  totals[totals <= 0 | is.na(totals)] <- median(totals[totals > 0], na.rm = TRUE)
  reference_total <- max(totals, na.rm = TRUE)
  relative <- sweep(raw_matrix, 2, totals, "/")
  normalized_linear <- relative * reference_total
  normalized_log2 <- log2(normalized_linear + constant)
  list(
    normalized_linear = normalized_linear,
    normalized_log2 = normalized_log2,
    totals = totals,
    reference_total = reference_total
  )
}

guess_log_scale <- function(data_matrix, format_family) {
  family_lower <- tolower(format_family)
  if (family_lower == "olink") {
    return(TRUE)
  }
  finite_values <- as.numeric(unlist(data_matrix))
  finite_values <- finite_values[is.finite(finite_values)]
  if (length(finite_values) == 0) {
    return(FALSE)
  }
  q95 <- as.numeric(quantile(finite_values, 0.95, na.rm = TRUE))
  q50 <- as.numeric(median(finite_values, na.rm = TRUE))
  q05 <- as.numeric(quantile(finite_values, 0.05, na.rm = TRUE))
  q95 < 50 && q50 < 25 && q05 > -20
}

make_traits_frame <- function(sample_meta, traits_path, cohort1, cohort2) {
  sample_ids <- as.character(sample_meta$sample_name)
  disease <- ifelse(sample_meta$group == cohort2, 1, ifelse(sample_meta$group == cohort1, 0, NA))
  traits <- data.frame(
    SAMPLE_ID = sample_ids,
    Disease = disease,
    stringsAsFactors = FALSE
  )
  safe_ids <- ifelse(is.na(sample_ids) | sample_ids == "", paste0("sample_", seq_along(sample_ids)), sample_ids)
  rownames(traits) <- make.unique(safe_ids)

  if (file.exists(traits_path)) {
    traits_df <- read.csv(traits_path, stringsAsFactors = FALSE, check.names = FALSE)
    sample_col <- first_existing(colnames(traits_df), c("SAMPLE_ID", "sample_name", "Sample", "sample"))
    if (!is.null(sample_col)) {
      trait_ids <- as.character(traits_df[[sample_col]])
      rownames(traits_df) <- make.unique(ifelse(is.na(trait_ids) | trait_ids == "", paste0("trait_", seq_along(trait_ids)), trait_ids))
      traits_df <- traits_df[sample_ids, , drop = FALSE]
      numeric_cols <- names(traits_df)[sapply(traits_df, is.numeric)]
      numeric_cols <- setdiff(numeric_cols, c("Disease"))
      for (column in numeric_cols) {
        values <- suppressWarnings(as.numeric(traits_df[[column]]))
        if (sum(!is.na(values)) >= 3) {
          traits[[column]] <- values
        }
      }
    }
  }

  traits
}

write_trait_heatmap <- function(moduleTraitCor, moduleTraitPvalue, output_file) {
  if (nrow(moduleTraitCor) == 0 || ncol(moduleTraitCor) == 0) {
    write.csv(data.frame(module_color = character()), output_file, row.names = FALSE)
    return()
  }
  out <- data.frame(module_color = rownames(moduleTraitCor), stringsAsFactors = FALSE)
  for (column in colnames(moduleTraitCor)) {
    out[[paste0("cor_", column)]] <- as.numeric(moduleTraitCor[, column])
    out[[paste0("p_", column)]] <- as.numeric(moduleTraitPvalue[, column])
  }
  write.csv(out, output_file, row.names = FALSE)
}

build_network_edges <- function(MEsNoGrey, output_file) {
  if (ncol(MEsNoGrey) < 2) {
    write.csv(data.frame(source = character(), target = character(), weight = numeric()), output_file, row.names = FALSE)
    return()
  }
  cor_matrix <- cor(MEsNoGrey, use = "pairwise.complete.obs")
  edges <- list()
  row_index <- 1
  modules <- colnames(cor_matrix)
  for (i in seq_len(ncol(cor_matrix))) {
    for (j in seq_len(ncol(cor_matrix))) {
      if (j <= i) {
        next
      }
      value <- cor_matrix[i, j]
      if (is.finite(value) && abs(value) >= 0.35) {
        edges[[row_index]] <- data.frame(
          source = gsub("^ME", "", modules[i]),
          target = gsub("^ME", "", modules[j]),
          weight = round(as.numeric(value), 4),
          stringsAsFactors = FALSE
        )
        row_index <- row_index + 1
      }
    }
  }
  if (length(edges) == 0) {
    write.csv(data.frame(source = character(), target = character(), weight = numeric()), output_file, row.names = FALSE)
  } else {
    write.csv(do.call(rbind, edges), output_file, row.names = FALSE)
  }
}

write_module_response_plots <- function(MEsNoGrey, sample_groups, cohort1, cohort2, output_file) {
  if (is.null(MEsNoGrey) || ncol(MEsNoGrey) == 0 || length(sample_groups) != nrow(MEsNoGrey)) {
    return()
  }

  groups <- factor(as.character(sample_groups), levels = unique(c(cohort1, cohort2, unique(as.character(sample_groups)))))
  valid <- !is.na(groups)
  if (sum(valid) < 4 || length(unique(groups[valid])) < 2) {
    return()
  }

  module_names <- colnames(MEsNoGrey)
  if (length(module_names) == 0) {
    return()
  }

  n_cols <- 4
  n_rows <- ceiling(length(module_names) / n_cols)
  width <- max(12, n_cols * 3.1)
  height <- max(8, n_rows * 3.2)

  pdf(output_file, width = width, height = height)
  old_par <- par(no.readonly = TRUE)
  on.exit({
    try(par(old_par), silent = TRUE)
    try(dev.off(), silent = TRUE)
  }, add = TRUE)
  par(mfrow = c(n_rows, n_cols), mar = c(4.2, 4.1, 3.2, 1.2))

  for (module in module_names) {
    module_data <- data.frame(
      ME = as.numeric(MEsNoGrey[, module]),
      Group = groups,
      stringsAsFactors = FALSE
    )
    module_data <- module_data[!is.na(module_data$ME) & !is.na(module_data$Group), , drop = FALSE]

    p_value <- tryCatch(
      t.test(ME ~ Group, data = module_data)$p.value,
      error = function(e) NA_real_
    )

    boxplot(
      ME ~ Group,
      data = module_data,
      main = paste0(gsub("^ME", "", module), "\np = ", format(p_value, digits = 3, scientific = TRUE)),
      xlab = "Group",
      ylab = "Module Eigengene",
      col = c("#dbeafe", "#fee2e2"),
      outline = FALSE
    )
    stripchart(
      ME ~ Group,
      data = module_data,
      vertical = TRUE,
      method = "jitter",
      add = TRUE,
      pch = 20,
      col = "#1f2937",
      cex = 0.7
    )
  }

  invisible(NULL)
}

safe_cor <- function(x, y) {
  if (all(is.na(x)) || all(is.na(y))) {
    return(c(NA_real_, 1))
  }
  tryCatch({
    valid <- !is.na(x) & !is.na(y)
    if (sum(valid) < 3) {
      return(c(NA_real_, 1))
    }
    result <- cor.test(x[valid], y[valid], method = "pearson")
    c(as.numeric(result$estimate), as.numeric(result$p.value))
  }, error = function(e) c(NA_real_, 1))
}

input_dir <- CONFIG$input_dir
output_dir <- CONFIG$output_directory
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

matrix_path <- file.path(input_dir, "cleaned_matrix.csv")
sample_meta_path <- file.path(input_dir, "sample_metadata.csv")
# Honor an explicit traits_path config key (set by pipeline.py when it writes
# expanded_traits.csv with _raw/_std variants); fall back to input/traits.csv.
if (!is.null(CONFIG$traits_path) && nzchar(CONFIG$traits_path) && file.exists(CONFIG$traits_path)) {
  traits_path <- CONFIG$traits_path
} else {
  traits_path <- file.path(input_dir, "traits.csv")
}
manifest_path <- file.path(input_dir, "dataset_manifest.json")

if (!file.exists(matrix_path) || !file.exists(sample_meta_path)) {
  stop("Canonical input bundle not found. Expected cleaned_matrix.csv and sample_metadata.csv.")
}

msg("Loading canonical matrix bundle")
matrix_df <- read.csv(matrix_path, stringsAsFactors = FALSE, check.names = FALSE)
sample_meta <- read.csv(sample_meta_path, stringsAsFactors = FALSE, check.names = FALSE)
sample_meta$sample_name <- as.character(sample_meta$sample_name)
sample_meta$group <- as.character(sample_meta$group)

manifest <- read_json_if_exists(manifest_path)

cohort1 <- CONFIG$group1_name
cohort2 <- CONFIG$group2_name
format_family <- if (!is.null(CONFIG$format_family)) CONFIG$format_family else if (!is.null(manifest$format_family)) manifest$format_family else "Generic"
input_level <- if (!is.null(CONFIG$input_level)) CONFIG$input_level else if (!is.null(manifest$assay_level)) manifest$assay_level else "unknown"
normalization_method <- tolower(if (!is.null(CONFIG$normalization_method)) CONFIG$normalization_method else "median")
missing_value_threshold <- as.numeric(CONFIG$missing_value_threshold)
min_samples_present <- as.integer(CONFIG$min_samples_present)
log_transform_requested <- isTRUE(CONFIG$log_transform)
statistical_test <- tolower(CONFIG$statistical_test)
use_adjusted <- isTRUE(CONFIG$use_adjusted_pvalue)
pvalue_threshold <- as.numeric(CONFIG$pvalue_threshold)
fold_change_threshold <- as.numeric(CONFIG$fold_change_threshold)
multiple_testing_method <- tolower(if (!is.null(CONFIG$multiple_testing_method)) CONFIG$multiple_testing_method else "fdr_bh")
p_adjust_method <- if (multiple_testing_method == "bonferroni") "bonferroni" else "BH"
soft_power <- as.integer(CONFIG$wgcna_soft_threshold)
min_module_size <- as.integer(CONFIG$wgcna_min_module_size)
deep_split <- as.integer(CONFIG$wgcna_deep_split)
merge_cut_height <- as.numeric(CONFIG$wgcna_merge_cut_height)
network_type <- if (!is.null(CONFIG$wgcna_network_type)) CONFIG$wgcna_network_type else "signed"
correlation_type <- if (!is.null(CONFIG$wgcna_correlation_type)) CONFIG$wgcna_correlation_type else "bicor"
correlation_function <- if (correlation_type == "pearson") "cor" else correlation_type
tom_type <- if (!is.null(CONFIG$wgcna_tom_type)) CONFIG$wgcna_tom_type else network_type
pam_stage <- if (!is.null(CONFIG$wgcna_pam_stage)) isTRUE(CONFIG$wgcna_pam_stage) else TRUE
wgcna_power_mode <- tolower(if (!is.null(CONFIG$wgcna_power_mode)) CONFIG$wgcna_power_mode else "fixed")
wgcna_auto_power_cutoff <- if (!is.null(CONFIG$wgcna_auto_power_cutoff)) as.numeric(CONFIG$wgcna_auto_power_cutoff) else 0.8
hub_percentile <- if (!is.null(CONFIG$wgcna_hub_percentile)) as.numeric(CONFIG$wgcna_hub_percentile) else 0.2
# Cap the WGCNA network at the top-N most-variable features. Single-block WGCNA on
# the full feature set builds dense feature x feature matrices (~2.6 GB each at
# ~18k features) and can exceed available RAM (OOM-kill). Restricting the network
# to the most-variable features is standard WGCNA practice; DE still runs on all
# features, and non-network features are reported as grey/Unassigned. 0/negative
# disables the cap.
wgcna_max_features <- if (!is.null(CONFIG$wgcna_max_features)) as.integer(CONFIG$wgcna_max_features) else 5000L

sample_columns <- intersect(sample_meta$sample_name, colnames(matrix_df))
sample_meta <- sample_meta[match(sample_columns, sample_meta$sample_name), , drop = FALSE]
rownames(sample_meta) <- sample_meta$sample_name

group1_cols <- sample_meta$sample_name[sample_meta$group == cohort1]
group2_cols <- sample_meta$sample_name[sample_meta$group == cohort2]

if (length(group1_cols) < 2 || length(group2_cols) < 2) {
  stop(sprintf(
    "Need at least 2 samples per group for Stage 1. Found %d %s and %d %s.",
    length(group1_cols), cohort1, length(group2_cols), cohort2
  ))
}

matrix_numeric <- safe_numeric(matrix_df[, sample_columns, drop = FALSE])
raw_matrix <- as.matrix(matrix_numeric)
rownames(raw_matrix) <- as.character(matrix_df$feature_id)
feature_ids <- rownames(raw_matrix)
gene_names <- if ("gene" %in% colnames(matrix_df)) as.character(matrix_df$gene) else feature_ids
gene_names[is.na(gene_names) | gene_names == ""] <- feature_ids[is.na(gene_names) | gene_names == ""]

intensity_like <- tolower(format_family) != "olink"
if (intensity_like) {
  raw_matrix[raw_matrix <= 0] <- NA
}

msg(sprintf("Loaded %d features x %d samples (%s / %s)", nrow(raw_matrix), ncol(raw_matrix), format_family, input_level))

present_fraction <- rowMeans(!is.na(raw_matrix))
present_counts <- rowSums(!is.na(raw_matrix))
keep_rows <- present_fraction >= (1 - missing_value_threshold) & present_counts >= min_samples_present

raw_matrix <- raw_matrix[keep_rows, , drop = FALSE]
feature_ids <- feature_ids[keep_rows]
gene_names <- gene_names[keep_rows]

msg(sprintf("Retained %d features after missingness and sample-present filters", nrow(raw_matrix)))

already_logged <- identical(CONFIG$value_scale, "log2") || guess_log_scale(raw_matrix, format_family)
if (tolower(format_family) == "olink" && normalization_method == "tin") {
  msg("Olink NPX is already log-scale; switching normalization from TIN to median")
  normalization_method <- "median"
}

normalized_log2 <- NULL
normalized_linear <- NULL
log_transform_applied <- FALSE
network_input_scale <- "log2"

if (normalization_method == "tin") {
  msg("Applying total intensity normalization (TIN)")
  tin_result <- total_intensity_normalize(raw_matrix, constant = 1)
  normalized_linear <- tin_result$normalized_linear
  normalized_log2 <- tin_result$normalized_log2
  log_transform_applied <- TRUE
  network_input <- normalized_linear
  network_input_scale <- "linear"
} else {
  working_log2 <- raw_matrix
  if (!already_logged && log_transform_requested) {
    msg("Applying log2 transform before column normalization")
    working_log2 <- log2(raw_matrix + 1)
    log_transform_applied <- TRUE
  } else if (already_logged) {
    msg("Detected log-scale input; skipping additional log2 transform")
  } else {
    msg("Leaving input on original scale because log handling is disabled")
  }

  msg(sprintf("Applying %s normalization", normalization_method))
  normalized_log2 <- column_normalize_log2(working_log2, normalization_method)
  if (tolower(format_family) == "olink" || !log_transform_requested) {
    normalized_linear <- normalized_log2
    network_input <- normalized_log2
    network_input_scale <- "log2"
  } else {
    normalized_linear <- 2^normalized_log2
    network_input <- normalized_linear
    network_input_scale <- "linear"
  }
}

normalized_df <- data.frame(feature_id = feature_ids, gene = gene_names, normalized_log2, check.names = FALSE)
write.csv(normalized_df, file.path(output_dir, "normalized_matrix.csv"), row.names = FALSE)

normalized_linear_df <- data.frame(feature_id = feature_ids, gene = gene_names, normalized_linear, check.names = FALSE)
write.csv(normalized_linear_df, file.path(output_dir, "normalized_linear_matrix.csv"), row.names = FALSE)

msg("Running differential expression")

g1_idx <- match(group1_cols, colnames(normalized_log2))
g2_idx <- match(group2_cols, colnames(normalized_log2))
group1_matrix <- normalized_log2[, g1_idx, drop = FALSE]
group2_matrix <- normalized_log2[, g2_idx, drop = FALSE]

group1_means <- apply(group1_matrix, 1, function(row) mean(row, na.rm = TRUE))
group2_means <- apply(group2_matrix, 1, function(row) mean(row, na.rm = TRUE))
log2fc <- group2_means - group1_means

pvalues <- rep(1, nrow(normalized_log2))
for (i in seq_len(nrow(normalized_log2))) {
  a <- group1_matrix[i, ]
  b <- group2_matrix[i, ]
  a <- a[!is.na(a)]
  b <- b[!is.na(b)]
  if (length(a) < 2 || length(b) < 2) {
    pvalues[i] <- 1
    next
  }
  pvalues[i] <- tryCatch({
    if (grepl("wilcoxon|mann", statistical_test)) {
      wilcox.test(a, b, exact = FALSE)$p.value
    } else {
      t.test(a, b, var.equal = FALSE)$p.value
    }
  }, error = function(e) 1)
}
pvalues[!is.finite(pvalues)] <- 1
adj_pvalues <- p.adjust(pvalues, method = p_adjust_method)

metric_values <- if (use_adjusted) adj_pvalues else pvalues
metric_values[!is.finite(metric_values)] <- 1
fc_cutoff <- log2(fold_change_threshold)
significant <- abs(log2fc) >= fc_cutoff & metric_values < pvalue_threshold
direction <- ifelse(significant & log2fc > 0, "up", ifelse(significant & log2fc < 0, "down", "ns"))

n_sig <- sum(significant, na.rm = TRUE)
n_up <- sum(significant & log2fc > 0, na.rm = TRUE)
n_down <- sum(significant & log2fc < 0, na.rm = TRUE)

volcano_results <- data.frame(
  peptide_id = feature_ids,
  feature_id = feature_ids,
  gene = gene_names,
  log2fc = round(as.numeric(log2fc), 6),
  pvalue = signif(as.numeric(pvalues), 8),
  adj_pvalue = signif(as.numeric(adj_pvalues), 8),
  significant = as.integer(significant),
  direction = direction,
  module = "grey",
  stringsAsFactors = FALSE
)

module_colors <- rep("grey", nrow(normalized_log2))
assigned_kme <- rep(NA_real_, nrow(normalized_log2))
alt_module <- rep(NA_character_, nrow(normalized_log2))
alt_kme <- rep(NA_real_, nrow(normalized_log2))
module_quality <- rep("Unassigned", nrow(normalized_log2))
moduleTraitCor <- matrix(nrow = 0, ncol = 0)
moduleTraitPvalue <- matrix(nrow = 0, ncol = 0)
MEsNoGrey <- NULL
selected_power <- soft_power
power_fit <- NA_real_

datExpr <- t(network_input)
if (ncol(datExpr) >= max(20, min_module_size) && nrow(datExpr) >= 4) {
  msg(sprintf("Running WGCNA with power=%d, minModuleSize=%d, deepSplit=%d, mergeCutHeight=%.2f", soft_power, min_module_size, deep_split, merge_cut_height))

  gsg <- goodSamplesGenes(datExpr, verbose = 0)
  if (!gsg$allOK) {
    msg(sprintf("Removing %d bad samples and %d bad features prior to WGCNA", sum(!gsg$goodSamples), sum(!gsg$goodGenes)))
    datExpr <- datExpr[gsg$goodSamples, gsg$goodGenes, drop = FALSE]
  }

  # Restrict the network to the top-N most-variable features (bounds memory/time;
  # see wgcna_max_features). DE/volcano already ran on the full feature set above —
  # here we only narrow WGCNA's input. Module assignments map back by feature name,
  # so dropped features simply remain grey/Unassigned in module_assignments.csv.
  if (wgcna_max_features > 0 && ncol(datExpr) > wgcna_max_features) {
    feature_variances <- apply(datExpr, 2, var, na.rm = TRUE)
    keep <- sort(order(feature_variances, decreasing = TRUE)[seq_len(wgcna_max_features)])
    datExpr <- datExpr[, keep, drop = FALSE]
    msg(sprintf("WGCNA: using top %d most-variable features (of %d) to bound memory", ncol(datExpr), length(feature_variances)))
  }

  selected_power <- max(1, soft_power)
  powers <- c(1:10, seq(12, 20, by = 2))
  power_fit_df <- tryCatch({
    pickSoftThreshold(
      datExpr,
      powerVector = powers,
      corFnc = correlation_function,
      networkType = network_type,
      verbose = 0
    )$fitIndices
  }, error = function(e) NULL)

  if (!is.null(power_fit_df)) {
    if (wgcna_power_mode == "auto_pick") {
      fit_values <- -sign(power_fit_df$slope) * power_fit_df$SFT.R.sq
      passing <- which(is.finite(fit_values) & fit_values >= wgcna_auto_power_cutoff)
      auto_selected_power <- if (length(passing) > 0) {
        power_fit_df$Power[passing[1]]
      } else if (any(is.finite(fit_values))) {
        power_fit_df$Power[which.max(ifelse(is.finite(fit_values), fit_values, -Inf))]
      } else {
        max(1, soft_power)
      }
      selected_power <- auto_selected_power
    }
    power_fit <- power_fit_df$SFT.R.sq[match(selected_power, power_fit_df$Power)]
    write.csv(power_fit_df, file.path(output_dir, "wgcna_power_diagnostics.csv"), row.names = FALSE)
  } else {
    write.csv(data.frame(Power = integer(), SFT.R.sq = numeric()), file.path(output_dir, "wgcna_power_diagnostics.csv"), row.names = FALSE)
  }

  # Top-level Sample Clustering QC PDF (native R, replaces Python matplotlib substitute).
  tryCatch({
    pdf(file.path(output_dir, "sample_clustering_qc.pdf"), width = 12, height = 9)
    par(cex = 0.6, mar = c(0, 4, 2, 0))
    sample_tree <- hclust(dist(datExpr), method = "average")
    plot(sample_tree, main = "Sample clustering to detect outliers",
         sub = "", xlab = "", cex.lab = 1.5, cex.axis = 1.5, cex.main = 2)
    dev.off()
  }, error = function(e) {
    try(dev.off(), silent = TRUE)
    message(sprintf("[stage1_parity] sample_clustering_qc.pdf failed: %s", conditionMessage(e)))
  })

  # Top-level Power Selection PDF (two-panel native R: scale-free fit R² + mean connectivity).
  if (!is.null(power_fit_df) && nrow(power_fit_df) > 0) {
    tryCatch({
      pdf(file.path(output_dir, "power_selection.pdf"), width = 9, height = 5)
      par(mfrow = c(1, 2), cex = 0.9)
      plot(power_fit_df[, 1], -sign(power_fit_df[, 3]) * power_fit_df[, 2],
           xlab = "Soft Threshold (power)",
           ylab = "Scale Free Topology Model Fit, signed R²",
           type = "n", main = "Scale independence")
      text(power_fit_df[, 1], -sign(power_fit_df[, 3]) * power_fit_df[, 2],
           labels = power_fit_df[, 1], col = "red")
      abline(h = 0.85, col = "red")
      plot(power_fit_df[, 1], power_fit_df[, 5],
           xlab = "Soft Threshold (power)",
           ylab = "Mean Connectivity",
           type = "n", main = "Mean connectivity")
      text(power_fit_df[, 1], power_fit_df[, 5],
           labels = power_fit_df[, 1], col = "red")
      dev.off()
    }, error = function(e) {
      try(dev.off(), silent = TRUE)
      message(sprintf("[stage1_parity] power_selection.pdf failed: %s", conditionMessage(e)))
    })
  }

  net <- tryCatch({
    blockwiseModules(
      datExpr,
      power = selected_power,
      TOMType = tom_type,
      minModuleSize = min_module_size,
      mergeCutHeight = merge_cut_height,
      numericLabels = TRUE,
      deepSplit = deep_split,
      saveTOMs = FALSE,
      maxBlockSize = max(20000, ncol(datExpr) + 1000),
      corType = correlation_type,
      networkType = network_type,
      pamStage = pam_stage,
      pamRespectsDendro = TRUE,
      verbose = 0
    )
  }, error = function(e) {
    msg(paste("WGCNA failed:", e$message))
    NULL
  })

  if (!is.null(net)) {
    module_colors_good <- labels2colors(net$colors)
    names(module_colors_good) <- colnames(datExpr)

    MEList <- moduleEigengenes(datExpr, colors = module_colors_good)
    MEs <- orderMEs(MEList$eigengenes)
    kME_matrix <- signedKME(datExpr, MEs, corFnc = correlation_type)

    for (feature_name in names(module_colors_good)) {
      original_index <- match(feature_name, feature_ids)
      assigned_module <- module_colors_good[[feature_name]]
      module_colors[original_index] <- assigned_module
      assigned_column <- paste0("kME", assigned_module)
      if (assigned_module != "grey" && assigned_column %in% colnames(kME_matrix)) {
        assigned_kme[original_index] <- as.numeric(kME_matrix[feature_name, assigned_column])
        alternatives <- setdiff(colnames(kME_matrix), assigned_column)
        if (length(alternatives) > 0) {
          alternative_values <- as.numeric(kME_matrix[feature_name, alternatives])
          if (length(alternative_values) > 0 && any(is.finite(alternative_values))) {
            alternative_index <- which.max(abs(alternative_values))
            alt_module[original_index] <- gsub("^kME", "", alternatives[alternative_index])
            alt_kme[original_index] <- alternative_values[alternative_index]
          }
        }
      }
    }

    module_quality[!is.na(assigned_kme) & abs(assigned_kme) >= 0.7] <- "High"
    module_quality[!is.na(assigned_kme) & abs(assigned_kme) < 0.7] <- "Medium"
    module_quality[!is.na(assigned_kme) & abs(assigned_kme) < 0.5] <- "Low"

    traits <- make_traits_frame(sample_meta[rownames(datExpr), , drop = FALSE], traits_path, cohort1, cohort2)
    trait_numeric <- traits[, sapply(traits, is.numeric), drop = FALSE]
    if (ncol(trait_numeric) > 0) {
      MEsNoGrey <- MEs[, !grepl("^MEgrey$", colnames(MEs)), drop = FALSE]
      if (ncol(MEsNoGrey) > 0) {
        moduleTraitCor <- cor(MEsNoGrey, trait_numeric, use = "pairwise.complete.obs")
        moduleTraitPvalue <- corPvalueStudent(moduleTraitCor, nrow(datExpr))
        if (is.null(dim(moduleTraitCor))) {
          moduleTraitCor <- matrix(moduleTraitCor, nrow = 1, dimnames = list(colnames(MEsNoGrey), colnames(trait_numeric)))
          moduleTraitPvalue <- matrix(moduleTraitPvalue, nrow = 1, dimnames = list(colnames(MEsNoGrey), colnames(trait_numeric)))
        }
      }
    }

    me_export <- data.frame(sample_name = rownames(datExpr), group = sample_meta[rownames(datExpr), "group"], MEs, check.names = FALSE)
    write.csv(me_export, file.path(output_dir, "module_eigengenes.csv"), row.names = FALSE)
    build_network_edges(if (!is.null(MEsNoGrey)) MEsNoGrey else matrix(nrow = 0, ncol = 0), file.path(output_dir, "network_edges.csv"))

    # Write the full peptide x module signedKME matrix for downstream
    # deliverables. This replaces the hubs-frame mis-write that previously
    # populated kME_Matrix.csv with the wrong content (deliverables.py:1438).
    tryCatch({
      kme_export <- as.data.frame(kME_matrix, check.names = FALSE)
      kme_export <- cbind(feature_id = rownames(kME_matrix), kme_export)
      write.csv(kme_export, file.path(output_dir, "kme_matrix.csv"), row.names = FALSE)
    }, error = function(e) {
      message(sprintf("[stage1_parity] kme_matrix write failed: %s", conditionMessage(e)))
    })

    tryCatch({
      pdf(file.path(output_dir, "wgcna_dendrogram.pdf"), width = 12, height = 7)
      plotDendroAndColors(net$dendrograms[[1]], module_colors_good[net$blockGenes[[1]]], "Module", dendroLabels = FALSE, addGuide = TRUE, guideHang = 0.05)
      dev.off()
    }, error = function(e) {
      try(dev.off(), silent = TRUE)
    })

    if (!is.null(MEsNoGrey) && nrow(moduleTraitCor) > 0 && ncol(moduleTraitCor) > 0) {
      tryCatch({
        pdf(file.path(output_dir, "module_trait_heatmap.pdf"), width = max(9, 5 + (ncol(moduleTraitCor) * 1.1)), height = max(10, 4 + (nrow(moduleTraitCor) * 0.28)))
        par(mar = c(6, 8.5, 3, 3))
        textMatrix <- paste(signif(moduleTraitCor, 2), "\n(", signif(moduleTraitPvalue, 1), ")", sep = "")
        dim(textMatrix) <- dim(moduleTraitCor)
        labeledHeatmap(
          Matrix = moduleTraitCor,
          xLabels = colnames(moduleTraitCor),
          yLabels = rownames(moduleTraitCor),
          ySymbols = rownames(moduleTraitCor),
          colorLabels = FALSE,
          colors = greenWhiteRed(50),
          textMatrix = textMatrix,
          setStdMargins = FALSE,
          cex.text = 0.8,
          zlim = c(-1, 1),
          main = "Module-trait relationships"
        )
        dev.off()
      }, error = function(e) {
        try(dev.off(), silent = TRUE)
      })

      tryCatch({
        write_module_response_plots(
          MEsNoGrey,
          sample_meta[rownames(datExpr), "group"],
          cohort1,
          cohort2,
          file.path(output_dir, "module_response_plots.pdf")
        )
      }, error = function(e) {
        msg(sprintf("Module response plots could not be generated: %s", e$message))
      })
    }
  } else {
    write.csv(data.frame(Power = integer(), SFT.R.sq = numeric()), file.path(output_dir, "wgcna_power_diagnostics.csv"), row.names = FALSE)
    write.csv(data.frame(sample_name = rownames(datExpr), group = sample_meta[rownames(datExpr), "group"]), file.path(output_dir, "module_eigengenes.csv"), row.names = FALSE)
    build_network_edges(matrix(nrow = 0, ncol = 0), file.path(output_dir, "network_edges.csv"))
  }
} else {
  msg("Skipping WGCNA because the filtered matrix is too small for stable module detection")
  write.csv(data.frame(Power = integer(), SFT.R.sq = numeric()), file.path(output_dir, "wgcna_power_diagnostics.csv"), row.names = FALSE)
  write.csv(data.frame(sample_name = rownames(datExpr), group = sample_meta[rownames(datExpr), "group"]), file.path(output_dir, "module_eigengenes.csv"), row.names = FALSE)
  build_network_edges(matrix(nrow = 0, ncol = 0), file.path(output_dir, "network_edges.csv"))
}

volcano_results$module <- module_colors
write.table(volcano_results, file.path(output_dir, "volcano_results.tsv"), sep = "\t", row.names = FALSE, quote = FALSE)
write.csv(volcano_results[volcano_results$direction == "up", , drop = FALSE], file.path(output_dir, "volcano_upregulated.csv"), row.names = FALSE)
write.csv(volcano_results[volcano_results$direction == "down", , drop = FALSE], file.path(output_dir, "volcano_downregulated.csv"), row.names = FALSE)

module_assignments <- data.frame(
  peptide_id = feature_ids,
  feature_id = feature_ids,
  gene = gene_names,
  module_color = module_colors,
  kME = round(assigned_kme, 6),
  alternative_module = alt_module,
  kME_alternative = round(alt_kme, 6),
  module_quality = module_quality,
  stringsAsFactors = FALSE
)
write.csv(module_assignments, file.path(output_dir, "module_assignments.csv"), row.names = FALSE)

write_trait_heatmap(moduleTraitCor, moduleTraitPvalue, file.path(output_dir, "module_trait_cor.csv"))

top_metric <- if (use_adjusted) "adj_pvalue" else "pvalue"
top_df <- volcano_results[order(volcano_results[[top_metric]], -abs(volcano_results$log2fc)), , drop = FALSE]
top_df <- top_df[top_df$significant == 1, , drop = FALSE]
if (nrow(top_df) == 0) {
  top_df <- volcano_results[order(volcano_results[[top_metric]], -abs(volcano_results$log2fc)), , drop = FALSE]
}
top_df <- head(top_df, 20)
writeLines(toJSON(top_df, pretty = TRUE, auto_unbox = TRUE, dataframe = "rows"), file.path(output_dir, "top_proteins.json"))

analysis_summary <- list(
  feature_count = nrow(normalized_log2),
  sample_count = ncol(normalized_log2),
  peptides_total = nrow(normalized_log2),
  peptides_significant = unname(n_sig),
  peptides_upregulated = unname(n_up),
  peptides_downregulated = unname(n_down),
  wgcna_modules = length(setdiff(unique(module_colors), "grey")),
  selected_wgcna_power = unname(selected_power),
  selected_power_scale_free_fit = if (is.na(power_fit)) NULL else unname(round(power_fit, 4)),
  normalization_method = normalization_method,
  log_transform_applied = log_transform_applied,
  network_input_scale = network_input_scale,
  statistical_test = statistical_test,
  multiple_testing_method = multiple_testing_method,
  pvalue_threshold = pvalue_threshold,
  fold_change_threshold = fold_change_threshold,
  use_adjusted_pvalue = use_adjusted,
  wgcna_power_mode = wgcna_power_mode,
  wgcna_auto_power_cutoff = wgcna_auto_power_cutoff,
  wgcna_tom_type = tom_type,
  wgcna_pam_stage = pam_stage,
  cohort1 = cohort1,
  cohort2 = cohort2,
  n_samples_cohort1 = length(group1_cols),
  n_samples_cohort2 = length(group2_cols),
  format_family = format_family,
  input_level = input_level,
  wgcna_seed = wgcna_seed
)
writeLines(toJSON(analysis_summary, pretty = TRUE, auto_unbox = TRUE), file.path(output_dir, "analysis_summary.json"))

tryCatch({
  pdf(file.path(output_dir, "volcano_plot.pdf"), width = 9, height = 7)
  metric_values_plot <- if (use_adjusted) volcano_results$adj_pvalue else volcano_results$pvalue
  neglog <- -log10(pmax(metric_values_plot, 1e-300))
  colors <- ifelse(volcano_results$direction == "up", "#c0392b", ifelse(volcano_results$direction == "down", "#1a56db", "#7f8c8d"))
  plot(
    volcano_results$log2fc,
    neglog,
    pch = 19,
    col = colors,
    cex = 0.7,
    xlab = "Log2 fold change",
    ylab = if (use_adjusted) "-log10 adjusted p-value" else "-log10 p-value",
    main = sprintf("Volcano: %s vs %s", cohort2, cohort1)
  )
  abline(v = c(-fc_cutoff, fc_cutoff), lty = 2, col = "gray50")
  abline(h = -log10(pvalue_threshold), lty = 2, col = "gray50")
  dev.off()
}, error = function(e) {
  try(dev.off(), silent = TRUE)
})

msg(sprintf("Stage 1 complete: %d significant features, %d modules", n_sig, length(setdiff(unique(module_colors), "grey"))))
