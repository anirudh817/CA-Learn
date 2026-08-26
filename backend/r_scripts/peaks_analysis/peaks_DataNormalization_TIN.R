# peaks_DataNormalization_TIN.R
# v1.0: Total Intensity Normalization (TIN) for PEAKS peptide data
# Location: peaks_analysis/
################################################################################
## SUMMARY:     Total Intensity Normalization with comprehensive QC
## INPUT:       Raw peptide abundance matrix (NOT log2 transformed)
## OUTPUT:      - TIN normalized data matrix
##              - Before/after MDS plots
##              - Comprehensive QC plots and metrics
## DESCRIPTION: Total sum scaling normalization with log2 post-transformation
################################################################################

peaks_TIN_Normalization <- function(cleanDat, traitsMetaData, 
                                   scale_to_max = TRUE, log2_constant = 1,
                                   outputDir = NULL, generatePlots = TRUE) {
  
  print("START - PEAKS Total Intensity Normalization (TIN)")
  
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
  
  # Store original data
  rawData <- cleanDat
  
  print(paste0("Input validation complete: ", nrow(cleanDat), " peptides x ", ncol(cleanDat), " samples"))
  
  # For TIN normalization, rawData should NOT contain negative values from input
  # as we're working with raw intensities (before log2 transformation)
  # Only check for and handle zeros (missing values)
  n_negative <- sum(rawData < 0, na.rm = TRUE)
  if (n_negative > 0) {
    stop(paste("ERROR: Found", n_negative, "negative values in input data. TIN normalization expects raw (non-log) intensity values. Check data loading."))
  }
  
  # Convert zeros to NA for missing value handling
  rawData[rawData == 0] <- NA
  
  #=============================================================================
  # 2. CALCULATE PRE-NORMALIZATION STATISTICS
  #=============================================================================
  
  print("STEP 2 - Calculating pre-normalization statistics...")
  
  # Calculate total intensities per sample
  total_intensities_before <- colSums(rawData, na.rm = TRUE)
  completeness_before <- (1 - sum(is.na(rawData))/(nrow(rawData)*ncol(rawData))) * 100
  cv_before <- sd(total_intensities_before, na.rm = TRUE) / mean(total_intensities_before, na.rm = TRUE) * 100
  
  print(paste0("Data completeness before normalization: ", round(completeness_before, 1), "%"))
  print(paste0("Total intensity CV before normalization: ", round(cv_before, 2), "%"))
  print("Total intensity summary before:")
  print(summary(total_intensities_before))
  
  #=============================================================================
  # 3. APPLY TOTAL INTENSITY NORMALIZATION
  #=============================================================================
  
  print("STEP 3 - Applying Total Intensity Normalization...")
  
  # Step 1: Calculate relative abundances
  relative_abundances <- sweep(rawData, 2, total_intensities_before, FUN = "/")
  
  # Step 2: Scale to reference intensity
  if (scale_to_max) {
    reference_intensity <- max(total_intensities_before, na.rm = TRUE)
    scaling_method <- "maximum"
  } else {
    reference_intensity <- mean(total_intensities_before, na.rm = TRUE)
    scaling_method <- "mean"
  }
  
  normalized_data_linear <- relative_abundances * reference_intensity
  
  print(paste0("Scaling to ", scaling_method, " total intensity: ", 
               format(reference_intensity, scientific = TRUE, digits = 3)))
  
  # Step 3: Log2 transformation (TIN requires log2 AFTER normalization)
  normalized_data_log2 <- log2(normalized_data_linear + log2_constant)
  
  print(paste0("Applied log2 transformation with constant: ", log2_constant))
  
  # Handle missing values properly for each data type
  # Linear data: Set NA to 0 (missing intensities)
  normalized_data_linear[is.na(normalized_data_linear)] <- 0
  
  # Log2 data: Keep NA as NA (don't convert -Inf to 0, it destroys negative values)
  # Only handle true missing values (not -Inf from log2 transformation)
  true_na_mask <- is.na(normalized_data_linear)  # Original missing data locations
  normalized_data_log2[true_na_mask] <- NA
  
  #=============================================================================
  # 4. CALCULATE POST-NORMALIZATION STATISTICS
  #=============================================================================
  
  print("STEP 4 - Calculating post-normalization statistics...")
  
  # Calculate post-normalization metrics
  total_intensities_after <- colSums(normalized_data_linear, na.rm = TRUE)
  completeness_after <- (1 - sum(normalized_data_linear == 0)/(nrow(normalized_data_linear)*ncol(normalized_data_linear))) * 100
  cv_after <- sd(total_intensities_after, na.rm = TRUE) / mean(total_intensities_after, na.rm = TRUE) * 100
  
  # Calculate scaling factors
  scaling_factors <- total_intensities_before / reference_intensity
  
  print(paste0("Data completeness after normalization: ", round(completeness_after, 1), "%"))
  print(paste0("Total intensity CV after normalization: ", round(cv_after, 2), "%"))
  
  # Handle CV improvement calculation properly
  if (cv_after > 0.001) {  # Only calculate ratio if CV is meaningful
    cv_improvement <- round(cv_before / cv_after, 1)
    print(paste0("CV improvement: ", cv_improvement, "x"))
  } else {
    print("CV improvement: Perfect normalization achieved (CV ≈ 0%)")
  }
  
  #=============================================================================
  # 5. GENERATE COMPREHENSIVE VISUALIZATION
  #=============================================================================
  
  if (generatePlots && !is.null(outputDir)) {
    print("STEP 5 - Generating comprehensive QC plots...")
    
    # Create comprehensive PDF with multiple pages
    pdf_file <- file.path(outputDir, "PEAKS_TIN_Normalization_QC_Plots.pdf")
    pdf(pdf_file, width = 12, height = 8)
    
    # Page 1: Total intensity distributions and CV comparison
    par(mfrow = c(2, 2))
    
    # Total intensity boxplots
    boxplot(list(Before = total_intensities_before, After = total_intensities_after),
            main = "Total Intensities Before vs After TIN",
            ylab = "Total Intensity", col = c("lightcoral", "lightblue"))
    
    # Total intensity histograms
    hist(total_intensities_before, breaks = 20, col = "lightcoral",
         main = "Total Intensities Before TIN", xlab = "Total Intensity")
    hist(total_intensities_after, breaks = 20, col = "lightblue",
         main = "Total Intensities After TIN", xlab = "Total Intensity")
    
    # CV comparison
    barplot(c(Before = cv_before, After = cv_after),
            main = "Coefficient of Variation Improvement",
            ylab = "CV (%)", col = c("lightcoral", "lightblue"))
    text(1, cv_before/2, paste0(round(cv_before, 1), "%"), cex = 1.2)
    text(2, cv_after/2, paste0(round(cv_after, 1), "%"), cex = 1.2)
    
    # Page 2: Sample-wise distributions before and after
    par(mfrow = c(2, 1))
    
    # Before normalization (raw data)
    boxplot(log2(rawData + 1), las = 2, 
            main = "Sample Distributions Before TIN Normalization",
            ylab = "log2(Raw Intensity + 1)", col = "lightcoral")
    
    # After normalization (log2 transformed)
    boxplot(normalized_data_log2, las = 2,
            main = "Sample Distributions After TIN Normalization", 
            ylab = "log2(TIN Normalized Intensity)", col = "lightblue")
    
    dev.off()
    print(paste0("Comprehensive QC plots saved: ", pdf_file))
    
    # Generate MDS plots (critical for normalization assessment)
    print("STEP 6 - Generating MDS plots...")
    mds_file <- file.path(outputDir, "PEAKS_MDS_Before_After_Normalization.pdf")
    pdf(mds_file, width = 12, height = 6)
    
    par(mfrow = c(1, 2))
    
    # Determine group colors
    if ("GROUP" %in% colnames(traitsMetaData)) {
      group_colors <- ifelse(traitsMetaData$GROUP == "Control", "blue", "red")
    } else if ("Group" %in% colnames(traitsMetaData)) {
      group_colors <- ifelse(traitsMetaData$Group == "Control", "blue", "red")
    } else {
      group_colors <- rep("black", ncol(rawData))
    }
    
    # MDS plot before normalization
    mds_before <- limma::plotMDS(log2(rawData + 1), 
                                labels = NULL,
                                col = group_colors,
                                main = "Before Normalization",
                                pch = 19, cex = 1.2)
    legend("topright", c("Control", "AD"), col = c("blue", "red"), pch = 19)
    
    # MDS plot after normalization
    mds_after <- limma::plotMDS(normalized_data_log2,
                               labels = NULL,
                               col = group_colors, 
                               main = "After TIN Normalization",
                               pch = 19, cex = 1.2)
    legend("topright", c("Control", "AD"), col = c("blue", "red"), pch = 19)
    
    dev.off()
    print(paste0("MDS plots saved: ", mds_file))
  }
  
  #=============================================================================
  # 6. SAVE RESULTS
  #=============================================================================
  
  print("STEP 6 - Saving results...")
  
  if (!is.null(outputDir)) {
    # Save normalized data (linear scale)
    write.csv(normalized_data_linear, 
              file.path(outputDir, "PEAKS_Normalized_Abundance_Data.csv"), 
              row.names = TRUE)
    
    # Save normalized data (log2 scale)  
    write.csv(normalized_data_log2,
              file.path(outputDir, "PEAKS_Normalized_Log2_Data.csv"),
              row.names = TRUE)
    
    # Save enhanced traits data in normalization output folder
    write.csv(traitsMetaData, 
              file.path(outputDir, "PEAKS_Sample_Traits_Data.csv"), 
              row.names = FALSE)
    
    # Save normalization factors
    norm_factors <- data.frame(
      Sample = colnames(rawData),
      Total_Intensity_Before = total_intensities_before,
      Total_Intensity_After = total_intensities_after,
      Scaling_Factor = scaling_factors,
      row.names = colnames(rawData)
    )
    write.csv(norm_factors, 
              file.path(outputDir, "PEAKS_TIN_Normalization_Factors.csv"),
              row.names = FALSE)
    
    # Create comprehensive output object
    InputToNext <- list(
      normalizedAbundance = normalized_data_linear,  # Linear scale for some analyses
      normalizedData = normalized_data_log2,        # Log2 scale for most analyses
      traitsMetaData = traitsMetaData,
      normalizationFactors = scaling_factors,
      qcMetrics = list(
        cv_before = cv_before,
        cv_after = cv_after,
        completeness_before = completeness_before,
        completeness_after = completeness_after,
        method = "TIN",
        scale_method = scaling_method,
        log2_constant = log2_constant
      )
    )
    
    # Save complete results
    save(InputToNext, file = file.path(outputDir, "PEAKS_Normalization_Complete.RData"))
    
    # Generate summary report
    summary_text <- paste(
      "PEAKS TIN Normalization Summary",
      "===============================",
      paste("Method: TIN (Total Intensity Normalization)"),
      paste("Peptides:", nrow(normalized_data_log2)),
      paste("Samples:", ncol(normalized_data_log2)),
      paste("Data completeness:", paste0(round(completeness_after, 1), "%")),
      paste("Scaling method:", scaling_method),
      paste("Log2 constant:", log2_constant),
      paste("CV before:", paste0(round(cv_before, 2), "%")),
      paste("CV after:", paste0(round(cv_after, 2), "%")),
      ifelse(cv_after > 0.001, paste("CV improvement:", paste0(round(cv_before / cv_after, 1), "x")), "CV improvement: Perfect (≈0%)"),
      "===============================",
      sep = "\n"
    )
    
    writeLines(summary_text, file.path(outputDir, "PEAKS_Normalization_Summary.txt"))
    
    print(paste0("Results saved to: ", outputDir))
  }
  
  print("TIN normalization applied")
  
  # Create summary statistics
  summary_stats <- list(
    method = "TIN",
    completeness = round(completeness_after, 1),
    cv_before = round(cv_before, 2),
    cv_after = round(cv_after, 2),
    scaling_method = scaling_method,
    log2_constant = log2_constant
  )
  
  print("END - PEAKS Total Intensity Normalization")
  
  # Return results in same format as column-based normalization
  return(list(
    normalizedAbundance = normalized_data_linear,
    normalizedData = normalized_data_log2,
    traitsMetaData = traitsMetaData,
    summary = summary_stats
  ))
}
