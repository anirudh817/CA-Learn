# peaks_VolcanoPlot_Analysis.R
# v2.0: Interactive volcano plot analysis for PEAKS differential expression
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Comprehensive volcano plot analysis with interactive features
## INPUT:       Normalized peptide abundance matrix and sample metadata
## OUTPUT:      - Static volcano plots (PDF)
##              - Interactive volcano plots (HTML) 
##              - Differential expression results tables
## DESCRIPTION: T-tests, fold change calculation, FDR correction, and visualization
################################################################################

peaks_VolcanoPlot_Analysis <- function(normalizedData, traitsMetaData, 
                                     pvalue_threshold = 0.05, fold_change_threshold = 1.5,
                                     outputDir = NULL, useAdjustedPValue = TRUE) {
  
  print("START - PEAKS Volcano Plot Analysis")
  
  #=============================================================================
  # 1. INPUT VALIDATION AND SETUP
  #=============================================================================
  
  print("STEP 1 - Validating input data and setup...")
  
  # Validate inputs
  if (is.null(normalizedData) || nrow(normalizedData) == 0) {
    stop("normalizedData is empty or NULL")
  }
  
  if (is.null(traitsMetaData) || nrow(traitsMetaData) == 0) {
    stop("traitsMetaData is empty or NULL")
  }
  
  # Load required packages
  required_packages <- c("ggplot2", "plotly", "htmlwidgets", "ggrepel")
  for (pkg in required_packages) {
    if (!require(pkg, character.only = TRUE, quietly = TRUE)) {
      print(paste("Installing", pkg, "package..."))
      install.packages(pkg)
      library(pkg, character.only = TRUE)
    }
  }
  
  print(paste0("Analysis setup complete: ", nrow(normalizedData), " peptides x ", ncol(normalizedData), " samples"))
  
  #=============================================================================
  # 2. PREPARE GROUP ASSIGNMENTS
  #=============================================================================
  
  print("STEP 2 - Preparing group assignments...")
  
  # Get sample groups
  control_samples <- rownames(traitsMetaData)[traitsMetaData$GROUP == "Control"]
  ad_samples <- rownames(traitsMetaData)[traitsMetaData$GROUP == "AD"]
  
  print(paste0("Group assignments: ", length(control_samples), " Control, ", length(ad_samples), " AD samples"))
  
  # Check if we have samples from both groups
  if (length(control_samples) == 0 || length(ad_samples) == 0) {
    stop("Need samples from both Control and AD groups")
  }
  
  #=============================================================================
  # 3. PERFORM STATISTICAL TESTS
  #=============================================================================
  
  print("STEP 3 - Performing statistical tests...")
  
  # Initialize results vectors
  n_peptides <- nrow(normalizedData)
  pvalues <- numeric(n_peptides)
  log2_fold_changes <- numeric(n_peptides)
  control_means <- numeric(n_peptides)
  ad_means <- numeric(n_peptides)
  peptide_names <- rownames(normalizedData)
  
  # Perform t-tests for each peptide
  for (i in 1:n_peptides) {
    # Extract data for current peptide
    control_values <- as.numeric(normalizedData[i, control_samples])
    ad_values <- as.numeric(normalizedData[i, ad_samples])
    
    # Remove NA values
    control_values <- control_values[!is.na(control_values)]
    ad_values <- ad_values[!is.na(ad_values)]
    
    # Calculate means
    control_means[i] <- mean(control_values, na.rm = TRUE)
    ad_means[i] <- mean(ad_values, na.rm = TRUE)
    
    # Calculate log2 fold change (AD vs Control)
    log2_fold_changes[i] <- ad_means[i] - control_means[i]
    
    # Perform t-test if we have enough samples
    if (length(control_values) >= 3 && length(ad_values) >= 3) {
      tryCatch({
        t_test_result <- t.test(ad_values, control_values)
        pvalues[i] <- t_test_result$p.value
      }, error = function(e) {
        pvalues[i] <- 1  # Assign p-value of 1 if test fails
      })
    } else {
      pvalues[i] <- 1  # Assign p-value of 1 if insufficient samples
    }
  }
  
  print("Statistical tests completed")
  
  #=============================================================================
  # 4. APPLY MULTIPLE TESTING CORRECTION
  #=============================================================================
  
  print("STEP 4 - Applying multiple testing correction...")
  
  # Apply Benjamini-Hochberg FDR correction
  adjusted_pvalues <- p.adjust(pvalues, method = "BH")
  
  # Calculate -log10 p-values for plotting
  neg_log10_pvals <- -log10(pvalues)
  neg_log10_adj_pvals <- -log10(adjusted_pvalues)
  
  # Replace infinite values with maximum finite value + 1
  max_finite_pval <- max(neg_log10_pvals[is.finite(neg_log10_pvals)])
  max_finite_adj_pval <- max(neg_log10_adj_pvals[is.finite(neg_log10_adj_pvals)])
  
  neg_log10_pvals[is.infinite(neg_log10_pvals)] <- max_finite_pval + 1
  neg_log10_adj_pvals[is.infinite(neg_log10_adj_pvals)] <- max_finite_adj_pval + 1
  
  print("Multiple testing correction applied")
  
  #=============================================================================
  # 5. CREATE RESULTS DATAFRAME
  #=============================================================================
  
  print("STEP 5 - Creating results dataframe...")
  
  # Create comprehensive results dataframe
  results <- data.frame(
    Peptide_ID = peptide_names,
    Control_Mean = control_means,
    AD_Mean = ad_means,
    Log2FC = log2_fold_changes,
    PValue = pvalues,
    AdjustedPValue = adjusted_pvalues,
    NegLog10P = neg_log10_pvals,
    NegLog10AdjP = neg_log10_adj_pvals,
    stringsAsFactors = FALSE
  )
  
  # Extract gene names for labeling
  results$Gene <- sapply(strsplit(results$Peptide_ID, "\\|"), function(x) x[1])
  
  # Determine significance based on user preference
  if (useAdjustedPValue) {
    results$Significant <- (results$AdjustedPValue < pvalue_threshold) & 
                          (abs(results$Log2FC) > log2(fold_change_threshold))
    pvalue_col <- "AdjustedPValue"
    neg_log10_col <- "NegLog10AdjP"
    pvalue_label <- "FDR-adjusted p-value"
  } else {
    results$Significant <- (results$PValue < pvalue_threshold) & 
                          (abs(results$Log2FC) > log2(fold_change_threshold))
    pvalue_col <- "PValue"
    neg_log10_col <- "NegLog10P"
    pvalue_label <- "p-value"
  }
  
  # Classify peptides
  results$Direction <- "Not Significant"
  results$Direction[results$Significant & results$Log2FC > 0] <- "Upregulated in AD"
  results$Direction[results$Significant & results$Log2FC < 0] <- "Downregulated in AD"
  
  print(paste0("Results created: ", sum(results$Significant), " significant peptides"))
  
  #=============================================================================
  # 6. IDENTIFY TOP PEPTIDES FOR LABELING
  #=============================================================================
  
  print("STEP 6 - Identifying top peptides for labeling...")
  
  # Get top significant peptides for labeling
  significant_peptides <- results[results$Significant, ]
  
  if (nrow(significant_peptides) > 0) {
    # Sort by adjusted p-value and select top 10
    top_peptides <- significant_peptides[order(significant_peptides[[pvalue_col]]), ]
    top_peptides <- head(top_peptides, 10)
    
    # Ensure top_peptides has the NegLog10P column for ggrepel
    if (!neg_log10_col %in% colnames(top_peptides)) {
      top_peptides[[neg_log10_col]] <- -log10(top_peptides[[pvalue_col]])
    }
    
    print(paste0("Top ", nrow(top_peptides), " peptides identified for labeling"))
  } else {
    top_peptides <- data.frame()
    print("No significant peptides found for labeling")
  }
  
  #=============================================================================
  # 7. CREATE STATIC VOLCANO PLOT
  #=============================================================================
  
  print("STEP 7 - Creating static volcano plot...")
  
  # Define colors
  colors <- c("Not Significant" = "grey", 
              "Upregulated in AD" = "red", 
              "Downregulated in AD" = "blue")
  
  # Create the plot
  p_static <- ggplot(results, aes(x = Log2FC, y = get(neg_log10_col))) +
    geom_point(aes(color = Direction), alpha = 0.6, size = 1) +
    scale_color_manual(values = colors) +
    geom_hline(yintercept = -log10(pvalue_threshold), linetype = "dashed", color = "black") +
    geom_vline(xintercept = c(-log2(fold_change_threshold), log2(fold_change_threshold)), 
               linetype = "dashed", color = "black") +
    labs(title = paste0("PEAKS Volcano Plot: Control vs AD (Abeta42 -ve vs Abeta42 +ve)\n",
                       sum(results$Direction == "Upregulated in AD"), " up, ",
                       sum(results$Direction == "Downregulated in AD"), " down (",
                       pvalue_label, " < ", pvalue_threshold, ", FC > ", fold_change_threshold, ")"),
         x = "Log2 Fold Change (AD vs Control)",
         y = paste0("-Log10 ", pvalue_label),
         color = "Regulation") +
    theme_minimal() +
    theme(plot.title = element_text(hjust = 0.5))
  
  # Add labels for top peptides if any exist
  if (nrow(top_peptides) > 0) {
    p_static <- p_static + 
      geom_text_repel(data = top_peptides,
                      aes(x = Log2FC, y = get(neg_log10_col), label = Gene),
                      color = "black", size = 3, max.overlaps = 10)
  }
  
  print("Static volcano plot created")
  
  #=============================================================================
  # 8. CREATE INTERACTIVE VOLCANO PLOT
  #=============================================================================
  
  print("STEP 8 - Creating interactive volcano plot...")
  
  # Create a web-optimized version with custom tooltip
  results$tooltip_text <- paste0(
    "Gene: ", results$Gene, "<br>",
    "Log2FC: ", round(results$Log2FC, 3), "<br>",
    pvalue_label, ": ", format(results[[pvalue_col]], scientific = TRUE, digits = 3), "<br>",
    "Direction: ", results$Direction
  )
  
  # Create ggplot optimized for plotly conversion
  p_interactive <- ggplot(results, aes(x = Log2FC, y = get(neg_log10_col), 
                                      text = tooltip_text, color = Direction)) +
    geom_point(alpha = 0.7, size = 1.5) +
    scale_color_manual(values = colors) +
    geom_hline(yintercept = -log10(pvalue_threshold), linetype = "dashed", color = "black") +
    geom_vline(xintercept = c(-log2(fold_change_threshold), log2(fold_change_threshold)), 
               linetype = "dashed", color = "black") +
    labs(title = paste0("Interactive PEAKS Volcano Plot: Control vs AD"),
         x = "Log2 Fold Change (AD vs Control)",
         y = paste0("-Log10 ", pvalue_label),
         color = "Regulation") +
    theme_minimal() +
    theme(plot.title = element_text(hjust = 0.5))
  
  # Convert to plotly
  p_plotly <- ggplotly(p_interactive, tooltip = "text") %>%
    layout(title = list(text = paste0("Interactive PEAKS Volcano Plot: Control vs AD<br>",
                                     "<sup>", sum(results$Direction == "Upregulated in AD"), " up, ",
                                     sum(results$Direction == "Downregulated in AD"), " down (",
                                     pvalue_label, " < ", pvalue_threshold, ", FC > ", fold_change_threshold, ")</sup>"),
                       x = 0.5))
  
  print("Interactive volcano plot created")
  
  #=============================================================================
  # 9. SAVE RESULTS
  #=============================================================================
  
  if (!is.null(outputDir)) {
    print("STEP 9 - Saving results...")
    
    if (!dir.exists(outputDir)) {
      dir.create(outputDir, recursive = TRUE)
    }
    
    # Save static plot
    pdf(file.path(outputDir, "PEAKS_Volcano_Plot.pdf"), width = 10, height = 8)
    print(p_static)
    dev.off()
    
    # Save interactive plot
    htmlwidgets::saveWidget(p_plotly, 
                           file.path(outputDir, "PEAKS_Interactive_Volcano_Plot.html"),
                           selfcontained = TRUE)
    
    # Save results tables
    write.csv(results, file.path(outputDir, "PEAKS_Volcano_Results_All.csv"), row.names = FALSE)
    
    upregulated <- results[results$Direction == "Upregulated in AD", ]
    downregulated <- results[results$Direction == "Downregulated in AD", ]
    
    write.csv(upregulated, file.path(outputDir, "PEAKS_Volcano_Upregulated_AD.csv"), row.names = FALSE)
    write.csv(downregulated, file.path(outputDir, "PEAKS_Volcano_Downregulated_AD.csv"), row.names = FALSE)
    
    # Save enhanced traits data in analysis output folder
    write.csv(traitsMetaData, 
              file = file.path(outputDir, "PEAKS_Sample_Traits_Data.csv"), 
              row.names = FALSE)
    
    # Save summary statistics
    capture.output({
      cat("PEAKS VOLCANO PLOT ANALYSIS SUMMARY\n")
      cat("===================================\n")
      cat(paste0("Total peptides analyzed: ", nrow(results), "\n"))
      cat(paste0("Significance criteria: ", pvalue_label, " < ", pvalue_threshold, 
                 " AND |Log2FC| > ", round(log2(fold_change_threshold), 2), "\n"))
      cat(paste0("Upregulated in AD: ", sum(results$Direction == "Upregulated in AD"), "\n"))
      cat(paste0("Downregulated in AD: ", sum(results$Direction == "Downregulated in AD"), "\n"))
      cat(paste0("Total significant: ", sum(results$Significant), "\n"))
      cat(paste0("Percentage significant: ", round(sum(results$Significant)/nrow(results)*100, 1), "%\n"))
      cat("===================================\n")
    }, file = file.path(outputDir, "PEAKS_Volcano_Summary.txt"))
    
    print(paste0("Results saved to: ", outputDir))
  }
  
  #=============================================================================
  # 10. FINAL SUMMARY
  #=============================================================================
  
  cat("\n")
  cat("PEAKS VOLCANO PLOT ANALYSIS SUMMARY:\n")
  cat("====================================\n")
  cat(paste0("Total peptides: ", nrow(results), "\n"))
  cat(paste0("Upregulated in AD: ", sum(results$Direction == "Upregulated in AD"), "\n"))
  cat(paste0("Downregulated in AD: ", sum(results$Direction == "Downregulated in AD"), "\n"))
  cat(paste0("Total significant: ", sum(results$Significant), " (", 
             round(sum(results$Significant)/nrow(results)*100, 1), "%)\n"))
  cat(paste0("Significance criteria: ", pvalue_label, " < ", pvalue_threshold, 
             " AND FC > ", fold_change_threshold, "\n"))
  cat("====================================\n")
  
  print("END - PEAKS Volcano Plot Analysis")
  
  # Return comprehensive results
  return(list(
    all_results = results,
    upregulated = upregulated,
    downregulated = downregulated,
    static_plot = p_static,
    interactive_plot = p_plotly,
    summary = list(
      total_peptides = nrow(results),
      upregulated_count = sum(results$Direction == "Upregulated in AD"),
      downregulated_count = sum(results$Direction == "Downregulated in AD"),
      significant_count = sum(results$Significant),
      significance_threshold = pvalue_threshold,
      fold_change_threshold = fold_change_threshold
    )
  ))
} 