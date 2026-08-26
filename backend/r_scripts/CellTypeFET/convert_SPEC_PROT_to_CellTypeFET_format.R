# Convert SPEC Protein WGCNA Module Assignments to CellTypeFET Wide Format
# Input: Long format CSV (Unique.ID, net.colors) from protein analysis
# Output: Wide format CSV with modules as columns for brain cell type enrichment

# Load required packages
library(tidyverse)

# Read the SPEC protein module assignments (long format)
input_file <- "SPEC-PROT-Module_Assignment-GO-Inpout.csv"
prot_modules <- read.csv(input_file, stringsAsFactors = FALSE, fileEncoding = "UTF-8-BOM")

# Clean column names (remove any invisible characters)
colnames(prot_modules) <- c("Unique.ID", "net.colors")

cat("SPEC Protein Module Input Data:\n")
cat("  Total proteins:", nrow(prot_modules), "\n")
cat("  Unique modules:", length(unique(prot_modules$net.colors)), "\n")
cat("  Module distribution:\n")
print(table(prot_modules$net.colors))

# Extract gene symbols from Unique.ID (first part before |)
cat("\nExtracting gene symbols from protein IDs...\n")

# Extract gene symbols using stringr (more robust)
prot_modules$gene_symbol <- str_extract(prot_modules$Unique.ID, "^[^|]+")

# Handle any remaining NAs
prot_modules$gene_symbol[is.na(prot_modules$gene_symbol)] <- "UNKNOWN"

cat("Gene symbol extraction examples:\n")
print(head(data.frame(
  Original = prot_modules$Unique.ID[1:5],
  Gene_Symbol = prot_modules$gene_symbol[1:5]
)))

# Remove grey module (unassigned proteins) - standard practice for CellTypeFET
prot_modules_filtered <- prot_modules[prot_modules$net.colors != "grey", ]
cat("\nFiltered data (excluding grey module):\n")
cat("  Proteins retained:", nrow(prot_modules_filtered), "\n")
cat("  Modules for analysis:", length(unique(prot_modules_filtered$net.colors)), "\n")

# Convert to wide format using tidyr
cat("\nConverting to wide format for CellTypeFET...\n")
prot_wide <- prot_modules_filtered %>%
  select(gene_symbol, net.colors) %>%
  group_by(net.colors) %>%
  mutate(row_id = row_number()) %>%
  pivot_wider(
    names_from = net.colors,
    values_from = gene_symbol,
    values_fill = ""
  ) %>%
  select(-row_id)

# Reorder columns to match typical WGCNA module order (largest first)
module_sizes <- prot_modules_filtered %>%
  count(net.colors, sort = TRUE)

ordered_modules <- module_sizes$net.colors
prot_wide <- prot_wide[, ordered_modules]

cat("Final wide format for CellTypeFET:\n")
cat("  Modules (columns):", ncol(prot_wide), "\n")
cat("  Max rows per module:", nrow(prot_wide), "\n")
cat("  Module order (by size):", paste(colnames(prot_wide)[1:min(5, ncol(prot_wide))], collapse = ", "), "...\n")

# Preview the wide format
cat("\nPreview of wide format data:\n")
print(prot_wide[1:5, 1:min(5, ncol(prot_wide))])

# Save in CellTypeFET format
output_file <- "SPEC_PROT_WGCNA_Modules_CellTypeFET_Wide-Format-CTFTP-input.csv"
write.csv(prot_wide, output_file, row.names = FALSE, na = "")

cat("\nConversion complete!\n")
cat("Output file:", output_file, "\n")
cat("Ready for SPEC Protein CellTypeFET analysis.\n")

# Validation check
cat("\nValidation:\n")
for (module in colnames(prot_wide)) {
  gene_count <- sum(prot_wide[[module]] != "")
  cat("  ", module, "module:", gene_count, "genes\n")
}
