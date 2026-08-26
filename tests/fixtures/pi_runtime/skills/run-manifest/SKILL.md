---
name: run-manifest
description: Build a stable manifest of selected run input artifacts.
---

# Run Manifest

Run `scripts/build_manifest.py RUN_ROOT OUTPUT.json`. Register the JSON output as an artifact. The script excludes `ai_insights/` so generated outputs never become run inputs implicitly.
