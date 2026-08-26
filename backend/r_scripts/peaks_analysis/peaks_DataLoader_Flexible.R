# peaks_DataLoader_Flexible.R
# v3.0: Flexible PEAKS peptide data loader with automatic column detection
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Flexible data loading for PEAKS peptide data with auto-detection
## INPUT:       PEAKS Peptide List CSV file
## OUTPUT:      - Cleaned abundance matrix
##              - Sample metadata with group assignments
## DESCRIPTION: Automatically detects column structure and sample groups
################################################################################

peaks_DataLoader_Flexible <- function(peaksFile, outputDir = NULL, missingValueThreshold = 0.5, 
                                     group1_name = "Control", group2_name = "AD") {
  
  print("START - PEAKS Flexible Data Loader")
  
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
  
  #=============================================================================
  # 2. AUTOMATIC COLUMN DETECTION
  #=============================================================================
  
  print("STEP 2 - Detecting column structure...")
  
  # Detect identification columns
  col_names <- colnames(peaksData)
  
  # Find identification columns by common patterns
  accession_col <- detect_accession_column(col_names)
  gene_col <- detect_gene_column(col_names)
  peptide_col <- detect_peptide_column(col_names)
  
  print(paste0("Detected columns:"))
  print(paste0("  Accession: ", accession_col, " (", col_names[accession_col], ")"))
  print(paste0("  Gene: ", gene_col, " (", col_names[gene_col], ")"))
  print(paste0("  Peptide: ", peptide_col, " (", col_names[peptide_col], ")"))
  
  # Detect abundance columns (Area columns)
  abundance_cols <- detect_abundance_columns(col_names)
  
  print(paste0("Detected ", length(abundance_cols), " abundance columns"))
  
  # Detect sample groups from column names
  sample_groups <- detect_sample_groups(col_names[abundance_cols], group1_name, group2_name)
  
  print(paste0("Detected sample groups:"))
  print(paste0("  ", group1_name, ": ", sum(sample_groups == group1_name), " samples"))
  print(paste0("  ", group2_name, ": ", sum(sample_groups == group2_name), " samples"))
  
  #=============================================================================
  # 3. EXTRACT ABUNDANCE DATA
  #=============================================================================
  
  print("STEP 3 - Extracting abundance data...")
  
  # Extract abundance columns
  abundanceMatrix <- peaksData[, abundance_cols]
  
  # Convert to numeric (handle any character values)
  col_names_abundance <- colnames(abundanceMatrix)
  abundanceMatrix <- data.frame(lapply(abundanceMatrix, function(x) {
    as.numeric(as.character(x))
  }), stringsAsFactors = FALSE)
  colnames(abundanceMatrix) <- col_names_abundance
  
  print(paste0("Extracted abundance data: ", nrow(abundanceMatrix), " peptides x ", ncol(abundanceMatrix), " samples"))
  
  #=============================================================================
  # 4. CREATE PEPTIDE IDENTIFIERS
  #=============================================================================
  
  print("STEP 4 - Creating peptide identifiers...")
  
  # Extract identification columns
  accession <- peaksData[, accession_col]
  gene <- peaksData[, gene_col]
  peptide <- peaksData[, peptide_col]
  
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
  # 5. CREATE ENHANCED SAMPLE TRAITS DATA
  #=============================================================================
  
  print("STEP 5 - Creating enhanced sample traits data...")
  
  # Create basic sample metadata
  sampleNames <- colnames(abundanceMatrix)
  
  basic_metadata <- data.frame(
    SAMPLE_ID = sampleNames,
    GROUP = sample_groups,
    BATCH = rep("Batch1", length(sampleNames)),  # Could be made configurable
    stringsAsFactors = FALSE
  )
  
  rownames(basic_metadata) <- sampleNames
  
  # Try to load and merge clinical traits data, those data not found in the oroginal input file- add on
  clinical_traits_file <- "data/Clinical_Traits_Processed.csv"
  
  if (file.exists(clinical_traits_file)) {
    print("Loading clinical traits data...")
    
    # Load clinical traits
    clinical_traits <- read.csv(clinical_traits_file, stringsAsFactors = FALSE)
    rownames(clinical_traits) <- clinical_traits$SAMPLE_ID
    
    # Merge with basic metadata - use clinical data where available, basic where not
    merged_samples <- intersect(sampleNames, clinical_traits$SAMPLE_ID)
    basic_only_samples <- setdiff(sampleNames, clinical_traits$SAMPLE_ID)
    
    if (length(merged_samples) > 0) {
      # Create enhanced traits data for matched samples
      enhanced_traits_matched <- clinical_traits[merged_samples, ]
      
      # Create basic traits for unmatched samples (if any)
      if (length(basic_only_samples) > 0) {
        enhanced_traits_basic <- data.frame(
          SAMPLE_ID = basic_only_samples,
          GROUP = basic_metadata[basic_only_samples, "GROUP"],
          BATCH = rep("Batch1", length(basic_only_samples)),
          T_TAU = rep(NA, length(basic_only_samples)),
          P_TAU = rep(NA, length(basic_only_samples)),
          ABETA42 = rep(NA, length(basic_only_samples)),
          stringsAsFactors = FALSE
        )
        rownames(enhanced_traits_basic) <- basic_only_samples
        
        # Combine matched and unmatched
        sampleTraitsData <- rbind(enhanced_traits_matched, enhanced_traits_basic)
      } else {
        # All samples matched
        sampleTraitsData <- enhanced_traits_matched
      }
      
      # Reorder to match abundance matrix column order
      sampleTraitsData <- sampleTraitsData[sampleNames, ]
      
      print(paste0("Enhanced traits data created: ", nrow(sampleTraitsData), " samples"))
      print(paste0("  With clinical data: ", length(merged_samples), " samples"))
      print(paste0("  Basic only: ", length(basic_only_samples), " samples"))
      print("Biochemical markers summary:")
      biomarker_cols <- c("T_TAU", "P_TAU", "ABETA42")
      available_biomarkers <- biomarker_cols[biomarker_cols %in% colnames(sampleTraitsData)]
      if (length(available_biomarkers) > 0) {
        print(summary(sampleTraitsData[, available_biomarkers]))
      }
      
    } else {
      print("WARNING: No samples matched between abundance data and clinical traits")
      print("Using basic metadata only")
      sampleTraitsData <- basic_metadata
    }
    
  } else {
    print(paste0("Clinical traits file not found: ", clinical_traits_file))
    print("Using basic metadata only")
    sampleTraitsData <- basic_metadata
  }
  
  print(paste0("Final traits data: ", sum(sampleTraitsData$GROUP == group1_name), " ", group1_name, " + ", 
               sum(sampleTraitsData$GROUP == group2_name), " ", group2_name, " samples"))
  
  #=============================================================================
  # 6. APPLY MISSING VALUE FILTER
  #=============================================================================
  
  print(paste0("STEP 6 - Applying missing value filter (", missingValueThreshold * 100, "% threshold)..."))
  
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
  # 7. LOG2 TRANSFORMATION
  #=============================================================================
  
  # Check if we should apply log2 transformation now (method-dependent timing)
  apply_log2_now <- TRUE
  if (exists("CONFIG") && CONFIG$normalization_method == "TIN") {
    apply_log2_now <- FALSE
    print("STEP 7 - Skipping log2 transformation (will be applied after TIN normalization)")
    log2Matrix <- abundanceMatrix_filtered  # Keep raw data for TIN
  } else {
    print("STEP 7 - Applying log2 transformation...")
    
    # Ensure data is numeric matrix for log transformation
    abundanceMatrix_filtered <- as.matrix(abundanceMatrix_filtered)
    
    # Replace zeros and negative values with small value before log transformation
    abundanceMatrix_filtered[abundanceMatrix_filtered <= 0] <- 1
    
    # Log2 transform
    log2Matrix <- log2(abundanceMatrix_filtered)
    
    # Replace infinite values with NA
    log2Matrix[is.infinite(log2Matrix)] <- NA
    
    print("Log2 transformation complete")
  }
  
  #=============================================================================
  # 8. SAVE RESULTS
  #=============================================================================
  
  if (!is.null(outputDir)) {
    print("STEP 8 - Saving results...")
    
    if (!dir.exists(outputDir)) {
      dir.create(outputDir, recursive = TRUE)
    }
    
    # Save abundance matrix
    write.csv(abundanceMatrix_filtered, 
              file = file.path(outputDir, "PEAKS_Abundance_Matrix.csv"))
    
    # Save enhanced sample traits data  
    write.csv(sampleTraitsData,
              file = file.path(outputDir, "PEAKS_Sample_Traits_Data.csv"))
    
    # Save log2 normalized data for easy access
    write.csv(log2Matrix,
              file = file.path(outputDir, "PEAKS_Log2_Normalized_Data.csv"))
    
    # Save workspace
    save(log2Matrix, sampleTraitsData, abundanceMatrix_filtered, peptideIDs_filtered,
         file = file.path(outputDir, "PEAKS_Loaded_Data.RData"))
    
    print(paste0("Results saved to: ", outputDir))
    print("Files created:")
    print("  - PEAKS_Abundance_Matrix.csv (raw abundance data)")
    print("  - PEAKS_Log2_Normalized_Data.csv (log2 transformed data)")
    print("  - PEAKS_Sample_Traits_Data.csv (enhanced traits with clinical data)")
    print("  - PEAKS_Loaded_Data.RData (complete workspace)")
  }
  
  #=============================================================================
  # 9. SUMMARY
  #=============================================================================
  
  cat("\n")
  cat("PEAKS DATA LOADING SUMMARY:\n")
  cat("==========================\n")
  cat(paste0("Original peptides: ", nrow(peaksData), "\n"))
  cat(paste0("After missing value filter: ", nrow(log2Matrix), "\n"))
  cat(paste0(group1_name, " samples: ", sum(sample_groups == group1_name), "\n"))
  cat(paste0(group2_name, " samples: ", sum(sample_groups == group2_name), "\n"))
  cat(paste0("Data completeness: ", round((1 - sum(is.na(log2Matrix))/(nrow(log2Matrix)*ncol(log2Matrix)))*100, 1), "%\n"))
  cat("==========================\n")
  
  print("END - PEAKS Flexible Data Loader")
  
  # Return results in format expected by downstream functions
  return(list(
    cleanDat_ETL = log2Matrix,
    traitsMetaData = sampleTraitsData,  # Now includes clinical biomarkers
    abundanceData = abundanceMatrix_filtered,
    peptideIDs = peptideIDs_filtered
  ))
}

#===============================================================================
# HELPER FUNCTIONS FOR COLUMN DETECTION
#===============================================================================

detect_accession_column <- function(col_names) {
  
  # Common patterns for accession columns
  patterns <- c("Accession", "accession", "Protein", "protein", "UniProt", "uniprot")
  
  for (pattern in patterns) {
    matches <- grep(pattern, col_names, ignore.case = TRUE)
    if (length(matches) > 0) {
      return(matches[1])  # Return first match
    }
  }
  
  # If no pattern match, assume it's the first column
  warning("Could not detect accession column, using column 1")
  return(1)
}

detect_gene_column <- function(col_names) {
  # Detect the column containing gene names
  
  # Common patterns for gene columns
  patterns <- c("Gene", "gene", "Gene name", "gene name", "Symbol", "symbol")
  
  for (pattern in patterns) {
    matches <- grep(pattern, col_names, ignore.case = TRUE)
    if (length(matches) > 0) {
      return(matches[1])  # Return first match
    }
  }
  
  # If no pattern match, assume it's the second column
  warning("Could not detect gene column, using column 2")
  return(2)
}

detect_peptide_column <- function(col_names) {
  # Detect the column containing peptide sequences
  
  # Common patterns for peptide columns
  patterns <- c("Peptide", "peptide", "Sequence", "sequence", "Seq", "seq")
  
  for (pattern in patterns) {
    matches <- grep(pattern, col_names, ignore.case = TRUE)
    if (length(matches) > 0) {
      return(matches[1])  # Return first match
    }
  }
  
  # If no pattern match, assume it's the third column
  warning("Could not detect peptide column, using column 3")
  return(3)
}

detect_abundance_columns <- function(col_names) {
  # Detect columns containing abundance/area data
  
  # Common patterns for abundance columns
  patterns <- c("Area", "area", "Abundance", "abundance", "Intensity", "intensity")
  
  abundance_cols <- c()
  
  for (pattern in patterns) {
    matches <- grep(pattern, col_names, ignore.case = TRUE)
    abundance_cols <- c(abundance_cols, matches)
  }
  
  # Remove duplicates and sort
  abundance_cols <- unique(sort(abundance_cols))
  
  if (length(abundance_cols) == 0) {
    # If no pattern match, look for numeric columns (excluding first few)
    numeric_cols <- c()
    for (i in 4:length(col_names)) {  # Skip first 3 columns (usually ID columns)
      # Check if column name contains numbers (sample indicators)
      if (grepl("[0-9]", col_names[i])) {
        numeric_cols <- c(numeric_cols, i)
      }
    }
    abundance_cols <- numeric_cols
  }
  
  if (length(abundance_cols) == 0) {
    stop("Could not detect abundance columns. Please check file structure.")
  }
  
  return(abundance_cols)
}

detect_sample_groups <- function(sample_names, group1_name, group2_name) {
  # Detect sample groups from column names
  
  sample_groups <- rep(NA, length(sample_names))
  
  # Look for group1 patterns in sample names
  group1_patterns <- c(tolower(group1_name), "control", "ctrl", "normal", "healthy")
  for (pattern in group1_patterns) {
    matches <- grep(pattern, sample_names, ignore.case = TRUE)
    sample_groups[matches] <- group1_name
  }
  
  # Look for group2 patterns in sample names
  group2_patterns <- c(tolower(group2_name), "ad", "alzheimer", "disease", "case")
  for (pattern in group2_patterns) {
    matches <- grep(pattern, sample_names, ignore.case = TRUE)
    sample_groups[matches] <- group2_name
  }
  
  # If some samples are still unassigned, try to infer from position
  if (any(is.na(sample_groups))) {
    n_samples <- length(sample_names)
    mid_point <- ceiling(n_samples / 2)
    
    # Assume first half is group1, second half is group2
    sample_groups[1:mid_point] <- group1_name
    sample_groups[(mid_point + 1):n_samples] <- group2_name
    
    warning("Could not detect all sample groups from names, using position-based assignment")
  }
  
  return(sample_groups)
} 