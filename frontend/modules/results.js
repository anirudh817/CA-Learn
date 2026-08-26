export function createResultsModule({
  STATE,
  toast,
  escapeHtml,
  humanBytes,
  artifactKindLabel,
  artifactIcon,
  hasNativeArtifacts,
  ARTIFACT_DESCRIPTIONS,
  statusBadgeClass,
}) {
  return {
    artifactPreviewHtml(artifact) {
      const frameTitle = escapeHtml(artifact.title || artifact.rel_path || "Artifact");
      const contentUrl = artifact.content_url || artifact.inline_url || artifact.download_url || "#";
      const canEmbed = ["html", "pdf"].includes(String(artifact.viewer_type || ""));
      const companions = artifact.download_companions || [];
      const companionButtons = companions.length
        ? companions
            .map(
              (item) =>
                `<button class="btn btn-outline btn-sm" onclick="downloadViaAuth('${item.download_url}')"><i class="fa-solid fa-download"></i> ${escapeHtml(artifactKindLabel(item.kind))}</button>`
            )
            .join("")
        : "";
      return `
        <div class="artifact-card preview">
          <div class="artifact-head">
            <div>
              <div class="artifact-title">${frameTitle}</div>
              <div class="artifact-meta">${escapeHtml(artifact.rel_path.split("/").pop())} · ${escapeHtml(artifactKindLabel(artifact.kind))}${artifact.viewer_type ? ` · ${escapeHtml(artifact.viewer_type)}` : ""}${artifact.size_bytes ? ` · ${escapeHtml(humanBytes(artifact.size_bytes))}` : ""}${artifact.derived_fallback ? " · Derived fallback" : ""}</div>
            </div>
            <div class="artifact-actions">
              <button class="btn btn-outline btn-sm" onclick="APP.openArtifact('${artifact.artifact_id}')"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</button>
              <button class="btn btn-primary btn-sm" onclick="downloadViaAuth('${artifact.download_url}')"><i class="fa-solid fa-download"></i> Download</button>
              ${companionButtons}
            </div>
          </div>
          ${
            canEmbed
              ? `<iframe class="artifact-frame" data-content-url="${contentUrl}" title="${frameTitle}" style="background:var(--bg-input)"></iframe>`
              : (() => {
                  const description = ARTIFACT_DESCRIPTIONS[artifact.artifact_family || ""] || "";
                  return description
                    ? `<div style="padding:1rem 1rem 1.1rem;border-top:1px solid var(--border);background:var(--bg-input);color:var(--text-muted);font-size:0.82rem">${escapeHtml(description)}</div>`
                    : `<div style="border-top:1px solid var(--border)"></div>`;
                })()
          }
        </div>
      `;
    },

    artifactSecondaryHtml(artifact) {
      return `
        <div class="artifact-card">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem">
            <div>
              <div class="artifact-title"><i class="fa-solid ${artifactIcon(artifact.kind)}" style="color:var(--primary);margin-right:0.45rem"></i>${escapeHtml(artifact.title || artifact.rel_path)}</div>
              <div class="artifact-meta">${escapeHtml(artifact.rel_path.split("/").pop())}${artifact.viewer_type ? ` · ${escapeHtml(artifact.viewer_type)}` : ""}</div>
            </div>
            <span class="artifact-pill">${escapeHtml(artifactKindLabel(artifact.kind))}</span>
          </div>
          <div style="margin-top:0.8rem;display:flex;gap:0.5rem;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" onclick="APP.openArtifact('${artifact.artifact_id}')"><i class="fa-solid fa-eye"></i> Open</button>
            <button class="btn btn-primary btn-sm" onclick="downloadViaAuth('${artifact.download_url}')"><i class="fa-solid fa-download"></i> Download</button>
          </div>
        </div>
      `;
    },

    renderNativeDeck(containerId, section, fallbackHtml = "") {
      const container = document.getElementById(containerId);
      if (!container) return false;
      const featured = section?.featured || [];
      const secondary = section?.secondary || [];
      if (!featured.length && !secondary.length) {
        container.innerHTML = fallbackHtml || '<div class="native-empty">No pipeline-native artifacts are available for this tab yet.</div>';
        return false;
      }

      const featuredHtml = featured.length
        ? `<div class="artifact-stack">${featured.map((artifact) => this.artifactPreviewHtml(artifact)).join("")}</div>`
        : "";
      const noPrimaryHtml =
        !featured.length && secondary.length
          ? fallbackHtml || '<div class="native-empty">No canonical inline artifact is available for this tab yet. Related client-safe files are still available below.</div>'
          : "";
      const secondaryHtml = secondary.length
        ? `
          <div>
            <div class="section-label">Additional Files</div>
            <div class="artifact-secondary">${secondary.map((artifact) => this.artifactSecondaryHtml(artifact)).join("")}</div>
          </div>
        `
        : "";
      container.innerHTML = `
        <div class="artifact-stack">
          ${noPrimaryHtml}
          ${featuredHtml}
          ${secondaryHtml}
        </div>
      `;
      this.loadAuthFrames(container);
      return true;
    },

    loadAuthFrames(root) {
      const frames = (root || document).querySelectorAll("iframe.artifact-frame[data-content-url]");
      for (const frame of frames) {
        const url = frame.getAttribute("data-content-url");
        if (!url || url === "#") continue;
        this.api(url)
          .then((response) => response.blob())
          .then((blob) => {
            frame.src = URL.createObjectURL(blob);
          })
          .catch(() => {
            /* leave blank */
          });
      }
    },

    artifactMapForCurrentRun() {
      const index = STATE.currentRunId ? STATE.artifactsCache[STATE.currentRunId] : null;
      const map = {};
      (index?.artifacts || []).forEach((artifact) => {
        map[artifact.rel_path] = artifact;
        map[artifact.artifact_id] = artifact;
      });
      return map;
    },

    async openArtifact(artifactId) {
      if (!STATE.currentRunId || !artifactId) return;
      try {
        const descriptor = await this.apiJson(`/api/results/${encodeURIComponent(STATE.currentRunId)}/artifacts/${encodeURIComponent(artifactId)}/viewer`);
        STATE.viewer.descriptor = descriptor;
        STATE.viewer.tablePayload = null;
        STATE.viewer.search = "";
        STATE.viewer.filters = {};
        STATE.viewer.hiddenColumns = [];
        STATE.viewer.sortColumn = "";
        STATE.viewer.sortDirection = "asc";
        STATE.viewer.page = 1;
        this.showArtifactViewer();
        await this.renderArtifactViewer();
      } catch (error) {
        toast(`Could not open artifact: ${error.message}`, "error");
      }
    },

    showArtifactViewer() {
      const shell = document.getElementById("artifactViewer");
      if (shell) shell.classList.add("show");
      document.body.style.overflow = "hidden";
    },

    closeArtifactViewer() {
      const shell = document.getElementById("artifactViewer");
      if (shell) shell.classList.remove("show");
      document.body.style.overflow = "";
    },

    async renderArtifactViewer() {
      const descriptor = STATE.viewer.descriptor;
      const title = document.getElementById("artifactViewerTitle");
      const meta = document.getElementById("artifactViewerMeta");
      const actions = document.getElementById("artifactViewerActions");
      const body = document.getElementById("artifactViewerBody");
      if (!descriptor || !descriptor.artifact || !title || !body) return;

      const artifact = descriptor.artifact;
      const viewer = descriptor.viewer || {};
      title.textContent = artifact.title || artifact.rel_path || "Artifact";
      meta.textContent = `${artifact.rel_path} · ${artifactKindLabel(artifact.kind)}${artifact.viewer_type ? ` · ${artifact.viewer_type}` : ""}`;
      actions.innerHTML = `
        <button class="btn btn-outline btn-sm" onclick="APP.closeArtifactViewer()"><i class="fa-solid fa-xmark"></i> Close</button>
        <button class="btn btn-primary btn-sm" onclick="downloadViaAuth('${escapeHtml(viewer.download_url || artifact.download_url)}')"><i class="fa-solid fa-download"></i> Download</button>
      `;

      if (viewer.type === "html" || viewer.type === "pdf") {
        const iframeResponse = await this.api(viewer.content_url || artifact.content_url);
        const iframeBlob = await iframeResponse.blob();
        const iframeBlobUrl = URL.createObjectURL(iframeBlob);
        body.innerHTML = `<iframe class="artifact-viewer-frame" src="${iframeBlobUrl}" title="${escapeHtml(artifact.title || artifact.rel_path)}"></iframe>`;
        setTimeout(() => URL.revokeObjectURL(iframeBlobUrl), 300000);
        return;
      }

      if (viewer.type === "table") {
        body.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading interactive table...</div>';
        await this.loadViewerTable();
        return;
      }

      if (viewer.type === "json") {
        const response = await this.api(viewer.content_url || artifact.content_url, {}, false);
        const payload = await response.json();
        body.innerHTML = `
          <div class="viewer-doc viewer-json">
            <div class="viewer-doc-head">
              <div class="section-label">Structured JSON</div>
              <button class="btn btn-outline btn-sm" onclick="APP.copyViewerJson()"><i class="fa-solid fa-copy"></i> Copy JSON</button>
            </div>
            <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
          </div>
        `;
        STATE.viewer.jsonPayload = payload;
        return;
      }

      const response = await this.api(viewer.content_url || artifact.content_url, {}, false);
      const text = await response.text();
      STATE.viewer.textPayload = text;
      body.innerHTML = `
        <div class="viewer-doc">
          <div class="viewer-doc-head">
            <div class="section-label">Document View</div>
            <button class="btn btn-outline btn-sm" onclick="APP.copyViewerText()"><i class="fa-solid fa-copy"></i> Copy text</button>
          </div>
          <pre>${escapeHtml(text)}</pre>
        </div>
      `;
    },

    async loadViewerTable() {
      const descriptor = STATE.viewer.descriptor;
      const artifact = descriptor?.artifact;
      const viewer = descriptor?.viewer || {};
      const body = document.getElementById("artifactViewerBody");
      if (!artifact || !viewer.table_url || !body) return;

      const filters = {};
      Object.entries(STATE.viewer.filters || {}).forEach(([column, value]) => {
        if (String(value || "").trim()) filters[column] = value;
      });

      const params = new URLSearchParams();
      if (STATE.viewer.search) params.set("search", STATE.viewer.search);
      if (Object.keys(filters).length) params.set("filters", JSON.stringify(filters));
      if (STATE.viewer.sortColumn) params.set("sort_column", STATE.viewer.sortColumn);
      params.set("sort_direction", STATE.viewer.sortDirection || "asc");
      params.set("page", String(STATE.viewer.page || 1));
      params.set("page_size", String(STATE.viewer.pageSize || 25));

      const payload = await this.apiJson(`${viewer.table_url}?${params.toString()}`);
      STATE.viewer.tablePayload = payload;

      const columns = payload.columns || [];
      const hidden = new Set(STATE.viewer.hiddenColumns || []);
      const visibleColumns = columns.filter((column) => !hidden.has(column.name));
      const rows = payload.rows || [];

      const headerHtml = visibleColumns
        .map((column) => {
          const active = STATE.viewer.sortColumn === column.name ? ` <span style="color:var(--accent)">${STATE.viewer.sortDirection === "desc" ? "↓" : "↑"}</span>` : "";
          return `<th onclick="APP.toggleViewerSort('${encodeURIComponent(column.name)}')" style="cursor:pointer">${escapeHtml(column.name)}${active}</th>`;
        })
        .join("");

      const filterHtml = visibleColumns
        .map(
          (column) =>
            `<th><input class="form-control viewer-filter" data-col="${encodeURIComponent(column.name)}" value="${escapeHtml((STATE.viewer.filters || {})[column.name] || "")}" placeholder="Filter ${escapeHtml(column.name)}" oninput="APP.updateViewerFilter('${encodeURIComponent(column.name)}', this.value)"></th>`
        )
        .join("");

      const rowHtml = rows.length
        ? rows
            .map(
              (row) =>
                `<tr>${visibleColumns
                  .map((column) => `<td>${escapeHtml(row[column.name] ?? "")}</td>`)
                  .join("")}</tr>`
            )
            .join("")
        : `<tr><td colspan="${Math.max(1, visibleColumns.length)}" style="text-align:center;color:var(--text-muted);padding:2rem">No rows match the current search/filter state.</td></tr>`;

      const columnToggleHtml = columns
        .map(
          (column) => `
            <label class="check-row">
              <input type="checkbox" ${hidden.has(column.name) ? "" : "checked"} onchange="APP.toggleViewerColumn('${encodeURIComponent(column.name)}')">
              ${escapeHtml(column.name)}
            </label>
          `
        )
        .join("");

      body.innerHTML = `
        <div class="viewer-table-shell">
          <div class="viewer-table-toolbar">
            <input class="form-control" style="max-width:260px" placeholder="Search all columns..." value="${escapeHtml(STATE.viewer.search || "")}" oninput="APP.updateViewerSearch(this.value)">
            <select class="form-control" style="max-width:120px" onchange="APP.updateViewerPageSize(this.value)">
              ${[25, 50, 100, 200].map((size) => `<option value="${size}" ${Number(STATE.viewer.pageSize) === size ? "selected" : ""}>${size}/page</option>`).join("")}
            </select>
            <button class="btn btn-outline btn-sm" onclick="APP.copyViewerPage()"><i class="fa-solid fa-copy"></i> Copy Page</button>
            <button class="btn btn-outline btn-sm" onclick="downloadViaAuth('${descriptor.viewer.download_url || artifact.download_url}')"><i class="fa-solid fa-file-arrow-down"></i> Raw File</button>
          </div>
          <div class="viewer-columns">${columnToggleHtml}</div>
          <div class="viewer-pagination">
            <div style="color:var(--text-muted);font-size:0.8rem">${Number(payload.total_rows || 0).toLocaleString()} rows · page ${payload.page} of ${payload.total_pages}</div>
            <div style="display:flex;gap:0.5rem">
              <button class="btn btn-outline btn-sm" ${payload.page <= 1 ? "disabled" : ""} onclick="APP.changeViewerPage(-1)">Previous</button>
              <button class="btn btn-outline btn-sm" ${payload.page >= payload.total_pages ? "disabled" : ""} onclick="APP.changeViewerPage(1)">Next</button>
            </div>
          </div>
          <div class="viewer-table-wrap">
            <table class="data-table viewer-table">
              <thead>
                <tr>${headerHtml}</tr>
                <tr>${filterHtml}</tr>
              </thead>
              <tbody>${rowHtml}</tbody>
            </table>
          </div>
        </div>
      `;
      if (STATE.viewer._activeFilterCol) {
        const encoded = encodeURIComponent(STATE.viewer._activeFilterCol);
        const filterInput = body.querySelector(`.viewer-filter[data-col="${encoded}"]`);
        if (filterInput) {
          const value = filterInput.value;
          filterInput.focus();
          filterInput.setSelectionRange(value.length, value.length);
        }
      }
    },

    updateViewerSearch(value) {
      STATE.viewer.search = value;
      STATE.viewer.page = 1;
      this.loadViewerTable();
    },

    updateViewerFilter(encodedColumn, value) {
      const column = decodeURIComponent(encodedColumn);
      STATE.viewer.filters = STATE.viewer.filters || {};
      STATE.viewer.filters[column] = value;
      STATE.viewer._activeFilterCol = column;
      STATE.viewer.page = 1;
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => this.loadViewerTable(), 350);
    },

    toggleViewerSort(encodedColumn) {
      const column = decodeURIComponent(encodedColumn);
      if (STATE.viewer.sortColumn === column) {
        STATE.viewer.sortDirection = STATE.viewer.sortDirection === "asc" ? "desc" : "asc";
      } else {
        STATE.viewer.sortColumn = column;
        STATE.viewer.sortDirection = "asc";
      }
      this.loadViewerTable();
    },

    toggleViewerColumn(encodedColumn) {
      const column = decodeURIComponent(encodedColumn);
      const hidden = new Set(STATE.viewer.hiddenColumns || []);
      if (hidden.has(column)) hidden.delete(column);
      else hidden.add(column);
      STATE.viewer.hiddenColumns = Array.from(hidden);
      this.loadViewerTable();
    },

    updateViewerPageSize(value) {
      STATE.viewer.pageSize = Number(value || 25);
      STATE.viewer.page = 1;
      this.loadViewerTable();
    },

    changeViewerPage(delta) {
      STATE.viewer.page = Math.max(1, Number(STATE.viewer.page || 1) + Number(delta || 0));
      this.loadViewerTable();
    },

    copyViewerJson() {
      const payload = STATE.viewer.jsonPayload;
      if (!payload) return;
      navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
      toast("JSON copied", "info");
    },

    copyViewerText() {
      const payload = STATE.viewer.textPayload;
      if (!payload) return;
      navigator.clipboard?.writeText(String(payload));
      toast("Text copied", "info");
    },

    copyViewerPage() {
      const payload = STATE.viewer.tablePayload;
      if (!payload) return;
      const columns = (payload.columns || [])
        .map((column) => column.name)
        .filter((name) => !(STATE.viewer.hiddenColumns || []).includes(name));
      const lines = [
        columns.join("\t"),
        ...(payload.rows || []).map((row) => columns.map((column) => String(row[column] ?? "")).join("\t")),
      ];
      navigator.clipboard?.writeText(lines.join("\n"));
      toast("Current page copied", "info");
    },

    async loadResults(runId) {
      if (!runId) return;
      STATE.topProteins.search = "";
      STATE.topProteins.filters = {};
      const topSearch = document.getElementById("topProteinsSearch");
      const topPFilter = document.getElementById("topProteinsPFilter");
      const topModuleFilter = document.getElementById("topProteinsModuleFilter");
      if (topSearch) topSearch.value = "";
      if (topPFilter) topPFilter.value = "";
      if (topModuleFilter) topModuleFilter.value = "";
      const runSummary = [...STATE.runsCache, ...STATE.trashedRunsCache].find((run) => run.id === runId);
      if (runSummary) {
        document.getElementById("resultsTitle").textContent = `Results - ${runSummary.name}`;
        document.getElementById("resultsRunBadge").textContent = runSummary.id;
        document.getElementById("resultsRunBadge").className = `badge ${statusBadgeClass(runSummary.status)}`;
      }

      const runMeta = await this.fetchRun(runId).catch(() => null);
      try {
        const summary = await this.apiJson(`/api/results/${encodeURIComponent(runId)}/summary`);
        const featureLabel =
          String(runMeta?.input_level || "").toLowerCase() === "protein"
            ? "proteins"
            : String(runMeta?.input_level || "").toLowerCase() === "peptide"
              ? "peptides"
              : "features";
        const peptidesTotal = summary.peptides_total ?? summary.feature_count ?? summary.sig_peptides ?? 0;
        const significant = summary.peptides_significant ?? summary.sig_peptides ?? 0;
        const up = summary.peptides_upregulated ?? summary.up_peptides ?? 0;
        const down = summary.peptides_downregulated ?? summary.down_peptides ?? 0;
        const modules = summary.wgcna_modules ?? summary.modules_count ?? 0;
        const terms = summary.significant_terms ?? summary.go_terms ?? 0;
        const params = runMeta?.params || summary.params || {};
        const useAdjusted = params.use_adjusted_pvalue ?? true;
        const pvalueThreshold = Number(params.pvalue_threshold ?? summary.pvalue_threshold ?? 0.05);
        document.getElementById("topProteinsMetricHeader").textContent = useAdjusted ? "Adj p-value" : "p-value";
        document.getElementById("topProteinsSub").textContent =
          `Ranked by ${useAdjusted ? "adjusted p-value" : "raw p-value"} · ${useAdjusted ? "FDR" : "p"} < ${pvalueThreshold.toFixed(3)}`;
        if (topPFilter) topPFilter.placeholder = `${useAdjusted ? "Adjusted" : "Raw"} p-value filter e.g. <0.01`;

        const subtitleParts = [
          runMeta?.pipeline_profile ? `${runMeta.pipeline_profile}` : "",
          runMeta?.analysis_format ? `${runMeta.analysis_format} / ${runMeta.input_level}` : "",
          summary.cohort2 && summary.cohort1 ? `${summary.cohort2} vs ${summary.cohort1}` : "",
          summary.sample_count ? `${summary.sample_count} samples` : "",
          peptidesTotal ? `${Number(peptidesTotal).toLocaleString()} ${featureLabel}` : "",
        ].filter(Boolean);
        document.getElementById("resultsSub").textContent = subtitleParts.join(" · ") || "Run outputs loaded";

        document.getElementById("metricStrip").innerHTML = [
          peptidesTotal ? `<div class="m-chip"><strong>${Number(peptidesTotal).toLocaleString()}</strong> ${featureLabel}</div>` : "",
          significant ? `<div class="m-chip"><strong style="color:var(--danger)">${Number(significant).toLocaleString()}</strong> significant ${featureLabel}</div>` : "",
          up ? `<div class="m-chip"><strong style="color:var(--danger)">+${Number(up).toLocaleString()}</strong> up</div>` : "",
          down ? `<div class="m-chip"><strong style="color:#1a56db">${Number(down).toLocaleString()}</strong> down</div>` : "",
          modules ? `<div class="m-chip"><strong style="color:var(--primary)">${Number(modules).toLocaleString()}</strong> modules</div>` : "",
          terms ? `<div class="m-chip"><strong style="color:var(--accent)">${Number(terms).toLocaleString()}</strong> GO terms</div>` : "",
        ]
          .filter(Boolean)
          .join("");

        const pctUp = peptidesTotal ? `${((Number(up) / Number(peptidesTotal)) * 100).toFixed(1)}% of features` : "No grouped samples";
        const pctDown = peptidesTotal ? `${((Number(down) / Number(peptidesTotal)) * 100).toFixed(1)}% of features` : "No grouped samples";
        document.getElementById("sumGrid").innerHTML = `
          <div class="sum-card"><div class="num up">${Number(up).toLocaleString()}</div><div class="lbl">Upregulated · ${pctUp}</div></div>
          <div class="sum-card"><div class="num dn">${Number(down).toLocaleString()}</div><div class="lbl">Downregulated · ${pctDown}</div></div>
          <div class="sum-card"><div class="num" style="color:var(--primary)">${modules || "—"}</div><div class="lbl">Modules</div></div>
          <div class="sum-card"><div class="num" style="color:var(--accent)">${terms || "—"}</div><div class="lbl">Enriched GO</div></div>
        `;
      } catch (error) {
        document.getElementById("resultsSub").textContent = `Failed to load run summary: ${error.message}`;
      }

      try {
        const artifacts = await this.fetchArtifacts(runId);
        const overview = artifacts?.overview;
        const rendered = this.renderNativeDeck(
          "overviewNative",
          overview,
          '<div class="native-empty">No pipeline-native overview artifacts were generated for this run yet.</div>'
        );
        if (!rendered) {
          document.getElementById("overviewNative").insertAdjacentHTML(
            "beforeend",
            '<div class="native-note" style="margin-top:0.85rem">Structured summaries remain available below, but this tab will prefer pipeline-generated HTML/PDF outputs whenever they exist.</div>'
          );
        }
      } catch (error) {
        document.getElementById("overviewNative").innerHTML = `<div class="native-empty">Failed to load native overview artifacts: ${escapeHtml(error.message)}</div>`;
      }

      await this.loadTopProteinsTable(runId);

      document.getElementById("aiBanner").innerHTML =
        `<i class="fa-solid fa-circle-nodes" style="color:var(--accent)"></i><span>Ask grounded questions about <strong style="color:var(--accent)">${escapeHtml(runId)}</strong>. Responses use only generated outputs and linked citations.</span>`;
    },

    resolveTopProteinArtifact(artifacts) {
      const tables = artifacts?.artifacts || [];
      return (
        tables.find((artifact) => artifact.artifact_family === "volcano.results" && artifact.viewer_type === "table") ||
        tables.find((artifact) => /volcano_results\.tsv$/i.test(artifact.rel_path)) ||
        tables.find((artifact) => /volcano_results/i.test(artifact.rel_path) && artifact.viewer_type === "table") ||
        null
      );
    },

    async loadTopProteinsTable(runId) {
      const table = document.getElementById("topProteinsTable");
      const openButton = document.getElementById("topProteinsOpenTableBtn");
      if (!table) return;
      try {
        const artifacts = await this.fetchArtifacts(runId);
        const artifact = this.resolveTopProteinArtifact(artifacts);
        if (!artifact) {
          table.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">No differential-expression table is available for this run.</td></tr>';
          if (openButton) openButton.disabled = true;
          return;
        }

        STATE.topProteins.artifactId = artifact.artifact_id;
        if (openButton) {
          openButton.disabled = false;
          openButton.onclick = () => APP.openArtifact(artifact.artifact_id);
        }

        const runMeta = STATE.currentRunMeta || {};
        const useAdjusted = runMeta?.params?.use_adjusted_pvalue ?? true;
        const pColumn = useAdjusted ? "adj_pvalue" : "pvalue";
        const params = new URLSearchParams({
          page: "1",
          page_size: "20",
          sort_column: pColumn,
          sort_direction: "asc",
        });
        const filters = { significant: "1" };
        if (STATE.topProteins.filters.module) filters.module = STATE.topProteins.filters.module;
        if (STATE.topProteins.filters.pvalue) filters[pColumn] = STATE.topProteins.filters.pvalue;
        if (Object.keys(filters).length) params.set("filters", JSON.stringify(filters));
        if (STATE.topProteins.search) params.set("search", STATE.topProteins.search);

        const payload = await this.apiJson(`/api/results/${encodeURIComponent(runId)}/tables/${encodeURIComponent(artifact.artifact_id)}?${params.toString()}`);
        STATE.topProteins.rows = payload.rows || [];
        if (!STATE.topProteins.rows.length) {
          table.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">No proteins match the current filters.</td></tr>';
          return;
        }

        table.innerHTML = STATE.topProteins.rows
          .map((protein) => {
            const gene = protein.gene || protein.protein || protein.peptide_id || protein.feature_id || "—";
            const log2fc = Number(protein.log2fc ?? 0);
            const moduleName = String(protein.module || "grey");
            const direction = String(protein.direction || (log2fc >= 0 ? "up" : "down")).toLowerCase();
            const metricValue = protein[pColumn];
            return `
              <tr>
                <td><strong>${escapeHtml(gene)}</strong></td>
                <td style="color:${direction === "up" ? "#c0392b" : "#1a56db"};font-weight:600">${log2fc > 0 ? "+" : ""}${escapeHtml(log2fc.toFixed(3))}</td>
                <td style="color:var(--text-muted)">${escapeHtml(metricValue ?? "")}</td>
                <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(moduleName === "white" ? "#ddd" : moduleName)};margin-right:4px;vertical-align:middle"></span>${escapeHtml(moduleName)}</td>
                <td><span class="badge ${direction === "up" ? "badge-red" : "badge-blue"}">${direction === "up" ? "Up" : "Down"}</span></td>
              </tr>
            `;
          })
          .join("");
      } catch (error) {
        table.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--danger);padding:2rem">${escapeHtml(error.message)}</td></tr>`;
      }
    },

    updateTopProteinsSearch(value) {
      STATE.topProteins.search = value;
      if (STATE.currentRunId) this.loadTopProteinsTable(STATE.currentRunId);
    },

    updateTopProteinsFilter(key, value) {
      STATE.topProteins.filters[key] = value;
      if (STATE.currentRunId) this.loadTopProteinsTable(STATE.currentRunId);
    },

    async loadVolcanoTable(runId) {
      const tbody = document.getElementById("volcanoResultsTableBody");
      const rowCount = document.getElementById("volcanoRowCount");
      const pageInfo = document.getElementById("volcanoPageInfo");
      const prevBtn = document.getElementById("volcanoPrevPage");
      const nextBtn = document.getElementById("volcanoNextPage");
      if (!tbody) return;
      if (!runId) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">Load a run to display DE results</td></tr>';
        return;
      }

      // Loading state
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading DE results…</td></tr>';
      if (rowCount) rowCount.textContent = "Showing — of — features";

      try {
        const artifacts = await this.fetchArtifacts(runId);
        const artifact = this.resolveTopProteinArtifact(artifacts);
        if (!artifact) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">No differential-expression table is available for this run.</td></tr>';
          if (rowCount) rowCount.textContent = "Showing 0 of 0 features";
          if (pageInfo) pageInfo.textContent = "Page 1 of 1";
          if (prevBtn) prevBtn.disabled = true;
          if (nextBtn) nextBtn.disabled = true;
          return;
        }

        STATE.volcanoTable.artifactId = artifact.artifact_id;

        // Build query params from STATE
        const params = new URLSearchParams();
        if (STATE.volcanoTable.search) params.set("search", STATE.volcanoTable.search);
        const filters = {};
        Object.entries(STATE.volcanoTable.filters || {}).forEach(([k, v]) => {
          if (String(v ?? "").trim() !== "") filters[k] = v;
        });
        if (Object.keys(filters).length) params.set("filters", JSON.stringify(filters));
        params.set("sort_column", STATE.volcanoTable.sortColumn || "adj_pvalue");
        params.set("sort_direction", STATE.volcanoTable.sortDirection || "asc");
        params.set("page", String(STATE.volcanoTable.page || 1));
        params.set("page_size", String(STATE.volcanoTable.pageSize || 25));

        const payload = await this.apiJson(`/api/results/${encodeURIComponent(runId)}/tables/${encodeURIComponent(artifact.artifact_id)}?${params.toString()}`);

        const rows = payload.rows || [];
        const total = Number(payload.total_rows || 0);
        const totalPages = Math.max(1, Number(payload.total_pages || 1));
        STATE.volcanoTable.total = total;
        STATE.volcanoTable.totalPages = totalPages;
        STATE.volcanoTable.page = Number(payload.page || STATE.volcanoTable.page || 1);

        // Update sort indicators on every <th data-col="...">
        ["gene", "log2fc", "adj_pvalue", "pvalue"].forEach((col) => {
          const indicator = document.getElementById(`volcanoSort_${col}`);
          const th = document.querySelector(`#volcanoResultsTable th[data-col="${col}"]`);
          if (indicator) {
            if (STATE.volcanoTable.sortColumn === col) {
              indicator.textContent = STATE.volcanoTable.sortDirection === "desc" ? "▼" : "▲";
            } else {
              indicator.textContent = "";
            }
          }
          if (th) {
            th.style.color = STATE.volcanoTable.sortColumn === col ? "var(--primary)" : "";
          }
        });

        // Update pagination controls
        if (pageInfo) pageInfo.textContent = `Page ${STATE.volcanoTable.page} of ${totalPages}`;
        if (prevBtn) prevBtn.disabled = STATE.volcanoTable.page <= 1;
        if (nextBtn) nextBtn.disabled = STATE.volcanoTable.page >= totalPages;
        if (rowCount) rowCount.textContent = `Showing ${rows.length} of ${total} features`;

        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">No proteins match the current filters. <a href="#" onclick="APP.volcanoTableClearFilters();return false">Clear filters</a></td></tr>';
          return;
        }

        tbody.innerHTML = rows
          .map((row) => {
            const gene = row.gene || row.protein || row.peptide_id || row.feature_id || "—";
            const log2fc = Number(row.log2fc ?? 0);
            const direction = String(row.direction || (log2fc >= 0 ? "up" : "down")).toLowerCase();
            const pval = row.pvalue;
            const adjPval = row.adj_pvalue;
            const fmtP = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) ? "—" : Number(v).toPrecision(4);
            return `
              <tr>
                <td><strong>${escapeHtml(gene)}</strong></td>
                <td style="color:${direction === "up" ? "#c0392b" : "#1a56db"};font-weight:600">${log2fc > 0 ? "+" : ""}${escapeHtml(log2fc.toFixed(3))}</td>
                <td style="color:var(--text-muted)">${escapeHtml(fmtP(adjPval))}</td>
                <td style="color:var(--text-muted)">${escapeHtml(fmtP(pval))}</td>
                <td><span class="badge ${direction === "up" ? "badge-red" : "badge-blue"}">${direction === "up" ? "↑ Up" : "↓ Down"}</span></td>
              </tr>
            `;
          })
          .join("");
      } catch (error) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--danger);padding:2rem">${escapeHtml(error.message)}</td></tr>`;
        if (rowCount) rowCount.textContent = "Showing 0 of 0 features";
      }
    },

    volcanoTableSearch(value) {
      STATE.volcanoTable.search = String(value || "");
      STATE.volcanoTable.page = 1;
      clearTimeout(this._volcanoSearchTimer);
      this._volcanoSearchTimer = setTimeout(() => {
        if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
      }, 350);
    },

    volcanoTableFilter(key, value) {
      const v = String(value || "");
      if (v === "") {
        delete STATE.volcanoTable.filters[key];
      } else {
        STATE.volcanoTable.filters[key] = v;
      }
      STATE.volcanoTable.page = 1;
      if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
    },

    volcanoTableSort(col) {
      if (!col) return;
      if (STATE.volcanoTable.sortColumn === col) {
        STATE.volcanoTable.sortDirection = STATE.volcanoTable.sortDirection === "asc" ? "desc" : "asc";
      } else {
        STATE.volcanoTable.sortColumn = col;
        STATE.volcanoTable.sortDirection = "asc";
      }
      STATE.volcanoTable.page = 1;
      if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
    },

    volcanoTablePage(delta) {
      const next = Math.max(1, Number(STATE.volcanoTable.page || 1) + Number(delta || 0));
      const max = Math.max(1, Number(STATE.volcanoTable.totalPages || 1));
      STATE.volcanoTable.page = Math.min(next, max);
      if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
    },

    volcanoTableSetPageSize(value) {
      STATE.volcanoTable.pageSize = Number(value || 25);
      STATE.volcanoTable.page = 1;
      if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
    },

    volcanoTableClearFilters() {
      STATE.volcanoTable.search = "";
      STATE.volcanoTable.filters = {};
      STATE.volcanoTable.page = 1;
      const searchEl = document.getElementById("volcanoTableSearch");
      const dirEl = document.getElementById("volcanoTableDirection");
      const sigEl = document.getElementById("volcanoTableSignificance");
      if (searchEl) searchEl.value = "";
      if (dirEl) dirEl.value = "";
      if (sigEl) sigEl.value = "";
      if (STATE.currentRunId) this.loadVolcanoTable(STATE.currentRunId);
    },

    async renderVolcano() {
      const container = document.getElementById("volcanoNative");
      if (!STATE.currentRunId) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading volcano outputs...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        if (hasNativeArtifacts(artifacts?.volcano)) {
          document.getElementById("volcanoSub").textContent = "Canonical volcano deliverable from the pipeline bundle";
          this.renderNativeDeck("volcanoNative", artifacts.volcano);
        } else {
          container.innerHTML = '<div class="native-empty">No canonical volcano HTML/PDF artifact is available for this run yet.</div>';
        }
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load native volcano artifacts: ${escapeHtml(error.message)}</div>`;
      }
      // Always attempt to load the DE results table — even if the plot artifact is missing or errored,
      // the underlying volcano_results.tsv may still exist (per CONTEXT.md §Integration Points).
      await this.loadVolcanoTable(STATE.currentRunId);
    },

    async renderQC() {
      const container = document.getElementById("qcNative");
      if (!STATE.currentRunId || !container) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading QC and normalization outputs...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        this.renderNativeDeck(
          "qcNative",
          artifacts?.qc,
          '<div class="native-empty">No QC / normalization artifact bundle was generated for this run yet.</div>'
        );
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load QC artifacts: ${escapeHtml(error.message)}</div>`;
      }
    },

    async renderNetwork() {
      const container = document.getElementById("networkNative");
      if (!STATE.currentRunId) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading WGCNA outputs...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        if (hasNativeArtifacts(artifacts?.network)) {
          this.renderNativeDeck("networkNative", artifacts.network);
          return;
        }
        container.innerHTML = '<div class="native-empty">No canonical WGCNA PDF/HTML artifact family is available for this run yet.</div>';
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load native WGCNA artifacts: ${escapeHtml(error.message)}</div>`;
      }
    },

    async renderGO() {
      const container = document.getElementById("goNative");
      if (!STATE.currentRunId) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading GO outputs...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        if (hasNativeArtifacts(artifacts?.go)) {
          this.renderNativeDeck("goNative", artifacts.go);
          return;
        }
        container.innerHTML = '<div class="native-empty">No canonical GO HTML/PDF artifact is available for this run yet.</div>';
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load native GO artifacts: ${escapeHtml(error.message)}</div>`;
      }
    },

    async renderCellTypes() {
      const container = document.getElementById("cellNative");
      if (!STATE.currentRunId) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading cell type outputs...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        if (hasNativeArtifacts(artifacts?.cells)) {
          this.renderNativeDeck("cellNative", artifacts.cells);
          return;
        }
        container.innerHTML = '<div class="native-empty">No canonical CellTypeFET HTML/PDF artifact is available for this run yet.</div>';
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load native cell type artifacts: ${escapeHtml(error.message)}</div>`;
      }
    },

    async renderTables() {
      const container = document.getElementById("tablesNative");
      if (!STATE.currentRunId || !container) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading interactive tables...</div>';
      try {
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        this.renderNativeDeck(
          "tablesNative",
          artifacts?.tables,
          '<div class="native-empty">No client-safe tables were generated for this run yet.</div>'
        );
      } catch (error) {
        container.innerHTML = `<div class="native-empty">Failed to load table artifacts: ${escapeHtml(error.message)}</div>`;
      }
    },

    async renderFileTree() {
      const container = document.getElementById("fileTreeContainer");
      if (!STATE.currentRunId) return;
      container.innerHTML = '<div class="loading-state"><i class="fa-solid fa-circle-notch"></i>Loading run files...</div>';
      try {
        const files = await this.apiJson(`/api/runs/${encodeURIComponent(STATE.currentRunId)}/files`);
        const artifacts = await this.fetchArtifacts(STATE.currentRunId);
        const artifactMap = {};
        (artifacts?.artifacts || []).forEach((artifact) => {
          artifactMap[artifact.rel_path] = artifact;
        });
        const visibleFiles = files.filter((file) => {
          const artifact = artifactMap[file.rel_path];
          if (artifact?.tab === "reports") return false;
          return !/reports\//i.test(String(file.rel_path || ""));
        });
        if (!visibleFiles.length) {
          container.innerHTML = '<div style="padding:1rem;color:var(--text-muted)">No client-safe files are available for this run yet.</div>';
          return;
        }
        const byStage = {};
        visibleFiles.forEach((file) => {
          const stage = file.stage || "meta";
          if (!byStage[stage]) byStage[stage] = [];
          byStage[stage].push(file);
        });

        const labels = {
          input: "Input bundle",
          stage1: "Stage 1 - QC, DE, network",
          stage2: "Stage 2 - GO and pathway enrichment",
          stage3: "Stage 3 - Cell type enrichment",
          meta: "Metadata and exports",
        };
        const icons = {
          input: "fa-folder-tree",
          stage1: "fa-flask",
          stage2: "fa-dna",
          stage3: "fa-brain",
          meta: "fa-file-code",
        };

        const html = Object.entries(byStage)
          .map(([stage, stageFiles]) => {
            const items = stageFiles
              .map((file) => {
                const artifact = artifactMap[file.rel_path];
                const size = file.size_bytes ? `${(file.size_bytes / 1024).toFixed(1)} KB` : "";
                return `
                  <div class="ftree-item" style="justify-content:space-between;align-items:flex-start">
                    <div style="display:flex;gap:0.5rem;align-items:flex-start;min-width:0">
                      <i class="fa-regular fa-file"></i>
                      <div>
                        <div>${escapeHtml(file.rel_path)}</div>
                        <div style="font-size:0.7rem;color:var(--text-light)">${size}</div>
                      </div>
                    </div>
                    <div style="display:flex;gap:0.45rem;flex-wrap:wrap;justify-content:flex-end">
                      ${artifact ? `<button class="btn btn-outline btn-sm" onclick="APP.openArtifact('${artifact.artifact_id}')"><i class="fa-solid fa-eye"></i> Open</button>` : ""}
                      <button class="btn btn-primary btn-sm" onclick="APP.downloadFile('${STATE.currentRunId}','${encodeURIComponent(file.rel_path)}')"><i class="fa-solid fa-download"></i> Download</button>
                    </div>
                  </div>
                `;
              })
              .join("");
            return `
              <div style="margin-bottom:1rem">
                <div class="section-label">${escapeHtml(labels[stage] || stage)}</div>
                <div class="file-tree">
                  <div class="ftree-item folder"><i class="fa-solid ${icons[stage] || "fa-folder-open"}"></i> ${escapeHtml(stage)}/</div>
                  <div class="ftree-children">${items}</div>
                </div>
              </div>
            `;
          })
          .join("");

        container.innerHTML = `${html}<div style="margin-top:1rem;padding:0.9rem 1rem;background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:0.8rem;color:var(--text-muted)"><i class="fa-solid fa-circle-info" style="color:var(--accent)"></i> &nbsp;Only client-safe artifacts are listed here. Internal R workspace/session files are hidden, and every listed artifact is eligible for grounded AI citation.</div>`;
      } catch (error) {
        container.innerHTML = `<div style="padding:1rem;color:var(--danger)">Failed to load files: ${escapeHtml(error.message)}</div>`;
      }
    },
  };
}
