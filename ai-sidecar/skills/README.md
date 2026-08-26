# SignalFold AI Insights — validation skills

These committed [Agent Skills](https://agentskills.io/specification) are the
test vehicle for the sidecar's Pi tool/Python/skill execution. They are
discovered by the runtime and injected into the Pi session via
`DefaultResourceLoader.skillsOverride` (see `src/runtime.ts`), but **only when
execution is enabled** (`AI_DEVELOPER_MODE=1` and `AI_PYTHON_EXECUTION` is not
`disabled`). In production they are neither injected nor executable.

Each skill is deterministic and emits a unique, greppable sentinel so the live
smoke (`scripts/live-skills-smoke.ts`) can assert exact output.

| Skill | Proves | Sentinel(s) |
|---|---|---|
| `sf-runtime-probe` | bash runs shell commands (environment self-check) | `SF_SKILL_PROBE_OK` |
| `sf-echo-script` | bash runs a **bundled** script | `SF_SKILL_ECHO_OK` |
| `sf-python-compute` | write generates Python + bash runs `python3` | `SF_SKILL_PY_RESULT=5050` |
| `sf-artifact-report` | bundled script + generated Python + **registered artifact** | `SF_SKILL_PREPARE_OK`, `SF_SKILL_REPORT_WRITTEN`, `SF_SKILL_ARTIFACT=<relPath>` |

Notes:

- The skills deliberately do **not** state their sentinel values in the
  instructions where a value is computed (`sf-python-compute` describes the
  computation `sum(1..100)=5050`; `sf-echo-script` tells the model to copy the
  script's actual output). Real execution is what produces the correct
  sentinel, and the operations trace independently records the bash/python
  frames.
- `sf-artifact-report` persists `sf_report.csv` through the `save_artifact`
  custom tool, which writes under the run's `ai_insights/artifacts/` directory
  and registers the file so it appears in `GET /api/artifacts`.
- Bundled scripts are invoked as `bash <abs>/scripts/<name>.sh`, so no execute
  bit is required, but the bit is set for convenience.
