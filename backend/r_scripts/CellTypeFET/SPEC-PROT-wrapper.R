###################################################################################################################
# CellTypeFET Analysis for SPECTRONAUT Protein WGCNA Modules
# Customized wrapper for SPEC_PROT_WGCNA_Module_assignments
# Based on Eric Dammer's CellTypeFET pipeline
###################################################################################################################

options(stringsAsFactors=FALSE)

############ DIRECTORY AND FILE SETUP ##########################
rootdir <- paste0(getwd(), "/")  # Current working directory with trailing slash
setwd(rootdir)

# Source the main CellTypeFET function
source("geneListFET.R")  # You need this file from GitHub

############ CONFIGURATION PARAMETERS FOR SPEC PROTEIN DATA ##########################

# File naming and output settings
FileBaseName <- "SPEC_Protein_CellTypeFET"
refDataDescription <- "5brainCellTypes"

# Your input module assignment file (wide format)
categoriesFile <- "SPEC_PROT_WGCNA_Modules_CellTypeFET_Wide-Format-CTFTP-input.csv"
categorySpeciesCode <- "hsapiens"  # human protein data - Species of genes in user input data

# Cell type reference files
# hRef - no conversion 
# Mouse reference: Automatically converts mouse genes to human homologs
# Generates two heatmaps for both ref files
refDataFiles <- c("MyGene-Human-SharmaZhangUnion.csv", "MyGene-Mouse-SharmaZhangUnion.csv")
speciesCode <- c("hsapiens", "mmusculus")

# Analysis settings
modulesInMemory <- FALSE  # Use CSV file input (your case)
allowDuplicates <- TRUE   # Allow genes to appear in multiple cell type lists

# Output directory name (if NULL, outputs go to current directory)
outputDirName <- "SPEC_PROT_CellTypeFET_Results"  # SPEC protein-specific output folder

# resortListsDecreasingSize
# TRUE: Largest modules appear first
# FALSE: Preserve original WGCNA module order
resortListsDecreasingSize <- FALSE  # Keep modules in original order

# adjustFETforLookupEfficiency
# This does NOT control whether to do mouse conversion. It adjusts the statistical calculations:
# False- Standard FET 
# True-  Adjusts FET to account for gene symbol conversion losses in cross-species comparisons
adjustFETforLookupEfficiency <- FALSE  # Standard analysis

# Visualization settings
heatmapScale <- "minusLogFDR"  # Show -log10(FDR) values
heatmapTitle <- "SPECTRONAUT Protein WGCNA Modules - Brain Cell Type Enrichments"
paletteColors <- c("YlGnBu", "Oranges")  # One palette per reference file

# barOption param
# FALSE: Heatmap showing all modules vs all cell types
# TRUE: Separate bar chart per cell type showing module rankings
barOption <- FALSE  # Heatmap format (change to TRUE for bar charts)
verticalCompression <- 3  # Layout parameter for bar charts

# Advanced options (usually keep defaults)
reproduceHistoricCalc <- FALSE

############ PRE-ANALYSIS CHECKS ##########################

# Check if required files exist
if (!file.exists(categoriesFile)) {
  stop("Module assignment file not found: ", categoriesFile)
}

if (!file.exists("geneListFET.R")) {
  stop("geneListFET.R function file not found. Download from CellTypeFET GitHub.")
}

# Check reference files
missing_ref <- refDataFiles[!file.exists(refDataFiles)]
if (length(missing_ref) > 0) {
  cat("WARNING: Reference files not found:\n")
  cat(paste(missing_ref, collapse = "\n"), "\n")
  cat("You need to obtain these from CellTypeFET GitHub repository.\n\n")
}

# Preview your data
cat("Previewing your SPEC protein module assignment data:\n")
preview_data <- read.csv(categoriesFile, nrows = 5)
print(preview_data)

# Count genes per module
protein_data <- read.csv(categoriesFile, stringsAsFactors = FALSE)
module_counts <- sapply(protein_data, function(col) sum(col != "" & !is.na(col)))
cat("\nModule sizes (protein modules):\n")
print(sort(module_counts, decreasing = TRUE)[1:min(10, length(module_counts))])

cat(paste("\nTotal modules:", length(module_counts)))
cat(paste("\nTotal genes:", sum(module_counts)))

############ ANALYSIS EXECUTION ##########################

if (all(file.exists(c("geneListFET.R", refDataFiles)))) {
  cat("\n=== RUNNING CELLTYPE FET ANALYSIS FOR PROTEINS ===\n")
  
  # Main heatmap analysis
  geneListFET(
    FileBaseName = FileBaseName,
    heatmapTitle = heatmapTitle,
    modulesInMemory = modulesInMemory,
    categoriesFile = categoriesFile,
    categorySpeciesCode = categorySpeciesCode,
    refDataFiles = refDataFiles,
    speciesCode = speciesCode,
    refDataDescription = refDataDescription,
    heatmapScale = heatmapScale,
    paletteColors = paletteColors,
    allowDuplicates = allowDuplicates,
    resortListsDecreasingSize = resortListsDecreasingSize,
    barOption = barOption,
    adjustFETforLookupEfficiency = adjustFETforLookupEfficiency,
    verticalCompression = verticalCompression,
    outputDirName = outputDirName,
    reproduceHistoricCalc = reproduceHistoricCalc,
    rootdir = rootdir
  )
  
  # Optional: Generate bar chart version as well
  cat("\n=== GENERATING BAR CHART VERSION ===\n")
  geneListFET(
    FileBaseName = paste0(FileBaseName, "_barChart"),
    heatmapTitle = heatmapTitle,
    modulesInMemory = modulesInMemory,
    categoriesFile = categoriesFile,
    categorySpeciesCode = categorySpeciesCode,
    refDataFiles = refDataFiles,
    speciesCode = speciesCode,
    refDataDescription = refDataDescription,
    heatmapScale = heatmapScale,
    paletteColors = paletteColors,
    barOption = TRUE,  # Generate bar charts
    allowDuplicates = allowDuplicates,
    resortListsDecreasingSize = resortListsDecreasingSize,
    adjustFETforLookupEfficiency = adjustFETforLookupEfficiency,
    verticalCompression = verticalCompression,
    outputDirName = outputDirName,
    reproduceHistoricCalc = reproduceHistoricCalc,
    rootdir = rootdir
  )
  
  cat("\n=== ANALYSIS COMPLETE ===\n")
  cat("Output files generated in", ifelse(is.null(outputDirName), "current directory:", paste0(outputDirName, "/ directory:")), "\n")
  cat("- PDF heatmaps: ", paste0(FileBaseName, ".Overlap.in.", refDataDescription, ".pdf"), "\n")
  cat("- Statistical tables: *-hitListStats.csv files\n")
  
} else {
  cat("\n=== SETUP REQUIRED ===\n")
  cat("Please obtain missing files before running analysis.\n")
}

############ EXPECTED OUTPUT INTERPRETATION ##########################

cat("\n=== INTERPRETATION GUIDE ===\n")
cat("Heatmap interpretation:\n")
cat("- Rows: Brain cell types (Neurons, Astrocytes, Oligodendrocytes, Microglia, Endothelial)\n")
cat("- Columns: Your SPEC protein WGCNA modules (colors)\n")
cat("- Color intensity: -log10(FDR) values\n")
cat("- Significance: Darker colors indicate stronger enrichment\n")
cat("- FDR < 0.05 threshold: -log10(0.05) = 1.3\n")
cat("- FDR < 0.01 threshold: -log10(0.01) = 2.0\n\n")

cat("Expected patterns for brain proteins:\n")
cat("- Modules enriched in Neuron markers: Synaptic proteins, ion channels, neurotransmitter receptors\n")
cat("- Modules enriched in Astrocyte markers: GFAP, metabolic support proteins, aquaporins\n")
cat("- Modules enriched in Oligodendrocyte markers: Myelin proteins, oligodendrocyte markers\n")
cat("- Modules enriched in Microglia markers: Immune/inflammatory proteins, complement system\n")
cat("- Modules enriched in Endothelial markers: Vascular proteins, blood-brain barrier components\n")
