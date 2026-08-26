"""SignalFold AI chat services package.

Modules:
    crypto         — Fernet encryption of BYOK keys, derived from SESSION_SECRET.
    key_resolver   — user → workspace → platform key precedence; platform quota.
    providers      — provider-agnostic streaming abstraction (Anthropic / OpenAI / Google).
    dispatcher     — provider client cache and default-provider selection.

Higher layers added in P1–P8:
    context_builder, retrievers, artifact_index, summarizer, prompts, tokens,
    attachments, external_lookups/.
"""
