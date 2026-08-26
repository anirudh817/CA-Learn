---
name: sf-artifact-report
description: Full SignalFold artifact chain — runs a bundled script, generates and runs Python that writes an output file, then persists that file as a registered run artifact. Use to verify end-to-end skill execution with artifact persistence.
---

# sf-artifact-report

Proves the full chain in one turn: run a bundled script, generate and run
Python that produces a file, then persist that file as a registered run
artifact.

## Steps

1. Run the bundled preparation script with the bash tool, using the absolute
   path to this skill's directory (the `<location>` shown for this skill, with
   the trailing `SKILL.md` replaced by `scripts/prepare.sh`):

   ```bash
   bash <skill-dir>/scripts/prepare.sh
   ```
2. With the write tool, create `report.py` in the current working directory. It
   must write a CSV file named `sf_report.csv` (in the current directory) whose
   exact contents are:

   ```
   metric,value
   genes,3
   modules,2
   ```

   and then print the single line `SF_SKILL_REPORT_WRITTEN`.
3. Run it with the bash tool:

   ```bash
   python3 report.py
   ```
4. Persist the generated file as a run artifact by calling the `save_artifact`
   tool with these arguments:
   - `sourcePath`: `sf_report.csv`
   - `kind`: `skill-report`
   - `mimeType`: `text/csv`

   The tool stores the file under the run's `ai_insights/artifacts/` directory,
   registers it in the artifact index, and returns the stored relative path.
5. Finish your answer with this exact line on its own (substitute the path the
   `save_artifact` tool returned):

   ```
   SF_SKILL_ARTIFACT=<relPath>
   ```
