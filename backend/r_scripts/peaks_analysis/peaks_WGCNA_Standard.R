#!/usr/bin/env Rscript
################################################################################
# PEAKS WGCNA Standard Network Analysis
# Clean implementation following standard WGCNA workflow
# Target: 20-30 modules
################################################################################

#===============================================================================
# CONFIGURABLE PARAMETERS (from CONFIG object or defaults)
#===============================================================================

# Use CONFIG parameters if available, otherwise use defaults
if (exists("CONFIG")) {
  SOFT_THRESHOLD_CUTOFF <- CONFIG$wgcna_soft_threshold
  MIN_MODULE_SIZE <- CONFIG$wgcna_min_module_size
  DEEP_SPLIT <- CONFIG$wgcna_deep_split
  MERGE_CUT_HEIGHT <- CONFIG$wgcna_merge_cut_height
  NETWORK_TYPE <- CONFIG$wgcna_network_type
  CORRELATION_TYPE <- CONFIG$wgcna_correlation_type
  PARALLEL_THREADS <- CONFIG$wgcna_parallel_threads
  HUB_PERCENTILE <- CONFIG$wgcna_hub_percentile
  OUTPUT_DIR <- paste0(CONFIG$network_dir, "/")
} else {
  # Default parameters if CONFIG not available
  SOFT_THRESHOLD_CUTOFF <- 0.8    # R-squared cutoff for scale-free topology
  MIN_MODULE_SIZE <- 20           # Minimum number of peptides per module
  DEEP_SPLIT <- 3                 # Module detection sensitivity (0-4, higher = more modules)
  MERGE_CUT_HEIGHT <- 0.30        # Height for merging similar modules (lower = more modules)
  NETWORK_TYPE <- "signed"        # "signed" or "unsigned"
  CORRELATION_TYPE <- "bicor"     # "bicor" (robust) or "pearson"
  PARALLEL_THREADS <- 10          # Number of parallel threads
  HUB_PERCENTILE <- 0.20          # Top percentile for hub protein identification (0.20 = top 20%)
  OUTPUT_DIR <- "peaks_output_converted/05_network/"
}

# Fixed parameters
POWER_TO_USE <- NULL            # Set to specific value to skip calculation, NULL to auto-detect
TOM_TYPE <- "signed"           # Type of TOM calculation
PAM_STAGE <- TRUE              # Use PAM preprocessing
PAM_RESPECTS_DENDRO <- TRUE    # PAM respects dendrogram
MAX_BLOCK_SIZE <- 20000        # Maximum block size for blockwiseModules
VERBOSE_LEVEL <- 3             # Verbosity level (0-5)
CREATE_INTERMEDIATE_PLOTS <- TRUE

#===============================================================================
# LOAD REQUIRED PACKAGES
#===============================================================================

cat("Loading required packages...\n")
suppressPackageStartupMessages({
  library(WGCNA)
  library(doParallel)
  library(ggplot2)
  library(dplyr)
  library(openxlsx)
  library(RColorBrewer)
  library(gplots)
  library(corrplot)
})

# Set WGCNA options
options(stringsAsFactors = FALSE)
enableWGCNAThreads(PARALLEL_THREADS)

#===============================================================================
# CREATE OUTPUT DIRECTORY
#===============================================================================

if (!dir.exists(OUTPUT_DIR)) {
  dir.create(OUTPUT_DIR, recursive = TRUE)
  cat("Created output directory:", OUTPUT_DIR, "\n")
}

# Create trait-centric output subdirectories
trait_output_dirs <- list(
  comprehensive = file.path(OUTPUT_DIR, "all_traits_comprehensive"),
  disease = file.path(OUTPUT_DIR, "disease_status"),
  total_tau = file.path(OUTPUT_DIR, "total_tau"), 
  phospho_tau = file.path(OUTPUT_DIR, "phospho_tau"),
  amyloid = file.path(OUTPUT_DIR, "amyloid_beta"),
  pathology = file.path(OUTPUT_DIR, "ad_pathology_composite")
)

# Create all trait-specific directories
for (dir_name in names(trait_output_dirs)) {
  dir.create(trait_output_dirs[[dir_name]], recursive = TRUE, showWarnings = FALSE)
  cat("Created trait directory:", trait_output_dirs[[dir_name]], "\n")
}

#===============================================================================
# LOAD DATA
#===============================================================================

cat("\n================================================================================\n")
cat("Step 1: Loading normalized data...\n")
cat("================================================================================\n")

# Load the normalized data
if (exists("CONFIG")) {
  normalization_file <- file.path(CONFIG$normalized_dir, "PEAKS_Normalization_Complete.RData")
} else {
  normalization_file <- "peaks_output_converted/02_normalized/PEAKS_Normalization_Complete.RData"
}

if (!file.exists(normalization_file)) {
  stop(paste("Normalized data file not found:", normalization_file))
}

load(normalization_file)

# Extract abundance matrix and metadata
abundanceData <- InputToNext$normalizedAbundance
metadata <- InputToNext$traitsMetaData

# Transpose for WGCNA (samples as rows, peptides as columns)
datExpr <- t(abundanceData)

cat("  Data dimensions:", nrow(datExpr), "samples x", ncol(datExpr), "peptides\n")
cat("  Metadata samples:", nrow(metadata), "\n")

# Ensure sample order matches
if (!all(rownames(datExpr) == rownames(metadata))) {
  stop("Sample order mismatch between expression data and metadata!")
}

# Create comprehensive trait data with multiple biomarkers
traits <- data.frame(
  # Binary disease classification (0=Control, 1=AD)
  ADStatus = as.numeric(factor(metadata$GROUP, levels = c("Control", "AD"))) - 1
)

# Add biomarkers if available
biomarker_cols <- c("T_TAU", "P_TAU", "ABETA42")
available_biomarkers <- biomarker_cols[biomarker_cols %in% colnames(metadata)]

if (length(available_biomarkers) > 0) {
  cat("  Adding biomarker traits:", paste(available_biomarkers, collapse = ", "), "\n")
  
  for (biomarker in available_biomarkers) {
    biomarker_values <- metadata[[biomarker]]
    
    # Only add if we have valid numeric data
    if (is.numeric(biomarker_values) && sum(!is.na(biomarker_values)) > 10) {
      # Standardized version (for fair comparison)
      traits[[paste0(biomarker, "_std")]] <- as.numeric(scale(biomarker_values)[,1])
      
      # Raw version (for biological interpretation)  
      traits[[paste0(biomarker, "_raw")]] <- biomarker_values
    }
  }
} else {
  cat("  No biomarker data found, using only disease status\n")
}

rownames(traits) <- rownames(metadata)

# Remove any columns with all NA values
traits <- traits[, colSums(!is.na(traits)) > 0, drop = FALSE]

cat("  Final traits matrix dimensions:", nrow(traits), "samples x", ncol(traits), "traits\n")
cat("  Trait columns:", paste(colnames(traits), collapse = ", "), "\n")

cat("  AD samples:", sum(traits$ADStatus == 1), "\n")
cat("  Control samples:", sum(traits$ADStatus == 0), "\n")

#===============================================================================
# SAMPLE QUALITY CONTROL
#===============================================================================

cat("\n================================================================================\n")
cat("Step 2: Sample quality control and clustering...\n")
cat("================================================================================\n")

# Hierarchical clustering to detect outliers
sampleTree <- hclust(dist(datExpr), method = "average")

# Plot sample dendrogram
pdf(paste0(OUTPUT_DIR, "PEAKS_WGCNA_01_Sample_Clustering_QC.pdf"), width = 12, height = 9)
par(cex = 0.6, mar = c(0, 4, 2, 0))
plot(sampleTree, main = "Sample clustering to detect outliers", 
     sub = "", xlab = "", cex.lab = 1.5, cex.axis = 1.5, cex.main = 2)
dev.off()

cat("  Sample clustering plot saved\n")

#===============================================================================
# SOFT THRESHOLD POWER SELECTION
#===============================================================================

cat("\n================================================================================\n")
cat("Step 3: Selecting soft-thresholding power...\n")
cat("================================================================================\n")

if (is.null(POWER_TO_USE)) {
  # Calculate soft threshold
  powers <- c(seq(1, 10, by = 1), seq(12, 20, by = 2))
  sft <- pickSoftThreshold(datExpr, 
                           powerVector = powers,
                           corFnc = CORRELATION_TYPE,
                           networkType = NETWORK_TYPE,
                           verbose = 5)
  
  # Find first power that achieves R² > threshold
  power <- sft$fitIndices$Power[which(sft$fitIndices$SFT.R.sq > SOFT_THRESHOLD_CUTOFF)[1]]
  
  if (is.na(power)) {
    power <- sft$fitIndices$Power[which.max(sft$fitIndices$SFT.R.sq)]
    cat("  Warning: Could not achieve R² >", SOFT_THRESHOLD_CUTOFF, "\n")
    cat("  Using power with maximum R²:", power, "(R² =", 
        round(max(sft$fitIndices$SFT.R.sq), 3), ")\n")
  } else {
    cat("  Selected power:", power, "(R² =", 
        round(sft$fitIndices$SFT.R.sq[sft$fitIndices$Power == power], 3), ")\n")
  }
  
  # Plot soft threshold selection
  pdf(paste0(OUTPUT_DIR, "PEAKS_WGCNA_02_Power_Selection.pdf"), width = 9, height = 5)
  par(mfrow = c(1, 2), cex = 0.9)
  
  # Scale independence
  plot(sft$fitIndices[, 1], -sign(sft$fitIndices[, 3]) * sft$fitIndices[, 2],
       xlab = "Soft Threshold (power)", ylab = "Scale Free Topology Model Fit, signed R²",
       type = "n", main = "Scale independence")
  text(sft$fitIndices[, 1], -sign(sft$fitIndices[, 3]) * sft$fitIndices[, 2],
       labels = powers, cex = 0.9, col = "red")
  abline(h = SOFT_THRESHOLD_CUTOFF, col = "red")
  
  # Mean connectivity
  plot(sft$fitIndices[, 1], sft$fitIndices[, 5],
       xlab = "Soft Threshold (power)", ylab = "Mean Connectivity",
       type = "n", main = "Mean connectivity")
  text(sft$fitIndices[, 1], sft$fitIndices[, 5],
       labels = powers, cex = 0.9, col = "red")
  
  dev.off()
  cat("  Power selection plots saved\n")
} else {
  power <- POWER_TO_USE
  cat("  Using pre-specified power:", power, "\n")
}

#===============================================================================
# NETWORK CONSTRUCTION AND MODULE DETECTION
#===============================================================================

cat("\n================================================================================\n")
cat("Step 4: Constructing network and detecting modules...\n")
cat("================================================================================\n")

cat("  Parameters:\n")
cat("    Power:", power, "\n")
cat("    Min module size:", MIN_MODULE_SIZE, "\n")
cat("    Deep split:", DEEP_SPLIT, "\n")
cat("    Merge cut height:", MERGE_CUT_HEIGHT, "\n")
cat("    Network type:", NETWORK_TYPE, "\n")
cat("    Correlation type:", CORRELATION_TYPE, "\n")

# Build network
net <- blockwiseModules(
  datExpr,
  power = power,
  TOMType = TOM_TYPE,
  minModuleSize = MIN_MODULE_SIZE,
  reassignThreshold = 0,  # No reassignment for standard workflow
  mergeCutHeight = MERGE_CUT_HEIGHT,
  numericLabels = TRUE,
  pamRespectsDendro = PAM_RESPECTS_DENDRO,
  pamStage = PAM_STAGE,
  deepSplit = DEEP_SPLIT,
  saveTOMs = FALSE,
  saveTOMFileBase = "PEAKS_TOM",
  verbose = VERBOSE_LEVEL,
  maxBlockSize = MAX_BLOCK_SIZE,
  corType = CORRELATION_TYPE,
  networkType = NETWORK_TYPE,
  nThreads = PARALLEL_THREADS
)

# Convert labels to colors
moduleColors <- labels2colors(net$colors)
nModules <- length(table(moduleColors)) - 1  # Exclude grey

cat("\n  Network construction complete!\n")
cat("  Number of modules (excluding grey):", nModules, "\n")
cat("  Module sizes:\n")
print(table(moduleColors))

#===============================================================================
# CALCULATE MODULE EIGENGENES
#===============================================================================

cat("\n================================================================================\n")
cat("Step 5: Calculating module eigengenes...\n")
cat("================================================================================\n")

# Calculate MEs
MEList <- moduleEigengenes(datExpr, colors = moduleColors)
MEs <- MEList$eigengenes
MEs <- orderMEs(MEs)

# Remove grey module from MEs for correlation analysis
MEsNoGrey <- MEs[, !grepl("grey", colnames(MEs))]

cat("  Module eigengenes calculated for", ncol(MEsNoGrey), "modules\n")

#===============================================================================
# MODULE-TRAIT CORRELATIONS
#===============================================================================

cat("\n================================================================================\n")
cat("Step 6: Calculating module-trait correlations...\n")
cat("================================================================================\n")

# Calculate correlations and p-values
moduleTraitCor <- cor(MEsNoGrey, traits, use = "p")
moduleTraitPvalue <- corPvalueStudent(moduleTraitCor, nrow(datExpr))

cat("  Module-trait correlations calculated\n")

#===============================================================================
# GENERATE VISUALIZATIONS
#===============================================================================

cat("\n================================================================================\n")
cat("Step 7: Generating visualizations and outputs...\n")
cat("================================================================================\n")

# 1. Network dendrogram with module colors
pdf(paste0(OUTPUT_DIR, "PEAKS_WGCNA_03_Network_Dendrograms.pdf"), width = 12, height = 9)
plotDendroAndColors(net$dendrograms[[1]], moduleColors[net$blockGenes[[1]]],
                    "Module colors",
                    dendroLabels = FALSE, hang = 0.03,
                    addGuide = TRUE, guideHang = 0.05)
dev.off()
cat("  Network dendrograms saved\n")

# 2. Module-trait correlation heatmap
pdf(paste0(OUTPUT_DIR, "PEAKS_WGCNA_04_Module_Trait_Correlations.pdf"), width = 8, height = 10)
par(mar = c(6, 8.5, 3, 3))

# Create text matrix for heatmap
textMatrix <- paste(signif(moduleTraitCor, 2), "\n(",
                   signif(moduleTraitPvalue, 1), ")", sep = "")
dim(textMatrix) <- dim(moduleTraitCor)

# Plot heatmap
labeledHeatmap(Matrix = moduleTraitCor,
               xLabels = names(traits),
               yLabels = names(MEsNoGrey),
               ySymbols = names(MEsNoGrey),
               colorLabels = FALSE,
               colors = greenWhiteRed(50),
               textMatrix = textMatrix,
               setStdMargins = FALSE,
               cex.text = 0.8,
               zlim = c(-1, 1),
               main = paste("Module-trait relationships"))
dev.off()
cat("  Comprehensive module-trait heatmap saved\n")

#===============================================================================
# GENERATE TRAIT-SPECIFIC ANALYSES
#===============================================================================

cat("  Generating trait-specific analyses...\n")

# Disease Status Analysis
if ("ADStatus" %in% colnames(moduleTraitCor)) {
  disease_cor <- moduleTraitCor[, "ADStatus", drop = FALSE]
  disease_pval <- moduleTraitPvalue[, "ADStatus", drop = FALSE]
  
  pdf(file.path(trait_output_dirs$disease, "PEAKS_WGCNA_04_Disease_Trait_Correlations.pdf"), width = 6, height = 8)
  par(mar = c(6, 8.5, 3, 3))
  
  disease_text <- paste(signif(disease_cor, 2), "\n(",
                       signif(disease_pval, 1), ")", sep = "")
  dim(disease_text) <- dim(disease_cor)
  
  labeledHeatmap(Matrix = disease_cor,
                 xLabels = "AD Status",
                 yLabels = names(MEsNoGrey),
                 ySymbols = names(MEsNoGrey),
                 colorLabels = FALSE,
                 colors = greenWhiteRed(50),
                 textMatrix = disease_text,
                 setStdMargins = FALSE,
                 cex.text = 1.0,
                 zlim = c(-1, 1),
                 main = "Module-Disease Status Correlations")
  dev.off()
  
  # Save significant disease modules
  sig_disease <- which(abs(disease_cor[,1]) > 0.3 & disease_pval[,1] < 0.05)
  if (length(sig_disease) > 0) {
    disease_modules <- data.frame(
      Module = rownames(disease_cor)[sig_disease],
      Correlation = disease_cor[sig_disease, 1],
      P_Value = disease_pval[sig_disease, 1],
      Direction = ifelse(disease_cor[sig_disease, 1] > 0, "Upregulated_in_AD", "Downregulated_in_AD")
    )
    write.csv(disease_modules, 
              file.path(trait_output_dirs$disease, "AD_Associated_Modules.csv"), 
              row.names = FALSE)
    cat("    Disease-associated modules saved:", nrow(disease_modules), "modules\n")
  }
}

# Total Tau Analysis (General Neurodegeneration)
ttau_cols <- grep("T_TAU", colnames(moduleTraitCor), value = TRUE)
if (length(ttau_cols) > 0) {
  ttau_cor <- moduleTraitCor[, ttau_cols, drop = FALSE]
  ttau_pval <- moduleTraitPvalue[, ttau_cols, drop = FALSE]
  
  pdf(file.path(trait_output_dirs$total_tau, "PEAKS_WGCNA_04_Total_Tau_Correlations.pdf"), 
      width = max(6, length(ttau_cols) * 2), height = 8)
  par(mar = c(6, 8.5, 3, 3))
  
  ttau_text <- paste(signif(ttau_cor, 2), "\n(",
                    signif(ttau_pval, 1), ")", sep = "")
  dim(ttau_text) <- dim(ttau_cor)
  
  labeledHeatmap(Matrix = ttau_cor,
                 xLabels = colnames(ttau_cor),
                 yLabels = names(MEsNoGrey),
                 ySymbols = names(MEsNoGrey),
                 colorLabels = FALSE,
                 colors = greenWhiteRed(50),
                 textMatrix = ttau_text,
                 setStdMargins = FALSE,
                 cex.text = 0.9,
                 zlim = c(-1, 1),
                 main = "Module-Total Tau Correlations (Neurodegeneration)")
  dev.off()
  
  # Save significant total tau modules
  for (ttau_col in ttau_cols) {
    sig_ttau <- which(abs(ttau_cor[,ttau_col]) > 0.3 & ttau_pval[,ttau_col] < 0.05)
    if (length(sig_ttau) > 0) {
      ttau_modules <- data.frame(
        Module = rownames(ttau_cor)[sig_ttau],
        Correlation = ttau_cor[sig_ttau, ttau_col],
        P_Value = ttau_pval[sig_ttau, ttau_col],
        Biological_Process = "Neurodegeneration"
      )
      write.csv(ttau_modules, 
                file.path(trait_output_dirs$total_tau, paste0(ttau_col, "_Associated_Modules.csv")), 
                row.names = FALSE)
      cat("   ", ttau_col, "associated modules saved:", nrow(ttau_modules), "modules (neurodegeneration)\n")
    }
  }
}

# Phospho-Tau Analysis (AD-Specific Tangle Pathology)
ptau_cols <- grep("P_TAU", colnames(moduleTraitCor), value = TRUE)
if (length(ptau_cols) > 0) {
  ptau_cor <- moduleTraitCor[, ptau_cols, drop = FALSE]
  ptau_pval <- moduleTraitPvalue[, ptau_cols, drop = FALSE]
  
  pdf(file.path(trait_output_dirs$phospho_tau, "PEAKS_WGCNA_04_Phospho_Tau_Correlations.pdf"), 
      width = max(6, length(ptau_cols) * 2), height = 8)
  par(mar = c(6, 8.5, 3, 3))
  
  ptau_text <- paste(signif(ptau_cor, 2), "\n(",
                    signif(ptau_pval, 1), ")", sep = "")
  dim(ptau_text) <- dim(ptau_cor)
  
  labeledHeatmap(Matrix = ptau_cor,
                 xLabels = colnames(ptau_cor),
                 yLabels = names(MEsNoGrey),
                 ySymbols = names(MEsNoGrey),
                 colorLabels = FALSE,
                 colors = greenWhiteRed(50),
                 textMatrix = ptau_text,
                 setStdMargins = FALSE,
                 cex.text = 0.9,
                 zlim = c(-1, 1),
                 main = "Module-Phospho-Tau Correlations (AD Tangles)")
  dev.off()
  
  # Save significant phospho-tau modules
  for (ptau_col in ptau_cols) {
    sig_ptau <- which(abs(ptau_cor[,ptau_col]) > 0.3 & ptau_pval[,ptau_col] < 0.05)
    if (length(sig_ptau) > 0) {
      ptau_modules <- data.frame(
        Module = rownames(ptau_cor)[sig_ptau],
        Correlation = ptau_cor[sig_ptau, ptau_col],
        P_Value = ptau_pval[sig_ptau, ptau_col],
        Biological_Process = "AD_Tangle_Pathology"
      )
      write.csv(ptau_modules, 
                file.path(trait_output_dirs$phospho_tau, paste0(ptau_col, "_Associated_Modules.csv")), 
                row.names = FALSE)
      cat("   ", ptau_col, "associated modules saved:", nrow(ptau_modules), "modules (AD tangles)\n")
    }
  }
}

# Amyloid Beta Analysis
amyloid_cols <- grep("ABETA42", colnames(moduleTraitCor), value = TRUE)
if (length(amyloid_cols) > 0) {
  amyloid_cor <- moduleTraitCor[, amyloid_cols, drop = FALSE]
  amyloid_pval <- moduleTraitPvalue[, amyloid_cols, drop = FALSE]
  
  pdf(file.path(trait_output_dirs$amyloid, "PEAKS_WGCNA_04_Amyloid_Trait_Correlations.pdf"), 
      width = max(6, length(amyloid_cols) * 2), height = 8)
  par(mar = c(6, 8.5, 3, 3))
  
  amyloid_text <- paste(signif(amyloid_cor, 2), "\n(",
                       signif(amyloid_pval, 1), ")", sep = "")
  dim(amyloid_text) <- dim(amyloid_cor)
  
  labeledHeatmap(Matrix = amyloid_cor,
                 xLabels = colnames(amyloid_cor),
                 yLabels = names(MEsNoGrey),
                 ySymbols = names(MEsNoGrey),
                 colorLabels = FALSE,
                 colors = greenWhiteRed(50),
                 textMatrix = amyloid_text,
                 setStdMargins = FALSE,
                 cex.text = 0.9,
                 zlim = c(-1, 1),
                 main = "Module-Amyloid Beta Correlations")
  dev.off()
  
  # Save significant amyloid modules  
  for (amyloid_col in amyloid_cols) {
    sig_amyloid <- which(abs(amyloid_cor[,amyloid_col]) > 0.3 & amyloid_pval[,amyloid_col] < 0.05)
    if (length(sig_amyloid) > 0) {
      amyloid_modules <- data.frame(
        Module = rownames(amyloid_cor)[sig_amyloid],
        Correlation = amyloid_cor[sig_amyloid, amyloid_col],
        P_Value = amyloid_pval[sig_amyloid, amyloid_col],
        Effect = ifelse(amyloid_cor[sig_amyloid, amyloid_col] > 0, 
                       "Higher_with_Higher_Amyloid", "Lower_with_Higher_Amyloid")
      )
      write.csv(amyloid_modules, 
                file.path(trait_output_dirs$amyloid, paste0(amyloid_col, "_Associated_Modules.csv")), 
                row.names = FALSE)
      cat("   ", amyloid_col, "associated modules saved:", nrow(amyloid_modules), "modules\n")
    }
  }
}

cat("  Trait-specific analyses complete\n")

# Generate trait-specific module response plots for continuous variables
generate_continuous_trait_plots <- function(MEs, traits, trait_dirs) {
  
  # Total Tau Response Plots
  ttau_cols <- grep("T_TAU", colnames(traits), value = TRUE)
  if (length(ttau_cols) > 0) {
    pdf(file.path(trait_dirs$total_tau, "PEAKS_WGCNA_05_Total_Tau_Response_Plots.pdf"), 
        width = 12, height = 16)
    par(mfrow = c(5, 3), mar = c(4, 4, 3, 1))
    
    for (module in names(MEs)[names(MEs) != "MEgrey"]) {
      for (ttau_col in ttau_cols) {
        module_values <- MEs[[module]]
        trait_values <- traits[[ttau_col]]
        
        # Remove NAs
        valid_idx <- !is.na(module_values) & !is.na(trait_values)
        if (sum(valid_idx) > 10) {
          
          # Calculate correlation
          cor_result <- cor.test(module_values[valid_idx], trait_values[valid_idx])
          
          # Create scatterplot
          plot(trait_values[valid_idx], module_values[valid_idx],
               xlab = paste(gsub("_", "-", ttau_col), "(ng/L)"),
               ylab = paste("Module Eigengene"),
               main = paste(module, "vs", gsub("_", "-", ttau_col)),
               pch = 19, cex = 1.2,
               col = ifelse(traits$GROUP[valid_idx] == "AD", "red", "blue"))
          
          # Add regression line
          abline(lm(module_values[valid_idx] ~ trait_values[valid_idx]), col = "black", lwd = 2)
          
          # Add correlation info
          legend("topright", 
                 legend = paste0("r = ", round(cor_result$estimate, 3), 
                               "\np = ", signif(cor_result$p.value, 3)),
                 bty = "n", cex = 0.9)
        }
      }
    }
    dev.off()
  }
  
  # Phospho-Tau Response Plots  
  ptau_cols <- grep("P_TAU", colnames(traits), value = TRUE)
  if (length(ptau_cols) > 0) {
    pdf(file.path(trait_dirs$phospho_tau, "PEAKS_WGCNA_05_Phospho_Tau_Response_Plots.pdf"), 
        width = 12, height = 16)
    par(mfrow = c(5, 3), mar = c(4, 4, 3, 1))
    
    for (module in names(MEs)[names(MEs) != "MEgrey"]) {
      for (ptau_col in ptau_cols) {
        module_values <- MEs[[module]]
        trait_values <- traits[[ptau_col]]
        
        # Remove NAs
        valid_idx <- !is.na(module_values) & !is.na(trait_values)
        if (sum(valid_idx) > 10) {
          
          # Calculate correlation
          cor_result <- cor.test(module_values[valid_idx], trait_values[valid_idx])
          
          # Create scatterplot  
          plot(trait_values[valid_idx], module_values[valid_idx],
               xlab = paste(gsub("_", "-", ptau_col), "(ng/L)"),
               ylab = paste("Module Eigengene"),
               main = paste(module, "vs", gsub("_", "-", ptau_col)),
               pch = 19, cex = 1.2,
               col = ifelse(traits$GROUP[valid_idx] == "AD", "red", "blue"))
          
          # Add regression line
          abline(lm(module_values[valid_idx] ~ trait_values[valid_idx]), col = "black", lwd = 2)
          
          # Add correlation info
          legend("topright", 
                 legend = paste0("r = ", round(cor_result$estimate, 3), 
                               "\np = ", signif(cor_result$p.value, 3)),
                 bty = "n", cex = 0.9)
        }
      }
    }
    dev.off()
  }
  
  # Amyloid Beta Response Plots
  abeta_cols <- grep("ABETA42", colnames(traits), value = TRUE)
  if (length(abeta_cols) > 0) {
    pdf(file.path(trait_dirs$amyloid, "PEAKS_WGCNA_05_Amyloid_Response_Plots.pdf"), 
        width = 12, height = 16)
    par(mfrow = c(5, 3), mar = c(4, 4, 3, 1))
    
    for (module in names(MEs)[names(MEs) != "MEgrey"]) {
      for (abeta_col in abeta_cols) {
        module_values <- MEs[[module]]
        trait_values <- traits[[abeta_col]]
        
        # Remove NAs
        valid_idx <- !is.na(module_values) & !is.na(trait_values)
        if (sum(valid_idx) > 10) {
          
          # Calculate correlation
          cor_result <- cor.test(module_values[valid_idx], trait_values[valid_idx])
          
          # Create scatterplot
          plot(trait_values[valid_idx], module_values[valid_idx],
               xlab = paste(gsub("_", "-", abeta_col), "(ng/L)"),
               ylab = paste("Module Eigengene"),
               main = paste(module, "vs", gsub("_", "-", abeta_col)),
               pch = 19, cex = 1.2,
               col = ifelse(traits$GROUP[valid_idx] == "AD", "red", "blue"))
          
          # Add regression line
          abline(lm(module_values[valid_idx] ~ trait_values[valid_idx]), col = "black", lwd = 2)
          
          # Add correlation info
          legend("topright", 
                 legend = paste0("r = ", round(cor_result$estimate, 3), 
                               "\np = ", signif(cor_result$p.value, 3)),
                 bty = "n", cex = 0.9)
        }
      }
    }
    dev.off()
  }
  
  cat("  Continuous trait response plots generated\n")
}

# Generate continuous trait response plots
generate_continuous_trait_plots(MEs, traits, trait_output_dirs)

# 3. Module response plots (beeswarm plots)
pdf(paste0(OUTPUT_DIR, "PEAKS_WGCNA_05_Module_Response_Plots.pdf"), width = 12, height = 16)
par(mfrow = c(5, 4), mar = c(4, 4, 3, 1))

for (module in names(MEsNoGrey)) {
  # Get module data
  moduleData <- data.frame(
    ME = MEs[, module],
    Group = metadata$GROUP
  )
  
  # Calculate statistics
  ad_mean <- mean(moduleData$ME[moduleData$Group == "AD"])
  ctrl_mean <- mean(moduleData$ME[moduleData$Group == "Control"])
  p_value <- t.test(ME ~ Group, data = moduleData)$p.value
  
  # Create plot
  boxplot(ME ~ Group, data = moduleData,
          main = paste(module, "\np =", format(p_value, digits = 3)),
          xlab = "Group", ylab = "Module Eigengene",
          col = c("lightblue", "lightcoral"))
  
  # Add points
  stripchart(ME ~ Group, data = moduleData,
             vertical = TRUE, method = "jitter",
             add = TRUE, pch = 20, col = 'black', cex = 0.8)
}
dev.off()
cat("  Module response plots saved\n")

#===============================================================================
# SAVE MODULE ASSIGNMENTS AND EIGENGENES
#===============================================================================

cat("\n================================================================================\n")
cat("Step 8: Saving module assignments and results...\n")
cat("================================================================================\n")

# Module assignments
moduleAssignments <- data.frame(
  Peptide = colnames(datExpr),
  Module = moduleColors,
  stringsAsFactors = FALSE
)
write.csv(moduleAssignments, 
          file = paste0(OUTPUT_DIR, "PEAKS_WGCNA_Module_Assignments.csv"),
          row.names = FALSE)
cat("  Module assignments saved\n")

# Calculate module eigengene-based connectivity (kME) for each peptide
cat("  Calculating module eigengene-based connectivity (kME)...\n")

# Calculate kME for each peptide to each module
kME_matrix <- cor(datExpr, MEs, use = "p")
colnames(kME_matrix) <- paste0("kME", substring(colnames(kME_matrix), 3))

# Create comprehensive peptide-module table with kME values
peptide_module_info <- data.frame(
  Peptide = colnames(datExpr),
  Assigned_Module = moduleColors,
  stringsAsFactors = FALSE
)

# Add kME for assigned module for each peptide
peptide_module_info$kME_assigned <- NA
for (i in 1:nrow(peptide_module_info)) {
  assigned_module <- peptide_module_info$Assigned_Module[i]
  if (assigned_module != "grey") {
    kme_col <- paste0("kME", assigned_module)
    if (kme_col %in% colnames(kME_matrix)) {
      peptide_module_info$kME_assigned[i] <- kME_matrix[i, kme_col]
    }
  }
}

# Add top alternative module (highest kME in other modules)
peptide_module_info$Alternative_Module <- NA
peptide_module_info$kME_alternative <- NA

for (i in 1:nrow(peptide_module_info)) {
  assigned_module <- peptide_module_info$Assigned_Module[i]
  
  # Get kME values for all modules except assigned one
  other_modules <- setdiff(colnames(kME_matrix), paste0("kME", assigned_module))
  if (length(other_modules) > 0) {
    other_kmes <- kME_matrix[i, other_modules]
    
    # Find highest alternative
    max_idx <- which.max(abs(other_kmes))
    if (length(max_idx) > 0) {
      peptide_module_info$Alternative_Module[i] <- gsub("kME", "", other_modules[max_idx])
      peptide_module_info$kME_alternative[i] <- other_kmes[max_idx]
    }
  }
}

# Add module quality metrics
peptide_module_info$Module_Quality <- "High"
peptide_module_info$Module_Quality[abs(peptide_module_info$kME_assigned) < 0.7] <- "Medium"
peptide_module_info$Module_Quality[abs(peptide_module_info$kME_assigned) < 0.5] <- "Low"
peptide_module_info$Module_Quality[is.na(peptide_module_info$kME_assigned)] <- "Unassigned"

# Save enhanced module assignments with kME
write.csv(peptide_module_info, paste0(OUTPUT_DIR, "PEAKS_WGCNA_Module_Assignments_with_kME.csv"))

# Save complete kME matrix
write.csv(kME_matrix, paste0(OUTPUT_DIR, "PEAKS_WGCNA_kME_Matrix.csv"))

cat("  kME analysis complete\n")
cat("  Additional files created:\n")
cat("    - PEAKS_WGCNA_Module_Assignments_with_kME.csv (enhanced assignments)\n")
cat("    - PEAKS_WGCNA_kME_Matrix.csv (complete connectivity matrix)\n")

# Module eigengenes with sample information
MEsWithInfo <- cbind(metadata, MEs)
write.csv(MEsWithInfo,
          file = paste0(OUTPUT_DIR, "PEAKS_WGCNA_Module_Eigengenes.csv"),
          row.names = FALSE)
cat("  Module eigengenes saved\n")

#===============================================================================
# HUB PROTEIN IDENTIFICATION AND ANALYSIS
#===============================================================================

cat("\n================================================================================\n")
cat("Step 8b: Identifying hub proteins for each module...\n")
cat("================================================================================\n")

cat("  Hub protein percentile:", HUB_PERCENTILE * 100, "% (top ", HUB_PERCENTILE * 100, "% of each module)\n")

# Get all unique modules (excluding grey)
unique_modules <- unique(moduleColors)
unique_modules <- unique_modules[unique_modules != "grey"]

cat("  Identifying hubs in", length(unique_modules), "modules...\n")

# Create master hub protein list
all_hub_proteins <- list()

# For each module, identify hub proteins (top 20% by kME)
for (module in unique_modules) {
  cat("    Processing module:", module, "\n")
  
  # Get all peptides in this module
  module_peptides <- peptide_module_info[peptide_module_info$Assigned_Module == module, ]
  module_size <- nrow(module_peptides)
  
  if (module_size > 0) {
    # Sort by kME strength (descending absolute value)
    module_peptides <- module_peptides[order(abs(module_peptides$kME_assigned), decreasing = TRUE), ]
    
    # Calculate number of hub proteins (top 20% of module)
    n_hubs <- max(1, round(module_size * HUB_PERCENTILE))  # At least 1 hub per module
    
    # Select top N proteins as hubs
    hub_peptides <- module_peptides[1:n_hubs, ]
    
    # Add hub rank (1 = highest kME in module)
    hub_peptides$Hub_Rank <- 1:nrow(hub_peptides)
    
    cat("      Module size:", module_size, "| Selected", n_hubs, "hub proteins (", 
        round(n_hubs/module_size*100, 1), "%)\n")
    
    # Store for master list
    all_hub_proteins[[module]] <- hub_peptides
  } else {
    cat("      Empty module - no hub proteins\n")
  }
}

# Create comprehensive hub protein summary
if (length(all_hub_proteins) > 0) {
  
  # Combine all hubs with module information
  hub_summary <- do.call(rbind, lapply(names(all_hub_proteins), function(mod) {
    hubs <- all_hub_proteins[[mod]]
    hubs$Module_Name <- mod
    return(hubs)
  }))
  
  # Save master hub protein list
  write.csv(hub_summary, 
           paste0(OUTPUT_DIR, "PEAKS_WGCNA_All_Hub_Proteins.csv"),
           row.names = FALSE)
  
  # Create hub protein statistics summary
  hub_stats <- data.frame(
    Module = names(all_hub_proteins),
    Total_Peptides = sapply(names(all_hub_proteins), function(mod) {
      sum(peptide_module_info$Assigned_Module == mod)
    }),
    Hub_Proteins = sapply(all_hub_proteins, nrow),
    Hub_Percentage = round(sapply(names(all_hub_proteins), function(mod) {
      module_size <- sum(peptide_module_info$Assigned_Module == mod)
      hub_count <- nrow(all_hub_proteins[[mod]])
      (hub_count / module_size) * 100
    }), 1),
    stringsAsFactors = FALSE
  )
  
  # Sort by hub count (descending)
  hub_stats <- hub_stats[order(hub_stats$Hub_Proteins, decreasing = TRUE), ]
  
  # Save hub statistics
  write.csv(hub_stats, 
           paste0(OUTPUT_DIR, "PEAKS_WGCNA_Hub_Protein_Statistics.csv"),
           row.names = FALSE)
  
  cat("  Hub protein analysis complete\n")
  cat("  Files created:\n")
  cat("    - PEAKS_WGCNA_All_Hub_Proteins.csv (comprehensive list)\n")
  cat("    - PEAKS_WGCNA_Hub_Protein_Statistics.csv (summary statistics)\n")
  
  # Print summary
  total_hubs <- sum(hub_stats$Hub_Proteins)
  
  cat("  \n")
  cat("  Hub Protein Summary:\n")
  cat("  ===================\n")
  cat("  Approach: Top", HUB_PERCENTILE * 100, "% of each module\n")
  cat("  Total hub proteins:", total_hubs, "\n")
  cat("  \n")
  
} else {
  cat("  No hub proteins found in any module\n")
}

#===============================================================================
# CREATE EXCEL WORKBOOK WITH ALL RESULTS
#===============================================================================

cat("\n================================================================================\n")
cat("Step 9: Creating comprehensive Excel workbook...\n")
cat("================================================================================\n")

wb <- createWorkbook()

# Sheet 1: Module Summary
addWorksheet(wb, "Module_Summary")
moduleSummary <- data.frame(
  Module = gsub("ME", "", names(table(moduleColors))),
  Size = as.numeric(table(moduleColors)),
  stringsAsFactors = FALSE
)

# Add correlation info for non-grey modules
nonGreyModules <- moduleSummary$Module[moduleSummary$Module != "grey"]
corData <- data.frame(
  Module = nonGreyModules,
  Correlation_with_AD = NA,
  P_value = NA
)

for (i in 1:length(nonGreyModules)) {
  meCol <- paste0("ME", nonGreyModules[i])
  if (meCol %in% rownames(moduleTraitCor)) {
    corData$Correlation_with_AD[i] <- round(moduleTraitCor[meCol, "ADStatus"], 3)
    corData$P_value[i] <- signif(moduleTraitPvalue[meCol, "ADStatus"], 3)
  }
}

moduleSummary <- merge(moduleSummary, corData, by = "Module", all.x = TRUE)
moduleSummary <- moduleSummary[order(moduleSummary$Size, decreasing = TRUE), ]

writeData(wb, "Module_Summary", moduleSummary)

# Sheet 2: Module Assignments
addWorksheet(wb, "Module_Assignments")
writeData(wb, "Module_Assignments", moduleAssignments)

# Sheet 3: Module Eigengenes
addWorksheet(wb, "Module_Eigengenes")
writeData(wb, "Module_Eigengenes", MEsWithInfo)

# Sheet 4: Parameters Used
addWorksheet(wb, "Parameters")
parameters <- data.frame(
  Parameter = c("Soft Threshold Power", "Min Module Size", "Deep Split", 
                "Merge Cut Height", "Network Type", "Correlation Type",
                "Hub Percentile", "Number of Modules", "Total Peptides", "Total Samples"),
  Value = c(power, MIN_MODULE_SIZE, DEEP_SPLIT, MERGE_CUT_HEIGHT,
            NETWORK_TYPE, CORRELATION_TYPE, paste0(HUB_PERCENTILE * 100, "%"), nModules, ncol(datExpr), nrow(datExpr))
)
writeData(wb, "Parameters", parameters)

# Add Hub Protein sheets if available
if (exists("all_hub_proteins") && length(all_hub_proteins) > 0) {
  
  # Sheet 5: Hub Protein Statistics Summary
  addWorksheet(wb, "Hub_Statistics")
  writeData(wb, "Hub_Statistics", hub_stats)
  cat("  Added Hub Statistics sheet\n")
  
  # Sheet 6: All Hub Proteins Combined
  addWorksheet(wb, "All_Hub_Proteins")
  writeData(wb, "All_Hub_Proteins", hub_summary)
  cat("  Added All Hub Proteins sheet\n")
  
  # Add individual module hub protein sheets
  for (module in names(all_hub_proteins)) {
    # Create sheet name (Excel has 31 character limit for sheet names)
    sheet_name <- paste0("Hubs_", module)
    if (nchar(sheet_name) > 31) {
      sheet_name <- substr(sheet_name, 1, 31)
    }
    
    addWorksheet(wb, sheet_name)
    writeData(wb, sheet_name, all_hub_proteins[[module]])
    cat("    Added", sheet_name, "sheet (", nrow(all_hub_proteins[[module]]), "hub proteins)\n")
  }
  
  cat("  Hub protein sheets added successfully\n")
}

# Save workbook to comprehensive folder
saveWorkbook(wb, paste0(trait_output_dirs$comprehensive, "/PEAKS_WGCNA_Complete_Results.xlsx"), overwrite = TRUE)
cat("  Excel workbook saved\n")

#===============================================================================
# CREATE ANALYSIS SUMMARY
#===============================================================================

cat("\n================================================================================\n")
cat("Step 10: Creating analysis summary...\n")
cat("================================================================================\n")

summaryFile <- paste0(OUTPUT_DIR, "PEAKS_WGCNA_Analysis_Summary.txt")
sink(summaryFile)

cat("PEAKS WGCNA Network Analysis Summary\n")
cat("=====================================\n")
cat("Date:", format(Sys.Date(), "%B %d, %Y"), "\n")
cat("Time:", format(Sys.time(), "%H:%M:%S"), "\n\n")

cat("Input Data:\n")
cat("-----------\n")
cat("Total samples:", nrow(datExpr), "\n")
cat("  AD samples:", sum(traits$ADStatus == 1), "\n")
cat("  Control samples:", sum(traits$ADStatus == 0), "\n")
cat("Total peptides:", ncol(datExpr), "\n\n")

cat("Network Construction Parameters:\n")
cat("--------------------------------\n")
cat("Soft threshold power:", power, "\n")
cat("Minimum module size:", MIN_MODULE_SIZE, "\n")
cat("Deep split:", DEEP_SPLIT, "\n")
cat("Merge cut height:", MERGE_CUT_HEIGHT, "\n")
cat("Network type:", NETWORK_TYPE, "\n")
cat("Correlation type:", CORRELATION_TYPE, "\n\n")

cat("Results:\n")
cat("--------\n")
cat("Number of modules (excluding grey):", nModules, "\n")
cat("Module sizes:\n")
print(table(moduleColors))
cat("\n")

cat("Top modules by correlation with AD status:\n")
cat("------------------------------------------\n")
topModules <- moduleSummary[!is.na(moduleSummary$Correlation_with_AD), ]
topModules <- topModules[order(abs(topModules$Correlation_with_AD), decreasing = TRUE), ]
topModules <- head(topModules, 10)
print(topModules)

# Add hub protein summary if available
if (exists("all_hub_proteins") && length(all_hub_proteins) > 0) {
  cat("\n")
  cat("Hub Protein Analysis:\n")
  cat("--------------------\n")
  cat("Hub protein approach: Top", HUB_PERCENTILE * 100, "% of each module\n")
  cat("Total hub proteins identified:", sum(hub_stats$Hub_Proteins), "\n")
  cat("\n")
  
  cat("Hub proteins by module:\n")
  cat("----------------------\n")
  hub_stats_for_summary <- hub_stats[order(hub_stats$Hub_Proteins, decreasing = TRUE), ]
  for (i in 1:min(10, nrow(hub_stats_for_summary))) {
    cat(sprintf("%-12s: %3d hub proteins (%4.1f%% of module)\n",
                hub_stats_for_summary$Module[i],
                hub_stats_for_summary$Hub_Proteins[i],
                hub_stats_for_summary$Hub_Percentage[i]))
  }
  
  # Show top hub proteins overall
  if (exists("hub_summary")) {
    top_hubs <- hub_summary[order(abs(hub_summary$kME_assigned), decreasing = TRUE), ]
    if (nrow(top_hubs) > 0) {
      cat("\n")
      cat("Top Hub Proteins (by kME across all modules):\n")
      cat("--------------------------------------------\n")
      for (i in 1:min(10, nrow(top_hubs))) {
        cat(sprintf("%-20s: kME=%.3f, rank=%d, module=%s\n",
                    top_hubs$Peptide[i],
                    top_hubs$kME_assigned[i],
                    top_hubs$Hub_Rank[i],
                    top_hubs$Assigned_Module[i]))
      }
    }
  }
  
  cat("\n")
  cat("Hub protein files generated:\n")
  cat("- Comprehensive list: PEAKS_WGCNA_All_Hub_Proteins.csv\n")
  cat("- Statistics summary: PEAKS_WGCNA_Hub_Protein_Statistics.csv\n")
  cat("- Excel workbook includes dedicated hub protein sheets for each module\n")
}

sink()
cat("  Analysis summary saved\n")

#===============================================================================
# SAVE R SESSION
#===============================================================================

cat("\n================================================================================\n")
cat("Step 11: Saving complete R session...\n")
cat("================================================================================\n")

save.image(file = paste0(OUTPUT_DIR, "PEAKS_WGCNA_Complete_Session.RData"))
cat("  R session saved\n")

#===============================================================================
# COMPLETION MESSAGE
#===============================================================================

cat("\n================================================================================\n")
cat("WGCNA ANALYSIS COMPLETE!\n")
cat("================================================================================\n")
cat("Results saved to:", OUTPUT_DIR, "\n")
cat("Number of modules detected:", nModules, "\n")
cat("\nGenerated files:\n")
cat("  - PEAKS_WGCNA_01_Sample_Clustering_QC.pdf\n")
cat("  - PEAKS_WGCNA_02_Power_Selection.pdf\n")
cat("  - PEAKS_WGCNA_03_Network_Dendrograms.pdf\n")
cat("  - PEAKS_WGCNA_04_Module_Trait_Correlations.pdf\n")
cat("  - PEAKS_WGCNA_05_Module_Response_Plots.pdf\n")
cat("  - PEAKS_WGCNA_Module_Assignments.csv\n")
cat("  - PEAKS_WGCNA_Module_Eigengenes.csv\n")
cat("  - PEAKS_WGCNA_Complete_Results.xlsx\n")
cat("  - PEAKS_WGCNA_Analysis_Summary.txt\n")
cat("  - PEAKS_WGCNA_Complete_Session.RData\n")
cat("\n")
cat("TRAIT-SPECIFIC OUTPUTS CREATED:\n")
cat("===============================\n")

# Copy key files to trait-specific folders and summarize outputs
for (trait_name in names(trait_output_dirs)) {
  trait_dir <- trait_output_dirs[[trait_name]]
  cat(paste0("", trait_name, "/ folder:\n"))
  
  # Copy shared files to each trait folder
  shared_files <- c("PEAKS_WGCNA_01_Sample_Clustering_QC.pdf",
                   "PEAKS_WGCNA_02_Power_Selection.pdf", 
                   "PEAKS_WGCNA_03_Network_Dendrograms.pdf",
                   "PEAKS_WGCNA_Module_Assignments.csv",
                   "PEAKS_WGCNA_Module_Eigengenes.csv")
  
  for (shared_file in shared_files) {
    if (file.exists(paste0(OUTPUT_DIR, shared_file))) {
      file.copy(paste0(OUTPUT_DIR, shared_file), 
                file.path(trait_dir, shared_file), 
                overwrite = TRUE)
    }
  }
  
  # List trait-specific files
  trait_files <- list.files(trait_dir, pattern = "*.pdf|*.csv", full.names = FALSE)
  for (trait_file in trait_files) {
    cat(paste0("  - ", trait_file, "\n"))
  }
  cat("\n")
}

# Copy main comprehensive heatmap to comprehensive folder
if (file.exists(paste0(OUTPUT_DIR, "PEAKS_WGCNA_04_Module_Trait_Correlations.pdf"))) {
  file.copy(paste0(OUTPUT_DIR, "PEAKS_WGCNA_04_Module_Trait_Correlations.pdf"),
            file.path(trait_output_dirs$comprehensive, "PEAKS_WGCNA_04_All_Traits_Heatmap.pdf"),
            overwrite = TRUE)
}

# Save R session for reproducibility in comprehensive folder only
save.image(paste0(trait_output_dirs$comprehensive, "/PEAKS_WGCNA_Complete_Session.RData"))

cat("================================================================================\n")
cat("ENHANCED WGCNA ANALYSIS COMPLETE WITH TRAIT-CENTRIC ORGANIZATION\n")
cat("================================================================================\n")