# GOparallel Wrapper Configuration for Swedish Cohort Analysis

#dev.off()
options(stringsAsFactors=FALSE)

# ====================================================================
# EDIT THESE VARIABLES ONLY
# ====================================================================

# === INPUT CONFIGURATION ===
# input from the WGCNA resulting in 24 modules, main output folder: Output_Aug24_CBN_median_WGCNA_CBN_median
#inputFile <- "PEAKS_WGCNA_Module_assignments_FIXED.csv"  # Your kME matrix file
#filePath <- "/path/to/your/GOparallel/"    # Path to your GOparallel folder
                                           # (where your kME file is located)
inputFile <- "SPEC_WGCNA_Module_Assignments_GO-FIXED.csv"  # Your SPEC module assignments file
filePath <- "/Users/anirudhs/Documents/peptide_analysis/GOparallel"

# === OUTPUT CONFIGURATION ===
outFilename <- "SPEC-PEP_Proteomics_GO"  # Name for SPEC output folder/files

# === ANALYSIS PARAMETERS ===
modulesInMemory <- FALSE    # FALSE because you're using a CSV file
ANOVAgroups <- FALSE       # FALSE because you're using WGCNA modules

# === ADVANCED OPTIONS (v1.3 FEATURES) ===
removeRedundantGOterms <- "kappa"  # Use Cohen's kappa clustering 

# Cell Type Analysis. Creates heatmaps showing which modules are enriched for similar cellular components/cell types.
cocluster <- TRUE                  # Enable cell type co-clustering
maxBarsPerOntology <- 10          # Number of terms to show in plots

# === PERFORMANCE ===
parallelThreads <- 8              # Adjust based on your CPU cores

# === DATABASE ===
GMTdatabaseFile <- paste0(filePath, "/Human_GO_current.gmt")  # Will trigger auto-download
GO.OBOfile <- paste0(filePath, "go.obo")                    # Will auto-download

# === VISUALIZATION ===
panelDimensions <- c(3, 2)         # 3 columns, 2 rows per page  
pageDimensions <- c(11, 8.5)       # Landscape orientation (better for many modules)

color <- c("darkseagreen3", "lightsteelblue1", "lightpink4", 
           "goldenrod", "darkorange", "gold")
# Colors for: BP, MF, CC, Reactome, WikiPathways, MSigDB_C2

# === OPTIONAL ===
# Go Elite background file and module or list specified input files will be created within outFilename subfolder.
#outputGOeliteInputs <- FALSE       # Set TRUE if you want GO-Elite files
outputGOeliteInputs <- TRUE

# ====================================================================
# RUN THE ANALYSIS (Don't modify this part)
# ====================================================================

source("GOparallel-FET.R")
GOparallel()  # This runs everything automatically!

# ====================================================================
# WHAT HAPPENS AUTOMATICALLY:
# ====================================================================

# 1. Reads your SPEC_WGCNA_Module_Assignments_GO-FIXED.csv
# 2. Detects it's a WGCNA module assignment format
# 3. Extracts gene symbols from your protein IDs (IGKV3-7|A0A075B6H7|... → IGKV3-7)
# 4. Groups proteins by their assigned modules (30 SPEC modules)
# 5. Uses existing GO databases (Human_GO_AllPathways_noPFOCR_with_GO_iea_June_01_2025_symbol.gmt)
# 6. Runs Fisher's Exact Tests with Cohen's kappa redundancy removal
# 7. Creates bar plot PDFs for each SPEC module
# 8. Generates cell type co-clustering heatmaps for SPEC modules
# 9. Outputs tables with Z-scores, p-values, and FDR corrections