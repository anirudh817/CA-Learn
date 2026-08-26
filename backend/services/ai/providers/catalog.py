"""Static model catalog: Anthropic default, fallbacks, capabilities, pricing.

v1 ships Anthropic-only. The catalog data structure preserves the multi-
provider shape (dict-of-providers) so re-adding OpenAI / Google later is
mechanical — just add another top-level entry.

Pricing is best-effort USD per 1M tokens; used for the per-message cost
footer (display-only, never authoritative).

The ``fallback`` chain is load-bearing: if the default model 404s
(model renamed / retired), we try the next entry without troubling the
user. Add legacy models at the END of the fallback list.
"""
from __future__ import annotations

from typing import Any


PROVIDER_CATALOG: dict[str, dict[str, Any]] = {
    "anthropic": {
        "label": "Anthropic",
        "default_model": "claude-sonnet-4-6",
        "model_fallbacks": [
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-latest",
        ],
        "models": [
            {
                "id": "claude-opus-4-7",
                "label": "Claude Opus 4.7",
                "vision": True,
                "max_input": 200_000,
                "max_output": 32_000,
                "cost_in_per_1m": 15.0,
                "cost_out_per_1m": 75.0,
            },
            {
                "id": "claude-sonnet-4-6",
                "label": "Claude Sonnet 4.6 (recommended)",
                "vision": True,
                "max_input": 200_000,
                "max_output": 16_000,
                "cost_in_per_1m": 3.0,
                "cost_out_per_1m": 15.0,
            },
            {
                "id": "claude-sonnet-4-5",
                "label": "Claude Sonnet 4.5",
                "vision": True,
                "max_input": 200_000,
                "max_output": 16_000,
                "cost_in_per_1m": 3.0,
                "cost_out_per_1m": 15.0,
            },
            {
                "id": "claude-haiku-4-5",
                "label": "Claude Haiku 4.5 (fast / cheap)",
                "vision": True,
                "max_input": 200_000,
                "max_output": 8_000,
                "cost_in_per_1m": 1.0,
                "cost_out_per_1m": 5.0,
            },
        ],
    },
}


def list_providers() -> list[dict[str, Any]]:
    return [
        {
            "id": pid,
            "label": entry["label"],
            "default_model": entry["default_model"],
            "models": entry["models"],
        }
        for pid, entry in PROVIDER_CATALOG.items()
    ]


def default_model_for(provider: str) -> str:
    return PROVIDER_CATALOG.get(provider, {}).get("default_model", "")


def model_meta(provider: str, model_id: str) -> dict[str, Any] | None:
    for model in PROVIDER_CATALOG.get(provider, {}).get("models", []):
        if model["id"] == model_id:
            return model
    return None


def estimate_cost_usd(provider: str, model_id: str, input_tokens: int, output_tokens: int) -> float | None:
    meta = model_meta(provider, model_id)
    if not meta:
        return None
    return round(
        (input_tokens / 1_000_000) * meta.get("cost_in_per_1m", 0.0)
        + (output_tokens / 1_000_000) * meta.get("cost_out_per_1m", 0.0),
        6,
    )
