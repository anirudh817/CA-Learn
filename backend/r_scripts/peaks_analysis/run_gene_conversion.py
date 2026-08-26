#!/usr/bin/env python3
"""
Simple wrapper script for gene name conversion that can be called from R pipeline.
"""

import sys
import os
from gene_name_converter import convert_gene_names_to_official_symbols, create_peptide_identifiers

def main():
    """
    Simple wrapper to run gene name conversion with default parameters.
    """
    
    # Default file paths
    peptide_file = "Peptide List Sweden Cohort.csv"
    conversion_file = "Uniprot_to_gene.xlsx"
    output_file = "Peptide List Sweden Cohort_Converted.csv"
    final_output_file = "Peptide List Sweden Cohort_Final.csv"
    summary_report_file = "Gene_Conversion_Summary_Report.txt"
    not_found_file = "all_conversion_data.xlsx"
    
    # Check if files exist
    if not os.path.exists(peptide_file):
        print(f"ERROR: Peptide file not found: {peptide_file}")
        sys.exit(1)
    
    if not os.path.exists(conversion_file):
        print(f"ERROR: Conversion file not found: {conversion_file}")
        sys.exit(1)
    
    try:
        print("Starting gene name conversion...")
        
        # Step 1: Convert gene names
        converted_df, summary = convert_gene_names_to_official_symbols(
            peptide_file=peptide_file,
            conversion_file=conversion_file,
            output_file=output_file,
            summary_report_file=summary_report_file,
            not_found_file=not_found_file
        )
        
        # Step 2: Create peptide identifiers
        final_df = create_peptide_identifiers(
            peptide_df=converted_df,
            output_file=final_output_file
        )
        
        # Print summary
        print(f"\nConversion completed successfully!")
        print(f"Total peptides processed: {summary['total_peptides']}")
        print(f"Successfully converted: {summary['converted']} ({summary['conversion_rate']:.1f}%)")
        print(f"Output file: {final_output_file}")
        print(f"Summary report: {summary_report_file}")
        print(f"All conversion data: {not_found_file}")
        
        return 0
        
    except Exception as e:
        print(f"ERROR: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main()) 