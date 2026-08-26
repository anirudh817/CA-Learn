"""LLM safety-judge key isolation.

The input/output safety judges fail OPEN: if their provider call errors
(rate-limit, quota, outage) the gate silently allows. Today the judges run on
the *same* key as chat (user -> workspace -> platform), so chat load can starve
the gate — and a BYOK user could rate-limit their OWN key to bypass it.

`dispatcher.security_provider(fallback)` resolves the judge's provider: it uses
the dedicated `AI_SECURITY_ANTHROPIC_API_KEY` when configured (own key/quota,
independent of chat), and falls back to the chat provider when unset so existing
deployments are unchanged.

NOTE on imports: `tests.test_app.build_app` evicts `config`/`services.*` from
`sys.modules` for per-test isolation, so module identities rotate across the
full suite. `security_provider` reads `config` at call time, so each test here
resolves `config`/`dispatcher` fresh at call time too — otherwise a stale
module-level reference would patch a different object than the code reads.
"""
import importlib
import sys
import unittest

from tests.test_app import BACKEND_DIR

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import tempfile  # noqa: E402
from unittest import mock  # noqa: E402

from tests.test_app import (  # noqa: E402
    bootstrap_session,
    build_app,
    dataset_bytes,
    managed_client,
    upload_primary_dataset,
)

_CHAT_KEY = "sk-ant-CHATKEY-padding-padding-padding-pad"
_SEC_KEY = "sk-ant-SECKEY-padding-padding-padding-paddd"


def _current():
    """The live config + dispatcher modules the production code will use."""
    return (
        importlib.import_module("config"),
        importlib.import_module("services.ai.dispatcher"),
    )


class SecurityProviderResolutionTests(unittest.TestCase):
    def test_falls_back_to_chat_provider_on_explicit_empty_key(self):
        _, dispatcher = _current()
        sentinel = object()
        self.assertIs(dispatcher.security_provider(sentinel, security_key=""), sentinel)

    def test_falls_back_when_config_key_unset(self):
        config, dispatcher = _current()
        old = getattr(config, "AI_SECURITY_ANTHROPIC_API_KEY", "")
        config.AI_SECURITY_ANTHROPIC_API_KEY = ""
        try:
            sentinel = object()
            self.assertIs(dispatcher.security_provider(sentinel), sentinel)
        finally:
            config.AI_SECURITY_ANTHROPIC_API_KEY = old

    def test_uses_dedicated_key_when_explicitly_set(self):
        _, dispatcher = _current()
        sentinel = object()
        built = object()
        calls = []

        def fake_get_provider(provider, api_key):
            calls.append((provider, api_key))
            return built

        old_gp = dispatcher.get_provider
        dispatcher.get_provider = fake_get_provider
        try:
            result = dispatcher.security_provider(sentinel, security_key="sk-sec-123")
        finally:
            dispatcher.get_provider = old_gp

        self.assertIs(result, built)
        self.assertIsNot(result, sentinel)
        self.assertEqual(calls, [("anthropic", "sk-sec-123")])

    def test_reads_dedicated_key_from_config_dynamically(self):
        config, dispatcher = _current()
        sentinel = object()
        built = object()
        calls = []

        def fake_get_provider(provider, api_key):
            calls.append((provider, api_key))
            return built

        old_gp = dispatcher.get_provider
        old_cfg = getattr(config, "AI_SECURITY_ANTHROPIC_API_KEY", "")
        dispatcher.get_provider = fake_get_provider
        config.AI_SECURITY_ANTHROPIC_API_KEY = "sk-from-config"
        try:
            result = dispatcher.security_provider(sentinel)
        finally:
            dispatcher.get_provider = old_gp
            config.AI_SECURITY_ANTHROPIC_API_KEY = old_cfg

        self.assertIs(result, built)
        self.assertEqual(calls, [("anthropic", "sk-from-config")])

    def test_falls_back_to_chat_provider_when_dedicated_build_raises(self):
        """Fail-open invariant: security_provider is evaluated OUTSIDE the
        judge's internal try/except, so it must never raise. If building the
        dedicated provider errors, fall back to chat rather than break the turn."""
        config, dispatcher = _current()

        def boom(provider, api_key):
            raise RuntimeError("dedicated provider construction failed")

        old_gp = dispatcher.get_provider
        dispatcher.get_provider = boom
        try:
            sentinel = object()
            # Must NOT raise; must return the chat fallback.
            result = dispatcher.security_provider(sentinel, security_key="sk-broken")
        finally:
            dispatcher.get_provider = old_gp

        self.assertIs(result, sentinel)

    def test_dedicated_provider_is_independent_of_chat_provider(self):
        """The whole point: when a dedicated key is set, the judge provider is
        NOT the chat provider — so chat key starvation can't reach the judge."""
        _, dispatcher = _current()
        chat_provider = object()
        built = object()

        old_gp = dispatcher.get_provider
        dispatcher.get_provider = lambda provider, api_key: built
        try:
            judge_provider = dispatcher.security_provider(chat_provider, security_key="sk-sec")
        finally:
            dispatcher.get_provider = old_gp

        self.assertIsNot(judge_provider, chat_provider)

    def test_whitespace_only_key_is_treated_as_unset(self):
        """A whitespace-only env value is a misconfiguration, not a key — it
        must degrade to fallback, never build a provider from junk."""
        _, dispatcher = _current()
        sentinel = object()
        self.assertIs(dispatcher.security_provider(sentinel, security_key="   "), sentinel)

    def test_same_dedicated_key_returns_cached_provider(self):
        """The judge must not reconstruct an httpx pool every turn — repeated
        resolution of the same key returns get_provider's cached instance."""
        _, dispatcher = _current()
        built = object()
        old_gp = dispatcher.get_provider
        dispatcher.get_provider = lambda provider, api_key: built
        try:
            a = dispatcher.security_provider(object(), security_key="sk-sec")
            b = dispatcher.security_provider(object(), security_key="sk-sec")
        finally:
            dispatcher.get_provider = old_gp
        self.assertIs(a, b)


class JudgeRoutingIntegrationTests(unittest.TestCase):
    """Prove the route ACTUALLY routes the judges through security_provider —
    the unit tests above prove only the resolver in isolation. Drives one
    benign chat turn and captures which provider key each judge ran on."""

    def _capture_judge_keys(self, dedicated_key):
        import importlib

        captured = {}
        with tempfile.TemporaryDirectory() as temp_dir:
            app = build_app(temp_dir)
            config = importlib.import_module("config")
            security = importlib.import_module("services.ai.security")
            from services.ai.providers import anthropic_provider as ap_module
            from services.ai.security import InputClassification, OutputClassification

            old_cfg = getattr(config, "AI_SECURITY_ANTHROPIC_API_KEY", "")
            config.AI_SECURITY_ANTHROPIC_API_KEY = dedicated_key

            def _rec_init(self, api_key):
                self._recorded_key = api_key
                self._sync_client = None
                self._async_client = None

            async def _complete(self, **kwargs):
                return {
                    "text": "APOE is elevated in this cohort.",
                    "tool_calls": [],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                    "finish_reason": "end_turn",
                }

            async def _stream(self, **kwargs):
                yield {"type": "delta", "text": "APOE is elevated in this cohort."}

            async def _spy_input(text, *, provider, model="x"):
                captured["input"] = getattr(provider, "_recorded_key", None)
                return InputClassification(verdict="allowed", reason="ok", judge_ran=True)

            async def _spy_output(answer, *, provider, model="x"):
                captured["output"] = getattr(provider, "_recorded_key", None)
                return OutputClassification(leaked=False, reason="ok", judge_ran=True)

            patches = [
                mock.patch.object(ap_module.AnthropicProvider, "__init__", _rec_init),
                mock.patch.object(ap_module.AnthropicProvider, "complete", _complete),
                mock.patch.object(ap_module.AnthropicProvider, "stream", _stream),
                mock.patch.object(security, "classify_input_intent", _spy_input),
                mock.patch.object(security, "classify_output_for_leak", _spy_output),
            ]
            for p in patches:
                p.__enter__()
            try:
                with managed_client(app) as client:
                    headers, workspace, project = bootstrap_session(client)
                    uploaded = upload_primary_dataset(
                        client, headers, workspace["id"], project["id"], dataset_bytes()
                    )
                    run = client.post(
                        "/api/runs",
                        headers=headers,
                        json={
                            "workspace_id": workspace["id"],
                            "project_id": project["id"],
                            "name": "judge-routing",
                            "dataset_id": uploaded["dataset_id"],
                        },
                    ).json()
                    client.put(
                        "/api/settings/ai",
                        headers=headers,
                        json={"anthropic_key": _CHAT_KEY},
                    )
                    conv = client.post(
                        f"/api/runs/{run['run_id']}/conversations",
                        headers=headers,
                        json={},
                    ).json()
                    resp = client.post(
                        f"/api/conversations/{conv['id']}/messages",
                        headers=headers,
                        json={"content": "What is the APOE log2FC?"},
                    )
                    self.assertEqual(resp.status_code, 200, resp.text)
            finally:
                for p in reversed(patches):
                    p.__exit__(None, None, None)
                config.AI_SECURITY_ANTHROPIC_API_KEY = old_cfg
        return captured

    def test_judges_run_on_dedicated_key_when_set(self):
        captured = self._capture_judge_keys(_SEC_KEY)
        # Both the input judge and the non-streaming output judge ran on the
        # dedicated security key — NOT the chat key.
        self.assertEqual(captured.get("input"), _SEC_KEY)
        self.assertEqual(captured.get("output"), _SEC_KEY)
        self.assertNotEqual(captured.get("input"), _CHAT_KEY)

    def test_judges_run_on_chat_key_when_unset(self):
        captured = self._capture_judge_keys("")
        # No dedicated key → judges fall back to the chat provider, byte-for-byte
        # the pre-change behavior.
        self.assertEqual(captured.get("input"), _CHAT_KEY)
        self.assertEqual(captured.get("output"), _CHAT_KEY)


if __name__ == "__main__":
    unittest.main()
