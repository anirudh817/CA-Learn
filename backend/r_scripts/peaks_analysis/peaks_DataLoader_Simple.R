# peaks_DataLoader_Simple.R
# v2.0: Simplified PEAKS peptide data loader
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Simplified data loading for PEAKS peptide data
## INPUT:       PEAKS Peptide List CSV file
## OUTPUT:      - Cleaned abundance matrix
##              - Sample metadata with group assignments
## DESCRIPTION: Streamlined loading with 50% missing value filter
################################################################################

peaks_DataLoader_Simple <- function(peaksFile, outputDir = NULL, missingValueThreshold = 0.5) {
  
  print("START - PEAKS Simple Data Loader")
  
  #=============================================================================
  # 1. LOAD AND VALIDATE DATA
  #=============================================================================
  
  print("STEP 1 - Loading PEAKS peptide data...")
  
  # Check if file exists
  if (!file.exists(peaksFile)) {
    stop(paste("PEAKS file not found:", peaksFile))
  }
  
  # Load the data
  print(paste("Reading file:", peaksFile))
  peaksData <- read.csv(peaksFile, header = TRUE, stringsAsFactors = FALSE)
  
  print(paste0("Loaded data: ", nrow(peaksData), " rows x ", ncol(peaksData), " columns"))
  
  # Basic validation
  if (nrow(peaksData) == 0) {
    stop("PEAKS file appears to be empty")
  }
  
  # Expected structure validation
  expected_cols <- 139
  if (ncol(peaksData) != expected_cols) {
    print(paste("WARNING: Expected", expected_cols, "columns, found", ncol(peaksData)))
  }
  
  #=============================================================================
  # 2. EXTRACT ABUNDANCE DATA
  #=============================================================================
  
  print("STEP 2 - Extracting abundance data...")
  
  # Define column ranges based on PEAKS structure
  CONTROL_AREA_START <- 10    # Control samples start
  CONTROL_AREA_END <- 40      # Control samples end (31 samples)
  AD_AREA_START <- 41         # AD samples start  
  AD_AREA_END <- 69           # AD samples end (29 samples)
  
  # Extract abundance columns (Area values)
  abundance_cols <- c(CONTROL_AREA_START:CONTROL_AREA_END, AD_AREA_START:AD_AREA_END)
  abundanceMatrix <- peaksData[, abundance_cols]
  
  # Convert to numeric (handle any character values)
  col_names <- colnames(abundanceMatrix)
  abundanceMatrix <- data.frame(lapply(abundanceMatrix, function(x) {
    as.numeric(as.character(x))
  }), stringsAsFactors = FALSE)
  colnames(abundanceMatrix) <- col_names
  
  print(paste0("Extracted abundance data: ", nrow(abundanceMatrix), " peptides x ", ncol(abundanceMatrix), " samples"))
  
  #=============================================================================
  # 3. CREATE PEPTIDE IDENTIFIERS
  #=============================================================================
  
  print("STEP 3 - Creating peptide identifiers...")
  
  # Extract identification columns
  accession <- peaksData[, 1]    # Protein accession
  gene <- peaksData[, 2]         # Gene name  
  peptide <- peaksData[, 3]      # Peptide sequence
  
  # Create unique peptide IDs (Gene|Accession|Peptide)
  peptideIDs <- paste(gene, accession, peptide, sep = "|")
  
  # Remove any duplicates
  unique_indices <- !duplicated(peptideIDs)
  peptideIDs <- peptideIDs[unique_indices]
  abundanceMatrix <- abundanceMatrix[unique_indices, ]
  
  # Set row names
  rownames(abundanceMatrix) <- peptideIDs
  
  print(paste0("Created ", length(peptideIDs), " unique peptide identifiers"))
  
  #=============================================================================
  # 4. CREATE SAMPLE METADATA
  #=============================================================================
  
  print("STEP 4 - Creating sample metadata...")
  
  # Create sample metadata
  sampleNames <- colnames(abundanceMatrix)
  nControl <- CONTROL_AREA_END - CONTROL_AREA_START + 1
  nAD <- AD_AREA_END - AD_AREA_START + 1
  
  sampleMetadata <- data.frame(
    SAMPLE_ID = sampleNames,
    GROUP = c(rep("Control", nControl), rep("AD", nAD)),
    BATCH = rep("Batch1", length(sampleNames)),
    stringsAsFactors = FALSE
  )
  
  rownames(sampleMetadata) <- sampleNames
  
  print(paste0("Sample metadata created: ", nControl, " Control + ", nAD, " AD samples"))
  
  #=============================================================================
  # 5. APPLY MISSING VALUE FILTER (50% THRESHOLD)
  #=============================================================================
  
  print(paste0("STEP 5 - Applying missing value filter (", missingValueThreshold * 100, "% threshold)..."))
  
  # Calculate missing percentages per peptide
  missing_percent <- rowSums(is.na(abundanceMatrix)) / ncol(abundanceMatrix) * 100
  
  # Keep peptides with missing values below threshold
  keep_peptides <- missing_percent < (missingValueThreshold * 100)
  
  print(paste0("Before filtering: ", nrow(abundanceMatrix), " peptides"))
  print(paste0("After filtering: ", sum(keep_peptides), " peptides (", 
               round(sum(keep_peptides)/nrow(abundanceMatrix)*100, 1), "% retained)"))
  
  # Apply filter
  abundanceMatrix_filtered <- abundanceMatrix[keep_peptides, ]
  peptideIDs_filtered <- peptideIDs[keep_peptides]
  
  #=============================================================================
  # 6. LOG2 TRANSFORMATION
  #=============================================================================
  
  print("STEP 6 - Applying log2 transformation...")
  
  # Ensure data is numeric matrix for log transformation
  abundanceMatrix_filtered <- as.matrix(abundanceMatrix_filtered)
  
  # Replace zeros and negative values with small value before log transformation
  abundanceMatrix_filtered[abundanceMatrix_filtered <= 0] <- 1
  
  # Log2 transform
  log2Matrix <- log2(abundanceMatrix_filtered)
  
  # Replace infinite values with NA
  log2Matrix[is.infinite(log2Matrix)] <- NA
  
  print("Log2 transformation complete")
  
  #=============================================================================
  # 7. SAVE RESULTS
  #=============================================================================
  
  if (!is.null(outputDir)) {
    print("STEP 7 - Saving results...")
    
    if (!dir.exists(outputDir)) {
      dir.create(outputDir, recursive = TRUE)
    }
    
    # Save abundance matrix
    write.csv(abundanceMatrix_filtered, 
              file = file.path(outputDir, "PEAKS_Sweden_Abundance_Matrix.csv"))
    
    # Save sample metadata  
    write.csv(sampleMetadata,
              file = file.path(outputDir, "PEAKS_Sweden_Sample_Metadata.csv"))
    
    # Save workspace
    save(log2Matrix, sampleMetadata, abundanceMatrix_filtered, peptideIDs_filtered,
         file = file.path(outputDir, "PEAKS_Sweden_Simple_Loaded.RData"))
    
    print(paste0("Results saved to: ", outputDir))
  }
  
  #=============================================================================
  # 8. SUMMARY
  #=============================================================================
  
  cat("\n")
  cat("PEAKS DATA LOADING SUMMARY:\n")
  cat("==========================\n")
  cat(paste0("Original peptides: ", nrow(peaksData), "\n"))
  cat(paste0("After missing value filter: ", nrow(log2Matrix), "\n"))
  cat(paste0("Control samples: ", nControl, "\n"))
  cat(paste0("AD samples: ", nAD, "\n"))
  cat(paste0("Data completeness: ", round((1 - sum(is.na(log2Matrix))/(nrow(log2Matrix)*ncol(log2Matrix)))*100, 1), "%\n"))
  cat("==========================\n")
  
  print("END - PEAKS Simple Data Loader")
  
  # Return results in format expected by downstream functions
  return(list(
    cleanDat_ETL = log2Matrix,
    traitsMetaData_ETL = sampleMetadata
  ))
} 