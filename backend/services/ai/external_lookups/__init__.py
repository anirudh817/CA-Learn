"""External biological database lookups (P7).

Opt-in, per-conversation tool-use against public databases (UniProt,
Reactome). The chat exposes each adapter as a tool the model may call; the
dispatcher enforces caching, quotas, a circuit breaker, and timeouts.

Public surface used by the chat layer:
    dispatcher.external_tool_schemas()  → tool schemas to expose to the model
    dispatcher.EXTERNAL_TOOL_NAMES      → set of tool names handled here
    dispatcher.dispatch(...)            → run one external lookup
"""
