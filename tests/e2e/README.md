# End-to-end (Playwright) tests

Browser-level tests for the AI chat. They load the **real app page** (all
wiring intact), intercept only the chat API endpoints, and override `fetch` for
the streaming `/messages` endpoint with a test-controlled SSE stream so delta
timing is deterministic. Chat methods are driven programmatically via
`window.APP.chat.*` (no flaky clicks).

`chat_isolation.spec.js` proves the conversation-isolation fix at the DOM level:
- a streaming conversation does **not** bleed into a newly opened one,
- switching back into a finished stream shows its complete answer,
- a redacted stream renders the refusal and never the leaked text.

The no-bleed test is **red-verified**: it fails against the pre-fix `chat.js`
(B's thread shows A's tokens) and passes on the fix.

`chat_controls.spec.js` proves the composer-controls polish fix: the
conversation-scoped controls (External-lookups toggle, Discovery selector,
export, clear) are `display:none` when no conversation is selected and shown
once one is open. It asserts each control's effective `display` (toBeVisible is
unreliable here — the test mounts the chat shell without full page layout, so
ancestors aren't "visible" to Playwright even when the control's own display is
correct). Also **red-verified**: the "hidden when no conversation" test fails on
the pre-fix `chat.js` (controls were `disabled` but never `display:none`).

## Run

1. Start the app (from the repo root):
   ```bash
   python3 -m uvicorn main:app --port 8000 --host 127.0.0.1
   ```
2. Install deps (first time only) and run:
   ```bash
   cd tests/e2e
   npm install
   npx playwright install chromium
   npx playwright test            # or: npm test
   ```

Override the target with `SF_BASE_URL` (default `http://127.0.0.1:8000`).

`node_modules/`, `test-results/`, and `playwright-report/` are git-ignored.
