#!/usr/bin/env Rscript
# Simplified Stage 1 wrapper for web app
args <- commandArgs(trailingOnly = TRUE)
config_file <- args[1]

library(jsonlite)
library(doParallel)

CONFIG <- fromJSON(config_file)

cat("\n=== PROTEOMICS ANALYSIS STARTING ===\n")
cat("Input:", CONFIG$input_file, "\n")
cat("Output:", CONFIG$output_directory, "\n\n")

# Set paths
dir.create(CONFIG$output_directory, recursive = TRUE, showWarnings = FALSE)
setwd(CONFIG$output_directory)
r_base <- "/Users/anirudhs/Documents/Projects/wireframe"

# Source scripts
source(file.path(r_base, "peaks_analysis/peaks_DataLoader_Flexible.R"))
source(file.path(r_base, "peaks_analysis/peaks_DataNormalization_ColumnBased.R"))
source(file.path(r_base, "peaks_analysis/peaks_VolcanoPlot_Analysis.R"))

# STEP 1: Load data
cat("\n[1/3] Loading data...\n")
result <- peaks_DataLoader_Flexible(
  CONFIG$input_file,
  outputDir = file.path(CONFIG$output_directory, "01_input"),
  missingValueThreshold = CONFIG$missing_value_threshold,
  group1_name = CONFIG$group1_name,
  group2_name = CONFIG$group2_name
)

# STEP 2: Normalize
cat("\n[2/3] Normalizing...\n")
normalized <- peaks_ColumnNormalization(
  cleanDat = result[[1]],
  traitsMetaData = result[[2]],
  method = CONFIG$normalization_method,
  outputDir = file.path(CONFIG$output_directory, "02_normalized"),
  generatePlots = TRUE
)

# STEP 3: Differential expression
cat("\n[3/3] Running differential expression...\n")
volcano <- peaks_VolcanoPlot_Analysis(
  normalizedData = normalized$normalizedData,
  traitsMetaData = normalized$traitsMetaData,
  pvalue_threshold = CONFIG$pvalue_threshold,
  fold_change_threshold = CONFIG$fold_change_threshold,
  outputDir = file.path(CONFIG$output_directory, "03_analysis"),
  useAdjustedPValue = CONFIG$use_adjusted_pvalue
)

# Save summary
summary <- list(
  peptides_analyzed = nrow(normalized$normalizedData),
  peptides_upregulated = nrow(volcano$upregulated),
  peptides_downregulated = nrow(volcano$downregulated),
  data_completeness = round((1 - sum(is.na(normalized$normalizedData))/(nrow(normalized$normalizedData)*ncol(normalized$normalizedData)))*100, 1),
  normalization_method = CONFIG$normalization_method
)

write(toJSON(summary, auto_unbox = TRUE, pretty = TRUE),
      file.path(CONFIG$output_directory, "analysis_summary.json"))

cat("\n=== ANALYSIS COMPLETE ===\n")
cat("Results in:", CONFIG$output_directory, "\n")
