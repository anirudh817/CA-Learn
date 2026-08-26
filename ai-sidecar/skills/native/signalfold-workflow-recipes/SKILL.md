---
name: signalfold-workflow-recipes
description: Run one reviewed, deterministic SignalFold Deep Research recipe over the approved frozen run scope.
license: SignalFold repository license
metadata: {"version":"1.0","skill-author":"SignalFold"}
---

# SignalFold Workflow Recipes

Use this native skill only when the approved plan contains a Deep Research workflow recipe.

Call `signalfold_workflow_recipe` with the exact `recipe` value from the approved step. The tool verifies every scoped input hash, performs the committed offline computation, and emits a hashed CSV or JSON artifact plus a complete execution receipt.

The available recipes are `ranked-pathway`, `module-hub`, `external-protein-evidence`, `literature-contradiction`, and `power-next-experiment`. Do not generate or execute code. Do not substitute `stage1/network_edges.csv` for a protein-level graph. External retrieval remains a separate curated broker arm.
