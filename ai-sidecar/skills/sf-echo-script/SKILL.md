---
name: sf-echo-script
description: Runs the bundled SignalFold echo validation script. Use to verify that the agent can execute a helper script that ships inside a skill directory.
---

# sf-echo-script

Proves that a script bundled inside this skill can be executed with the bash
tool.

## Steps

1. This skill ships a script at `scripts/echo.sh`, in the same directory as this
   `SKILL.md` file. The absolute path to that directory is the `<location>`
   shown for this skill in your available-skills list — take that path and
   replace the trailing `SKILL.md` with `scripts/echo.sh`.
2. Run the script with the bash tool using that absolute path. For example, if
   this file is `/repo/ai-sidecar/skills/sf-echo-script/SKILL.md`, run:

   ```bash
   bash /repo/ai-sidecar/skills/sf-echo-script/scripts/echo.sh
   ```
3. The script prints exactly one line. Report that line verbatim as the final
   line of your answer. Do not invent the line — run the script and copy what it
   actually printed.
