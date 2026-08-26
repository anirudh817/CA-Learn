#!/usr/bin/env Rscript
################################################################################
# Stage 1 Proteomics Analysis Wrapper for Web App
# Called by Python backend with JSON config file
################################################################################

# Get command line arguments
args <- commandArgs(trailingOnly = TRUE)

if (length(args) == 0) {
  stop("Error: No config file provided. Usage: Rscript run_stage1.R <config.json>")
}

config_file <- args[1]

if (!file.exists(config_file)) {
  stop(paste("Error: Config file not found:", config_file))
}

# Load required packages
print("Loading required R packages...")
required_packages <- c("jsonlite", "doParallel")

for (pkg in required_packages) {
  if (!require(pkg, character.only = TRUE, quietly = TRUE)) {
    print(paste("Installing", pkg))
    install.packages(pkg, repos = "https://cloud.r-project.org")
    library(pkg, character.only = TRUE)
  }
}

# Load configuration
print(paste("Loading configuration from:", config_file))
CONFIG <- fromJSON(config_file)

# Print configuration summary
cat("\n=================================================================\n")
cat("STAGE 1 PROTEOMICS ANALYSIS\n")
cat("=================================================================\n")
cat(paste("Dataset:", CONFIG$dataset_name, "\n"))
cat(paste("Input file:", CONFIG$input_file, "\n"))
cat(paste("Normalization:", CONFIG$normalization_method, "\n"))
cat(paste("Output directory:", CONFIG$output_directory, "\n"))
cat("=================================================================\n\n")

# Set working directory to location of original R scripts
# Find the script directory from the config file location
r_scripts_dir <- dirname(config_file)
# Go up to backend dir, then into r_scripts/peaks_analysis
while (basename(r_scripts_dir) != "backend" && r_scripts_dir != "/") {
  r_scripts_dir <- dirname(r_scripts_dir)
}
original_scripts_path <- file.path(r_scripts_dir, "r_scripts", "peaks_analysis")

# Fallback: try absolute path if relative doesn't work
if (!dir.exists(original_scripts_path)) {
  original_scripts_path <- "/Users/anirudhs/Documents/Projects/wireframe/proteomics-webapp/backend/r_scripts/peaks_analysis"
}

if (!dir.exists(original_scripts_path)) {
  stop(paste("Error: Original R scripts not found. Tried:", original_scripts_path))
}

cat(paste("Using R scripts from:", original_scripts_path, "\n"))

# Set paths for helper scripts
CONFIG$data_loader_script <- file.path(original_scripts_path, "peaks_DataLoader_Flexible.R")
CONFIG$normalization_script <- file.path(original_scripts_path, "peaks_DataNormalization_ColumnBased.R")
CONFIG$volcano_script <- file.path(original_scripts_path, "peaks_VolcanoPlot_Analysis.R")
CONFIG$wgcna_script <- file.path(original_scripts_path, "peaks_WGCNA_Standard.R")

# Verify all required scripts exist
required_scripts <- c(
  CONFIG$data_loader_script,
  CONFIG$normalization_script,
  CONFIG$volcano_script
)

if (CONFIG$run_wgcna) {
  required_scripts <- c(required_scripts, CONFIG$wgcna_script)
}

for (script in required_scripts) {
  if (!file.exists(script)) {
    stop(paste("Error: Required R script not found:", script))
  }
}

# Set up parallel processing
print("Setting up parallel processing...")
xclusterLocal <- makeCluster(detectCores() - 1, type = "SOCK")
registerDoParallel(xclusterLocal)

# Run the main analysis pipeline
tryCatch({

  # Source the main analysis script
  main_script <- file.path(original_scripts_path, "peaks_Main_Sweden_Cohort_Peptide_Analysis.R")

  if (!file.exists(main_script)) {
    stop(paste("Error: Main analysis script not found:", main_script))
  }

  # Set working directory for the analysis
  original_wd <- getwd()
  setwd(CONFIG$output_directory)

  # Source main script (it will use the global CONFIG object)
  source(main_script)

  # Restore working directory
  setwd(original_wd)

  # Create summary JSON file
  summary <- list(
    status = "completed",
    dataset_name = CONFIG$dataset_name,
    normalization_method = CONFIG$normalization_method,
    timestamp = format(Sys.time(), "%Y-%m-%d %H:%M:%S")
  )

  # Add statistics if available
  if (exists("InputToNext") && !is.null(InputToNext[[1]])) {
    summary$peptides_analyzed <- nrow(InputToNext[[1]])
    summary$samples_analyzed <- ncol(InputToNext[[1]])
  }

  if (exists("volcanoResults")) {
    summary$peptides_upregulated <- nrow(volcanoResults$upregulated)
    summary$peptides_downregulated <- nrow(volcanoResults$downregulated)
  }

  if (exists("moduleColors")) {
    summary$modules_detected <- length(unique(moduleColors)) - 1  # Exclude grey
  }

  # Write summary
  summary_file <- file.path(CONFIG$output_directory, "analysis_summary.json")
  write(toJSON(summary, pretty = TRUE, auto_unbox = TRUE), summary_file)

  cat("\n=================================================================\n")
  cat("ANALYSIS COMPLETED SUCCESSFULLY\n")
  cat("=================================================================\n")
  cat(paste("Results saved to:", CONFIG$output_directory, "\n"))
  cat(paste("Summary saved to:", summary_file, "\n"))
  cat("=================================================================\n\n")

}, error = function(e) {

  # Log error
  cat("\n=================================================================\n")
  cat("ERROR DURING ANALYSIS\n")
  cat("=================================================================\n")
  cat(paste("Error message:", e$message, "\n"))
  cat("=================================================================\n\n")

  # Write error summary
  error_summary <- list(
    status = "failed",
    error_message = e$message,
    timestamp = format(Sys.time(), "%Y-%m-%d %H:%M:%S")
  )

  error_file <- file.path(CONFIG$output_directory, "analysis_summary.json")
  write(toJSON(error_summary, pretty = TRUE, auto_unbox = TRUE), error_file)

  # Re-throw error
  stop(e)

}, finally = {

  # Clean up cluster
  if (exists("xclusterLocal")) {
    stopCluster(xclusterLocal)
  }

})

# Exit successfully
quit(status = 0)
