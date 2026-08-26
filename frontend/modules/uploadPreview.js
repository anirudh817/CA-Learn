export function createUploadPreviewModule({ STATE, toast, escapeHtml }) {
  return {
    renderPreviewCard(containerId, title, payload) {
      const container = document.getElementById(containerId);
      if (!container || !payload) return;
      const rows = payload.preview_rows || [];
      const columns = payload.columns || [];
      const sniff = payload.sniff || {};
      const confidencePct = Math.round(Number(sniff.confidence || 0) * 100);
      const evidence = (sniff.evidence || []).slice(0, 3);
      const warnings = sniff.warnings || [];
      const headerHtml = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
      const rowHtml = rows.length
        ? rows
            .map(
              (row) =>
                `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`
            )
            .join("")
        : `<tr><td colspan="${Math.max(1, columns.length)}" style="padding:1.2rem;text-align:center;color:var(--text-muted)">No preview rows available</td></tr>`;

      container.classList.add("show");
      container.innerHTML = `
        <div class="upload-preview-head">
          <div>
            <div style="font-weight:700;font-size:0.9rem">${escapeHtml(title)}</div>
            <div class="upload-preview-meta">${escapeHtml(payload.filename || "")}</div>
          </div>
          ${
            sniff.format_detected
              ? `<div class="detected-badge" title="Input format auto-detected by SignalFold"><i class="fa-solid fa-wand-magic-sparkles"></i> Detected: <strong>${escapeHtml(sniff.format_detected)}</strong></div>`
              : ""
          }
        </div>
        <div class="upload-preview-body">
          <div class="upload-preview-grid">
            <div class="preview-chip"><strong>${Number(payload.rows_total || 0).toLocaleString()}</strong> rows detected</div>
            <div class="preview-chip"><strong>${Number(payload.columns_total || 0).toLocaleString()}</strong> columns detected</div>
            <div class="preview-chip"><strong>${Number(payload.sniff?.sample_count || 0).toLocaleString()}</strong> samples</div>
            <div class="preview-chip"><strong>${Number(payload.sniff?.peptide_count || 0).toLocaleString()}</strong> features</div>
          </div>
          <div class="upload-detection ${sniff.run_ready === false ? "warn" : ""}">
            <div>
              <strong>${escapeHtml(sniff.confidence_label || "unknown")} confidence</strong>
              <span>${Number.isFinite(confidencePct) ? confidencePct : 0}% · ${escapeHtml(payload.pipeline_profile || "profile pending")}</span>
            </div>
            <div class="upload-detection-detail">
              ${evidence.length ? evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("") : "<span>No detector evidence available</span>"}
            </div>
            ${warnings.length ? `<div class="upload-detection-warning">${warnings.map((item) => escapeHtml(item)).join(" ")}</div>` : ""}
          </div>
          <div class="preview-table-wrap">
            <table class="data-table">
              <thead><tr>${headerHtml}</tr></thead>
              <tbody>${rowHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    },

    async prepareUpload(file, fileKind = "primary") {
      const preview = await this.previewUpload(file, fileKind);
      if (preview) {
        this.renderPreviewCard(
          fileKind === "traits" ? "traitsPreview" : "rawPreview",
          fileKind === "traits" ? "Traits Preview" : "Raw Data Preview",
          preview
        );
      }
      await this.uploadFile(file, fileKind);
    },

    async previewUpload(file, fileKind = "primary") {
      if (!file || !STATE.currentWorkspaceId) return null;
      const formData = new FormData();
      formData.append("workspace_id", STATE.currentWorkspaceId);
      if (STATE.currentProjectId) formData.append("project_id", STATE.currentProjectId);
      formData.append("file", file);
      const endpoint = fileKind === "traits" ? "/api/uploads/preview/traits" : "/api/uploads/preview/raw";
      try {
        return await this.apiJson(endpoint, { method: "POST", body: formData });
      } catch (error) {
        toast(`Preview failed: ${error.message}`, "error");
        return null;
      }
    },
  };
}
