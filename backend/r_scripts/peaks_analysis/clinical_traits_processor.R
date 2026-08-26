# clinical_traits_processor.R
# v1.0: Clinical traits data preprocessor for PEAKS proteomics analysis
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Process clinical biochemical data (T-Tau, P-Tau, Aβ42) for integration
## INPUT:       Clinical_Info_Sweden.xlsx with biochemical AD markers
## OUTPUT:      - Processed clinical traits CSV
##              - Sample mapping validation
##              - Integration-ready traits data
## DESCRIPTION: Extract sample IDs, clean column names, validate matching
################################################################################

#' Process Clinical Traits Data for PEAKS Analysis
#' 
#' This function processes the clinical biochemical data containing T-Tau, P-Tau, 
#' and Aβ42 levels, extracts sample identifiers, and prepares the data for 
#' integration with the PEAKS proteomics pipeline.
#' 
#' @param clinical_file Path to the clinical Excel file (default: "data/Clinical_Info_Sweden.xlsx")
#' @param output_file Path to save processed traits CSV (default: "data/Clinical_Traits_Processed.csv")
#' @param validation_file Path to save validation report (default: "data/Clinical_Traits_Validation.txt")
#' @param verbose Boolean for detailed progress messages (default: TRUE)
#' 
#' @return List containing processed traits data and validation summary
#' 
#' @export
process_clinical_traits <- function(
  clinical_file = "data/Clinical_Info_Sweden.xlsx",
  output_file = "data/Clinical_Traits_Processed.csv", 
  validation_file = "data/Clinical_Traits_Validation.txt",
  verbose = TRUE
) {
  
  if (verbose) print("START - Clinical Traits Data Processor")
  
  # Load required packages
  required_packages <- c("readxl", "dplyr")
  for (pkg in required_packages) {
    if (!require(pkg, character.only = TRUE, quietly = TRUE)) {
      print(paste("Installing", pkg, "package..."))
      install.packages(pkg)
      library(pkg, character.only = TRUE)
    }
  }
  
  #=============================================================================
  # 1. LOAD AND VALIDATE CLINICAL DATA
  #=============================================================================
  
  if (verbose) print("STEP 1 - Loading clinical data...")
  
  # Check if file exists
  if (!file.exists(clinical_file)) {
    stop(paste("Clinical file not found:", clinical_file))
  }
  
  # Read Excel file
  clinical_data <- readxl::read_excel(clinical_file)
  
  if (verbose) {
    print(paste0("Loaded clinical data: ", nrow(clinical_data), " samples x ", ncol(clinical_data), " columns"))
    print("Column names found:")
    print(colnames(clinical_data))
  }
  
  # Validate required columns exist
  required_cols <- c("sample name", "t-tau [ng/L]", "p-tau [ng/L]", 
                     "Abeta-42 [ng/L]", "primary biochemical AD classification")
  
  missing_cols <- setdiff(required_cols, colnames(clinical_data))
  if (length(missing_cols) > 0) {
    stop(paste("Missing required columns:", paste(missing_cols, collapse = ", ")))
  }
  
  #=============================================================================
  # 2. EXTRACT AND PROCESS SAMPLE IDENTIFIERS
  #=============================================================================
  
  if (verbose) print("STEP 2 - Extracting sample identifiers...")
  
  # Extract sample IDs from full sample names
  # Pattern: extract 'sampleA01' from '20180618_QX0_JaBa_SA_LC12_5_CSF1_1_8-1xD1xS1fM1_sampleA01.raw.PG.Quantity'
  extract_sample_id <- function(full_name) {
    # Split by underscore, get last part, then split by .raw and get first part
    parts <- strsplit(as.character(full_name), "_")[[1]]
    last_part <- parts[length(parts)]
    sample_id <- strsplit(last_part, "\\.raw")[[1]][1]
    
    # Ensure proper case preservation - convert to expected format
    # Remove 'sample' prefix and ensure proper case (first letter uppercase)
    if (grepl("^sample", sample_id, ignore.case = TRUE)) {
      clean_id <- gsub("^sample", "", sample_id, ignore.case = TRUE)
      # Ensure first letter is uppercase, rest preserve original case
      if (nchar(clean_id) > 0) {
        first_char <- toupper(substr(clean_id, 1, 1))
        rest_chars <- substr(clean_id, 2, nchar(clean_id))
        sample_id <- paste0("sample", first_char, rest_chars)
      }
    }
    
    return(sample_id)
  }
  
  # Apply extraction
  clinical_data$extracted_sample_id <- sapply(clinical_data$`sample name`, extract_sample_id)
  
  if (verbose) {
    print("Sample ID extraction examples:")
    sample_examples <- head(data.frame(
      original = clinical_data$`sample name`,
      extracted = clinical_data$extracted_sample_id
    ), 5)
    print(sample_examples)
    
    # Check for any extraction failures
    failed_extractions <- clinical_data$extracted_sample_id[is.na(clinical_data$extracted_sample_id) | 
                                                           clinical_data$extracted_sample_id == ""]
    if (length(failed_extractions) > 0) {
      print(paste("Warning: Failed to extract sample IDs for", length(failed_extractions), "samples"))
    }
  }
  
  #=============================================================================
  # 3. CREATE PROTEOMICS-COMPATIBLE SAMPLE NAMES
  #=============================================================================
  
  if (verbose) print("STEP 3 - Creating proteomics-compatible sample names...")
  
  # Map extracted sample IDs to proteomics format based on AD classification
  create_proteomics_sample_name <- function(sample_id, ad_classification) {
    # Remove 'sample' prefix if present and get letter+number part
    clean_id <- gsub("^sample", "", sample_id)
    
    # Ensure proper case: first character (letter) should be uppercase
    # This fixes issues like "d09" -> "D09"
    if (nchar(clean_id) > 0) {
      first_char <- toupper(substr(clean_id, 1, 1))
      rest_chars <- substr(clean_id, 2, nchar(clean_id))
      clean_id <- paste0(first_char, rest_chars)
    }
    
    # Create proteomics format: Area.Control.A01 or Area.AD.A01
    # Handle both "biochemical control"/"biochemical AD" and "Control"/"AD" formats
    ad_class_clean <- tolower(trimws(as.character(ad_classification)))
    
    if (grepl("control", ad_class_clean)) {
      return(paste0("Area.Control.", clean_id))
    } else if (grepl("ad", ad_class_clean)) {
      return(paste0("Area.AD.", clean_id))
    } else {
      warning(paste("Unknown AD classification:", ad_classification, "for sample:", sample_id))
      return(paste0("Area.Unknown.", clean_id))  # Return something instead of NA
    }
  }
  
  # Apply mapping
  clinical_data$proteomics_sample_id <- mapply(
    create_proteomics_sample_name,
    clinical_data$extracted_sample_id,
    clinical_data$`primary biochemical AD classification`
  )
  
  if (verbose) {
    print("Proteomics sample name mapping examples:")
    mapping_examples <- head(data.frame(
      extracted_id = clinical_data$extracted_sample_id,
      ad_classification = clinical_data$`primary biochemical AD classification`,
      proteomics_id = clinical_data$proteomics_sample_id
    ), 5)
    print(mapping_examples)
    
    # Check for mapping failures
    failed_mappings <- is.na(clinical_data$proteomics_sample_id) | clinical_data$proteomics_sample_id == ""
    if (any(failed_mappings)) {
      print(paste("Warning: Failed to map", sum(failed_mappings), "samples to proteomics format"))
      print("Failed classifications:")
      failed_classifications <- unique(clinical_data$`primary biochemical AD classification`[failed_mappings])
      print(failed_classifications)
    }
    
    # Show all unique AD classifications found
    print("All unique AD classifications found:")
    print(unique(clinical_data$`primary biochemical AD classification`))
  }
  
  #=============================================================================
  # 4. CLEAN AND STANDARDIZE BIOCHEMICAL DATA
  #=============================================================================
  
  if (verbose) print("STEP 4 - Cleaning biochemical data columns...")
  
  # Clean GROUP column to standard format
  clean_group <- function(ad_classification) {
    ad_class_clean <- tolower(trimws(as.character(ad_classification)))
    if (grepl("control", ad_class_clean)) {
      return("Control")
    } else if (grepl("ad", ad_class_clean)) {
      return("AD")
    } else {
      return("Unknown")
    }
  }
  
  # Create processed data frame with clean column names
  processed_traits <- data.frame(
    SAMPLE_ID = clinical_data$proteomics_sample_id,
    GROUP = sapply(clinical_data$`primary biochemical AD classification`, clean_group),
    BATCH = rep("Batch1", nrow(clinical_data)),  # Default batch
    T_TAU = as.numeric(clinical_data$`t-tau [ng/L]`),
    P_TAU = as.numeric(clinical_data$`p-tau [ng/L]`),
    ABETA42 = as.numeric(clinical_data$`Abeta-42 [ng/L]`),
    stringsAsFactors = FALSE
  )
  
  # Remove any rows with missing or invalid proteomics sample IDs
  processed_traits <- processed_traits[!is.na(processed_traits$SAMPLE_ID) & 
                                     processed_traits$SAMPLE_ID != "" &
                                     !grepl("Unknown", processed_traits$SAMPLE_ID), ]
  
  # Check for duplicate sample IDs and handle them
  if (any(duplicated(processed_traits$SAMPLE_ID))) {
    duplicated_ids <- processed_traits$SAMPLE_ID[duplicated(processed_traits$SAMPLE_ID)]
    warning(paste("Duplicate sample IDs found:", paste(duplicated_ids, collapse = ", ")))
    # Keep only the first occurrence of each duplicate
    processed_traits <- processed_traits[!duplicated(processed_traits$SAMPLE_ID), ]
  }
  
  # Set row names to proteomics sample IDs (now guaranteed to be unique)
  rownames(processed_traits) <- processed_traits$SAMPLE_ID
  
  if (verbose) {
    print(paste0("Processed clinical traits: ", nrow(processed_traits), " samples"))
    print("Biochemical data summary:")
    print(summary(processed_traits[, c("T_TAU", "P_TAU", "ABETA42")]))
    
    # Group distribution
    group_counts <- table(processed_traits$GROUP)
    print("Group distribution:")
    print(group_counts)
  }
  
  #=============================================================================
  # 5. VALIDATE AGAINST EXISTING ABUNDANCE DATA
  #=============================================================================
  
  if (verbose) print("STEP 5 - Validating against abundance data...")
  
  # Try to load existing sample metadata for validation
  validation_summary <- list()
  
  # Check if we can find existing sample metadata
  existing_metadata_files <- c(
    "output_Aug17_CBN_median/01_input/PEAKS_Sample_Metadata.csv",
    "conversion/Peptide List Sweden Cohort_Converted.csv"
  )
  
  abundance_sample_names <- NULL
  
  # Try to get sample names from converted abundance data
  for (metadata_file in existing_metadata_files) {
    if (file.exists(metadata_file)) {
      if (verbose) print(paste("Found existing data file:", metadata_file))
      
      if (grepl("Metadata", metadata_file)) {
        # Read metadata file
        existing_metadata <- read.csv(metadata_file, row.names = 1)
        abundance_sample_names <- rownames(existing_metadata)
      } else if (grepl("Converted", metadata_file)) {
        # Read abundance data header
        abundance_header <- read.csv(metadata_file, nrows = 1)
        abundance_sample_names <- colnames(abundance_header)[grepl("^Area\\.", colnames(abundance_header))]
      }
      break
    }
  }
  
  if (!is.null(abundance_sample_names)) {
    # Validate matching
    clinical_samples <- processed_traits$SAMPLE_ID
    
    # Find matches
    matched_samples <- intersect(clinical_samples, abundance_sample_names)
    clinical_only <- setdiff(clinical_samples, abundance_sample_names)
    abundance_only <- setdiff(abundance_sample_names, clinical_samples)
    
    validation_summary <- list(
      total_clinical_samples = length(clinical_samples),
      total_abundance_samples = length(abundance_sample_names),
      matched_samples = length(matched_samples),
      clinical_only = clinical_only,
      abundance_only = abundance_only,
      match_rate = length(matched_samples) / length(clinical_samples) * 100
    )
    
    if (verbose) {
      print("VALIDATION RESULTS:")
      print(paste0("Clinical samples: ", validation_summary$total_clinical_samples))
      print(paste0("Abundance samples: ", validation_summary$total_abundance_samples))
      print(paste0("Matched samples: ", validation_summary$matched_samples))
      print(paste0("Match rate: ", round(validation_summary$match_rate, 1), "%"))
      
      if (length(clinical_only) > 0) {
        print("Samples in clinical data but not in abundance data:")
        print(clinical_only)
      }
      
      if (length(abundance_only) > 0) {
        print("Samples in abundance data but not in clinical data:")
        print(abundance_only)
      }
    }
  } else {
    validation_summary$note <- "No existing abundance data found for validation"
    if (verbose) print("Note: No existing abundance data found for validation")
  }
  
  #=============================================================================
  # 6. SAVE RESULTS
  #=============================================================================
  
  if (verbose) print("STEP 6 - Saving results...")
  
  # Save processed traits data
  write.csv(processed_traits, file = output_file, row.names = FALSE)
  
  # Save validation report
  if (!is.null(validation_file)) {
    capture.output({
      cat("CLINICAL TRAITS PROCESSING VALIDATION REPORT\n")
      cat("============================================\n")
      cat(paste0("Processing date: ", Sys.time(), "\n"))
      cat(paste0("Input file: ", clinical_file, "\n"))
      cat(paste0("Output file: ", output_file, "\n"))
      cat("\nPROCESSING SUMMARY:\n")
      cat(paste0("Total clinical samples processed: ", nrow(processed_traits), "\n"))
      cat(paste0("Control samples: ", sum(processed_traits$GROUP == "Control"), "\n"))
      cat(paste0("AD samples: ", sum(processed_traits$GROUP == "AD"), "\n"))
      
      cat("\nBIOCHEMICAL DATA SUMMARY:\n")
      cat("T-Tau (ng/L):\n")
      print(summary(processed_traits$T_TAU))
      cat("P-Tau (ng/L):\n") 
      print(summary(processed_traits$P_TAU))
      cat("Aβ42 (ng/L):\n")
      print(summary(processed_traits$ABETA42))
      
      if (!is.null(validation_summary$match_rate)) {
        cat(paste0("\nVALIDATION RESULTS:\n"))
        cat(paste0("Match rate with abundance data: ", round(validation_summary$match_rate, 1), "%\n"))
        cat(paste0("Matched samples: ", validation_summary$matched_samples, "\n"))
        
        if (length(validation_summary$clinical_only) > 0) {
          cat("\nSamples in clinical data only:\n")
          cat(paste(validation_summary$clinical_only, collapse = ", "), "\n")
        }
        
        if (length(validation_summary$abundance_only) > 0) {
          cat("\nSamples in abundance data only:\n")
          cat(paste(validation_summary$abundance_only, collapse = ", "), "\n")
        }
      }
      
      cat("\n============================================\n")
      cat("PROCESSING COMPLETE\n")
      cat("============================================\n")
    }, file = validation_file)
  }
  
  if (verbose) {
    print(paste0("Clinical traits data saved to: ", output_file))
    if (!is.null(validation_file)) {
      print(paste0("Validation report saved to: ", validation_file))
    }
  }
  
  #=============================================================================
  # 7. RETURN RESULTS
  #=============================================================================
  
  if (verbose) print("END - Clinical Traits Data Processor")
  
  return(list(
    processed_traits = processed_traits,
    validation_summary = validation_summary,
    input_file = clinical_file,
    output_file = output_file
  ))
}

#===============================================================================
# STANDALONE EXECUTION
#===============================================================================

# Allow script to be run standalone
if (!interactive()) {
  # Set working directory to project root if running from script location
  if (basename(getwd()) == "peaks_analysis") {
    setwd("..")
  }
  
  # Run with default parameters
  result <- process_clinical_traits(
    clinical_file = "data/Clinical_Info_Sweden.xlsx",
    output_file = "data/Clinical_Traits_Processed.csv",
    validation_file = "data/Clinical_Traits_Validation.txt",
    verbose = TRUE
  )
  
  cat("\n================================================================================\n")
  cat("CLINICAL TRAITS PROCESSING COMPLETE\n")
  cat("================================================================================\n")
  cat(paste0("Processed ", nrow(result$processed_traits), " samples\n"))
  cat("Files created:\n")
  cat(paste0("  - ", result$output_file, "\n"))
  cat("  - data/Clinical_Traits_Validation.txt\n")
  cat("\nReady for integration with PEAKS analysis pipeline!\n")
  cat("================================================================================\n")
}
