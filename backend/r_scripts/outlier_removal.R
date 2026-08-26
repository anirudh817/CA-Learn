#!/usr/bin/env Rscript
# Standalone bicor network-connectivity outlier detection.
# Usage: Rscript outlier_removal.R <matrix_csv> <z_threshold> <output_json>
# matrix_csv: features × samples (first column = feature IDs)
# Writes JSON: {outlier_candidates: [{sample, z_score, round_detected}], all_z_scores: {sample: z}}

suppressPackageStartupMessages({
  library(WGCNA)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 3) stop("Usage: outlier_removal.R <matrix_csv> <z_threshold> <output_json>")

matrix_csv  <- args[1]
z_threshold <- as.numeric(args[2])
output_json <- args[3]

# Read matrix: features × samples; drop first (feature ID) column, transpose to samples × features
mat_raw <- read.csv(matrix_csv, row.names = 1, check.names = FALSE)
dat     <- t(as.matrix(mat_raw))  # samples × features

all_samples        <- rownames(dat)
outlier_candidates <- list()
current_dat        <- dat
last_z_scores      <- setNames(rep(0.0, nrow(dat)), rownames(dat))

for (round in 1:5) {
  normadj    <- 0.5 + 0.5 * bicor(t(current_dat), use = "pairwise.complete.obs")^2
  netsummary <- fundamentalNetworkConcepts(normadj)
  ku         <- netsummary$Connectivity
  z_ku       <- (ku - mean(ku)) / sqrt(var(ku))

  # Update z-scores for current samples
  for (s in names(z_ku)) last_z_scores[s] <- z_ku[s]

  flagged <- names(which(z_ku < -z_threshold))
  cat(sprintf("Round %d: %d outlier(s) detected\n", round, length(flagged)))

  if (length(flagged) == 0) break

  for (s in flagged) {
    outlier_candidates[[length(outlier_candidates) + 1]] <- list(
      sample         = s,
      z_score        = round(z_ku[s], 4),
      round_detected = round
    )
  }
  current_dat <- current_dat[!rownames(current_dat) %in% flagged, , drop = FALSE]
  if (nrow(current_dat) < 3) {
    cat("Too few samples remaining — stopping early\n")
    break
  }
}

result <- list(
  outlier_candidates = outlier_candidates,
  all_z_scores       = as.list(round(last_z_scores, 4))
)
write(toJSON(result, auto_unbox = TRUE), output_json)
cat(sprintf("Done: %d candidate(s) written to %s\n", length(outlier_candidates), output_json))
