---
name: sf-python-compute
description: Generates and runs a small Python program for a deterministic numeric computation. Use to verify that the agent can write Python to disk and execute it with python3.
---

# sf-python-compute

Proves that the agent can generate Python source and run it with `python3`.

## Steps

1. With the write tool, create a file named `compute.py` in the current working
   directory. The program must compute the sum of all integers from 1 to 100
   inclusive (that is, 1 + 2 + 3 + ... + 100) and print exactly one line, in
   this format and nothing else:

   ```
   SF_SKILL_PY_RESULT=<sum>
   ```

   where `<sum>` is the integer the program computed. Do not hard-code the
   number — compute it in Python.
2. Run it with the bash tool:

   ```bash
   python3 compute.py
   ```
3. Report the single line the program printed as the final line of your answer.
