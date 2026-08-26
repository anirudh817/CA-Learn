# Convert SPEC WGCNA Module Assignments to CellTypeFET Wide Format
# Input: Long format CSV (Unique.ID, net.colors)
# Output: Wide format CSV with modules as columns

# Load required packages
library(tidyverse)

# Read the SPEC module assignments (long format)
input_file <- "../GOparallel/SPEC_WGCNA_Module_Assignments_GO-FIXED.csv"
spec_modules <- read.csv(input_file, stringsAsFactors = FALSE)

cat("Input data loaded:\n")
cat("  Total peptides:", nrow(spec_modules), "\n")
cat("  Unique modules:", length(unique(spec_modules$net.colors)), "\n")
cat("  Module distribution:\n")
print(table(spec_modules$net.colors))

# Convert to wide format using tidyr
spec_wide <- spec_modules %>%
  group_by(net.colors) %>%
  mutate(row_id = row_number()) %>%
  pivot_wider(
    names_from = net.colors,
    values_from = Unique.ID,
    values_fill = ""
  ) %>%
  select(-row_id)

# Remove the grey module if present (unassigned peptides)
if ("grey" %in% colnames(spec_wide)) {
  spec_wide <- spec_wide %>% select(-grey)
  cat("  Removed grey module (unassigned peptides)\n")
}

# Reorder columns to match typical WGCNA module order (largest first)
module_sizes <- spec_modules %>%
  filter(net.colors != "grey") %>%
  count(net.colors, sort = TRUE)

ordered_modules <- module_sizes$net.colors
spec_wide <- spec_wide[, ordered_modules]

cat("Final wide format:\n")
cat("  Modules (columns):", ncol(spec_wide), "\n")
cat("  Max rows per module:", nrow(spec_wide), "\n")
cat("  Module order (by size):", paste(colnames(spec_wide)[1:min(5, ncol(spec_wide))], collapse = ", "), "...\n")

# Save in CellTypeFET format
output_file <- "SPEC_WGCNA_Modules_CellTypeFET_Wide-Format.csv"
write.csv(spec_wide, output_file, row.names = FALSE, na = "")

cat("\nConversion complete!\n")
cat("Output file:", output_file, "\n")
cat("Ready for CellTypeFET analysis.\n")
