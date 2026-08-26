# peaks_Search_Proteins.R
# v2.0: Search and filter functionality for PEAKS protein/peptide data
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Search for specific proteins or peptides in PEAKS results
## INPUT:       PEAKS results data and search terms
## OUTPUT:      Filtered results matching search criteria
## DESCRIPTION: Gene/protein/peptide search functionality
################################################################################

peaks_SearchProteins <- function(results_data, search_terms, search_type = "gene") {
  
  print("START - PEAKS Protein/Peptide Search")
  
  #=============================================================================
  # 1. INPUT VALIDATION
  #=============================================================================
  
  if (is.null(results_data) || nrow(results_data) == 0) {
    stop("results_data is empty or NULL")
  }
  
  if (is.null(search_terms) || length(search_terms) == 0) {
    stop("search_terms is empty or NULL")
  }
  
  # Convert search terms to character and make case-insensitive
  search_terms <- tolower(as.character(search_terms))
  
  print(paste0("Searching for: ", paste(search_terms, collapse = ", ")))
  print(paste0("Search type: ", search_type))
  
  #=============================================================================
  # 2. PERFORM SEARCH BASED ON TYPE
  #=============================================================================
  
  if (search_type == "gene") {
    # Search in Gene column (first part of Peptide_ID)
    if ("Gene" %in% colnames(results_data)) {
      search_column <- tolower(results_data$Gene)
    } else {
      # Extract gene from Peptide_ID if Gene column doesn't exist
      search_column <- tolower(sapply(strsplit(results_data$Peptide_ID, "\\|"), function(x) x[1]))
    }
    
  } else if (search_type == "protein") {
    # Search in protein accession (second part of Peptide_ID)
    search_column <- tolower(sapply(strsplit(results_data$Peptide_ID, "\\|"), function(x) x[2]))
    
  } else if (search_type == "peptide") {
    # Search in peptide sequence (third part of Peptide_ID)
    search_column <- tolower(sapply(strsplit(results_data$Peptide_ID, "\\|"), function(x) x[3]))
    
  } else {
    stop("search_type must be 'gene', 'protein', or 'peptide'")
  }
  
  #=============================================================================
  # 3. FIND MATCHES
  #=============================================================================
  
  # Find rows that match any of the search terms
  matches <- rep(FALSE, nrow(results_data))
  
  for (term in search_terms) {
    # Use partial matching
    term_matches <- grepl(term, search_column, fixed = TRUE)
    matches <- matches | term_matches
  }
  
  # Extract matching results
  matched_results <- results_data[matches, ]
  
  print(paste0("Found ", nrow(matched_results), " matches out of ", nrow(results_data), " total entries"))
  
  #=============================================================================
  # 4. RETURN RESULTS
  #=============================================================================
  
  if (nrow(matched_results) > 0) {
    return(matched_results)
  } else {
    print("No matches found")
    return(NULL)
  }
} 