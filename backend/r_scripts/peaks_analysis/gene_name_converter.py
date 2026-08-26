#!/usr/bin/env python3
"""
Gene Name Converter for PEAKS Proteomics Data
=============================================

This module provides functionality to convert abbreviated gene names to official
gene symbols using UniProt mapping tables for PEAKS proteomics data preprocessing.

Author: Anirudh 
Date: 2024
"""

import pandas as pd
import numpy as np
import warnings
from typing import Dict, Tuple, Optional
import logging
from pathlib import Path
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def convert_gene_names_to_official_symbols(
    peptide_file: str,
    conversion_file: str,
    output_file: Optional[str] = None,
    summary_report_file: Optional[str] = None,
    not_found_file: Optional[str] = None,
    accession_col: str = "Accession",
    gene_name_col: str = "Gene name",
    peptide_col: str = "Peptide",
    entry_col: str = "Entry",
    official_symbol_col: str = "Gene names  (primary )"
) -> Tuple[pd.DataFrame, Dict]:
    """
    Convert abbreviated gene names to official gene symbols using UniProt mapping.
    
    Parameters
    ----------
    peptide_file : str
        Path to the PEAKS peptide CSV file
    conversion_file : str
        Path to the UniProt to gene symbol conversion Excel file
    output_file : str, optional
        Path to save the converted peptide data (if None, won't save)
    summary_report_file : str, optional
        Path to save the detailed conversion summary report (if None, won't save)
    not_found_file : str, optional
        Path to save Excel file with not-found conversions (if None, won't save)
    accession_col : str, default "Accession"
        Name of the column containing UniProt accessions
    gene_name_col : str, default "Gene name"
        Name of the column containing abbreviated gene names
    peptide_col : str, default "Peptide"
        Name of the column containing peptide sequences
    entry_col : str, default "Entry"
        Name of the column containing UniProt entries in conversion file
    official_symbol_col : str, default "Gene names  (primary )"
        Name of the column containing official gene symbols in conversion file
    
    Returns
    -------
    Tuple[pd.DataFrame, Dict]
        - Modified peptide dataframe with official gene symbols
        - Conversion summary statistics
    
    Raises
    ------
    FileNotFoundError
        If input files don't exist
    ValueError
        If required columns are missing
    """
    
    # Initialize summary statistics
    summary = {
        'total_peptides': 0,
        'converted': 0,
        'not_found': 0,
        'conversion_rate': 0.0,
        'unique_accessions': 0,
        'unique_converted': 0,
        'unique_not_found': 0,
        'warnings': [],
        'not_found_details': [],
        'conversion_examples': [],
        'start_time': datetime.now(),
        'end_time': None
    }
    
    try:
        # Step 1: Load the conversion table
        logger.info(f"Loading conversion table from: {conversion_file}")
        conversion_df = pd.read_excel(conversion_file)
        
        # Validate conversion table columns
        required_cols = [entry_col, official_symbol_col]
        missing_cols = [col for col in required_cols if col not in conversion_df.columns]
        if missing_cols:
            raise ValueError(f"Missing required columns in conversion file: {missing_cols}")
        
        # Clean and prepare conversion table
        conversion_df = conversion_df[[entry_col, official_symbol_col]].copy()
        conversion_df = conversion_df.dropna(subset=[entry_col, official_symbol_col])
        conversion_df = conversion_df.drop_duplicates(subset=[entry_col])
        
        # Create lookup dictionary for faster access
        conversion_dict = dict(zip(conversion_df[entry_col], conversion_df[official_symbol_col]))
        
        logger.info(f"Loaded {len(conversion_dict)} UniProt to gene symbol mappings")
        
        # Step 2: Load peptide data
        logger.info(f"Loading peptide data from: {peptide_file}")
        peptide_df = pd.read_csv(peptide_file)
        
        # Validate peptide data columns
        required_peptide_cols = [accession_col, gene_name_col, peptide_col]
        missing_peptide_cols = [col for col in required_peptide_cols if col not in peptide_df.columns]
        if missing_peptide_cols:
            raise ValueError(f"Missing required columns in peptide file: {missing_peptide_cols}")
        
        # Create a copy to avoid modifying original
        result_df = peptide_df.copy()
        
        # Step 3: Perform conversion
        logger.info("Starting gene name conversion...")
        
        # Track statistics
        summary['total_peptides'] = len(result_df)
        summary['unique_accessions'] = result_df[accession_col].nunique()
        
        # Track which accessions were converted
        converted_accessions = set()
        not_found_accessions = set()
        not_found_details = []
        
        # Process each row
        for idx, row in result_df.iterrows():
            accession = str(row[accession_col]).strip()
            original_gene_name = str(row[gene_name_col]).strip()
            peptide_sequence = str(row[peptide_col]).strip()
            
            # Skip if accession is missing or invalid
            if pd.isna(accession) or accession == 'nan' or accession == '':
                summary['warnings'].append(f"Row {idx+1}: Missing accession")
                continue
            
            # Handle UniProt isoforms (e.g., Q16181-2 -> Q16181)
            base_accession = accession.split('-')[0] if '-' in accession else accession
            
            # Look up official symbol
            if base_accession in conversion_dict:
                official_symbol = conversion_dict[base_accession]
                
                # Update the gene name column
                result_df.at[idx, gene_name_col] = official_symbol
                summary['converted'] += 1
                converted_accessions.add(base_accession)
                
                # Store conversion example (first few)
                if len(summary['conversion_examples']) < 10:
                    summary['conversion_examples'].append({
                        'accession': accession,
                        'original_name': original_gene_name,
                        'official_symbol': official_symbol,
                        'peptide': peptide_sequence[:20] + '...' if len(peptide_sequence) > 20 else peptide_sequence
                    })
                
                logger.debug(f"Converted: {accession} ({original_gene_name}) -> {official_symbol}")
            else:
                # Keep original name if no match found
                not_found_accessions.add(base_accession)
                summary['not_found'] += 1
                
                # Store not-found details
                not_found_details.append({
                    'Row_Index': idx + 1,
                    'Accession': accession,
                    'Base_Accession': base_accession,
                    'Original_Gene_Name': original_gene_name,
                    'Peptide_Sequence': peptide_sequence[:50] + '...' if len(peptide_sequence) > 50 else peptide_sequence,
                    'Peptide_Length': len(peptide_sequence)
                })
                
                if base_accession not in [acc.split('-')[0] for acc in converted_accessions]:
                    summary['warnings'].append(f"Accession not found in conversion table: {base_accession}")
        
        # Calculate summary statistics
        summary['unique_converted'] = len(converted_accessions)
        summary['unique_not_found'] = len(not_found_accessions)
        summary['conversion_rate'] = (summary['converted'] / summary['total_peptides']) * 100 if summary['total_peptides'] > 0 else 0
        summary['end_time'] = datetime.now()
        summary['not_found_details'] = not_found_details
        
        # Step 4: Generate summary report
        logger.info("Conversion completed!")
        logger.info(f"Total peptides processed: {summary['total_peptides']}")
        logger.info(f"Successfully converted: {summary['converted']} ({summary['conversion_rate']:.1f}%)")
        logger.info(f"Not found: {summary['not_found']}")
        logger.info(f"Unique accessions: {summary['unique_accessions']}")
        logger.info(f"Unique converted: {summary['unique_converted']}")
        
        # Print warnings
        if summary['warnings']:
            logger.warning(f"Generated {len(summary['warnings'])} warnings:")
            for warning in summary['warnings'][:10]:  # Show first 10 warnings
                logger.warning(f"  {warning}")
            if len(summary['warnings']) > 10:
                logger.warning(f"  ... and {len(summary['warnings']) - 10} more warnings")
        
        # Step 5: Save output if requested
        if output_file:
            logger.info(f"Saving converted data to: {output_file}")
            result_df.to_csv(output_file, index=False)
            logger.info("File saved successfully!")
        
        # Step 6: Generate summary report
        if summary_report_file:
            generate_summary_report(summary, summary_report_file, peptide_file, conversion_file)
        
        # Step 7: Generate not-found Excel file
        if not_found_file and not_found_details:
            generate_not_found_excel(not_found_details, not_found_file)
        
        return result_df, summary
        
    except FileNotFoundError as e:
        logger.error(f"File not found: {e}")
        raise
    except Exception as e:
        logger.error(f"Error during conversion: {e}")
        raise


def generate_summary_report(summary: Dict, output_file: str, peptide_file: str, conversion_file: str):
    """
    Generate a detailed conversion summary report as a text file.
    
    Parameters
    ----------
    summary : Dict
        Summary statistics from the conversion
    output_file : str
        Path to save the summary report
    peptide_file : str
        Path to the original peptide file
    conversion_file : str
        Path to the conversion file
    """
    
    logger.info(f"Generating summary report: {output_file}")
    
    with open(output_file, 'w') as f:
        f.write("=" * 80 + "\n")
        f.write("GENE NAME CONVERSION SUMMARY REPORT\n")
        f.write("=" * 80 + "\n\n")
        
        # Basic information
        f.write("EXECUTION INFORMATION\n")
        f.write("-" * 40 + "\n")
        f.write(f"Start Time: {summary['start_time'].strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"End Time: {summary['end_time'].strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"Duration: {summary['end_time'] - summary['start_time']}\n")
        f.write(f"Input Peptide File: {peptide_file}\n")
        f.write(f"Conversion Table File: {conversion_file}\n\n")
        
        # Conversion statistics
        f.write("CONVERSION STATISTICS\n")
        f.write("-" * 40 + "\n")
        f.write(f"Total Peptides Processed: {summary['total_peptides']:,}\n")
        f.write(f"Successfully Converted: {summary['converted']:,} ({summary['conversion_rate']:.1f}%)\n")
        f.write(f"Not Found: {summary['not_found']:,} ({100-summary['conversion_rate']:.1f}%)\n")
        f.write(f"Unique Accessions: {summary['unique_accessions']:,}\n")
        f.write(f"Unique Converted: {summary['unique_converted']:,}\n")
        f.write(f"Unique Not Found: {summary['unique_not_found']:,}\n\n")
        
        # Conversion examples
        f.write("CONVERSION EXAMPLES\n")
        f.write("-" * 40 + "\n")
        for i, example in enumerate(summary['conversion_examples'], 1):
            f.write(f"{i:2d}. {example['accession']} ({example['original_name']}) -> {example['official_symbol']}\n")
            f.write(f"    Peptide: {example['peptide']}\n")
        f.write("\n")
        
        # Warning summary
        if summary['warnings']:
            f.write("WARNINGS SUMMARY\n")
            f.write("-" * 40 + "\n")
            f.write(f"Total Warnings: {len(summary['warnings'])}\n")
            f.write("Sample Warnings:\n")
            for i, warning in enumerate(summary['warnings'][:20], 1):
                f.write(f"{i:2d}. {warning}\n")
            if len(summary['warnings']) > 20:
                f.write(f"... and {len(summary['warnings']) - 20} more warnings\n")
            f.write("\n")
        
        # Performance metrics
        f.write("PERFORMANCE METRICS\n")
        f.write("-" * 40 + "\n")
        f.write(f"Conversion Success Rate: {summary['conversion_rate']:.1f}%\n")
        f.write(f"Data Quality Score: {'Excellent' if summary['conversion_rate'] >= 95 else 'Good' if summary['conversion_rate'] >= 85 else 'Fair' if summary['conversion_rate'] >= 70 else 'Poor'}\n")
        f.write(f"Processing Efficiency: {summary['total_peptides'] / (summary['end_time'] - summary['start_time']).total_seconds():.0f} peptides/second\n\n")
        
        # Recommendations
        f.write("RECOMMENDATIONS\n")
        f.write("-" * 40 + "\n")
        if summary['conversion_rate'] >= 95:
            f.write("✓ Excellent conversion rate! The data is ready for downstream analysis.\n")
        elif summary['conversion_rate'] >= 85:
            f.write("✓ Good conversion rate. Consider reviewing not-found accessions for important genes.\n")
        else:
            f.write("⚠ Lower conversion rate detected. Review the not-found Excel file for missing mappings.\n")
        
        if summary['unique_not_found'] > 0:
            f.write(f"✓ Review {summary['unique_not_found']} unique not-found accessions in the Excel report.\n")
        
        f.write("\n" + "=" * 80 + "\n")
        f.write("REPORT GENERATED SUCCESSFULLY\n")
        f.write("=" * 80 + "\n")
    
    logger.info("Summary report generated successfully!")


def generate_not_found_excel(not_found_details: list, output_file: str):
    """
    Generate an Excel file with details of not-found conversions.
    
    Parameters
    ----------
    not_found_details : list
        List of dictionaries with not-found conversion details
    output_file : str
        Path to save the Excel file
    """
    
    logger.info(f"Generating not-found Excel file: {output_file}")
    
    # Create DataFrame
    df = pd.DataFrame(not_found_details)
    
    # Add summary statistics
    summary_stats = {
        'Metric': [
            'Total Not-Found Peptides',
            'Unique Accessions',
            'Most Common Accession',
            'Average Peptide Length',
            'Shortest Peptide',
            'Longest Peptide'
        ],
        'Value': [
            len(not_found_details),
            df['Base_Accession'].nunique(),
            df['Base_Accession'].mode().iloc[0] if not df['Base_Accession'].mode().empty else 'N/A',
            f"{df['Peptide_Length'].mean():.1f}",
            df['Peptide_Length'].min(),
            df['Peptide_Length'].max()
        ]
    }
    
    summary_df = pd.DataFrame(summary_stats)
    
    # Create Excel writer
    with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
        # Write main data
        df.to_excel(writer, sheet_name='Not_Found_Details', index=False)
        
        # Write summary statistics
        summary_df.to_excel(writer, sheet_name='Summary_Statistics', index=False)
        
        # Write unique accessions summary
        unique_acc = df['Base_Accession'].value_counts().reset_index()
        unique_acc.columns = ['Accession', 'Count']
        unique_acc.to_excel(writer, sheet_name='Unique_Accessions', index=False)
    
    logger.info("Not-found Excel file generated successfully!")


def create_peptide_identifiers(
    peptide_df: pd.DataFrame,
    gene_name_col: str = "Gene name",
    accession_col: str = "Accession",
    peptide_col: str = "Peptide",
    output_file: Optional[str] = None
) -> pd.DataFrame:
    """
    Create standardized peptide identifiers using the format: GENE|ACCESSION|PEPTIDE
    
    Parameters
    ----------
    peptide_df : pd.DataFrame
        Peptide dataframe with converted gene names
    gene_name_col : str, default "Gene name"
        Column containing gene names
    accession_col : str, default "Accession"
        Column containing UniProt accessions
    peptide_col : str, default "Peptide"
        Column containing peptide sequences
    output_file : str, optional
        Path to save the dataframe with peptide identifiers
    
    Returns
    -------
    pd.DataFrame
        Dataframe with new 'Peptide_ID' column
    """
    
    logger.info("Creating peptide identifiers...")
    
    # Create peptide identifiers
    peptide_df['Peptide_ID'] = (
        peptide_df[gene_name_col].astype(str) + '|' +
        peptide_df[accession_col].astype(str) + '|' +
        peptide_df[peptide_col].astype(str)
    )
    
    # Clean up any 'nan' values in the identifier
    peptide_df['Peptide_ID'] = peptide_df['Peptide_ID'].replace('nan|nan|nan', 'Unknown|Unknown|Unknown')
    
    logger.info(f"Created {len(peptide_df)} peptide identifiers")
    
    # Show examples
    sample_ids = peptide_df['Peptide_ID'].head(5).tolist()
    logger.info("Sample peptide identifiers:")
    for i, pid in enumerate(sample_ids, 1):
        logger.info(f"  {i}. {pid}")
    
    # Save if requested
    if output_file:
        logger.info(f"Saving peptide data with identifiers to: {output_file}")
        peptide_df.to_csv(output_file, index=False)
        logger.info("File saved successfully!")
    
    return peptide_df


def main():
    """
    Main function to demonstrate usage of the gene name converter.
    """
    
    # File paths
    peptide_file = "Peptide List Sweden Cohort.csv"
    conversion_file = "Uniprot_to_gene.xlsx"
    output_file = "Peptide List Sweden Cohort_Converted.csv"
    final_output_file = "Peptide List Sweden Cohort_Final.csv"
    summary_report_file = "Gene_Conversion_Summary_Report.txt"
    not_found_file = "all_conversion_data.xlsx"
    
    try:
        # Step 1: Convert gene names
        logger.info("=" * 60)
        logger.info("GENE NAME CONVERSION PIPELINE")
        logger.info("=" * 60)
        
        converted_df, summary = convert_gene_names_to_official_symbols(
            peptide_file=peptide_file,
            conversion_file=conversion_file,
            output_file=output_file,
            summary_report_file=summary_report_file,
            not_found_file=not_found_file
        )
        
        # Step 2: Create peptide identifiers
        logger.info("\n" + "=" * 60)
        logger.info("CREATING PEPTIDE IDENTIFIERS")
        logger.info("=" * 60)
        
        final_df = create_peptide_identifiers(
            peptide_df=converted_df,
            output_file=final_output_file
        )
        
        # Step 3: Print final summary
        logger.info("\n" + "=" * 60)
        logger.info("PIPELINE COMPLETED SUCCESSFULLY!")
        logger.info("=" * 60)
        logger.info(f"Original file: {peptide_file}")
        logger.info(f"Converted file: {output_file}")
        logger.info(f"Final file with IDs: {final_output_file}")
        logger.info(f"Summary report: {summary_report_file}")
        logger.info(f"All conversion data: {not_found_file}")
        logger.info(f"Total peptides processed: {summary['total_peptides']}")
        logger.info(f"Conversion success rate: {summary['conversion_rate']:.1f}%")
        
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        raise


if __name__ == "__main__":
    main() 