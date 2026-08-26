# peaks_DataNormalization_ColumnBased.R
# v2.0: Column-based normalization for PEAKS peptide data
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Column-based normalization with MDS plots
## INPUT:       Log2-transformed peptide abundance matrix
## OUTPUT:      - Normalized data matrix
##              - Before/after MDS plots
##              - Normalization statistics
## DESCRIPTION: Median-based column normalization and quality assessment
################################################################################

peaks_ColumnNormalization <- function(cleanDat, traitsMetaData, method = "median", 
                                     outputDir = NULL, generatePlots = TRUE) {
  
  print("START - PEAKS Column-Based Normalization")
  
  #=============================================================================
  # 1. INPUT VALIDATION AND PREPARATION
  #=============================================================================
  
  print("STEP 1 - Validating input data...")
  
  # Check if input data is valid
  if (is.null(cleanDat) || nrow(cleanDat) == 0) {
    stop("cleanDat is empty or NULL")
  }
  
  if (is.null(traitsMetaData) || nrow(traitsMetaData) == 0) {
    stop("traitsMetaData is empty or NULL")
  }
  
  # Convert to matrix if data.frame
  if (is.data.frame(cleanDat)) {
    cleanDat <- as.matrix(cleanDat)
  }
  
  print(paste0("Input validation complete: ", nrow(cleanDat), " peptides x ", ncol(cleanDat), " samples"))
  
  #=============================================================================
  # 2. CALCULATE PRE-NORMALIZATION STATISTICS
  #=============================================================================
  
  print("STEP 2 - Calculating pre-normalization statistics...")
  
  # Calculate column medians, means, and completeness
  col_medians_before <- apply(cleanDat, 2, median, na.rm = TRUE)
  col_means_before <- apply(cleanDat, 2, mean, na.rm = TRUE)
  completeness_before <- (1 - sum(is.na(cleanDat))/(nrow(cleanDat)*ncol(cleanDat))) * 100
  
    print(paste0("Data completeness before normalization: ", round(completeness_before, 1), "%"))
  print(paste0("Median range before normalization: ",
               round(min(col_medians_before, na.rm = TRUE), 2), " to ", 
               round(max(col_medians_before, na.rm = TRUE), 2)))
  
  #=============================================================================
  # 3. APPLY COLUMN NORMALIZATION
  #=============================================================================
  
  print(paste0("STEP 3 - Applying ", method, " normalization..."))
  
  cleanDat_normalized <- cleanDat
  
  if (method == "median") {
    # Calculate column medians
    col_medians <- apply(cleanDat, 2, median, na.rm = TRUE)
    global_median <- median(col_medians, na.rm = TRUE)
    
    # Normalize each column by subtracting its median and adding global median
    for (i in 1:ncol(cleanDat)) {
      cleanDat_normalized[, i] <- cleanDat[, i] - col_medians[i] + global_median
    }
    
    print("Median normalization applied")
    
  } else if (method == "mean") {
    # Calculate column means
    col_means <- apply(cleanDat, 2, mean, na.rm = TRUE)
    global_mean <- mean(col_means, na.rm = TRUE)
    
    # Normalize each column by subtracting its mean and adding global mean
    for (i in 1:ncol(cleanDat)) {
      cleanDat_normalized[, i] <- cleanDat[, i] - col_means[i] + global_mean
    }
    
    print("Mean normalization applied")
    
  } else if (method == "quantile") {
    # Quantile normalization (simplified version)
    print("Applying quantile normalization...")
    
    # Sort each column
    sorted_data <- apply(cleanDat, 2, sort, na.last = TRUE)
    
    # Calculate row means of sorted data
    row_means <- rowMeans(sorted_data, na.rm = TRUE)
    
    # Replace sorted values with row means
    for (i in 1:ncol(cleanDat)) {
      order_i <- order(cleanDat[, i], na.last = TRUE)
      cleanDat_normalized[order_i, i] <- row_means
    }
    
    print("Quantile normalization applied")
    
  } else if (method == "zscore") {
    # Z-score normalization
    for (i in 1:ncol(cleanDat)) {
      col_mean <- mean(cleanDat[, i], na.rm = TRUE)
      col_sd <- sd(cleanDat[, i], na.rm = TRUE)
      if (col_sd > 0) {
        cleanDat_normalized[, i] <- (cleanDat[, i] - col_mean) / col_sd
      }
    }
    
    print("Z-score normalization applied")
    
  } else {
    stop(paste("Unknown normalization method:", method))
  }
  
  #=============================================================================
  # 4. CALCULATE POST-NORMALIZATION STATISTICS
  #=============================================================================
  
  print("STEP 4 - Calculating post-normalization statistics...")
  
  col_medians_after <- apply(cleanDat_normalized, 2, median, na.rm = TRUE)
  col_means_after <- apply(cleanDat_normalized, 2, mean, na.rm = TRUE)
  completeness_after <- (1 - sum(is.na(cleanDat_normalized))/(nrow(cleanDat_normalized)*ncol(cleanDat_normalized))) * 100
  
    print(paste0("Data completeness after normalization: ", round(completeness_after, 1), "%"))
  print(paste0("Median range after normalization: ",
               round(min(col_medians_after, na.rm = TRUE), 2), " to ", 
               round(max(col_medians_after, na.rm = TRUE), 2)))
  
  #=============================================================================
  # 5. GENERATE MDS PLOTS
  #=============================================================================
  
  if (generatePlots && !is.null(outputDir)) {
    print("STEP 5 - Generating MDS plots...")
    
    if (!dir.exists(outputDir)) {
      dir.create(outputDir, recursive = TRUE)
    }
    
    # Load required library
    if (!require(limma, quietly = TRUE)) {
      print("Warning: limma package not available, skipping MDS plots")
    } else {
      
      # Create group factor for coloring
      group_factor <- factor(traitsMetaData$GROUP, levels = c("Control", "AD"))
      group_colors <- c("Control" = "blue", "AD" = "red")
      colors <- group_colors[as.character(group_factor)]
      
      # Generate MDS plots
      pdf(file.path(outputDir, "PEAKS_MDS_Before_After_Normalization.pdf"), width = 12, height = 6)
      
      par(mfrow = c(1, 2))
      
      # Before normalization
      mds_before <- plotMDS(cleanDat, top = 500, gene.selection = "common", 
                           plot = FALSE)
      plot(mds_before$x, mds_before$y, 
           col = colors, pch = 19, cex = 1.2,
           xlab = paste0("Leading logFC dim 1 (", round(mds_before$var.explained[1]*100, 1), "%)"),
           ylab = paste0("Leading logFC dim 2 (", round(mds_before$var.explained[2]*100, 1), "%)"),
           main = "Before Normalization")
      legend("topright", legend = levels(group_factor), 
             col = group_colors[levels(group_factor)], pch = 19, cex = 0.8)
      
      # After normalization
      mds_after <- plotMDS(cleanDat_normalized, top = 500, gene.selection = "common", 
                          plot = FALSE)
      plot(mds_after$x, mds_after$y, 
           col = colors, pch = 19, cex = 1.2,
           xlab = paste0("Leading logFC dim 1 (", round(mds_after$var.explained[1]*100, 1), "%)"),
           ylab = paste0("Leading logFC dim 2 (", round(mds_after$var.explained[2]*100, 1), "%)"),
           main = paste0("After ", stringr::str_to_title(method), " Normalization"))
      legend("topright", legend = levels(group_factor), 
             col = group_colors[levels(group_factor)], pch = 19, cex = 0.8)
      
      dev.off()
      
      print("MDS plots saved")
      
      # Generate additional comprehensive QC plots
      print("Generating additional QC plots...")
      
      pdf_file <- file.path(outputDir, "PEAKS_CBN_Normalization_QC_Plots.pdf")
      pdf(pdf_file, width = 12, height = 8)
      
      # Page 1: Column statistics before and after
      par(mfrow = c(2, 2))
      
      # Column medians/means before and after
      if (method == "median") {
        boxplot(list(Before = col_medians_before, After = col_medians_after),
                main = "Column Medians Before vs After CBN",
                ylab = "Column Median", col = c("lightcoral", "lightblue"))
        
        median_cv_before <- sd(col_medians_before, na.rm = TRUE) / mean(col_medians_before, na.rm = TRUE) * 100
        median_cv_after <- sd(col_medians_after, na.rm = TRUE) / mean(col_medians_after, na.rm = TRUE) * 100
        
        barplot(c(Before = median_cv_before, After = median_cv_after),
                main = "Column Median CV Improvement",
                ylab = "CV (%)", col = c("lightcoral", "lightblue"))
      } else if (method == "mean") {
        boxplot(list(Before = col_means_before, After = col_means_after),
                main = "Column Means Before vs After CBN",
                ylab = "Column Mean", col = c("lightcoral", "lightblue"))
        
        mean_cv_before <- sd(col_means_before, na.rm = TRUE) / mean(col_means_before, na.rm = TRUE) * 100
        mean_cv_after <- sd(col_means_after, na.rm = TRUE) / mean(col_means_after, na.rm = TRUE) * 100
        
        barplot(c(Before = mean_cv_before, After = mean_cv_after),
                main = "Column Mean CV Improvement", 
                ylab = "CV (%)", col = c("lightcoral", "lightblue"))
      }
      
      # Distribution histograms
      hist(col_medians_before, breaks = 15, col = "lightcoral", alpha = 0.7,
           main = "Column Statistics Before CBN", xlab = "Statistic Value")
      hist(col_medians_after, breaks = 15, col = "lightblue", alpha = 0.7,
           main = "Column Statistics After CBN", xlab = "Statistic Value")
      
      # Page 2: Sample-wise distributions
      par(mfrow = c(2, 1))
      
      # Before normalization
      boxplot(cleanDat, las = 2, 
              main = paste0("Sample Distributions Before ", stringr::str_to_title(method), " Normalization"),
              ylab = "log2(Intensity)", col = "lightcoral")
      
      # After normalization
      boxplot(cleanDat_normalized, las = 2,
              main = paste0("Sample Distributions After ", stringr::str_to_title(method), " Normalization"),
              ylab = "log2(Normalized Intensity)", col = "lightblue")
      
      dev.off()
      print(paste0("Additional QC plots saved: ", pdf_file))
    }
  }
  
  #=============================================================================
  # 6. CREATE SUMMARY STATISTICS
  #=============================================================================
  
  print("STEP 6 - Creating summary statistics...")
  
  summary_stats <- list(
    method = method,
    completeness = round(completeness_after, 1),
    median_range_before = c(min(col_medians_before, na.rm = TRUE), max(col_medians_before, na.rm = TRUE)),
    median_range_after = c(min(col_medians_after, na.rm = TRUE), max(col_medians_after, na.rm = TRUE)),
    mean_range_before = c(min(col_means_before, na.rm = TRUE), max(col_means_before, na.rm = TRUE)),
    mean_range_after = c(min(col_means_after, na.rm = TRUE), max(col_means_after, na.rm = TRUE)),
    peptides = nrow(cleanDat_normalized),
    samples = ncol(cleanDat_normalized)
  )
  
  #=============================================================================
  # 7. CONVERT BACK TO LINEAR SCALE FOR ABUNDANCE
  #=============================================================================
  
  print("STEP 7 - Converting to linear abundance scale...")
  
  # Convert log2 normalized data back to linear scale
  cleanDat_abundance <- 2^cleanDat_normalized
  
  #=============================================================================
  # 8. SAVE RESULTS
  #=============================================================================
  
  if (!is.null(outputDir)) {
    print("STEP 8 - Saving results...")
    
    # Save normalized data
    write.csv(cleanDat_normalized, 
              file = file.path(outputDir, "PEAKS_Normalized_Log2_Data.csv"))
    
    write.csv(cleanDat_abundance, 
              file = file.path(outputDir, "PEAKS_Normalized_Abundance_Data.csv"))
    
    # Save enhanced traits data in normalization output folder
    write.csv(traitsMetaData, 
              file = file.path(outputDir, "PEAKS_Sample_Traits_Data.csv"))
    
    # Save summary statistics
    capture.output({
      cat("PEAKS NORMALIZATION SUMMARY\n")
      cat("==========================\n")
      cat(paste0("Method: ", summary_stats$method, "\n"))
      cat(paste0("Peptides: ", summary_stats$peptides, "\n"))
      cat(paste0("Samples: ", summary_stats$samples, "\n"))
      cat(paste0("Data completeness: ", summary_stats$completeness, "%\n"))
      cat(paste0("Median range before: ", round(summary_stats$median_range_before[1], 2), 
                 " to ", round(summary_stats$median_range_before[2], 2), "\n"))
      cat(paste0("Median range after: ", round(summary_stats$median_range_after[1], 2), 
                 " to ", round(summary_stats$median_range_after[2], 2), "\n"))
      cat("==========================\n")
    }, file = file.path(outputDir, "PEAKS_Normalization_Summary.txt"))
    
    # Save workspace
    save(cleanDat_normalized, cleanDat_abundance, traitsMetaData, summary_stats,
         file = file.path(outputDir, "PEAKS_Normalization_Complete.RData"))
    
    print(paste0("Results saved to: ", outputDir))
  }
  
  #=============================================================================
  # 9. FINAL SUMMARY
  #=============================================================================
  
  cat("\n")
  cat("PEAKS NORMALIZATION SUMMARY:\n")
  cat("============================\n")
  cat(paste0("Method: ", summary_stats$method, "\n"))
  cat(paste0("Peptides: ", summary_stats$peptides, "\n"))
  cat(paste0("Samples: ", summary_stats$samples, "\n"))
  cat(paste0("Data completeness: ", summary_stats$completeness, "%\n"))
  cat(paste0("Median CV before: ", round(sd(col_medians_before)/mean(col_medians_before)*100, 2), "%\n"))
  cat(paste0("Median CV after: ", round(sd(col_medians_after)/mean(col_medians_after)*100, 2), "%\n"))
  cat("============================\n")
  
  print("END - PEAKS Column-Based Normalization")
  
  # Return results in expected format
  return(list(
    normalizedData = cleanDat_normalized,
    normalizedAbundance = cleanDat_abundance,
    traitsMetaData = traitsMetaData,
    summary = summary_stats
  ))
} 