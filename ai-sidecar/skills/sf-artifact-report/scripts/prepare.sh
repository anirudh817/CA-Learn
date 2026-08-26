#!/usr/bin/env bash
# Bundled preparation step for the sf-artifact-report skill.
# Prints a deterministic marker so the live skills smoke can confirm the
# bundled script ran before the Python + artifact steps.
echo "SF_SKILL_PREPARE_OK"
