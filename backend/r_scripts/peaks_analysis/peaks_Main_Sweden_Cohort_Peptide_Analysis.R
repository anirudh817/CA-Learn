# peaks_Main_Sweden_Cohort_Peptide_Analysis.R
# v2.0: Clean and organized PEAKS proteomics analysis with centralized configuration
# Author: Adapted for PEAKS Proteomics Pipeline
# Location: scripts/peaks_analysis/
################################################################################
## SUMMARY:     Main orchestration script for PEAKS peptide analysis
## INPUT:       PEAKS peptide CSV file (from CONFIG)
## OUTPUT:      Normalized data, MDS plots, volcano plots, differential results
## DESCRIPTION: Clean 3-step workflow for PEAKS proteomics analysis
################################################################################

#===============================================================================
# SETUP AND INITIALIZATION
#===============================================================================
print("Initializing PEAKS Proteomics Analysis Pipeline v2.0...")

# Set working directory to project root (already set by run_peaks_analysis.R)
if (!exists("project.root")) {
  project.root <- getwd()
  print(paste0("Working directory set to: ", getwd()))
}

# Load required packages
print("Loading required packages...")
library(doParallel)

# Parallel processing setup
xclusterLocal <- makeCluster(detectCores()-1, type="SOCK")
registerDoParallel(xclusterLocal)

#===============================================================================
# CONFIGURATION PARAMETERS (from centralized CONFIG)
#===============================================================================
# Use the CONFIG object passed from run_peaks_analysis.R
if (!exists("CONFIG")) {
  stop("ERROR: CONFIG object not found. Please run this script through run_peaks_analysis.R")
}

# Extract configuration parameters
global.peaksFileCSV           <- CONFIG$input_file
global.controlSampleCount     <- CONFIG$control_samples
global.adSampleCount          <- CONFIG$ad_samples
global.missingValueThreshold  <- CONFIG$missing_value_threshold
global.normalizationMethod    <- CONFIG$normalization_method
global.pvalueThreshold        <- CONFIG$pvalue_threshold
global.foldChangeThreshold    <- CONFIG$fold_change_threshold
global.useAdjustedPValue      <- CONFIG$use_adjusted_pvalue
global.group1_name            <- CONFIG$group1_name
global.group2_name            <- CONFIG$group2_name

# Output configuration  
manual.outputDirectory        <- CONFIG$output_directory
global.output_CSV             <- CONFIG$save_csv_files
global.generatePlots          <- CONFIG$generate_plots
global.cohortList             <- c(CONFIG$dataset_name)
global.rawFileHandle          <- CONFIG$dataset_name

# Analysis parameters
global.MinBatchSize           <- 5

#----------------CLEAN DIRECTORY STRUCTURE FOR PEAKS ANALYSIS-----------------
# Simple, logical directory structure that's easy to understand
rootDir <- getwd()
global.Output                 <- paste0(rootDir, "/", manual.outputDirectory)

# Core directories for PEAKS peptide analysis workflow (use CONFIG method-specific paths)
global.inputDir               <- CONFIG$input_dir                             # Raw and processed input data  
global.normalizedDir          <- CONFIG$normalized_dir                        # Normalized data and MDS plots (method-specific)
global.analysisDir            <- CONFIG$analysis_dir                          # Volcano plots and statistics (method-specific)
global.qcDir                  <- CONFIG$qc_dir                                # Quality control reports
global.networkDir             <- CONFIG$network_dir                           # WGCNA network analysis (method-specific)

# Legacy aliases for compatibility (will be removed in future versions)
global.ETLRoot                <- global.inputDir        # For data loading
global.datNormRoot            <- global.normalizedDir   # For normalization outputs  
global.analysisRoot           <- global.analysisDir     # For volcano plots
global.datExplrStatRoot       <- global.analysisDir     # Duplicate - keeping for compatibility

# Create output directories with informative messages
create_directory_with_info <- function(dir_path, description) {
  if(!dir.exists(dir_path)) {
    dir.create(dir_path, recursive = TRUE)
    cat(paste0("Created: ", basename(dir_path), " - ", description, "\n"))
  }
}

if(!dir.exists(global.Output)) dir.create(global.Output, recursive = TRUE)
create_directory_with_info(global.inputDir, "Raw PEAKS data and cleaned peptide matrices")
create_directory_with_info(global.normalizedDir, "Column-normalized data and MDS plots") 
create_directory_with_info(global.analysisDir, "Volcano plots and differential expression results")
create_directory_with_info(global.qcDir, "Quality control reports and data summaries")
#=============END VARIABLE INITIALIZATION=======================================

#===============================================================================
#FUNCTION CALLS BY PROCESSING & ANALYSIS STEPS
#===============================================================================
# WORKFLOW STEPS CONTROLLED BY CONFIG (No hardcoding!)
STEP_1_DATA_LOADING         <- CONFIG$run_data_loading      # Load and clean PEAKS peptide data
STEP_2_NORMALIZATION        <- CONFIG$run_normalization     # Normalization + MDS plots  
STEP_3_DIFFERENTIAL_ANALYSIS <- CONFIG$run_volcano_analysis # Volcano plots and statistical analysis
STEP_4_WGCNA_ANALYSIS       <- CONFIG$run_wgcna            # WGCNA network analysis (if enabled)

#=============END WORKFLOW CONFIGURATION========================================

print("=================================================================")
print("STARTING PEAKS PROTEOMICS PIPELINE")
print("=================================================================")
print(paste("Dataset:", CONFIG$dataset_name))
print(paste("Input file:", global.peaksFileCSV))
print(paste("Expected peptides:", CONFIG$expected_peptides))
print(paste("Control samples:", global.controlSampleCount))
print(paste("AD samples:", global.adSampleCount))
print(paste("Missing value threshold:", global.missingValueThreshold * 100, "%"))
print(paste("Normalization method:", global.normalizationMethod))
print(paste("P-value threshold:", global.pvalueThreshold))
print(paste("Fold change threshold:", global.foldChangeThreshold))
print("=================================================================")

#===============================================================================
# STEP 1: DATA LOADING AND INITIAL PROCESSING
#===============================================================================
if (STEP_1_DATA_LOADING){
  print("STEP 1: PEAKS DATA LOADING AND PROCESSING")
  print("Loading PEAKS peptide data from CSV")
  print(paste("Applying", global.missingValueThreshold * 100, "% missing value filter"))
  print("Creating peptide identifiers")
  print("Setting up Control vs AD sample groups")
  
  script_path <- CONFIG$data_loader_script
  if(file.exists(script_path)) {
    source(script_path)
    InputToNext <- peaks_DataLoader_Flexible(
      peaksFile = global.peaksFileCSV, 
      outputDir = global.inputDir,
      missingValueThreshold = global.missingValueThreshold,  # Pass the threshold
      group1_name = global.group1_name,
      group2_name = global.group2_name
    )
    
    print("PEAKS data loaded and processed successfully")
    print(paste0("Final dataset: ", nrow(InputToNext[[1]]), " peptides x ", ncol(InputToNext[[1]]), " samples"))
    print(paste0("Sample groups: ", global.controlSampleCount, " Control + ", global.adSampleCount, " AD"))
    print(paste0("Results saved to: ", global.inputDir))
    
  } else {
    print("ERROR: peaks_DataLoader_Simple.R not found!")
    stop("Data loading script is required for PEAKS analysis.")
  }
}
#-------------------------------------------------------------------------------

#===============================================================================
# STEP 2: DATA NORMALIZATION AND MDS PLOTS
#===============================================================================
if (STEP_2_NORMALIZATION && !is.null(InputToNext[[1]])){
  print("STEP 2: PEAKS NORMALIZATION")
  print(paste("Applying", global.normalizationMethod, "normalization"))
  print("Generating before/after MDS plots")
  print("Calculating data completeness metrics")
  
  # Select normalization script based on method
  if (global.normalizationMethod == "TIN") {
    script_path <- "peaks_analysis/peaks_DataNormalization_TIN.R"
    print("Using Total Intensity Normalization (TIN)")
    print("Note: Log2 transformation will be applied AFTER normalization")
  } else {
    script_path <- CONFIG$normalization_script
    print(paste("Using Column-Based Normalization:", global.normalizationMethod))
    print("Note: Log2 transformation already applied to input data")
  }
  
  if(file.exists(script_path)) {
    source(script_path)
    
    # Apply selected normalization method
    if (global.normalizationMethod == "TIN") {
      InputToNext <- peaks_TIN_Normalization(
        cleanDat = InputToNext[[1]],  # Raw data for TIN
        traitsMetaData = InputToNext[[2]],
        scale_to_max = CONFIG$tin_scale_to_max,
        log2_constant = CONFIG$log2_constant,
        outputDir = global.normalizedDir,
        generatePlots = global.generatePlots
      )
    } else {
      # Column-based normalization (median, mean, quantile)
      InputToNext <- peaks_ColumnNormalization(
        cleanDat = InputToNext[[1]], 
        traitsMetaData = InputToNext[[2]],
        method = global.normalizationMethod,  
        outputDir = global.normalizedDir,
        generatePlots = global.generatePlots
      )
    }
    
    print("Column normalization complete")
    print("MDS plots saved (before/after normalization)")
    print(paste0("Normalized data: ", nrow(InputToNext$normalizedData), " peptides x ", ncol(InputToNext$normalizedData), " samples"))
    print(paste0("Data completeness: ", InputToNext$summary$completeness, "%"))
    print(paste0("Results saved to: ", global.normalizedDir))
    
    # Save additional CSV outputs if requested
    if (global.output_CSV){
      write.csv(InputToNext$normalizedData, 
                file = file.path(global.normalizedDir, "PEAKS_Normalized_Log2_Data.csv"))
      write.csv(InputToNext$normalizedAbundance, 
                file = file.path(global.normalizedDir, "PEAKS_Normalized_Abundance_Data.csv"))
      write.csv(InputToNext$traitsMetaData, 
                file = file.path(global.normalizedDir, "PEAKS_Sample_Metadata.csv"))
      save(InputToNext, 
           file = file.path(global.normalizedDir, "PEAKS_Normalization_Complete.RData"))
    }
    
  } else {
    print("ERROR: peaks_DataNormalization_ColumnBased.R not found!")
    stop("Normalization script is required for PEAKS analysis.")
  }
}
#-------------------------------------------------------------------------------

#===============================================================================
# STEP 3: DIFFERENTIAL EXPRESSION ANALYSIS
#===============================================================================
if(STEP_3_DIFFERENTIAL_ANALYSIS && !is.null(InputToNext[[1]])){
  print("STEP 3: VOLCANO PLOT ANALYSIS")
  print("Performing t-tests between Control and AD groups")
  print("Calculating log2 fold changes and FDR-adjusted p-values")
  print("Generating static volcano plots (PDF)")
  print("Creating interactive volcano plots (HTML)")
  
  script_path <- CONFIG$volcano_script
  if(file.exists(script_path)) {
    source(script_path)
    
    # Perform comprehensive volcano plot analysis with configurable parameters
    volcanoResults <- peaks_VolcanoPlot_Analysis(
      normalizedData = InputToNext$normalizedData,
      traitsMetaData = InputToNext$traitsMetaData,
      pvalue_threshold = global.pvalueThreshold,        # From CONFIG
      fold_change_threshold = global.foldChangeThreshold,    # From CONFIG
      outputDir = global.analysisDir,
      useAdjustedPValue = global.useAdjustedPValue         # From CONFIG
    )
    
    print("Differential expression analysis complete")
    print(paste0(nrow(volcanoResults$upregulated), " peptides significantly upregulated in AD"))
    print(paste0(nrow(volcanoResults$downregulated), " peptides significantly downregulated in AD"))
    print(paste0("Static volcano plots saved to: ", file.path(global.analysisDir, "PEAKS_Volcano_Plot.pdf")))
    print(paste0("Interactive volcano plot saved to: ", file.path(global.analysisDir, "PEAKS_Interactive_Volcano_Plot.html")))
    print(paste0("Results tables saved to: ", global.analysisDir))
    
  } else {
    print("ERROR: peaks_VolcanoPlot_Analysis.R not found!")
    stop("Volcano plot analysis script is required for differential expression analysis.")
  }
}

#===============================================================================
# STEP 4: WGCNA NETWORK ANALYSIS
#===============================================================================
if(STEP_4_WGCNA_ANALYSIS && !is.null(InputToNext[[1]])){
  print("STEP 4: WGCNA NETWORK ANALYSIS")
  print("Constructing co-expression networks")
  print("Determining optimal soft threshold power")
  print("Building modules and calculating eigengenes")
  print("Correlating modules with sample traits")
  
  script_path <- CONFIG$wgcna_script
  if(file.exists(script_path)) {
    # Set up environment variables for WGCNA script
    normalizedData <- InputToNext$normalizedData
    traitsMetaData <- InputToNext$traitsMetaData
    OUTPUT_DIR <- paste0(global.networkDir, "/")
    
    # Source WGCNA script (it runs directly, not as function)
    source(script_path)
    
    print("WGCNA network analysis complete")
    # Check if moduleColors was created by the script
    if(exists("moduleColors")) {
      print(paste0("Modules detected: ", length(unique(moduleColors)) - 1))  # -1 for grey module
    }
    print(paste0("Network plots saved to: ", global.networkDir))
    print(paste0("Module assignments saved to: ", file.path(global.networkDir, "PEAKS_WGCNA_Module_Assignments.csv")))
    
  } else {
    print("ERROR: peaks_WGCNA_Standard.R not found!")
    stop("WGCNA script is required for network analysis.")
  }
} else if(!STEP_4_WGCNA_ANALYSIS) {
  print("STEP 4: WGCNA NETWORK ANALYSIS - SKIPPED (disabled in configuration)")
}

#===============================================================================
# ANALYSIS COMPLETE - SUMMARY AND CLEANUP
#===============================================================================
print("\n")
print("=================================================================")
print("PEAKS PROTEOMICS PIPELINE COMPLETED SUCCESSFULLY!")
print("=================================================================")
print("OUTPUT DIRECTORY STRUCTURE:")
print(paste0("- ", basename(global.inputDir), "/ - Raw and processed PEAKS data"))
print(paste0("- ", basename(global.normalizedDir), "/ - Normalized data and MDS plots"))
print(paste0("- ", basename(global.analysisDir), "/ - Volcano plots and statistical results"))
print(paste0("- ", basename(global.qcDir), "/ - Quality control reports"))
print("")
print("KEY RESULTS:")
if(exists("volcanoResults")) {
  print(paste0("- ", nrow(volcanoResults$upregulated), " peptides upregulated in AD (FDR < ", global.pvalueThreshold, ", FC > ", global.foldChangeThreshold, ")"))
  print(paste0("- ", nrow(volcanoResults$downregulated), " peptides downregulated in AD (FDR < ", global.pvalueThreshold, ", FC > ", global.foldChangeThreshold, ")"))
  print(paste0("- Interactive volcano plot: ", file.path(global.analysisDir, "PEAKS_Interactive_Volcano_Plot.html")))
}
if(STEP_4_WGCNA_ANALYSIS && exists("moduleColors")) {
  print(paste0("- ", length(unique(moduleColors)) - 1, " co-expression modules identified"))
  print(paste0("- Network analysis results: ", file.path(global.networkDir, "PEAKS_WGCNA_Complete_Results.xlsx")))
}
print("")
print("NEXT STEPS:")
print("1. Open the interactive volcano plot in your web browser")
print("2. Review the MDS plots for normalization quality")
print("3. Examine the differential expression results tables")
if(STEP_4_WGCNA_ANALYSIS) {
  print("4. Explore WGCNA network plots and module-trait correlations")
  print("5. Review module assignments and eigengene profiles")
}
print("=================================================================")

# Clean up cluster if it exists
if(exists("xclusterLocal")) {
  stopCluster(xclusterLocal)
  print("Computational cluster cleaned up")
} 