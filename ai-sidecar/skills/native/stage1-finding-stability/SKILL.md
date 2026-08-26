---
name: stage1-finding-stability
description: Test whether approved SignalFold Stage 1 differential-expression findings survive a declared adjusted-p threshold sweep. Use when the research objective asks about robustness or threshold sensitivity; do not use merely because it is available.
license: SignalFold repository license
metadata: {"version":"1.0","skill-author":"SignalFold"}
---

# Stage 1 Finding Stability

Activate this skill only for a robustness question over the frozen differential-expression artifact.

Call the `stage1_finding_stability` custom tool with explicit adjusted-p thresholds. The tool validates that the input belongs to the approved frozen scope, verifies its hash, runs the existing deterministic threshold sweep, and returns a hashed CSV artifact. Interpret the table; do not describe the skill as executed unless the tool was actually called.

This skill contains instructions only. Its scientific computation remains the narrow SignalFold deterministic custom tool, not Python or a hard-coded skill-ID dispatcher.
