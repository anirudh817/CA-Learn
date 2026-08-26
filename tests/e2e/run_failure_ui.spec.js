// Browser-level proof of the stuck-on-failure fix: when a run FAILS, the
// executing page must visibly transition to a failed state (red progress bar,
// "Run failed" subtitle, and a persistent banner showing error_message) — not
// just fire a transient toast and freeze on "Pipeline Executing / ETL 10%".
//
// The original bug: a fast failure (e.g. Stage 1 aborts in ~0.5s because R is
// unavailable) left the SSE-driven page frozen at the last event it received,
// so the run *looked* hung at 5% when it had actually failed. The fix wires the
// SSE "failed" path through APP.markRunFailed(), which re-fetches the
// authoritative run state and renders the failure UI.
//
// We reproduce the real fast-failure SSE sequence via route mocks (ETL running →
// terminal done/failed) and assert the failure UI appears. The page shell,
// assets and auth bootstrap are served live (only the run endpoints are mocked),
// matching the existing chat specs.
//
// RED-VERIFY: against the pre-fix app.js the "failed" branch only called
// toast(...) — no .run-failure-banner is ever inserted and #progressBar never
// gets the `failed` class, so every assertion below fails. They pass on the fix.
//
// Run:  (app on SF_BASE_URL)  npx playwright test run_failure_ui
const { test, expect } = require("@playwright/test");

const RUN = "RUN-E2E-FAIL";
const ERROR_MESSAGE =
  "R Stage 1 is required but unavailable. Rscript not found in PATH -- install R (https://cran.r-project.org/)";

// Real fast-failure stream: a running ETL log + stage event, then the terminal
// done/failed event — exactly what the live SSE emits when Stage 1 aborts.
const SSE_BODY = [
  { type: "log", line: "[12:03:38] Parsing wide-format matrix", status: "running" },
  {
    type: "stage",
    status: "running",
    stages: [
      { stage_key: "etl", status: "running", progress: 10, message: "Preparing canonical input bundle" },
    ],
  },
  { type: "log", line: "[ProteomicsAI] ERROR: " + ERROR_MESSAGE, status: "failed" },
  { type: "done", status: "failed" },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join("");

// Authoritative final state markRunFailed() re-fetches: FAILED, with the real
// error_message and the true stage statuses (ETL done, the rest never ran).
const FAILED_RUN = {
  id: RUN,
  name: "01_input-PEAKS_Log2_Normalized_Data",
  status: "failed",
  error_message: ERROR_MESSAGE,
  stages: [
    { stage_key: "etl", status: "complete", progress: 100, message: "Canonical input bundle ready" },
    { stage_key: "normalization", status: "pending", progress: 0, message: "" },
  ],
};

async function installRoutes(page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/runs/${RUN}/logs` || path === `/api/runs/${RUN}/events`) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: SSE_BODY,
      });
    }
    if (path === `/api/runs/${RUN}`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FAILED_RUN) });
    }
    return route.continue(); // page shell, assets, auth bootstrap → live backend
  });
}

test.describe("executing page surfaces run failure (stuck-on-failure fix)", () => {
  test("failed run shows the failure banner, red bar, and 'Run failed' subtitle", async ({ page }) => {
    await installRoutes(page);
    await page.goto("/");
    await page.waitForFunction(() => window.APP && typeof window.APP.startLogStream === "function", null, {
      timeout: 15000,
    });

    // Show the analysis page and start the real SSE-driven log stream — the exact
    // path the app takes after POST /api/runs.
    await page.evaluate((run) => {
      document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
      const analysis = document.getElementById("page-analysis");
      if (analysis) {
        analysis.classList.add("active");
        analysis.style.display = "block";
      }
      window.APP.startLogStream(run);
    }, RUN);

    // The persistent banner carries the real error message (no longer a toast).
    const banner = page.locator(".run-failure-banner");
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText("Run failed.");
    await expect(banner).toContainText("Rscript not found in PATH");

    // Progress bar flips to the failed (red) state and the subtitle reflects it.
    await expect(page.locator("#progressBar")).toHaveClass(/failed/);
    await expect(page.locator("#analysisSubtitle")).toHaveText("Run failed");

    // The stale "ETL running 10%" snapshot was replaced by the authoritative
    // final state: exactly one banner, rendered once (idempotent guard).
    await expect(page.locator(".run-failure-banner")).toHaveCount(1);
  });
});
