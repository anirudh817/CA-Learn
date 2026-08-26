# Convert WGCNA module assignments from long format to CellTypeFET wide format
# Input: Two-column CSV (Unique.ID, net.colors) OR wide format CSV with modules as columns
# Output: Wide format CSV with modules as columns, unique gene symbols only
# Gene symbols are extracted from peptide strings (first part before "|")

# Load required packages
require(tidyverse, quietly = TRUE)

# Function to extract gene symbol from peptide string
extract_gene_symbol <- function(peptide_string) {
  # Handle empty strings or NA values
  if(is.na(peptide_string) || peptide_string == "" || peptide_string == "0") {
    return("")
  }
  
  # Extract gene symbol (first part before "|")
  gene_symbol <- strsplit(peptide_string, "\\|")[[1]][1]
  
  # Handle cases where there's no "|" in the string
  if(is.na(gene_symbol)) {
    return(peptide_string)
  }
  
  return(gene_symbol)
}

# Check if input file exists and determine format
input_file <- "PEAKS_WGCNA_Module_assignments_GO-M42.csv"
long_format_file <- "PEAKS_WGCNA_Modules_CellTypeFET_Format-M42.csv"

# Try to read the wide format file first (if it exists)
if(file.exists(long_format_file)) {
  cat("Found wide format file, processing for unique gene symbols:\n")
  cat("Input file:", long_format_file, "\n\n")
  
  # Read the wide format data
  wide_data_raw <- read.csv(long_format_file, stringsAsFactors = FALSE, check.names = FALSE)
  
  # Preview raw data structure
  cat("Raw data structure (first 3 rows, first 4 modules):\n")
  print(wide_data_raw[1:3, 1:min(4, ncol(wide_data_raw))])
  cat("\n")
  
  # Process each module to extract unique gene symbols
  # Use a list to collect gene vectors first
  processed_lists <- list()
  
  for(col_name in names(wide_data_raw)) {
    cat("Processing module:", col_name, "\n")
    
    # Get all peptides in this module (remove empty entries)
    peptides <- wide_data_raw[[col_name]][wide_data_raw[[col_name]] != "" & !is.na(wide_data_raw[[col_name]])]
    
    if(length(peptides) > 0) {
      # Extract gene symbols
      gene_symbols <- sapply(peptides, extract_gene_symbol, USE.NAMES = FALSE)
      
      # Remove empty gene symbols and get unique ones
      unique_genes <- unique(gene_symbols[gene_symbols != "" & !is.na(gene_symbols)])
      
      cat("  - Original peptides:", length(peptides), "\n")
      cat("  - Unique gene symbols:", length(unique_genes), "\n")
      
      # Store in list
      processed_lists[[col_name]] <- unique_genes
    } else {
      processed_lists[[col_name]] <- character(0)
    }
  }
  
  # Find maximum length to create properly sized data frame
  max_size <- max(sapply(processed_lists, length))
  if(max_size == 0) max_size <- 1
  
  # Create final wide format data frame with equal row counts
  final_wide_data <- data.frame(row.names = 1:max_size)
  
  for(col_name in names(processed_lists)) {
    genes <- processed_lists[[col_name]]
    # Pad with empty strings to match max_size
    padded_genes <- c(genes, rep("", max_size - length(genes)))
    final_wide_data[[col_name]] <- padded_genes
  }
  
  # Set the processed wide data as our main dataset
  wide_data <- final_wide_data
  
} else if(file.exists(input_file)) {
  cat("Processing long format file:\n")
  cat("Input file:", input_file, "\n\n")
  
  # Read long format data
  wgcna_data <- read.csv(input_file, stringsAsFactors = FALSE)
  
  # Preview current format
  cat("Current data structure:\n")
  print(head(wgcna_data))
  cat("\nModule distribution:\n")
  module_counts <- table(wgcna_data$net.colors)
  print(sort(module_counts, decreasing = TRUE))
  
  # Extract gene symbols from peptide identifiers
  wgcna_data$gene_symbol <- sapply(wgcna_data$Unique.ID, extract_gene_symbol)
  
  # Remove 'grey' module (unassigned genes) - standard practice
  wgcna_data_filtered <- wgcna_data[wgcna_data$net.colors != "grey", ]
  
  # Remove entries with empty gene symbols
  wgcna_data_filtered <- wgcna_data_filtered[wgcna_data_filtered$gene_symbol != "" & !is.na(wgcna_data_filtered$gene_symbol), ]
  
  # Get unique gene-module combinations (remove duplicate gene symbols per module)
  wgcna_data_unique <- wgcna_data_filtered %>%
    group_by(net.colors, gene_symbol) %>%
    slice(1) %>%
    ungroup()
  
  cat("\nAfter processing:\n")
  cat("Original entries:", nrow(wgcna_data), "\n")
  cat("After removing grey module:", nrow(wgcna_data_filtered), "\n")
  cat("Unique gene-module combinations:", nrow(wgcna_data_unique), "\n")
  cat("Active modules:", length(unique(wgcna_data_unique$net.colors)), "\n\n")
  
  # Convert to wide format for CellTypeFET
  # Split by module and create list of unique gene symbols
  module_lists <- split(wgcna_data_unique$gene_symbol, wgcna_data_unique$net.colors)
  
  # Find maximum module size to create properly sized data frame
  max_size <- max(sapply(module_lists, length))
  
  # Create wide format data frame
  wide_data <- data.frame(row.names = 1:max_size)
  
  # Fill each column with unique gene symbols
  for(module in names(module_lists)) {
    genes <- module_lists[[module]]
    # Pad with empty strings to match max_size
    padded_genes <- c(genes, rep("", max_size - length(genes)))
    wide_data[[module]] <- padded_genes
  }
  
} else {
  stop("Neither ", input_file, " nor ", long_format_file, " found!")
}

# Preview the final processed data
cat("\nFinal processed data structure (first 5 rows, first 4 modules):\n")
print(wide_data[1:5, 1:min(4, ncol(wide_data))])

cat("\nModule sizes (unique gene symbols):\n")
module_sizes <- sapply(wide_data, function(x) sum(x != "" & !is.na(x)))
print(sort(module_sizes, decreasing = TRUE))

# Write the converted file with unique gene symbols
output_file <- "PEAKS_WGCNA_Modules_CellTypeFET_Format_UniqueGenes.csv"
write.csv(wide_data, output_file, row.names = FALSE, na = "")

cat("\nProcessing complete!\n")
cat("Output file:", output_file, "\n")
cat("Total modules:", ncol(wide_data), "\n")
cat("Largest module size:", max(module_sizes), "unique genes\n")
cat("\nThe file now contains only unique gene symbols per module.\n")
cat("Gene symbols were extracted from peptide strings (text before first '|').\n")

# Create a summary report
cat("\nSummary of gene symbol extraction:\n")
cat("- Each peptide string like 'ORM1|P02763|WGLSVYADKPETTK' becomes 'ORM1'\n")
cat("- Duplicate gene symbols within each module have been removed\n")
cat("- Empty cells are padded with empty strings for consistent formatting\n")

# Display sample transformations for verification
if(exists("wide_data_raw")) {
  cat("\nSample transformations (first module, first few entries):\n")
  first_col <- names(wide_data_raw)[1]
  sample_peptides <- wide_data_raw[[first_col]][1:5]
  sample_peptides <- sample_peptides[sample_peptides != "" & !is.na(sample_peptides)]
  
  if(length(sample_peptides) > 0) {
    for(i in 1:min(3, length(sample_peptides))) {
      original <- sample_peptides[i]
      gene_sym <- extract_gene_symbol(original)
      cat("  Original: ", original, "\n")
      cat("  Gene Symbol: ", gene_sym, "\n\n")
    }
  }
}

cat("\nUpdate your wrapper script to use:", output_file, "\n")