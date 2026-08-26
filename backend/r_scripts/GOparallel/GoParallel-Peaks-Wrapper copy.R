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
inputFile <- "SPEC_WGCNA_Module_Assignments-GO-input.csv"  # Your kME matrix file
filePath <- "/Users/anirudhs/Documents/peaks_peptide_analysis/GOparallel"

# === OUTPUT CONFIGURATION ===
#outFilename <- "SwedishCohort_Proteomics_GO"  # Name for output folder/files
outFilename <- "G0-M30-SPEC-Sept22"

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
GMTdatabaseFile <- paste0(filePath, "/Human_GO_current.gmt")  # Will auto-download
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

# 1. Reads your PEAKS_WGCNA_kME_Matrix.csv
# 2. Detects it's a WGCNA kME table format
# 3. Extracts gene symbols from your protein IDs (SEPTIN7|Q16181-2|... → SEPTIN7)
# 4. Assigns proteins to modules based on highest kME values  
# 5. Downloads latest GO databases if needed
# 6. Runs Fisher's Exact Tests with Cohen's kappa redundancy removal
# 7. Creates bar plot PDFs for each module
# 8. Generates cell type co-clustering heatmaps (the "FET" your scientist wants)
# 9. Outputs tables with Z-scores, p-values, and FDR corrections