export function createRunHistoryModule({ STATE, toast, escapeHtml, humanizeStatus, statusBadgeClass, statusIcon, safeDate }) {
  return {
    async renderRuns() {
      if (!STATE.currentWorkspaceId) return;
      const el = document.getElementById("runList");
      if (el) {
        el.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading runs...</div>';
      }

      try {
        const activeRuns = await this.apiJson(`/api/runs?workspace_id=${encodeURIComponent(STATE.currentWorkspaceId)}`);
        const trashedRuns = await this.apiJson(`/api/runs?workspace_id=${encodeURIComponent(STATE.currentWorkspaceId)}&include_trashed=true`);
        STATE.runsCache = activeRuns;
        STATE.trashedRunsCache = trashedRuns;
        this.renderRunList(STATE.showTrash ? trashedRuns : activeRuns);
        this.refreshCompareTray();
      } catch (error) {
        if (el) {
          el.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load runs: ${escapeHtml(error.message)}</div>`;
        }
      }
    },

    renderRunList(runs) {
      const el = document.getElementById("runList");
      if (!el) return;
      const query = (document.getElementById("runSearch")?.value || "").toLowerCase();
      const filter = (document.getElementById("statusFilter")?.value || "").toLowerCase();
      const filtered = runs.filter((run) => {
        const matchesQuery =
          !query ||
          run.name.toLowerCase().includes(query) ||
          run.id.toLowerCase().includes(query) ||
          (run.file_name || "").toLowerCase().includes(query);
        const matchesFilter = !filter || String(run.status).toLowerCase() === filter;
        return matchesQuery && matchesFilter;
      });

      if (!filtered.length) {
        el.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted)">${STATE.showTrash ? "No trashed runs found." : `No runs found. <a href="#" onclick="APP.go('upload');return false;">Start your first analysis</a>`}</div>`;
        return;
      }

      el.innerHTML = filtered
        .map((run) => {
          const checked = STATE.selectedRuns.includes(run.id) ? "checked" : "";
          const compareSelected = STATE.selectedRuns.includes(run.id);
          const compareDisabled = !compareSelected && STATE.selectedRuns.length >= 2 ? "disabled" : "";
          const active = STATE.currentRunId === run.id ? " active-run" : "";
          const params = run.params || {};
          const status = String(run.status || "").toLowerCase();
          const metrics = [
            run.modules_count != null ? `<div><strong style="color:var(--primary)">${run.modules_count}</strong> modules</div>` : "",
            run.sig_peptides != null ? `<div><strong style="color:var(--danger)">${run.sig_peptides}</strong> significant</div>` : "",
          ]
            .filter(Boolean)
            .join("");
          const paramLabel = [params.normalization_method, params.statistical_test, `beta=${params.wgcna_power || "na"}`].filter(Boolean).join(" · ");
          return `
            <div class="run-row${active}">
              <div class="run-check">
                <input type="checkbox" ${checked} onclick="event.stopPropagation();APP.toggleSelect('${run.id}')" style="accent-color:var(--primary);width:15px;height:15px">
              </div>
              <div class="run-main" onclick="APP.openRun('${run.id}')">
                <div class="run-icon"><i class="fa-solid ${statusIcon(status)}"></i></div>
                <div class="run-info">
                  <h4>${escapeHtml(run.name)} <span class="badge ${statusBadgeClass(status)}" style="margin-left:0.4rem">${humanizeStatus(status)}</span>${run.app_version ? ` <span class="badge badge-stone" style="font-size:0.68rem;margin-left:0.4rem" title="Pipeline version used for this run"><i class="fa-solid fa-code-branch"></i> v${escapeHtml(run.app_version)}</span>` : ""}</h4>
                  <p>${escapeHtml(run.file_name || "Uploaded dataset")} &nbsp;·&nbsp; ${safeDate(run.created_at)}</p>
                </div>
              </div>
              <div class="run-summary">
                <div class="run-params">${escapeHtml(paramLabel || "Custom parameters")}</div>
                <div style="text-align:right;font-size:0.78rem;color:var(--text-muted)">${metrics || "<div>Pending metrics</div>"}</div>
                <div class="run-actions">
                  <button class="btn btn-outline btn-sm" ${compareDisabled} onclick="event.stopPropagation();APP.toggleSelect('${run.id}')"><i class="fa-solid fa-code-compare"></i> ${checked ? "Selected" : "Compare"}</button>
                  <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();APP.openRun('${run.id}')"><i class="fa-solid fa-arrow-right"></i> Open</button>
                  ${
                    status === "trashed"
                      ? `<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();APP.restoreRun('${run.id}')"><i class="fa-solid fa-trash-arrow-up"></i> Restore</button>
                         <button class="btn btn-outline btn-sm run-delete" onclick="event.stopPropagation();APP.purgeRun('${run.id}')"><i class="fa-solid fa-trash-can"></i> Purge</button>`
                      : `<button class="btn btn-outline btn-sm run-delete" onclick="event.stopPropagation();APP.trashRun('${run.id}')"><i class="fa-solid fa-trash"></i> Trash</button>`
                  }
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    },

    filterRuns() {
      this.renderRunList(STATE.showTrash ? STATE.trashedRunsCache : STATE.runsCache);
    },

    toggleSelect(id) {
      const index = STATE.selectedRuns.indexOf(id);
      if (index >= 0) {
        STATE.selectedRuns.splice(index, 1);
      } else {
        if (STATE.selectedRuns.length >= 2) {
          toast("The compare tray holds two runs. Clear one before adding another.", "info");
          return;
        }
        STATE.selectedRuns.push(id);
      }
      this.renderRunList(STATE.showTrash ? STATE.trashedRunsCache : STATE.runsCache);
      this.refreshCompareTray();
    },

    refreshCompareTray() {
      const tray = document.getElementById("compareTray");
      if (!tray) return;
      if (!STATE.selectedRuns.length) {
        tray.innerHTML = '<i class="fa-solid fa-code-compare"></i> No runs selected for compare';
        return;
      }
      const chips = STATE.selectedRuns
        .map((id) => {
          const run = [...STATE.runsCache, ...STATE.trashedRunsCache].find((item) => item.id === id);
          const label = run ? escapeHtml(run.name) : escapeHtml(id);
          return `<span class="tag-chip">${label}<span class="rm" onclick="event.stopPropagation();APP.toggleSelect('${id}')"><i class="fa-solid fa-xmark"></i></span></span>`;
        })
        .join("");
      tray.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;width:100%">
          <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
            <i class="fa-solid fa-code-compare"></i>
            <span>Compare tray</span>
            ${chips}
          </div>
          <div style="display:flex;gap:0.45rem;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" onclick="APP.clearCompareSelection()"><i class="fa-solid fa-broom"></i> Clear</button>
            <button class="btn btn-primary btn-sm" ${STATE.selectedRuns.length === 2 ? "" : "disabled"} onclick="APP.showDiff()"><i class="fa-solid fa-code-compare"></i> Compare</button>
          </div>
        </div>
      `;
    },

    clearCompareSelection() {
      STATE.selectedRuns = [];
      this.renderRunList(STATE.showTrash ? STATE.trashedRunsCache : STATE.runsCache);
      this.refreshCompareTray();
    },

    toggleTrashView() {
      STATE.showTrash = !STATE.showTrash;
      const button = document.getElementById("toggleTrashBtn");
      if (button) {
        button.innerHTML = STATE.showTrash
          ? '<i class="fa-solid fa-inbox"></i> View Active Runs'
          : '<i class="fa-solid fa-trash"></i> View Trash';
      }
      this.renderRunList(STATE.showTrash ? STATE.trashedRunsCache : STATE.runsCache);
    },

    async trashRun(runId) {
      try {
        await this.apiJson(`/api/runs/${encodeURIComponent(runId)}/trash`, { method: "POST" });
        STATE.selectedRuns = STATE.selectedRuns.filter((id) => id !== runId);
        toast("Run moved to trash", "info");
        await this.renderRuns();
      } catch (error) {
        toast(`Could not trash run: ${error.message}`, "error");
      }
    },

    async restoreRun(runId) {
      try {
        await this.apiJson(`/api/runs/${encodeURIComponent(runId)}/restore`, { method: "POST" });
        toast("Run restored", "info");
        await this.renderRuns();
      } catch (error) {
        toast(`Could not restore run: ${error.message}`, "error");
      }
    },

    async purgeRun(runId) {
      try {
        await this.apiJson(`/api/runs/${encodeURIComponent(runId)}/purge`, { method: "POST" });
        STATE.selectedRuns = STATE.selectedRuns.filter((id) => id !== runId);
        toast("Run permanently deleted", "info");
        await this.renderRuns();
      } catch (error) {
        toast(`Could not permanently delete run: ${error.message}`, "error");
      }
    },

    async fetchRun(runId) {
      const run = await this.apiJson(`/api/runs/${encodeURIComponent(runId)}`);
      STATE.currentRunMeta = run;
      return run;
    },

    async openRun(id) {
      const summary = STATE.runsCache.find((run) => run.id === id);
      STATE.currentRunId = id;
      delete STATE.artifactsCache[id];
      STATE.chartsLoaded = {};
      if (summary && ["queued", "running"].includes(String(summary.status || "").toLowerCase())) {
        document.getElementById("analysisSubtitle").textContent = `${summary.name} · ${summary.id}`;
        this.go("analysis");
        this.startLogStream(id);
        return;
      }
      this.resetResultsTabs();
      this.go("results");
    },

    async showDiff() {
      if (STATE.selectedRuns.length !== 2) {
        toast("Select exactly two runs to compare", "info");
        return;
      }

      try {
        const data = await this.apiJson("/api/compare/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ left_run_id: STATE.selectedRuns[0], right_run_id: STATE.selectedRuns[1] }),
        });
        document.getElementById("diffLabel").textContent = `${data.left.name} vs ${data.right.name}`;

        const rows = data.param_diff.length
          ? data.param_diff
              .map(
                (row) => `
                  <tr>
                    <td style="color:var(--text-muted);font-weight:500;padding:0.4rem 0.75rem;border-bottom:1px solid var(--border)">${escapeHtml(row.parameter)}</td>
                    <td class="diff-changed" style="padding:0.4rem 0.75rem;border-bottom:1px solid var(--border)">${escapeHtml(String(row.left ?? "—"))}</td>
                    <td class="diff-changed" style="padding:0.4rem 0.75rem;border-bottom:1px solid var(--border)">${escapeHtml(String(row.right ?? "—"))}</td>
                  </tr>
                `
              )
              .join("")
          : `<tr><td colspan="3" style="padding:0.8rem 0.75rem;color:var(--text-muted)">No parameter differences detected.</td></tr>`;

        document.getElementById("diffTable").innerHTML = `
          <tr><th>Parameter</th><th>${escapeHtml(data.left.name)}</th><th>${escapeHtml(data.right.name)}</th></tr>
          ${rows}
        `;

        // Metrics panel is rendered inline; we lazily create/update an
        // element next to the diff table since the prior modal was removed
        // in a refactor. Wire to whichever element exists.
        const metrics = [
          ["Significant", `${data.left.sig_peptides || 0} vs ${data.right.sig_peptides || 0}`],
          ["Modules", `${data.left.modules_count || 0} vs ${data.right.modules_count || 0}`],
          ["GO Terms", `${data.left.go_terms || 0} vs ${data.right.go_terms || 0}`],
        ]
          .map(([label, value]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`)
          .join("");

        let metricsEl = document.getElementById("diffMetrics");
        const panel = document.getElementById("diffPanel");
        if (!metricsEl && panel) {
          metricsEl = document.createElement("div");
          metricsEl.id = "diffMetrics";
          metricsEl.className = "diff-metrics";
          panel.appendChild(metricsEl);
        }
        if (metricsEl) {
          metricsEl.innerHTML = metrics;
        }

        // Inline panel — make sure it's visible. The legacy "diffModal"
        // overlay no longer exists, so we just unhide diffPanel.
        if (panel) panel.style.display = "";
        document.getElementById("diffModal")?.classList.add("show");
      } catch (error) {
        toast(`Could not compare runs: ${error.message}`, "error");
      }
    },
  };
}
