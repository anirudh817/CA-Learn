---
name: sf-runtime-probe
description: SignalFold runtime self-check. Use to confirm the execution toolchain is wired before running heavier skills — it reports the Python version and working directory and prints a fixed readiness sentinel.
---

# sf-runtime-probe

A fast smoke test that confirms the agent can run shell commands in the
conversation's working directory.

## Steps

Run these commands with the bash tool, one per call, in order:

1. `python3 --version`
2. `pwd`
3. `ls -la`

Then write a one-sentence summary that states the Python version and the
working directory you observed, and finish your answer with this exact line on
its own (nothing after it):

```
SF_SKILL_PROBE_OK
```
