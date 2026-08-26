# validate_sample_matching.R
# v1.0: Deep validation of sample matching across abundance data, disease groups, and clinical traits
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Comprehensive validation of sample-trait-abundance matching
## INPUT:       Processed abundance data and clinical traits
## OUTPUT:      Detailed validation report with any discrepancies
## DESCRIPTION: Ensures perfect alignment between samples, disease status, and biomarkers
################################################################################

#' Validate Sample Matching Across All Data Sources
#' 
#' Performs comprehensive validation to ensure that:
#' 1. Abundance data samples match traits data samples
#' 2. Disease classifications are consistent
#' 3. Clinical biomarker values are correctly associated
#' 4. No sample mix-ups or data integrity issues
#' 
#' @param abundance_file Path to abundance data CSV
#' @param traits_file Path to traits data CSV  
#' @param original_clinical_file Path to original clinical Excel file (optional)
#' @param verbose Boolean for detailed output
#' 
#' @return Validation report with any issues found
validate_sample_matching <- function(
  abundance_file = NULL,
  traits_file = NULL,
  original_clinical_file = "data/Clinical_Info_Sweden.xlsx",
  verbose = TRUE
) {
  
  if (verbose) print("START - Deep Sample Matching Validation")
  
  # Load required packages
  required_packages <- c("readxl")
  for (pkg in required_packages) {
    if (!require(pkg, character.only = TRUE, quietly = TRUE)) {
      print(paste("Installing", pkg, "package..."))
      install.packages(pkg)
      library(pkg, character.only = TRUE)
    }
  }
  
  validation_report <- list(
    issues_found = FALSE,
    critical_issues = character(),
    warnings = character(),
    details = list()
  )
  
  #=============================================================================
  # 1. AUTO-DETECT DATA FILES IF NOT PROVIDED
  #=============================================================================
  
  if (is.null(abundance_file)) {
    # Try to find abundance data
    abundance_candidates <- c(
      "output_Aug17_CBN_median/01_input/PEAKS_Log2_Normalized_Data.csv",
      "output_Aug17_CBN_median/01_input/PEAKS_Abundance_Matrix.csv",
      "conversion/Peptide List Sweden Cohort_Converted.csv"
    )
    
    for (candidate in abundance_candidates) {
      if (file.exists(candidate)) {
        abundance_file <- candidate
        break
      }
    }
  }
  
  if (is.null(traits_file)) {
    # Try to find traits data
    traits_candidates <- c(
      "output_Aug17_CBN_median/01_input/PEAKS_Sample_Traits_Data.csv",
      "data/Clinical_Traits_Processed.csv"
    )
    
    for (candidate in traits_candidates) {
      if (file.exists(candidate)) {
        traits_file <- candidate
        break
      }
    }
  }
  
  if (verbose) {
    print(paste0("Abundance data file: ", ifelse(is.null(abundance_file), "NOT FOUND", abundance_file)))
    print(paste0("Traits data file: ", ifelse(is.null(traits_file), "NOT FOUND", traits_file)))
  }
  
  #=============================================================================
  # 2. LOAD AND VALIDATE DATA FILES
  #=============================================================================
  
  if (is.null(abundance_file) || !file.exists(abundance_file)) {
    validation_report$critical_issues <- c(validation_report$critical_issues, 
                                         "Abundance data file not found or specified")
    validation_report$issues_found <- TRUE
    return(validation_report)
  }
  
  if (is.null(traits_file) || !file.exists(traits_file)) {
    validation_report$critical_issues <- c(validation_report$critical_issues, 
                                         "Traits data file not found or specified")
    validation_report$issues_found <- TRUE
    return(validation_report)
  }
  
  # Load abundance data
  if (verbose) print("Loading abundance data...")
  abundance_data <- read.csv(abundance_file, row.names = 1)
  abundance_samples <- colnames(abundance_data)
  
  # Filter to Area.* columns only (abundance columns)
  area_cols <- grepl("^Area\\.", abundance_samples)
  if (any(area_cols)) {
    abundance_samples <- abundance_samples[area_cols]
    abundance_data <- abundance_data[, area_cols]
  }
  
  # Load traits data
  if (verbose) print("Loading traits data...")
  traits_data <- read.csv(traits_file, stringsAsFactors = FALSE)
  if (!"SAMPLE_ID" %in% colnames(traits_data)) {
    validation_report$critical_issues <- c(validation_report$critical_issues, 
                                         "Traits data missing SAMPLE_ID column")
    validation_report$issues_found <- TRUE
    return(validation_report)
  }
  
  rownames(traits_data) <- traits_data$SAMPLE_ID
  traits_samples <- traits_data$SAMPLE_ID
  
  if (verbose) {
    print(paste0("Abundance data: ", ncol(abundance_data), " samples, ", nrow(abundance_data), " peptides"))
    print(paste0("Traits data: ", nrow(traits_data), " samples"))
  }
  
  #=============================================================================
  # 3. VALIDATE SAMPLE MATCHING
  #=============================================================================
  
  if (verbose) print("Validating sample matching...")
  
  # Check for perfect match
  matched_samples <- intersect(abundance_samples, traits_samples)
  abundance_only <- setdiff(abundance_samples, traits_samples)
  traits_only <- setdiff(traits_samples, abundance_samples)
  
  validation_report$details$sample_matching <- list(
    total_abundance_samples = length(abundance_samples),
    total_traits_samples = length(traits_samples),
    matched_samples = length(matched_samples),
    abundance_only = abundance_only,
    traits_only = traits_only,
    match_rate = length(matched_samples) / max(length(abundance_samples), length(traits_samples)) * 100
  )
  
  if (length(abundance_only) > 0) {
    validation_report$warnings <- c(validation_report$warnings,
                                   paste("Samples in abundance data but not in traits:", 
                                         paste(abundance_only, collapse = ", ")))
  }
  
  if (length(traits_only) > 0) {
    validation_report$warnings <- c(validation_report$warnings,
                                   paste("Samples in traits data but not in abundance:", 
                                         paste(traits_only, collapse = ", ")))
  }
  
  #=============================================================================
  # 4. VALIDATE DISEASE CLASSIFICATION CONSISTENCY
  #=============================================================================
  
  if (verbose) print("Validating disease classifications...")
  
  # Check that sample names are consistent with disease classification
  disease_classification_issues <- character()
  
  for (sample in matched_samples) {
    sample_group <- traits_data[sample, "GROUP"]
    
    # Check naming convention consistency
    if (grepl("Control", sample)) {
      expected_group <- "Control"
    } else if (grepl("AD", sample)) {
      expected_group <- "AD"
    } else {
      expected_group <- "Unknown"
    }
    
    if (expected_group != "Unknown" && sample_group != expected_group) {
      disease_classification_issues <- c(disease_classification_issues,
                                       paste0(sample, ": Named as ", expected_group, 
                                             " but classified as ", sample_group))
    }
  }
  
  validation_report$details$disease_classification <- list(
    total_checked = length(matched_samples),
    issues_found = length(disease_classification_issues),
    issue_details = disease_classification_issues
  )
  
  if (length(disease_classification_issues) > 0) {
    validation_report$critical_issues <- c(validation_report$critical_issues,
                                         "Disease classification inconsistencies found")
    validation_report$issues_found <- TRUE
  }
  
  #=============================================================================
  # 5. VALIDATE CLINICAL BIOMARKER DATA INTEGRITY  
  #=============================================================================
  
  if (verbose) print("Validating clinical biomarker data...")
  
  biomarker_cols <- c("T_TAU", "P_TAU", "ABETA42")
  available_biomarkers <- biomarker_cols[biomarker_cols %in% colnames(traits_data)]
  
  if (length(available_biomarkers) > 0) {
    biomarker_validation <- list()
    
    for (biomarker in available_biomarkers) {
      values <- traits_data[matched_samples, biomarker]
      values <- values[!is.na(values)]
      
      biomarker_validation[[biomarker]] <- list(
        samples_with_data = length(values),
        missing_data = sum(is.na(traits_data[matched_samples, biomarker])),
        range = if(length(values) > 0) range(values, na.rm = TRUE) else c(NA, NA),
        mean = if(length(values) > 0) mean(values, na.rm = TRUE) else NA,
        outliers = if(length(values) > 0) sum(abs(scale(values)) > 3, na.rm = TRUE) else 0
      )
      
      # Check for reasonable ranges based on typical biomarker values
      if (biomarker == "T_TAU" && length(values) > 0) {
        if (min(values, na.rm = TRUE) < 50 || max(values, na.rm = TRUE) > 5000) {
          validation_report$warnings <- c(validation_report$warnings,
                                         paste("T-Tau values outside typical range (50-5000 ng/L):",
                                               "min =", min(values, na.rm = TRUE),
                                               "max =", max(values, na.rm = TRUE)))
        }
      }
      
      if (biomarker == "P_TAU" && length(values) > 0) {
        if (min(values, na.rm = TRUE) < 10 || max(values, na.rm = TRUE) > 500) {
          validation_report$warnings <- c(validation_report$warnings,
                                         paste("P-Tau values outside typical range (10-500 ng/L):",
                                               "min =", min(values, na.rm = TRUE),
                                               "max =", max(values, na.rm = TRUE)))
        }
      }
      
      if (biomarker == "ABETA42" && length(values) > 0) {
        if (min(values, na.rm = TRUE) < 100 || max(values, na.rm = TRUE) > 2000) {
          validation_report$warnings <- c(validation_report$warnings,
                                         paste("Aβ42 values outside typical range (100-2000 ng/L):",
                                               "min =", min(values, na.rm = TRUE),
                                               "max =", max(values, na.rm = TRUE)))
        }
      }
    }
    
    validation_report$details$biomarker_validation <- biomarker_validation
  } else {
    validation_report$warnings <- c(validation_report$warnings,
                                   "No clinical biomarker data found in traits file")
  }
  
  #=============================================================================
  # 6. CROSS-VALIDATE WITH ORIGINAL CLINICAL DATA
  #=============================================================================
  
  if (file.exists(original_clinical_file)) {
    if (verbose) print("Cross-validating with original clinical data...")
    
    # Load original clinical data
    original_clinical <- readxl::read_excel(original_clinical_file)
    
    # Extract sample IDs from original file names (same logic as processor)
    extract_sample_id <- function(full_name) {
      parts <- strsplit(as.character(full_name), "_")[[1]]
      last_part <- parts[length(parts)]
      sample_id <- strsplit(last_part, "\\.raw")[[1]][1]
      
      if (grepl("^sample", sample_id, ignore.case = TRUE)) {
        clean_id <- gsub("^sample", "", sample_id, ignore.case = TRUE)
        if (nchar(clean_id) > 0) {
          first_char <- toupper(substr(clean_id, 1, 1))
          rest_chars <- substr(clean_id, 2, nchar(clean_id))
          clean_id <- paste0(first_char, rest_chars)
        }
      }
      
      return(paste0("sample", clean_id))
    }
    
    original_clinical$extracted_id <- sapply(original_clinical$`sample name`, extract_sample_id)
    
    # Create mapping to proteomics format
    create_proteomics_id <- function(sample_id, ad_classification) {
      clean_id <- gsub("^sample", "", sample_id)
      ad_class_clean <- tolower(trimws(as.character(ad_classification)))
      
      if (grepl("control", ad_class_clean)) {
        return(paste0("Area.Control.", clean_id))
      } else if (grepl("ad", ad_class_clean)) {
        return(paste0("Area.AD.", clean_id))
      } else {
        return(paste0("Area.Unknown.", clean_id))
      }
    }
    
    original_clinical$proteomics_id <- mapply(
      create_proteomics_id,
      original_clinical$extracted_id,
      original_clinical$`primary biochemical AD classification`
    )
    
    # Cross-validate key values
    cross_validation_issues <- character()
    
    for (sample in matched_samples) {
      if (sample %in% original_clinical$proteomics_id) {
        orig_row <- which(original_clinical$proteomics_id == sample)
        
        # Check T-Tau
        if ("T_TAU" %in% colnames(traits_data)) {
          orig_ttau <- as.numeric(original_clinical$`t-tau [ng/L]`[orig_row])
          processed_ttau <- traits_data[sample, "T_TAU"]
          
          if (!is.na(orig_ttau) && !is.na(processed_ttau) && abs(orig_ttau - processed_ttau) > 0.1) {
            cross_validation_issues <- c(cross_validation_issues,
                                       paste0(sample, " T-Tau mismatch: orig=", orig_ttau, 
                                             " processed=", processed_ttau))
          }
        }
        
        # Check P-Tau
        if ("P_TAU" %in% colnames(traits_data)) {
          orig_ptau <- as.numeric(original_clinical$`p-tau [ng/L]`[orig_row])
          processed_ptau <- traits_data[sample, "P_TAU"]
          
          if (!is.na(orig_ptau) && !is.na(processed_ptau) && abs(orig_ptau - processed_ptau) > 0.1) {
            cross_validation_issues <- c(cross_validation_issues,
                                       paste0(sample, " P-Tau mismatch: orig=", orig_ptau, 
                                             " processed=", processed_ptau))
          }
        }
        
        # Check Aβ42
        if ("ABETA42" %in% colnames(traits_data)) {
          orig_abeta <- as.numeric(original_clinical$`Abeta-42 [ng/L]`[orig_row])
          processed_abeta <- traits_data[sample, "ABETA42"]
          
          if (!is.na(orig_abeta) && !is.na(processed_abeta) && abs(orig_abeta - processed_abeta) > 0.1) {
            cross_validation_issues <- c(cross_validation_issues,
                                       paste0(sample, " Aβ42 mismatch: orig=", orig_abeta, 
                                             " processed=", processed_abeta))
          }
        }
      }
    }
    
    validation_report$details$cross_validation <- list(
      original_samples_found = sum(matched_samples %in% original_clinical$proteomics_id),
      value_mismatches = length(cross_validation_issues),
      mismatch_details = cross_validation_issues
    )
    
    if (length(cross_validation_issues) > 0) {
      validation_report$critical_issues <- c(validation_report$critical_issues,
                                           "Data value mismatches found with original clinical data")
      validation_report$issues_found <- TRUE
    }
  }
  
  #=============================================================================
  # 7. SUMMARY AND FINAL VALIDATION
  #=============================================================================
  
  if (verbose) {
    print("VALIDATION SUMMARY:")
    print("==================")
    print(paste0("Sample match rate: ", round(validation_report$details$sample_matching$match_rate, 1), "%"))
    print(paste0("Disease classification issues: ", length(validation_report$details$disease_classification$issue_details)))
    print(paste0("Critical issues found: ", length(validation_report$critical_issues)))
    print(paste0("Warnings: ", length(validation_report$warnings)))
    
    if (length(validation_report$critical_issues) > 0) {
      print("CRITICAL ISSUES:")
      for (issue in validation_report$critical_issues) {
        print(paste0("  - ", issue))
      }
    }
    
    if (length(validation_report$warnings) > 0) {
      print("WARNINGS:")
      for (warning in validation_report$warnings) {
        print(paste0("  - ", warning))
      }
    }
    
    if (!validation_report$issues_found && length(validation_report$warnings) == 0) {
      print("✅ VALIDATION PASSED: All samples are correctly matched!")
    }
  }
  
  if (verbose) print("END - Deep Sample Matching Validation")
  
  return(validation_report)
}

#===============================================================================
# STANDALONE EXECUTION
#===============================================================================

if (!interactive()) {
  # Set working directory to project root if running from script location
  if (basename(getwd()) == "peaks_analysis") {
    setwd("..")
  }
  
  cat("\n================================================================================\n")
  cat("                    SAMPLE MATCHING VALIDATION                                 \n")
  cat("================================================================================\n")
  
  # Run comprehensive validation
  validation_result <- validate_sample_matching(verbose = TRUE)
  
  cat("\n================================================================================\n")
  if (validation_result$issues_found) {
    cat("                          VALIDATION FAILED                                    \n")
    cat("================================================================================\n")
    cat("Critical issues found! Please review and fix before proceeding.\n")
  } else {
    cat("                          VALIDATION PASSED                                    \n") 
    cat("================================================================================\n")
    cat("All samples are correctly matched across all data sources!\n")
  }
  cat("================================================================================\n")
}
