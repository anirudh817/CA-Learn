"""Legacy pipeline runner shim.

The active runtime no longer uses this module. It is preserved only so older
imports fail clearly instead of silently pulling in a stale execution path.
"""


def run_full_pipeline(*_args, **_kwargs):
    raise RuntimeError(
        "backend/services/pipeline_runner.py is legacy-only. "
        "Use backend/services/pipeline.py:start_pipeline_thread or run_full_pipeline instead."
    )
