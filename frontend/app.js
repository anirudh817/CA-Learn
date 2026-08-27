import { createRunHistoryModule } from "./modules/runHistory.js";
import { createResultsModule } from "./modules/results.js";
import { createUploadPreviewModule } from "./modules/uploadPreview.js";

const ARTIFACT_DESCRIPTIONS = {
  // Tables
  "tables.cleaned_matrix":            "Cleaned and filtered abundance matrix after QC processing.",
  "tables.sample_metadata":           "Sample metadata including quality flags and run annotations.",
  "tables.normalized_linear_matrix":  "Normalized abundance matrix in linear (non-log) scale.",
  "tables.normalized_matrix":         "Normalized abundance matrix in log2 scale.",
  "tables.artifact_index":            "Index of all pipeline artifacts generated for this run.",
  "tables.config_stage1":             "Configuration parameters used for normalization and network analysis (Stage 1).",
  "tables.config_stage1_r":           "R WGCNA configuration parameters used for Stage 1.",
  "tables.config_stage2":             "Configuration parameters used for GO enrichment analysis (Stage 2).",
  "tables.config_stage3":             "Configuration parameters used for cell type analysis (Stage 3).",
  "tables.params":                    "Full parameter set submitted at run time.",
  "tables.run_manifest":              "Run provenance: dataset, pipeline version, and submission metadata.",
  "tables.pipeline_profile":          "Pipeline profile settings determining analysis variant and output naming.",
  // Volcano
  "volcano.results":      "Differential expression results — log2FC, p-values, and significance flags for all features.",
  "volcano.upregulated":  "Features significantly upregulated in the case group.",
  "volcano.downregulated":"Features significantly downregulated in the case group.",
  "volcano.summary":      "Summary of differential expression results.",
  // Network
  "network.assignments":  "WGCNA module assignment for each protein/peptide with kME score.",
  "network.hub_proteins": "Top hub proteins per module ranked by module membership (kME).",
  "network.eigengenes":   "Module eigengene expression profiles across samples.",
  "network.kme":          "Module membership (kME) scores for all features across all modules.",
  "network.module_trait": "Module–trait correlation coefficients and p-values.",
  // GO Enrichment
  "go.enrichment": "GO enrichment results with FDR-corrected p-values across all modules.",
  "go.pvalues":    "GO enrichment nominal p-value matrix by module.",
  "go.zscores":    "GO enrichment signed z-score matrix (piano-style FET z-scores).",
  // Cell Types
  "cells.matrix":   "Cell type Fisher Exact Test FDR matrix.",
  "cells.hit_list": "Per-cell-type hit list statistics.",
};

const STATE = {
  sessionToken: null,
  currentUser: null,
  runtime: null,
  workspaces: [],
  currentWorkspaceId: null,
  currentWorkspaceName: "",
  projects: [],
  currentProjectId: null,
  currentProjectName: "",
  currentRunId: null,
  currentRunMeta: null,
  currentFileId: null,
  currentFileMeta: null,
  currentTraitsFileId: null,
  runsCache: [],
  trashedRunsCache: [],
  selectedRuns: [],
  showTrash: false,
  artifactsCache: {},
  chartsLoaded: {},
  logSSE: null,
  timerInterval: null,
  stageSnapshot: [],
  topProteins: {
    artifactId: null,
    search: "",
    filters: {},
    rows: [],
  },
  volcanoTable: {
    artifactId: null,
    search: "",
    filters: { significant: "1" }, // D-04: default significant only
    sortColumn: "adj_pvalue",
    sortDirection: "asc",
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  },
  viewer: {
    descriptor: null,
    tablePayload: null,
    search: "",
    filters: {},
    hiddenColumns: [],
    sortColumn: "",
    sortDirection: "asc",
    page: 1,
    pageSize: 25,
  },
};

function toast(message, type = "") {
  const icon = type === "error" ? "triangle-exclamation" : type === "info" ? "circle-info" : "circle-check";
  const el = document.createElement("div");
  el.className = "toast" + (type ? " " + type : "");
  el.innerHTML = `<i class="fa-solid fa-${icon}"></i> &nbsp;${escapeHtml(message)}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Liveness probe for the standalone AI Insights sidecar (:4317). A no-cors GET
// resolves (opaque) when something is listening and rejects on connection
// refusal, so we can tell up from down without the sidecar needing CORS headers.
// A short timeout keeps the caller inside the click's transient activation.
async function aiInsightsReachable(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(new URL(base, window.location.href).toString(), {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function plotLayout(extra = {}) {
  return Object.assign(
    {
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(245,242,238,0.5)",
      font: { color: "#2a2420", family: "Inter" },
      margin: { t: 20, b: 60, l: 60, r: 20 },
    },
    extra
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanizeStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "Unknown";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusBadgeClass(value) {
  const text = String(value || "").toLowerCase();
  if (text === "complete") return "badge-green";
  if (text === "failed") return "badge-red";
  if (text === "running") return "badge-amber";
  if (text === "queued") return "badge-blue";
  return "badge-stone";
}

function statusIcon(value) {
  const text = String(value || "").toLowerCase();
  if (text === "complete") return "fa-circle-check";
  if (text === "failed") return "fa-circle-xmark";
  if (text === "running") return "fa-spinner";
  if (text === "queued") return "fa-hourglass-half";
  return "fa-clock";
}

function safeDate(value) {
  if (!value) return "Pending";
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return String(value);
  }
}

function withSSEToken(url) {
  // SSE-only: EventSource cannot set custom headers; token appears in server logs (accepted residual risk T-01-03)
  if (!STATE.sessionToken) return url;
  const glue = url.includes("?") ? "&" : "?";
  return `${url}${glue}session_token=${encodeURIComponent(STATE.sessionToken)}`;
}

async function downloadViaAuth(url) {
  try {
    const response = await APP.api(url);
    if (!response.ok) throw new Error("Download failed");
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = url.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    toast(`Download failed: ${e.message}`, "error");
  }
}

async function openViaAuth(url, target) {
  try {
    const response = await APP.api(url);
    if (!response.ok) throw new Error("Failed to load content");
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, target || "_blank");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
  } catch (e) {
    toast(`Failed to open: ${e.message}`, "error");
  }
}

function humanBytes(value) {
  const size = Number(value || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function artifactIcon(kind) {
  const key = String(kind || "").toLowerCase();
  if (key === "html") return "fa-compass-drafting";
  if (key === "pdf") return "fa-file-pdf";
  if (key === "xlsx") return "fa-file-excel";
  if (key === "csv" || key === "tsv" || key === "json" || key === "txt") return "fa-table";
  return "fa-file";
}

function artifactKindLabel(kind) {
  const key = String(kind || "").toLowerCase();
  if (key === "html") return "Interactive";
  if (key === "pdf") return "Static PDF";
  if (key === "xlsx") return "Workbook";
  if (key === "csv") return "CSV";
  if (key === "tsv") return "TSV";
  if (key === "json") return "JSON";
  if (key === "txt") return "Text";
  return key.toUpperCase() || "File";
}

function hasNativeArtifacts(section) {
  return Boolean((section?.featured || []).length || (section?.secondary || []).length);
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function tableFromMarkdown(lines) {
  const rows = lines
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((row) => row.length > 0);

  if (rows.length < 2) {
    return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  }

  const header = rows[0];
  const body = rows.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
  const headHtml = `<thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = `<tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table>${headHtml}${bodyHtml}</table>`;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.startsWith("|")) {
      const tableLines = [];
      while (index < lines.length && lines[index].startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push(tableFromMarkdown(tableLines));
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      const level = Math.min(4, (line.match(/^#+/) || ["#"])[0].length + 1);
      const text = line.replace(/^#{1,4}\s+/, "");
      blocks.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^- /.test(line)) {
      const items = [];
      while (index < lines.length && /^- /.test(lines[index])) {
        items.push(lines[index].replace(/^- /, ""));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !lines[index].startsWith("|") &&
      !/^#{1,4}\s+/.test(lines[index]) &&
      !/^- /.test(lines[index]) &&
      !/^\d+\.\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return blocks.join("");
}

async function parseError(response) {
  try {
    const payload = await response.json();
    return payload.detail || payload.message || JSON.stringify(payload);
  } catch (error) {
    return response.statusText || "Request failed";
  }
}

function showOutlierReviewModal(candidates, runId) {
  const existing = document.getElementById('outlier-review-modal');
  if (existing) existing.remove();

  const rows = candidates.map(c => `
    <tr>
      <td style="padding:0.4rem 0.8rem">${escapeHtml(String(c.sample))}</td>
      <td style="padding:0.4rem 0.8rem;text-align:right">${Number(c.z_score).toFixed(2)}</td>
      <td style="padding:0.4rem 0.8rem;text-align:center">
        <input type="checkbox" class="outlier-check" data-sample="${escapeHtml(String(c.sample))}" checked>
      </td>
    </tr>`).join('');

  const modal = document.createElement('div');
  modal.id = 'outlier-review-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--surface,#1e1e2e);border:1px solid var(--border,#444);border-radius:8px;padding:2rem;max-width:540px;width:90%;max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 0.5rem">Outlier Samples Detected</h3>
      <p style="margin:0 0 1rem;color:var(--muted,#888);font-size:0.9rem">
        ${candidates.length} sample(s) have anomalously low network connectivity.
        Uncheck any samples you want to keep in the analysis.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
        <thead><tr style="border-bottom:1px solid var(--border,#444)">
          <th style="text-align:left;padding:0.4rem 0.8rem">Sample</th>
          <th style="text-align:right;padding:0.4rem 0.8rem">Z-score</th>
          <th style="text-align:center;padding:0.4rem 0.8rem">Remove?</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:1.5rem;display:flex;gap:0.75rem;flex-wrap:wrap">
        <button id="outlier-proceed-btn" style="padding:0.5rem 1.2rem;border-radius:6px;border:none;background:var(--accent,#7c5c3e);color:#fff;cursor:pointer;font-size:0.9rem">Proceed</button>
        <button id="outlier-skip-btn" style="padding:0.5rem 1.2rem;border-radius:6px;border:1px solid var(--border,#444);background:transparent;color:inherit;cursor:pointer;font-size:0.9rem">Skip Removal</button>
        <button id="outlier-cancel-btn" style="padding:0.5rem 1.2rem;border-radius:6px;border:1px solid var(--danger,#f66);background:transparent;color:var(--danger,#f66);cursor:pointer;font-size:0.9rem">Cancel Run</button>
      </div>
      <p id="outlier-modal-error" style="color:var(--danger,#f66);margin-top:0.75rem;display:none"></p>
    </div>`;

  document.body.appendChild(modal);

  async function submitReview(action) {
    const excluded = action === 'proceed'
      ? [...modal.querySelectorAll('.outlier-check:checked')].map(cb => cb.dataset.sample)
      : [];
    modal.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      await APP.apiJson(`/api/runs/${runId}/review-outliers`, {
        method: 'POST',
        body: JSON.stringify({ action, excluded_samples: excluded }),
      });
      modal.remove();
    } catch (err) {
      const errEl = modal.querySelector('#outlier-modal-error');
      errEl.textContent = err.message || 'Request failed';
      errEl.style.display = '';
      modal.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  }

  modal.querySelector('#outlier-proceed-btn').onclick = () => submitReview('proceed');
  modal.querySelector('#outlier-skip-btn').onclick = () => submitReview('skip');
  modal.querySelector('#outlier-cancel-btn').onclick = () => submitReview('cancel');
}

const APP = {
  async api(path, options = {}, allowRetry = true) {
    const headers = new Headers(options.headers || {});
    if (STATE.sessionToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${STATE.sessionToken}`);
    }
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && allowRetry) {
      await this.bootstrapAuth();
      return this.api(path, options, false);
    }
    return response;
  },

  async apiJson(path, options = {}, allowRetry = true) {
    const response = await this.api(path, options, allowRetry);
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    return response.json();
  },

  async fetchArtifacts(runId, force = false) {
    if (!runId) return null;
    if (!force && STATE.artifactsCache[runId]) return STATE.artifactsCache[runId];
    const payload = await this.apiJson(`/api/results/${encodeURIComponent(runId)}/artifacts`);
    STATE.artifactsCache[runId] = payload;
    return payload;
  },

  async openQcModal() {
    if (!STATE.currentFileId) return toast("Upload a dataset first", "info");
    const body = document.getElementById("qcModalBody");
    body.innerHTML = '<p style="color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Computing quality metrics...</p>';
    document.getElementById("qcModal").classList.add("active");
    try {
      const data = await this.apiJson(`/api/datasets/${encodeURIComponent(STATE.currentFileId)}/qc`);
      let html = '';
      if (data.cv_histogram && data.cv_histogram.counts && data.cv_histogram.counts.length) {
        html += '<div class="chart-card"><div id="qcCvChart" style="height:220px"></div></div>';
      }
      if (data.missing_pct && Object.keys(data.missing_pct).length) {
        html += '<div class="chart-card"><div id="qcMissingChart" style="height:220px"></div></div>';
      }
      if (data.pca && data.pca.available) {
        html += '<div class="chart-card"><div id="qcPcaChart" style="height:280px"></div></div>';
      }
      if (!html) html = '<p style="color:var(--text-muted)">No quality data available for this dataset.</p>';
      body.innerHTML = html;
      const qcPlotLayout = { paper_bgcolor: 'transparent', plot_bgcolor: '#f9f7f4', font: { family: 'Inter, sans-serif', size: 11, color: '#7a6e65' }, margin: { t: 24, r: 16, b: 40, l: 48 } };
      if (data.cv_histogram && data.cv_histogram.counts && data.cv_histogram.counts.length) {
        Plotly.newPlot("qcCvChart", [{
          x: data.cv_histogram.bins.slice(0, -1),
          y: data.cv_histogram.counts,
          type: "bar",
          marker: { color: "rgba(124,92,62,0.8)" }
        }], plotLayout({ ...qcPlotLayout, title: { text: "CV Distribution", font: { size: 13 } }, xaxis: { title: "Coefficient of Variation" }, yaxis: { title: "Number of Features" } }), { responsive: true });
      }
      if (data.missing_pct && Object.keys(data.missing_pct).length) {
        const samples = Object.keys(data.missing_pct);
        const pcts = samples.map(s => +(data.missing_pct[s] * 100).toFixed(2));
        const colors = pcts.map(p => p > 20 ? "#c0392b" : p > 5 ? "#b7820a" : "#7c5c3e");
        Plotly.newPlot("qcMissingChart", [{
          y: samples,
          x: pcts,
          type: "bar",
          orientation: "h",
          marker: { color: colors }
        }], plotLayout({ ...qcPlotLayout, title: { text: "Missing Value %", font: { size: 13 } }, xaxis: { title: "Missing %" }, yaxis: { title: "" }, margin: { t: 24, r: 16, b: 40, l: 120 } }), { responsive: true });
      }
      if (data.pca && data.pca.available) {
        const varPct = data.pca.var_pct || [0, 0];
        Plotly.newPlot("qcPcaChart", [{
          x: data.pca.pc1,
          y: data.pca.pc2,
          text: data.pca.labels,
          mode: "markers+text",
          textposition: "top center",
          textfont: { size: 9 },
          type: "scatter",
          marker: { color: "#4a7c6f", size: 8, opacity: 0.75 }
        }], plotLayout({ ...qcPlotLayout, title: { text: "PCA Preview", font: { size: 13 } }, xaxis: { title: `PC1 (${varPct[0]}% variance)` }, yaxis: { title: `PC2 (${varPct[1]}% variance)` } }), { responsive: true });
      }
    } catch (error) {
      body.innerHTML = '<p style="color:var(--text-muted)">Could not compute QC metrics. Check that the dataset file is accessible and retry.</p>';
    }
  },

  closeQcModal() {
    document.getElementById("qcModal").classList.remove("active");
  },

  async openTraitsQcModal() {
    if (!STATE.currentTraitsFileId) return toast("Upload a traits file first", "info");
    const body = document.getElementById("traitsQcModalBody");
    body.innerHTML = '<p style="color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Computing traits summary...</p>';
    document.getElementById("traitsQcModal").classList.add("active");
    try {
      const data = await this.apiJson(`/api/datasets/${encodeURIComponent(STATE.currentTraitsFileId)}/traits-qc`);
      let html = '';

      // Summary table: column name, count, mean, std, min, max, missing, outliers
      if (data.column_summaries && Object.keys(data.column_summaries).length) {
        html += '<div class="chart-card"><h4 style="margin:0 0 0.75rem;font-size:0.85rem;color:var(--text-muted)">Summary Statistics</h4>';
        html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
        html += '<thead><tr style="border-bottom:2px solid var(--border)">';
        html += '<th style="text-align:left;padding:0.4rem 0.6rem">Column</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">N</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Mean</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Std</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Min</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Max</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Missing</th>';
        html += '<th style="text-align:right;padding:0.4rem 0.6rem">Outliers</th>';
        html += '</tr></thead><tbody>';
        for (const [col, s] of Object.entries(data.column_summaries)) {
          const missingColor = s.missing_count > 0 ? 'color:var(--warning)' : '';
          const outlierColor = s.outlier_count > 0 ? 'color:var(--warning)' : '';
          html += `<tr style="border-bottom:1px solid var(--border)">`;
          html += `<td style="padding:0.4rem 0.6rem;font-weight:600">${escapeHtml(col)}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem">${s.count}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem">${s.mean != null ? s.mean : '\u2014'}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem">${s.std != null ? s.std : '\u2014'}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem">${s.min != null ? s.min : '\u2014'}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem">${s.max != null ? s.max : '\u2014'}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem;${missingColor}">${s.missing_count}${s.missing_pct > 0 ? ' (' + (s.missing_pct * 100).toFixed(0) + '%)' : ''}</td>`;
          html += `<td style="text-align:right;padding:0.4rem 0.6rem;${outlierColor}">${s.outlier_count}</td>`;
          html += `</tr>`;
        }
        html += '</tbody></table></div></div>';
      }

      // Missing values bar chart (horizontal bars, one per column)
      const colsWithMissing = Object.entries(data.column_summaries).filter(([_, s]) => s.missing_count > 0);
      if (colsWithMissing.length > 0) {
        html += '<div class="chart-card"><div id="traitsQcMissingChart" style="height:' + Math.max(160, colsWithMissing.length * 40 + 60) + 'px"></div></div>';
      }

      // Distribution box plots (one per numeric column)
      if (data.column_summaries && Object.keys(data.column_summaries).length) {
        html += '<div class="chart-card"><div id="traitsQcDistChart" style="height:280px"></div></div>';
      }

      if (!html) html = '<p style="color:var(--text-muted)">No summary data available for this traits file.</p>';

      // Header with file info
      const header = `<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.5rem">${data.sample_count} samples &middot; ${data.trait_names ? data.trait_names.length : 0} columns &middot; ${Object.keys(data.column_summaries || {}).length} numeric</div>`;
      body.innerHTML = header + html;

      const tqcLayout = { paper_bgcolor: 'transparent', plot_bgcolor: '#f9f7f4', font: { family: 'Inter, sans-serif', size: 11, color: '#7a6e65' }, margin: { t: 24, r: 16, b: 40, l: 100 } };

      // Missing values chart
      if (colsWithMissing.length > 0) {
        const cols = colsWithMissing.map(([c]) => c);
        const pcts = colsWithMissing.map(([_, s]) => +(s.missing_pct * 100).toFixed(1));
        const colors = pcts.map(p => p > 20 ? "#c0392b" : p > 5 ? "#b7820a" : "#7c5c3e");
        Plotly.newPlot("traitsQcMissingChart", [{
          y: cols, x: pcts, type: "bar", orientation: "h",
          marker: { color: colors },
          text: pcts.map(p => p + '%'), textposition: 'outside'
        }], plotLayout({ ...tqcLayout, title: { text: "Missing Values by Column", font: { size: 13 } }, xaxis: { title: "Missing %" }, yaxis: { title: "" } }), { responsive: true });
      }

      // Distribution: box plot per numeric column
      if (data.column_summaries && Object.keys(data.column_summaries).length) {
        const traces = Object.entries(data.column_summaries).map(([col, s]) => ({
          y: [s.min, s.mean - s.std, s.mean, s.mean + s.std, s.max].filter(v => v != null),
          name: col, type: "box",
          boxpoints: false,
          marker: { color: "#4a7c6f" }
        }));
        Plotly.newPlot("traitsQcDistChart", traces, plotLayout({ ...tqcLayout, title: { text: "Trait Distributions", font: { size: 13 } }, showlegend: false, yaxis: { title: "Value" } }), { responsive: true });
      }
    } catch (error) {
      body.innerHTML = '<p style="color:var(--text-muted)">Could not compute traits summary. Check that the traits file is accessible and retry.</p>';
    }
  },

  closeTraitsQcModal() {
    document.getElementById("traitsQcModal").classList.remove("active");
  },

  async init() {
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { APP.closeQcModal(); APP.closeTraitsQcModal(); } });
    this.go("landing");
    try {
      await this.bootstrapAuth();
      await this.ensureProjects();
      await this.renderRuns();
      const runtimeLabel = STATE.runtime?.auth_mode === "local_bootstrap" ? "Authenticated Local Session" : "Authenticated Session";
      document.getElementById("platformPill").innerHTML = `<span class="status-dot"></span> ${escapeHtml(runtimeLabel)}`;
    } catch (error) {
      document.getElementById("platformPill").textContent = "Bootstrap failed";
      toast(`Failed to initialize app: ${error.message}`, "error");
    }
  },

  async bootstrapAuth() {
    const runtime = await fetch("/api/auth/runtime");
    if (!runtime.ok) {
      throw new Error(await parseError(runtime));
    }
    STATE.runtime = await runtime.json();
    if (!STATE.runtime?.local_bootstrap_enabled) {
      throw new Error("This deployment requires credential-based sign-in. Local bootstrap is disabled.");
    }
    const response = await fetch("/api/auth/bootstrap-local", { method: "POST" });
    if (!response.ok) {
      throw new Error(await parseError(response));
    }
    const payload = await response.json();
    STATE.sessionToken = payload.token;
    STATE.currentUser = payload.user;
    STATE.workspaces = payload.workspaces || [];
    const workspace = STATE.workspaces[0];
    if (!workspace) {
      throw new Error("No workspace available");
    }
    STATE.currentWorkspaceId = workspace.id;
    STATE.currentWorkspaceName = workspace.name;
    this.refreshWorkspaceChips();
  },

  async ensureProjects() {
    const projects = await this.apiJson(`/api/projects?workspace_id=${encodeURIComponent(STATE.currentWorkspaceId)}`);
    STATE.projects = projects;
    if (projects.length) {
      STATE.currentProjectId = projects[0].id;
      STATE.currentProjectName = projects[0].name;
      this.refreshWorkspaceChips();
      return;
    }
    const created = await this.apiJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: STATE.currentWorkspaceId,
        name: "General",
        description: "Default project",
      }),
    });
    STATE.projects = [created];
    STATE.currentProjectId = created.id;
    STATE.currentProjectName = created.name;
    this.refreshWorkspaceChips();
  },

  refreshWorkspaceChips() {
    const workspacePill = document.getElementById("workspacePill");
    const projectPill = document.getElementById("projectPill");
    if (workspacePill) {
      workspacePill.textContent = STATE.currentWorkspaceName ? `Workspace ${STATE.currentWorkspaceName}` : "Workspace loading...";
    }
    if (projectPill) {
      projectPill.textContent = STATE.currentProjectName ? `Project ${STATE.currentProjectName}` : "Project loading...";
    }
  },

  resetResultsTabs() {
    document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    const overviewPane = document.getElementById("tab-overview");
    const overviewButton = document.querySelector('.tab-btn[onclick*="overview"]');
    if (overviewPane) overviewPane.classList.add("active");
    if (overviewButton) overviewButton.classList.add("active");
  },

  go(page) {
    // Close SSE when navigating away from the analysis page
    if (page !== "analysis" && STATE.logSSE) {
      STATE.logSSE.close();
      STATE.logSSE = null;
    }

    if (page === "results" && !STATE.currentRunId) {
      toast("Select a run first", "info");
      page = "runs";
    }

    document.querySelectorAll(".page").forEach((element) => element.classList.remove("active"));
    document.querySelectorAll(".nav-link").forEach((element) => element.classList.remove("active"));
    const pageEl = document.getElementById("page-" + page);
    if (pageEl) pageEl.classList.add("active");
    const order = ["landing", "upload", "config", "analysis", "runs", "results", "export"];
    const idx = order.indexOf(page);
    const links = document.querySelectorAll(".nav-link");
    if (idx >= 0 && links[idx]) links[idx].classList.add("active");
    window.scrollTo(0, 0);

    if (page === "runs" && STATE.currentWorkspaceId) this.renderRuns();
    if (page === "results" && STATE.currentRunId) this.loadResults(STATE.currentRunId);
    if (page === "config") this.updateConfigSummary();
  },

  handleDrop(event) {
    event.preventDefault();
    document.getElementById("dropzone").classList.remove("over");
    const file = event.dataTransfer.files[0];
    if (file) this.prepareUpload(file, "primary");
  },

  handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) this.prepareUpload(file, "primary");
  },

  handleTraitsSelect(event) {
    const file = event.target.files[0];
    if (file) this.prepareUpload(file, "traits");
  },

  async loadFormatsCatalog() {
    if (STATE.formatsCatalog) return STATE.formatsCatalog;
    try {
      const data = await this.apiJson("/api/formats");
      STATE.formatsCatalog = data.formats || [];
    } catch (error) {
      STATE.formatsCatalog = [];
    }
    return STATE.formatsCatalog;
  },

  async showFormatPicker(meta) {
    const card = document.getElementById("formatPickerCard");
    if (!card) return;
    const formats = await this.loadFormatsCatalog();
    const familySel = document.getElementById("p_format_family");
    if (!familySel || !formats.length) return;
    familySel.innerHTML = formats
      .map((f) => `<option value="${escapeHtml(f.family)}">${escapeHtml(f.label)}</option>`)
      .join("");
    const detectedFamily = meta?.format_family || "Generic";
    familySel.value = formats.some((f) => f.family === detectedFamily) ? detectedFamily : "Generic";
    this.syncAssayOptions(meta?.assay_level);
    document.getElementById("formatMappingPanel").style.display = "none";
    document.getElementById("formatPickerStatus").innerHTML =
      `<span style="color:var(--text-muted)">Auto-detected <strong>${escapeHtml(detectedFamily)}</strong>. Adjust if needed.</span>`;
    card.style.display = "";
    this.refreshQuickRun(meta);
  },

  syncAssayOptions(preferred) {
    const formats = STATE.formatsCatalog || [];
    const family = document.getElementById("p_format_family")?.value;
    const entry = formats.find((f) => f.family === family);
    const levels = (entry && entry.assay_levels) || ["protein", "peptide", "unknown"];
    const assaySel = document.getElementById("p_assay_level");
    if (!assaySel) return;
    assaySel.innerHTML = levels
      .map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l.charAt(0).toUpperCase() + l.slice(1))}</option>`)
      .join("");
    if (preferred && levels.includes(preferred)) assaySel.value = preferred;
  },

  async onFormatPicked() {
    // Assay options depend on the chosen family; keep them in sync first.
    const currentAssay = document.getElementById("p_assay_level")?.value;
    this.syncAssayOptions(currentAssay);
    if (!STATE.currentFileId) return;
    const family = document.getElementById("p_format_family").value;
    const assay = document.getElementById("p_assay_level").value;
    // A column map is format-specific; drop it if the family changed so a stale
    // mapping can't leak into a different format.
    if (STATE.lastPickedFamily && STATE.lastPickedFamily !== family) {
      STATE.pendingColumnMap = null;
    }
    STATE.lastPickedFamily = family;
    const statusEl = document.getElementById("formatPickerStatus");
    statusEl.innerHTML = `<span style="color:var(--text-muted)">Applying ${escapeHtml(family)}...</span>`;
    try {
      const body = { format_family: family, assay_level: assay };
      if (STATE.pendingColumnMap) body.column_map = STATE.pendingColumnMap;
      const data = await this.apiJson(`/api/datasets/${STATE.currentFileId}/format`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      STATE.currentFileMeta = Object.assign({}, STATE.currentFileMeta, data);
      this.applyDetectedDefaults(data);
      if (data.validation && data.validation.needs_mapping) {
        this.renderMappingPanel(data.validation);
        statusEl.innerHTML = `<span class="log-warn">This ${escapeHtml(family)} file needs column mapping before it can run.</span>`;
      } else {
        document.getElementById("formatMappingPanel").style.display = "none";
        STATE.pendingColumnMap = null;
        statusEl.innerHTML = `<span style="color:var(--success)"><i class="fa-solid fa-circle-check"></i> Ready: ${escapeHtml(family)} · ${escapeHtml(assay)}</span>`;
      }
      this.refreshQuickRun(data);
    } catch (error) {
      statusEl.innerHTML = `<span class="log-error">Could not apply format: ${escapeHtml(error.message)}</span>`;
    }
  },

  renderMappingPanel(validation) {
    const panel = document.getElementById("formatMappingPanel");
    if (!panel) return;
    const roles = validation.missing_roles || [];
    const columns = validation.available_columns || [];
    const options = columns.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    panel.innerHTML =
      `<div class="form-hint" style="margin-bottom:0.5rem">Map the required field(s) to columns in your file:</div>` +
      roles
        .map(
          (role) => `
        <div class="form-group" style="margin-bottom:0.5rem">
          <label class="form-label" style="text-transform:capitalize">${escapeHtml(role)} column</label>
          <select class="form-control" data-role="${escapeHtml(role)}">${options}</select>
        </div>`
        )
        .join("") +
      `<button class="btn btn-outline btn-sm" onclick="APP.applyColumnMap()"><i class="fa-solid fa-wand-magic-sparkles"></i> Apply mapping</button>`;
    panel.style.display = "";
  },

  applyColumnMap() {
    const panel = document.getElementById("formatMappingPanel");
    if (!panel) return;
    const map = {};
    panel.querySelectorAll("select[data-role]").forEach((sel) => {
      map[sel.getAttribute("data-role")] = sel.value;
    });
    STATE.pendingColumnMap = map;
    this.onFormatPicked();
  },

  refreshQuickRun(data) {
    const ready = !data || data.run_ready !== false;
    const quick = document.getElementById("quickRunBtn");
    if (quick) {
      quick.style.display = "";
      quick.disabled = !ready;
    }
    const cfg = document.getElementById("configBtn");
    if (cfg) cfg.disabled = !ready;
  },

  async runWithRecommended() {
    // Recommended defaults are already applied to the config inputs via
    // applyDetectedDefaults(), so this reuses the same run path — it just skips
    // the manual Configure step for the one-click flow.
    if (!STATE.currentFileId) {
      toast("Upload a dataset first", "error");
      return;
    }
    await this.runPipeline();
  },

  applyDetectedDefaults(meta) {
    const recommendations = meta?.recommended_defaults || {};
    const overrides = recommendations.parameter_overrides || {};
    const hint = document.getElementById("configDetectionHint");
    const setValue = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.value = String(value);
    };
    const setChecked = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.checked = Boolean(value);
    };
    const syncRangeLabel = (id, displayId, formatter = (value) => String(value)) => {
      const element = document.getElementById(id);
      const display = document.getElementById(displayId);
      if (element && display) display.textContent = formatter(element.value);
    };

    if (Object.prototype.hasOwnProperty.call(overrides, "normalization_method")) setValue("p_norm", overrides.normalization_method);
    if (Object.prototype.hasOwnProperty.call(overrides, "wgcna_power")) setValue("p_power", overrides.wgcna_power);
    if (Object.prototype.hasOwnProperty.call(overrides, "min_module_size")) setValue("p_minmod", overrides.min_module_size);
    if (Object.prototype.hasOwnProperty.call(overrides, "deep_split")) setValue("p_deepsplit", overrides.deep_split);
    if (Object.prototype.hasOwnProperty.call(overrides, "merge_cut_height")) setValue("p_mergeheight", overrides.merge_cut_height);
    if (Object.prototype.hasOwnProperty.call(overrides, "log_transform")) setChecked("p_log2", overrides.log_transform);
    if (Object.prototype.hasOwnProperty.call(overrides, "use_adjusted_pvalue")) setChecked("p_adjp", overrides.use_adjusted_pvalue);

    syncRangeLabel("p_power", "pw-v");
    syncRangeLabel("p_deepsplit", "ds-v");
    syncRangeLabel("p_mergeheight", "mh-v", (value) => Number(value).toFixed(2));

    const message = recommendations.hint_text || `Detected ${meta?.format_detected || "dataset"} with ${Number(meta?.sample_count || 0).toLocaleString()} samples. Review parameters before launching the run.`;
    if (hint) hint.innerHTML = `<i class="fa-solid fa-sliders" style="color:var(--accent)"></i><span>${escapeHtml(message)}</span>`;
    this.updateConfigSummary();
  },

  // Compact, always-visible readout of the key active settings so advanced
  // controls can stay tucked inside their accordions.
  updateConfigSummary() {
    const host = document.getElementById("configSummaryChips");
    if (!host) return;
    const val = (id, fallback) => {
      const el = document.getElementById(id);
      if (!el) return fallback;
      if (el.type === "checkbox") return el.checked;
      return el.value;
    };
    const meta = STATE.currentFileMeta || {};
    const chips = [
      meta.format_family ? `${meta.format_family}${meta.assay_level ? " · " + meta.assay_level : ""}` : null,
      `Norm: ${val("p_norm", "median")}`,
      `Test: ${val("p_test", "t-test")}`,
      val("p_adjp", true) ? "FDR: BH-adjusted" : "FDR: raw p",
      `WGCNA power: ${val("p_power", "8")}`,
      val("p_log2", true) ? "log₂: auto" : "log₂: off",
    ].filter(Boolean);
    host.innerHTML = chips
      .map(
        (c) =>
          `<span style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:16px;padding:0.28rem 0.7rem;font-size:0.74rem;font-weight:600;color:var(--text)">${escapeHtml(String(c))}</span>`
      )
      .join("");
  },

  async uploadFile(file, fileKind = "primary") {
    const progress = document.getElementById("uploadProgress");
    const bar = document.getElementById("uploadBar");
    const status = document.getElementById("uploadStatus");
    progress.classList.add("show");
    bar.style.width = "18%";
    status.textContent = `Uploading ${file.name}...`;

    const formData = new FormData();
    formData.append("workspace_id", STATE.currentWorkspaceId);
    if (STATE.currentProjectId) formData.append("project_id", STATE.currentProjectId);
    formData.append("file_kind", fileKind);
    formData.append("file", file);

    try {
      bar.style.width = "60%";
      const data = await this.apiJson("/api/uploads", { method: "POST", body: formData });
      bar.style.width = "100%";
      status.textContent = "Upload complete";

      if (fileKind === "primary") {
        STATE.currentFileId = data.dataset_id;
        STATE.currentFileMeta = data;
        document.getElementById("fileName").textContent = data.original_name;
        document.getElementById("fileStats").innerHTML =
          `<strong style="color:var(--accent)">${escapeHtml(data.format_detected)}</strong> &nbsp;·&nbsp; ` +
          `<strong style="color:var(--accent)">${Number(data.peptide_count || 0).toLocaleString()}</strong> features &nbsp;·&nbsp; ` +
          `${Number(data.sample_count || 0).toLocaleString()} samples &nbsp;·&nbsp; ` +
          `${(Number(data.size_bytes || 0) / (1024 * 1024)).toFixed(1)} MB &nbsp;·&nbsp; ` +
          `<span style="color:var(--success)">Hash captured</span>`;
        document.getElementById("fileConfirm").classList.add("show");
        document.getElementById("configBtn").disabled = false;
        document.getElementById("analysisName").value = data.original_name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]/g, "-");
        this.applyDetectedDefaults(data);
        STATE.pendingColumnMap = null;
        await this.showFormatPicker(data);
        const btnQc = document.getElementById("btnPreviewQc");
        if (btnQc) btnQc.style.display = "";
      } else {
        STATE.currentTraitsFileId = data.dataset_id;
        document.getElementById("traitsFileName").textContent = data.original_name;
        document.getElementById("traitsFileStats").innerHTML =
          `<strong style="color:var(--accent)">${escapeHtml(data.format_detected)}</strong> &nbsp;·&nbsp; ` +
          `${(Number(data.size_bytes || 0) / (1024 * 1024)).toFixed(1)} MB &nbsp;·&nbsp; ` +
          `<span style="color:var(--success)">Attached to next run</span>`;
        document.getElementById("traitsConfirm").classList.add("show");
        const btnTraitsQc = document.getElementById("btnPreviewTraitsQc");
        if (btnTraitsQc) btnTraitsQc.style.display = "";
        if (STATE.currentFileId) {
          const el = document.getElementById("traitAlignmentPreview");
          if (el) {
            el.style.display = "";
            el.innerHTML = '<span class="trait-align-summary"><i class="fa-solid fa-spinner fa-spin"></i> Checking trait alignment...</span>';
            try {
              const preview = await this.apiJson(
                `/api/datasets/trait-alignment-preview?dataset_id=${encodeURIComponent(STATE.currentFileId)}&traits_id=${encodeURIComponent(data.dataset_id)}`
              );
              if (preview.matched === preview.total && preview.total > 0) {
                el.innerHTML = `<span class="trait-align-summary" style="color:var(--success)">All ${preview.total} samples matched</span>`;
              } else if (preview.matched === 0) {
                el.innerHTML = `<span class="trait-align-summary" style="color:var(--warning)">No samples matched. Check that your traits CSV uses the same sample IDs as the dataset.</span>`;
              } else {
                const unmatchedCount = preview.unmatched.length;
                const shown = preview.unmatched.slice(0, 5).map(s => `<span class="tag-chip">${escapeHtml(s)}</span>`).join(" ");
                const more = unmatchedCount > 5 ? ` <span class="trait-align-detail">and ${unmatchedCount - 5} more</span>` : "";
                el.innerHTML = `<span class="trait-align-summary"><span style="color:var(--success)">${preview.matched}</span>/<span>${preview.total}</span> samples matched &mdash; <span style="color:var(--warning)">${unmatchedCount} unmatched</span></span><div class="trait-align-detail" style="margin-top:0.5rem">${shown}${more}</div>`;
              }
            } catch (error) {
              el.innerHTML = '<span class="trait-align-detail">Could not check trait alignment.</span>';
            }
          }
        }
      }

      toast(`${data.original_name} uploaded`, "info");
      setTimeout(() => {
        progress.classList.remove("show");
        bar.style.width = "0%";
      }, 1600);
    } catch (error) {
      progress.classList.remove("show");
      bar.style.width = "0%";
      status.textContent = "";
      toast(`Upload failed: ${error.message}`, "error");
    }
  },

  buildParams() {
    const goCategories = [];
    if (document.getElementById("go_bp")?.checked) goCategories.push("BP");
    if (document.getElementById("go_mf")?.checked) goCategories.push("MF");
    if (document.getElementById("go_cc")?.checked) goCategories.push("CC");
    return {
      normalization_method: document.getElementById("p_norm")?.value || "median",
      normalization_strategy: document.getElementById("p_norm_strategy")?.value || "column",
      normalization_center: document.getElementById("p_norm_center")?.value || "median",
      tampor_mode: document.getElementById("p_tampor_mode")?.value || "one_way",
      tampor_iterations: parseInt(document.getElementById("p_tampor_iterations")?.value || "1", 10),
      imputation_method: "none",
      missing_value_threshold: parseFloat(document.getElementById("p_mvt")?.value || "0.5"),
      log_transform: document.getElementById("p_log2")?.checked ?? true,
      min_samples_present: parseInt(document.getElementById("p_minsamples")?.value || "3", 10),
      outlier_z_threshold: parseFloat(document.getElementById("p_outlier_z")?.value || "3.0"),
      outlier_mode: document.getElementById("p_outlier_mode")?.value || "low_connectivity",
      variance_correction_enabled: document.getElementById("p_varcorr_enabled")?.checked ?? false,
      variance_correction_method: document.getElementById("p_varcorr_method")?.value || "linear_regression",
      statistical_test: document.getElementById("p_test")?.value || "t-test",
      pvalue_threshold: parseFloat(document.getElementById("p_pval")?.value || "0.05"),
      fold_change_threshold: parseFloat(document.getElementById("p_fc")?.value || "1.5"),
      use_adjusted_pvalue: document.getElementById("p_adjp")?.checked ?? true,
      multiple_testing_method: document.getElementById("p_multitest")?.value || "fdr_bh",
      wgcna_power: parseInt(document.getElementById("p_power")?.value || "8", 10),
      wgcna_power_mode: document.getElementById("p_power_mode")?.value || "fixed",
      wgcna_auto_power_cutoff: parseFloat(document.getElementById("p_power_cutoff")?.value || "0.8"),
      min_module_size: parseInt(document.getElementById("p_minmod")?.value || "20", 10),
      deep_split: parseInt(document.getElementById("p_deepsplit")?.value || "3", 10),
      merge_cut_height: parseFloat(document.getElementById("p_mergeheight")?.value || "0.3"),
      network_type: document.getElementById("p_nettype")?.value || "signed",
      correlation_type: document.getElementById("p_cortype")?.value || "bicor",
      tom_type: document.getElementById("p_tom_type")?.value || "signed",
      pam_stage: document.getElementById("p_pam_stage")?.checked ?? true,
      go_categories: goCategories,
      fdr_threshold: parseFloat(document.getElementById("p_fdr")?.value || "0.05"),
      min_hits_per_ontology: parseInt(document.getElementById("p_minhits")?.value || "3", 10),
      go_min_hits: parseInt(document.getElementById("p_minhits")?.value || "3", 10),
      remove_redundant_go: document.getElementById("p_go_redundancy")?.value || "kappa",
      gmt_background_behavior: document.getElementById("p_go_background")?.value || "measured_features",
      adjust_fet_lookup: document.getElementById("p_adj_fet")?.checked ?? false,
      celltype_reference: document.getElementById("p_celltype_reference")?.value || "human_sharma_zhang_union",
      celltype_duplicate_handling: document.getElementById("p_celltype_duplicates")?.value || "allow",
      celltype_species_mode: document.getElementById("p_celltype_reference")?.value === "mouse_reference" ? "mouse" : "human",
    };
  },

  async runPipeline() {
    if (!STATE.currentFileId) {
      toast("Upload a dataset first", "error");
      this.go("upload");
      return;
    }

    const payload = {
      workspace_id: STATE.currentWorkspaceId,
      project_id: STATE.currentProjectId,
      name: document.getElementById("analysisName")?.value || "New-Analysis",
      dataset_id: STATE.currentFileId,
      traits_dataset_id: STATE.currentTraitsFileId,
      cohort1: document.getElementById("cohort1")?.value || "Control",
      cohort2: document.getElementById("cohort2")?.value || "Disease",
      params: this.buildParams(),
    };

    try {
      const data = await this.apiJson("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      STATE.currentRunId = data.run_id;
      STATE.chartsLoaded = {};
      document.getElementById("analysisSubtitle").textContent = `${payload.name} · ${STATE.currentRunId}`;

      await this.renderRuns();

      if (data.duplicate) {
        toast("Matching run already exists. Opening it now.", "info");
      } else {
        toast(`Run ${data.run_id} submitted`, "info");
      }

      const status = String(data.status || "").toLowerCase();
      if (status === "complete" || status === "failed") {
        this.resetResultsTabs();
        this.go("results");
        return;
      }

      this.go("analysis");
      this.startLogStream(data.run_id);
    } catch (error) {
      toast(`Failed to start run: ${error.message}`, "error");
    }
  },

  resetAnalysisUI() {
    const logEl = document.getElementById("logOutput");
    const stageCards = document.getElementById("stageCards");
    const stepList = document.getElementById("analysisStepList");
    const bar = document.getElementById("progressBar");
    const pct = document.getElementById("pct");
    logEl.innerHTML = "";
    stageCards.innerHTML = "";
    if (stepList) stepList.innerHTML = "";
    bar.style.width = "0%";
    bar.classList.remove("failed");
    pct.textContent = "0%";
    const sub = document.getElementById("analysisSubtitle");
    if (sub) {
      sub.textContent = "Starting analysis...";
      sub.classList.remove("failed");
    }
    STATE.stageSnapshot = [];
    STATE.runFailureShown = false;
  },

  stageDisplayName(stageKey) {
    const labels = {
      etl: "ETL",
      processing_sample_alignment: "Processing / Alignment",
      outlier_removal: "Outlier Removal",
      normalization: "Normalization",
      variance_batch_correction: "Variance Correction",
      differential_expression: "Differential Expression",
      wgcna_network: "WGCNA",
      goparallel: "GOparallel",
      celltypefet: "CellTypeFET",
      deliverable_packaging: "Deliverable Packaging",
    };
    return labels[stageKey] || stageKey;
  },

  renderAnalysisStages(stages = []) {
    const stepList = document.getElementById("analysisStepList");
    const bar = document.getElementById("progressBar");
    const pct = document.getElementById("pct");
    if (!stepList) return;

    const ordered = stages.slice();
    stepList.innerHTML = ordered
      .map((stage) => {
        const status = String(stage.status || "pending").toLowerCase();
        return `
          <div class="analysis-step ${status}">
            <div class="analysis-step-title">${escapeHtml(this.stageDisplayName(stage.stage_key))}</div>
            <div class="analysis-step-status">${escapeHtml(humanizeStatus(status))}${stage.progress ? ` · ${stage.progress}%` : ""}</div>
            <div class="analysis-step-msg">${escapeHtml(stage.message || "Waiting for this step to start")}</div>
          </div>
        `;
      })
      .join("");

    const doneCount = ordered.filter((stage) => ["complete", "skipped"].includes(String(stage.status || "").toLowerCase())).length;
    const running = ordered.some((stage) => String(stage.status || "").toLowerCase() === "running");
    const total = ordered.length || 1;
    const percent = ordered.length ? Math.round(((doneCount + (running ? 0.5 : 0)) / total) * 100) : 0;
    bar.style.width = `${percent}%`;
    pct.textContent = `${percent}%`;

    this.renderPipelineTrack(ordered);
    this.renderEta(ordered, doneCount, total);
  },

  // Collapse the fine-grained stage list into the three coarse phases shown on
  // the landing page, so users get an at-a-glance sense of where the run is.
  COARSE_PHASES: [
    { label: "Normalization & Network", icon: "diagram-project", keys: ["etl", "processing_sample_alignment", "outlier_removal", "normalization", "variance_batch_correction", "differential_expression", "wgcna_network"] },
    { label: "GO & Pathway", icon: "dna", keys: ["goparallel"] },
    { label: "Cell Type", icon: "microscope", keys: ["celltypefet", "deliverable_packaging"] },
  ],

  renderPipelineTrack(stages = []) {
    const track = document.getElementById("pipelineTrack");
    if (!track) return;
    const statusOf = (key) => String((stages.find((s) => s.stage_key === key) || {}).status || "pending").toLowerCase();
    const nodes = this.COARSE_PHASES.map((phase) => {
      const present = phase.keys.filter((k) => stages.some((s) => s.stage_key === k));
      const relevant = present.length ? present : phase.keys;
      const statuses = relevant.map(statusOf);
      let cls = "";
      if (statuses.length && statuses.every((s) => ["complete", "skipped"].includes(s))) cls = "done";
      else if (statuses.some((s) => s === "running")) cls = "running";
      const statusText = cls === "done" ? "Complete" : cls === "running" ? "Running" : "Pending";
      const icon = cls === "done" ? "circle-check" : cls === "running" ? "spinner" : phase.icon;
      return `
        <div class="p-node ${cls}">
          <div class="p-node-icon"><i class="fa-solid fa-${icon}"></i></div>
          <div class="p-node-label">${escapeHtml(phase.label)}</div>
          <div class="p-node-status">${statusText}</div>
        </div>`;
    });
    // Interleave connectors between nodes; connector is "done" when the phase before it is done.
    const parts = [];
    nodes.forEach((node, index) => {
      if (index > 0) {
        const prevDone = /p-node done/.test(nodes[index - 1]);
        const curActive = /p-node (done|running)/.test(nodes[index]);
        parts.push(`<div class="p-conn ${prevDone ? "done" : curActive ? "active" : ""}"></div>`);
      }
      parts.push(node);
    });
    track.innerHTML = parts.join("");
  },

  renderEta(stages, doneCount, total) {
    const el = document.getElementById("etaText");
    if (!el) return;
    const running = stages.some((s) => String(s.status || "").toLowerCase() === "running");
    const remaining = total - doneCount;
    if (!running || doneCount <= 0 || remaining <= 0 || !STATE.analysisStartMs) {
      el.textContent = "";
      return;
    }
    const elapsedSec = (Date.now() - STATE.analysisStartMs) / 1000;
    const perStage = elapsedSec / doneCount;
    const etaSec = Math.max(0, Math.round(perStage * remaining));
    const mins = Math.floor(etaSec / 60);
    const secs = etaSec % 60;
    el.textContent = mins > 0 ? `~${mins}m ${secs}s left` : `~${secs}s left`;
  },

  addAnalysisCard(message, icon = "circle-check", color = "#2e7d5a") {
    const stageCards = document.getElementById("stageCards");
    const card = document.createElement("div");
    card.style.cssText =
      "background:#f0faf5;border:1px solid #b8dece;border-radius:8px;padding:0.85rem 1.25rem;margin-top:0.65rem;display:flex;align-items:center;gap:0.75rem;font-size:0.82rem;opacity:0;transition:opacity 0.4s;";
    card.innerHTML = `<i class="fa-solid fa-${escapeHtml(icon)}" style="color:${escapeHtml(color)}"></i><div>${escapeHtml(message)}</div>`;
    stageCards.appendChild(card);
    setTimeout(() => {
      card.style.opacity = "1";
    }, 40);
  },

  addFailureCard(message) {
    const stageCards = document.getElementById("stageCards");
    if (!stageCards) return;
    const card = document.createElement("div");
    card.className = "run-failure-banner";
    card.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i><div><strong>Run failed.</strong> ${escapeHtml(message)}</div>`;
    stageCards.appendChild(card);
  },

  async markRunFailed(runId, fallbackMessage) {
    // The final SSE poll emits several log lines plus a terminal "done" event,
    // all carrying status:"failed" — guard so we render the banner only once.
    if (STATE.runFailureShown) return;
    STATE.runFailureShown = true;
    this.stopTimer();
    if (STATE.logSSE) {
      STATE.logSSE.close();
      STATE.logSSE = null;
    }
    // A fast failure can race the SSE stream, leaving a stale stage snapshot
    // ("ETL running 10%"). Pull the authoritative final state so the page
    // reflects reality and we can surface the real error_message.
    const run = await this.fetchRun(runId).catch(() => null);
    if (run && Array.isArray(run.stages) && run.stages.length) {
      this.renderAnalysisStages(run.stages);
    }
    const bar = document.getElementById("progressBar");
    if (bar) bar.classList.add("failed");
    const sub = document.getElementById("analysisSubtitle");
    if (sub) {
      sub.textContent = "Run failed";
      sub.classList.add("failed");
    }
    const message =
      (run && run.error_message) ||
      fallbackMessage ||
      "The run failed. Check the live log for details.";
    this.addFailureCard(message);
    toast("Run failed. Check the live log for details.", "error");
  },

  appendLogLine(line) {
    if (!line) return;
    const logEl = document.getElementById("logOutput");
    const row = document.createElement("div");
    const lowered = line.toLowerCase();
    if (lowered.includes("error") || lowered.includes("failed")) row.className = "log-error";
    else if (lowered.includes("complete") || lowered.includes("done")) row.className = "log-success";
    else if (lowered.includes("warning")) row.className = "log-warn";
    else row.className = "log-info";
    row.textContent = line;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  },

  startTimer() {
    if (STATE.timerInterval) clearInterval(STATE.timerInterval);
    const started = Date.now();
    STATE.analysisStartMs = started;
    STATE.timerInterval = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
      const remainder = String(seconds % 60).padStart(2, "0");
      document.getElementById("logTimer").textContent = `${minutes}:${remainder}`;
    }, 1000);
  },

  stopTimer() {
    if (STATE.timerInterval) {
      clearInterval(STATE.timerInterval);
      STATE.timerInterval = null;
    }
  },

  startLogStream(runId) {
    this.resetAnalysisUI();
    this.startTimer();
    if (STATE.logSSE) STATE.logSSE.close();

    const bar = document.getElementById("progressBar");
    const pct = document.getElementById("pct");
    bar.style.width = "6%";
    pct.textContent = "6%";

    const sse = new EventSource(withSSEToken(`/api/runs/${runId}/logs`));
    STATE.logSSE = sse;

    sse.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        const line = payload.line || "";
        const status = String(payload.status || "").toLowerCase();
        if (payload.type === "stage" && Array.isArray(payload.stages)) {
          STATE.stageSnapshot = payload.stages;
          this.renderAnalysisStages(payload.stages);
          return;
        }
        if (payload.type === "outlier_review") {
          showOutlierReviewModal(payload.candidates || [], runId);
          return;
        }
        if (line) this.appendLogLine(line);
        if (status === "complete") {
          bar.style.width = "100%";
          pct.textContent = "100%";
          this.addAnalysisCard("<strong>Run complete</strong> - opening results.", "sparkles", "#7c5c3e");
          sse.close();
          this.stopTimer();
          await this.renderRuns();
          this.resetResultsTabs();
          setTimeout(() => this.go("results"), 900);
        } else if (status === "failed") {
          await this.markRunFailed(runId);
        }
      } catch (error) {
        this.appendLogLine(event.data);
      }
    };

    sse.onerror = async () => {
      const run = await this.fetchRun(runId).catch(() => null);
      if (!run) return;
      const status = String(run.status || "").toLowerCase();
      if (status === "complete") {
        sse.close();
        this.stopTimer();
        await this.renderRuns();
        this.resetResultsTabs();
        this.go("results");
      } else if (status === "failed") {
        await this.markRunFailed(runId);
      }
    };
  },

  tab(name, event) {
    document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    const pane = document.getElementById(`tab-${name}`);
    if (!pane) return;
    pane.classList.add("active");
    const activeButton = event?.currentTarget || event?.target?.closest(".tab-btn");
    if (activeButton) activeButton.classList.add("active");

    if (!STATE.currentRunId || STATE.chartsLoaded[name]) return;
    STATE.chartsLoaded[name] = true;
    if (name === "volcano") this.renderVolcano();
    if (name === "qc") this.renderQC();
    if (name === "network") this.renderNetwork();
    if (name === "go") this.renderGO();
    if (name === "cells") this.renderCellTypes();
    if (name === "tables") this.renderTables();
    if (name === "files") this.renderFileTree();
    if (name === "parameters") this.renderParameters();
    if (name === "ai") this.updateAIInsightsLauncher();
  },

  updateAIInsightsLauncher() {
    const button = document.getElementById("openAIInsightsBtn");
    if (!button) return;
    button.disabled = !STATE.currentRunId;
    button.title = STATE.currentRunId ? `Open AI Insights for ${STATE.currentRunId}` : "Select a completed run first";
  },

  async openAIInsights() {
    if (!STATE.currentRunId) {
      toast("Select a completed run first", "error");
      return;
    }
    const base = window.SIGNALFOLD_AI_INSIGHTS_URL || "http://127.0.0.1:4317/";
    const url = new URL(base, window.location.href);
    url.searchParams.set("run", STATE.currentRunId);
    // The sidecar is a separate process; don't open a dead tab if it's down.
    // The probe stays well inside the click's activation window (<5s) so the
    // window.open below is not treated as a blocked popup.
    if (!(await aiInsightsReachable(base))) {
      toast("AI Insights server isn't running on :4317 — start it with ./run.sh ai", "error");
      return;
    }
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  },

  renderParameters() {
    const pane = document.getElementById("parametersPane");
    if (!pane) return;
    if (!STATE.currentRunMeta) {
      pane.innerHTML = '<div class="loading-state">No run loaded</div>';
      return;
    }
    const params = STATE.currentRunMeta.params || {};
    const CURATED = [
      ["cohort1",               "Cohort 1 (Reference)"],
      ["cohort2",               "Cohort 2 (Case)"],
      ["normalization_method",  "Normalization Method"],
      ["statistical_test",      "Statistical Test"],
      ["fold_change_threshold", "Fold Change Threshold"],
      ["pvalue_threshold",      "FDR Threshold"],
      ["use_adjusted_pvalue",   "Use Adjusted P-value"],
      ["wgcna_power",           "WGCNA Soft Threshold (Power)"],
      ["merge_cut_height",      "Merge Cut Height"],
      ["min_module_size",       "WGCNA Min Module Size"],
      ["correlation_type",      "Correlation Type"],
      ["network_type",          "Network Type"],
      ["gmt_file",              "GO GMT Database"],
    ];
    const rows = CURATED.map(([key, label]) => {
      let val = params[key];
      if (key === "gmt_file" && val) {
        const parts = String(val).split(/[/\\]/);
        val = parts[parts.length - 1];
      }
      if (key === "use_adjusted_pvalue") {
        val = (val === true || val === "true") ? "Yes" : "No";
      }
      return `<tr><td style="padding:0.5rem 1.5rem 0.5rem 0;font-weight:500;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:0.5rem 0">${escapeHtml(String(val ?? "\u2014"))}</td></tr>`;
    }).join("");
    const version = STATE.currentRunMeta.app_version
      ? `<p style="color:var(--text-muted);font-size:0.82rem;margin-top:1.5rem"><i class="fa-solid fa-code-branch"></i> Pipeline version: ${escapeHtml(STATE.currentRunMeta.app_version)}</p>`
      : "";
    pane.innerHTML = `<table style="border-collapse:collapse;width:100%;max-width:600px"><tbody>${rows}</tbody></table>${version}`;
  },

  downloadFile(runId, relPath) {
    const encodedPath = relPath.includes("%") ? relPath : encodeURI(relPath);
    downloadViaAuth(`/api/runs/${encodeURIComponent(runId)}/files/${encodedPath}`);
  },

  // APP.chat is replaced by the chat module (see Object.assign block below).
  // The previous APP.chat(text) single-shot method was retired with P0/P1.

  downloadResults(type) {
    if (!STATE.currentRunId) {
      toast("Open a run before exporting", "info");
      return;
    }

    const bundleMap = {
      bundle_zip: `/api/runs/${encodeURIComponent(STATE.currentRunId)}/export/zip`,
      bundle_xlsx: `/api/runs/${encodeURIComponent(STATE.currentRunId)}/export/xlsx`,
      bundle_summary: `/api/runs/${encodeURIComponent(STATE.currentRunId)}/export/summary.md`,
    };
    const fileMap = {
      volcano: "stage1/volcano_results.tsv",
      modules: "stage1/module_assignments.csv",
      go: "stage2/go_enrichment_all.csv",
      celltype: "stage3/celltype_FDR_matrix.csv",
    };

    if (bundleMap[type]) {
      downloadViaAuth(bundleMap[type]);
      return;
    }

    const relPath = fileMap[type];
    if (!relPath) {
      toast("Unknown export type", "error");
      return;
    }
    this.downloadFile(STATE.currentRunId, relPath);
  },
};

Object.assign(
  APP,
  createUploadPreviewModule({ STATE, toast, escapeHtml }),
  createRunHistoryModule({ STATE, toast, escapeHtml, humanizeStatus, statusBadgeClass, statusIcon, safeDate }),
  createResultsModule({
    STATE,
    toast,
    escapeHtml,
    humanBytes,
    artifactKindLabel,
    artifactIcon,
    hasNativeArtifacts,
    ARTIFACT_DESCRIPTIONS,
    statusBadgeClass,
  })
);

window.APP = APP;
window.downloadViaAuth = downloadViaAuth;
window.openViaAuth = openViaAuth;
window.addEventListener("load", () => {
  APP.init();
  const configPage = document.getElementById("page-config");
  if (configPage) {
    configPage.addEventListener("input", () => APP.updateConfigSummary());
    configPage.addEventListener("change", () => APP.updateConfigSummary());
  }
});
