// SignalFold AI chat module (P1: streaming UI shell + conversation CRUD + settings drawer).
// Mounted into APP.chat by app.js via createChatModule(...).
//
// Wire dependencies: { STATE, toast, escapeHtml, renderMarkdown, apiJson, api }
//
// Public surface used by the HTML:
//   APP.chat.init()
//   APP.chat.refresh()                — refresh conv list for current run
//   APP.chat.openSettings() / closeSettings()
//   APP.chat.saveSettings()
//   APP.chat.askExtLookupsConsent() / confirmExtLookupsConsent() / cancelExtLookupsConsent()
//
// Conv list / thread bindings are wired in init() (no inline onclick on dynamic items).

import { createChatStreams } from "./chatStreams.js";

export function createChatModule({ STATE, toast, escapeHtml, renderMarkdown, apiJson, api }) {
  // Per-conversation stream registry — each chat streams independently. The
  // visible thread is a projection of whichever conversation is on screen; a
  // background conversation keeps accumulating into its own state and never
  // touches another conversation's DOM.
  const streams = createChatStreams();
  // --- module-private state ---------------------------------------------
  if (!STATE.chat) {
    STATE.chat = {
      conversations: [],
      currentConvId: null,
      currentMessages: [],
      // Streaming state now lives in the per-conversation `streams` registry
      // (see createChatStreams), not in global STATE fields.
      sessionCostUsd: 0,
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
      settings: null,
      providers: null,
      pendingExtLookupsToggle: null,
      activeRunId: null,
      pendingAttachments: [], // {id, filename, mime_type, size_bytes, kind, thumbDataUrl?}
      // P9 — context panel + @-mention
      contextPanel: null,     // {run_artifacts:[...], local_files:[...], workspace_runs:[...]}
      ctxTab: "run",          // "run" | "local" | "runs"
      ctxCollapsed: false,    // panel open by default
      ctxFlatItems: [],       // flat list backing the rendered rows
      pendingRefs: [],        // refs pinned for the NEXT message
      persistentRefs: [],     // refs pinned to every message in this conversation
      mentionCtx: null,       // {atStart, query} while an @-mention is active
      mentionOpts: [],
      mentionIdx: 0,
    };
  }

  // Attachment caps & whitelist (mirrors backend config).
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGES_PER_TURN = 5;
  const ALLOWED_EXTS = new Set([
    ".csv", ".tsv", ".txt", ".md", ".json", ".pdf", ".xlsx",
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ]);
  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

  function extOf(name) {
    const dot = (name || "").lastIndexOf(".");
    return dot >= 0 ? (name || "").slice(dot).toLowerCase() : "";
  }
  function isImageExt(name) {
    return IMAGE_EXTS.has(extOf(name));
  }
  function humanSize(n) {
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  function readDataUrl(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }

  // --- helpers -----------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function showShell(visible) {
    const shell = $("chatShell");
    if (shell) shell.style.display = visible ? "" : "none";
    const emptyHint = $("chatEmptyHint");
    if (emptyHint) emptyHint.style.display = visible ? "none" : "";
  }

  function _convCostRollup(convId) {
    // Only meaningful for the active conversation (we have full messages
    // for it). For other rows we don't have per-message cost data in the
    // list-items endpoint, so we skip silently.
    if (convId !== STATE.chat.currentConvId) return null;
    const msgs = STATE.chat.currentMessages || [];
    let total = 0;
    let any = false;
    for (const m of msgs) {
      const c = parseFloat(m.cost_usd || 0);
      if (!Number.isNaN(c) && c > 0) {
        total += c;
        any = true;
      }
    }
    return any ? total : null;
  }

  function setConvListItems(items) {
    const list = $("convListItems");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = `<li class="conv-item-empty">No conversations yet. Click <strong>New chat</strong> above.</li>`;
      return;
    }
    items.forEach((conv) => {
      const li = document.createElement("li");
      li.className = "conv-item" + (conv.id === STATE.chat.currentConvId ? " active" : "");
      li.dataset.convId = conv.id;
      const cost = _convCostRollup(conv.id);
      const costPill = cost != null ? `<span class="conv-cost" title="Cost rolled up across answers in this chat">· $${cost.toFixed(4)}</span>` : "";
      li.innerHTML = `
        <div class="conv-item-row">
          <div class="conv-item-body">
            <div class="conv-item-title" data-title="${escapeHtml(conv.title || "Untitled")}">${escapeHtml(conv.title || "Untitled")}</div>
            <div class="conv-item-meta">
              <span>${escapeHtml(conv.provider)}</span>
              <span>·</span>
              <span>${conv.message_count} msg</span>
              ${costPill}
            </div>
          </div>
          <div class="conv-item-actions">
            <button class="conv-icon-btn" data-action="rename" title="Rename"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="conv-icon-btn conv-icon-btn-danger" data-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      `;
      li.addEventListener("click", (e) => {
        // Action-button clicks shouldn't also open the conversation.
        if (e.target.closest("[data-action]")) return;
        openConversation(conv.id);
      });
      const renameBtn = li.querySelector("[data-action='rename']");
      const delBtn = li.querySelector("[data-action='delete']");
      renameBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        beginRenameInline(li, conv);
      });
      delBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteConversation(conv.id, conv.title);
      });
      list.appendChild(li);
    });
  }

  async function renameConversation(convId, newTitle) {
    const title = (newTitle || "").trim();
    if (!title) return false;
    try {
      const updated = await apiJson(`/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      // Update local cache + UI.
      const idx = STATE.chat.conversations.findIndex((c) => c.id === convId);
      if (idx >= 0) STATE.chat.conversations[idx].title = updated.title;
      setConvListItems(STATE.chat.conversations);
      if (STATE.chat.currentConvId === convId) {
        // Refresh thread header.
        const conv = STATE.chat.conversations.find((c) => c.id === convId);
        if (conv) setThreadHeader(conv);
      }
      return true;
    } catch (err) {
      toast(`Rename failed: ${err.message}`, "error");
      return false;
    }
  }

  function beginRenameInline(li, conv) {
    const titleEl = li.querySelector(".conv-item-title");
    if (!titleEl) return;
    const original = conv.title || "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "conv-item-rename-input";
    input.value = original;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      if (commit && input.value.trim() && input.value.trim() !== original) {
        await renameConversation(conv.id, input.value);
      } else {
        // Restore without server call.
        const restored = document.createElement("div");
        restored.className = "conv-item-title";
        restored.textContent = original;
        input.replaceWith(restored);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function deleteConversation(convId, title) {
    if (!confirm(`Delete chat "${title || "Untitled"}"? This cannot be undone.`)) return;
    try {
      await apiJson(`/api/conversations/${convId}`, { method: "DELETE" });
      if (STATE.chat.currentConvId === convId) {
        STATE.chat.currentConvId = null;
        STATE.chat.currentMessages = [];
        setThreadHeader(null);
        renderThread();
      }
      await refreshList(STATE.chat.activeRunId);
      toast("Chat deleted", "info");
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "error");
    }
  }

  function setThreadHeader(conv) {
    const title = $("convThreadTitle");
    if (title) {
      title.textContent = conv ? conv.title : "Select or start a chat";
      title.title = conv ? "Double-click to rename" : "";
      // Wire double-click once per render (the title element gets recreated
      // on rename → restore, so this is idempotent enough).
      title.ondblclick = conv ? renameCurrentInline : null;
    }
    const meta = $("convThreadMetaText");
    if (meta) {
      meta.textContent = conv ? `${conv.provider} · ${conv.model || "default"}` : "";
    }
    // Conversation-scoped controls are hidden (not just disabled) until a
    // conversation is open — a greyed-out row with no chat selected reads as
    // broken rather than contextual. `display` overrides the label's flex CSS.
    const setShown = (el, shown) => {
      if (el) el.style.display = shown ? "" : "none";
    };
    const toggle = $("convExtLookupsToggle");
    if (toggle) {
      toggle.checked = !!(conv && conv.external_lookups_enabled);
      toggle.disabled = !conv;
      setShown(toggle.closest("label"), !!conv);
    }
    const discovery = $("convDiscoveryMode");
    if (discovery) {
      discovery.value = conv?.discovery_mode || "auto";
      discovery.disabled = !conv;
      setShown(discovery.closest("label"), !!conv);
    }
    const clearBtn = $("convClearBtn");
    const exportBtn = $("convExportBtn");
    if (clearBtn) {
      clearBtn.disabled = !conv;
      setShown(clearBtn, !!conv);
    }
    if (exportBtn) {
      exportBtn.disabled = !conv;
      setShown(exportBtn, !!conv);
    }
    const input = $("convInput");
    const send = $("convSendBtn");
    const attach = $("convAttachBtn");
    if (input) input.disabled = !conv;
    if (send) send.disabled = !conv;
    if (attach) attach.disabled = !conv;
  }

  function citationsHtml(citations) {
    // Provenance is now rendered via renderProvenancePanel; this is kept
    // as a no-op fallback so any pre-P5 message rendering still works.
    return "";
  }

  // Map an external-lookup tool to the public database it represents. The
  // breadcrumb shows the DATABASE name (a citation), never the internal tool
  // name — consistent with the confidentiality rules.
  function extDbName(toolName) {
    if (toolName === "lookup_uniprot") return "UniProt";
    if (toolName === "lookup_reactome") return "Reactome";
    return "External database";
  }

  function provenanceBadge(msg, finalExtras) {
    // Three-tier provenance: Grounded (this run's data), External (a live
    // public-database lookup), Background (model knowledge). A turn can carry
    // more than one — the badges are per-tier, not mutually exclusive.
    const hasCitations = (msg.citations || []).length > 0;
    const toolCalls = msg.tool_calls || [];
    const hasExternal = toolCalls.some((t) => t.external);
    const hasRunTools = toolCalls.some((t) => !t.external);
    const isError = (msg.status === "error") || (msg.error && msg.error.length > 0);
    if (isError) {
      return `<span class="prov-badge prov-badge-error" title="The chat failed to produce a grounded answer."><i class="fa-solid fa-circle-exclamation"></i> Error</span>`;
    }
    const badges = [];
    if (hasCitations || hasRunTools) {
      badges.push(`<span class="prov-badge prov-badge-grounded" title="At least one claim is traceable to your run data."><i class="fa-solid fa-circle-check"></i> Grounded</span>`);
    }
    if (hasExternal) {
      badges.push(`<span class="prov-badge prov-badge-external" title="This answer drew on a live lookup in a public biological database."><i class="fa-solid fa-globe"></i> External</span>`);
    }
    if (!badges.length) {
      badges.push(`<span class="prov-badge prov-badge-bg" title="Answer drawn from model knowledge; no run data was cited."><i class="fa-solid fa-circle-info"></i> Background</span>`);
    }
    return badges.join(" ");
  }

  function renderProvenancePanel(msg) {
    const citations = msg.citations || [];
    const toolCalls = msg.tool_calls || [];
    const attachments = msg.attachments || [];
    if (!citations.length && !toolCalls.length && !attachments.length) {
      return "";
    }

    const fileRows = citations
      .map((c) => {
        const file = escapeHtml(c.file_path || c.file || "");
        const rid = c.run_id ? `<span class="prov-run">run ${escapeHtml(c.run_id)}</span> ` : "";
        const rowIds = (c.row_ids || []).slice(0, 8);
        const rowDetail = rowIds.length
          ? `<span class="prov-rows">${rowIds.map((r) => typeof r === "object" ? escapeHtml(r.symbol || `row ${r.index}`) : `row ${r}`).join(", ")}${(c.row_ids || []).length > 8 ? ", …" : ""}</span>`
          : "";
        return `<li>${rid}<code>${file}</code>${rowDetail ? "<br>" + rowDetail : ""}</li>`;
      })
      .join("");
    const filesBlock = fileRows
      ? `<div class="prov-section"><div class="prov-section-h">Files cited</div><ul class="prov-list">${fileRows}</ul></div>`
      : "";

    // Tools called — run-data tools only; external lookups get their own
    // section below so the user can tell the two provenance tiers apart.
    const runTools = toolCalls.filter((t) => !t.external);
    const toolRows = runTools
      .map((t) => {
        const ok = !(t.result && t.result.is_error);
        const icon = ok ? "fa-circle-check" : "fa-circle-exclamation";
        const tone = ok ? "ok" : "error";
        const rows = t.result?.rows_returned ?? "";
        const ms = t.result?.latency_ms ?? "";
        const args = JSON.stringify(t.args || {});
        const argPreview = args.length > 60 ? args.slice(0, 57) + "…" : args;
        return `<li class="prov-tool prov-tool-${tone}"><i class="fa-solid ${icon}"></i> <code>run data</code> <span class="prov-args">${escapeHtml(argPreview)}</span>${rows !== "" ? ` <span class="prov-meta">${rows} rows</span>` : ""}${ms !== "" ? ` <span class="prov-meta">${ms} ms</span>` : ""}</li>`;
      })
      .join("");
    const toolsBlock = toolRows
      ? `<div class="prov-section"><div class="prov-section-h">Run data pulled</div><ul class="prov-list">${toolRows}</ul></div>`
      : "";

    // External sources — every public-database record / paper an answer
    // rested on, deduped by URL, each independently openable.
    const extRefs = [];
    toolCalls
      .filter((t) => t.external)
      .forEach((t) => {
        (t.result?.references || []).forEach((r) => {
          if (r && r.url && !extRefs.some((x) => x.url === r.url)) extRefs.push(r);
        });
      });
    const extUnavailable = toolCalls.some(
      (t) => t.external && t.result && t.result.is_error
    );
    const extRefRows = extRefs
      .map(
        (r) =>
          `<li class="prov-ext"><i class="fa-solid fa-up-right-from-square"></i> <a href="${escapeHtml(safeHref(r.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.label || r.ref_id || "source")}</a> <span class="prov-meta">${escapeHtml(r.source || "external")}</span></li>`
      )
      .join("");
    const extBlock =
      extRefRows || extUnavailable
        ? `<div class="prov-section"><div class="prov-section-h">External sources</div><ul class="prov-list">${extRefRows}${extUnavailable ? `<li class="prov-ext prov-ext-unavailable"><i class="fa-solid fa-triangle-exclamation"></i> An external lookup was unavailable — the answer fell back to run data and general knowledge.</li>` : ""}</ul></div>`
        : "";

    const attRows = attachments
      .map((a) => `<li><i class="fa-solid ${a.kind === "image" ? "fa-image" : "fa-file-lines"}"></i> <code>${escapeHtml(a.filename)}</code> <span class="prov-meta">${a.size_bytes || 0} bytes</span></li>`)
      .join("");
    const attBlock = attRows
      ? `<div class="prov-section"><div class="prov-section-h">Attachments used</div><ul class="prov-list">${attRows}</ul></div>`
      : "";

    const runId =
      (citations.find((c) => c.run_id)?.run_id) ||
      STATE.currentRunId ||
      STATE.chat.activeRunId ||
      "";
    const catalogUrl = runId
      ? `/api/results/${encodeURIComponent(runId)}/artifacts/file/artifact_index.html${STATE.sessionToken ? `?session_token=${encodeURIComponent(STATE.sessionToken)}` : ""}`
      : "";
    const catalogBlock = runId
      ? `<div class="prov-section"><div class="prov-section-h">Artifact catalog</div><a class="prov-catalog-link" href="${catalogUrl}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-up-right-from-square"></i> Open artifact catalog</a><div class="prov-catalog-note">Full run artifact list with descriptions and open/download links.</div></div>`
      : "";

    const countParts = [`${citations.length} file${citations.length === 1 ? "" : "s"}`];
    if (extRefs.length) countParts.push(`${extRefs.length} external`);
    if (attachments.length) countParts.push(`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`);

    return `
      <details class="prov-panel">
        <summary>What sourced this answer? <span class="prov-counts">${countParts.join(" · ")}</span></summary>
        ${filesBlock}
        ${toolsBlock}
        ${extBlock}
        ${attBlock}
        ${catalogBlock}
      </details>
    `;
  }

  function followupChipsHtml(items) {
    if (!items || !items.length) return "";
    const chips = items
      .map((q) => `<span class="followup-chip" data-question="${escapeHtml(q)}">${escapeHtml(q)}</span>`)
      .join("");
    return `<div class="followup-chips">${chips}</div>`;
  }

  function metaFooter(msg) {
    if (msg.role !== "assistant") return "";
    const parts = [];
    if (msg.provider) parts.push(escapeHtml(msg.provider));
    if (msg.model) parts.push(escapeHtml(msg.model));
    if (msg.input_tokens || msg.output_tokens) {
      parts.push(`${msg.input_tokens || 0}→${msg.output_tokens || 0} tok`);
    }
    if (msg.cost_usd) {
      const c = parseFloat(msg.cost_usd);
      if (!isNaN(c) && c > 0) parts.push(`≈ $${c.toFixed(4)}`);
    }
    if (!parts.length) return "";
    return `<div class="msg-meta-footer">${parts.join(" · ")}</div>`;
  }

  function renderMessage(msg) {
    if (msg.role === "user") {
      const atts = (msg.attachments || [])
        .map(
          (a) =>
            `<span class="attach-chip" style="background:rgba(255,255,255,0.18);border-color:rgba(255,255,255,0.25);color:#fff"><i class="fa-solid ${a.kind === "image" ? "fa-image" : "fa-file-lines"}"></i> ${escapeHtml(a.filename)}</span>`
        )
        .join(" ");
      const attsBlock = atts ? `<div style="margin-top:0.4rem;display:flex;flex-wrap:wrap;gap:0.3rem">${atts}</div>` : "";
      return `<div class="msg-user" data-mid="${escapeHtml(msg.id)}">${escapeHtml(msg.content)}${attsBlock}</div>`;
    }
    if (msg.role === "assistant") {
      const body =
        msg.status === "error"
          ? `<div class="msg-error">${escapeHtml(msg.error || "Provider error")}</div>`
          : renderMarkdown(msg.content || "");
      return `
        <div class="msg-ai" data-mid="${escapeHtml(msg.id)}">
          ${body}
          <div class="msg-action-bar">
            ${provenanceBadge(msg)}
            <span class="msg-action-spacer"></span>
            <button class="msg-action-btn" data-action="regenerate" data-mid="${escapeHtml(msg.id)}" title="Regenerate this answer"><i class="fa-solid fa-arrow-rotate-right"></i></button>
            <button class="msg-action-btn" data-action="pin" data-mid="${escapeHtml(msg.id)}" title="Pin this message"><i class="fa-solid fa-thumbtack"></i></button>
            <button class="msg-action-btn" data-action="copy" data-mid="${escapeHtml(msg.id)}" title="Copy answer"><i class="fa-solid fa-copy"></i></button>
          </div>
          ${renderProvenancePanel(msg)}
          ${metaFooter(msg)}
        </div>
      `;
    }
    return "";
  }

  // Hover-button click handlers — wired ONCE per renderThread to avoid leaks.
  function wireMessageActions() {
    const body = $("convThreadBody");
    if (!body || body.dataset.actionsWired === "1") return;
    body.dataset.actionsWired = "1";
    body.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const mid = btn.dataset.mid;
      const act = btn.dataset.action;
      if (act === "copy") {
        const msg = (STATE.chat.currentMessages || []).find((m) => m.id === mid);
        if (msg && navigator.clipboard) {
          try {
            await navigator.clipboard.writeText(msg.content || "");
            toast("Answer copied", "info");
          } catch (_) {
            toast("Clipboard blocked by browser", "error");
          }
        }
      } else if (act === "regenerate") {
        await regenerateMessage(mid);
      } else if (act === "pin") {
        await pinMessage(mid);
      }
    });
  }

  function renderThread() {
    const body = $("convThreadBody");
    if (!body) return;
    if (!STATE.chat.currentConvId) {
      body.innerHTML = `<div class="msg-empty">Pick a conversation or click <strong>New chat</strong> to begin.</div>`;
      return;
    }
    if (!STATE.chat.currentMessages.length) {
      const starters = [
        "What are the top differentially expressed proteins in this run?",
        "Which pathways or GO terms are most enriched?",
        "Which cell types are most implicated?",
        "Give me a high-level summary of this run.",
      ];
      body.innerHTML = `
        <div class="chat-starter">
          <div class="chat-starter-title">Ask anything about this run</div>
          <div class="chat-starter-sub">Pick a question to start, or type your own below.</div>
          <div class="chat-starter-list">
            ${starters
              .map(
                (q) =>
                  `<button class="chat-starter-chip" type="button" data-starter="${escapeHtml(q)}"><i class="fa-solid fa-arrow-right-long"></i><span>${escapeHtml(q)}</span></button>`
              )
              .join("")}
          </div>
        </div>`;
      body.querySelectorAll(".chat-starter-chip[data-starter]").forEach((el) => {
        el.addEventListener("click", () => sendMessage(el.dataset.starter));
      });
      return;
    }
    body.innerHTML = STATE.chat.currentMessages.map(renderMessage).join("");
    // Wire follow-up chips.
    body.querySelectorAll(".followup-chip[data-question]").forEach((el) => {
      el.addEventListener("click", () => sendMessage(el.dataset.question));
    });
    body.querySelectorAll(".msg-ai").forEach((bubble) => applyTableCollapsing(bubble));
    wireMessageActions();
    updateSessionMeter();
    autoScrollIfPinned(body);
  }

  async function regenerateMessage(messageId) {
    if (!STATE.chat.currentConvId) return;
    if (!confirm("Regenerate this answer? The current answer will be replaced.")) return;
    try {
      await apiJson(
        `/api/conversations/${STATE.chat.currentConvId}/messages/${messageId}/regenerate`,
        { method: "POST" }
      );
      const conv = await apiJson(`/api/conversations/${STATE.chat.currentConvId}`);
      STATE.chat.currentMessages = conv.messages || [];
      renderThread();
      toast("Answer regenerated", "info");
    } catch (err) {
      toast(`Regenerate failed: ${err.message}`, "error");
    }
  }

  async function pinMessage(messageId) {
    if (!STATE.chat.currentConvId) return;
    try {
      await apiJson(
        `/api/conversations/${STATE.chat.currentConvId}/messages/${messageId}/pin`,
        { method: "POST" }
      );
      toast("Message pinned", "info");
    } catch (err) {
      toast(`Pin failed: ${err.message}`, "error");
    }
  }

  async function exportCurrent() {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    try {
      const headers = new Headers();
      if (STATE.sessionToken) headers.set("Authorization", `Bearer ${STATE.sessionToken}`);
      const resp = await fetch(`/api/conversations/${cid}/export`, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const conv = STATE.chat.conversations.find((c) => c.id === cid);
      const name = (conv?.title || "conversation").replace(/[^\w\-]+/g, "_");
      a.href = url;
      a.download = `${name}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Conversation exported", "info");
    } catch (err) {
      toast(`Export failed: ${err.message}`, "error");
    }
  }

  function updateSessionMeter() {
    const el = $("sessionMeter");
    if (!el) return;
    const tot = (STATE.chat.sessionInputTokens || 0) + (STATE.chat.sessionOutputTokens || 0);
    if (tot === 0) {
      el.textContent = "";
      return;
    }
    el.innerHTML = `<i class="fa-solid fa-coins"></i> session: ${tot.toLocaleString()} tok · $${(STATE.chat.sessionCostUsd || 0).toFixed(4)}`;
  }

  // Human-friendly "resets in 8h" / "resets in 32m" from an ISO timestamp.
  function _humanTimeUntil(iso) {
    if (!iso) return "soon";
    try {
      const target = new Date(iso.replace(/Z?$/, "Z"));
      const ms = target.getTime() - Date.now();
      if (ms <= 0) return "now";
      const mins = Math.round(ms / 60000);
      if (mins < 60) return `${mins}m`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h`;
      return `${Math.round(hrs / 24)}d`;
    } catch (_) {
      return "soon";
    }
  }

  function updateQuotaGauge() {
    const el = $("quotaGauge");
    if (!el) return;
    const q = STATE.chat.platformQuota;
    // Only show the gauge if the last turn we observed actually consumed
    // platform-key budget. With BYOK the quota is irrelevant — hide it.
    if (!q || STATE.chat.lastKeySource !== "platform") {
      el.textContent = "";
      el.classList.remove("quota-warn", "quota-crit");
      return;
    }
    const reqsFrac = (q.reqs_limit || 0) > 0 ? (q.reqs_used || 0) / q.reqs_limit : 0;
    const toksFrac = (q.tokens_limit || 0) > 0 ? (q.tokens_used || 0) / q.tokens_limit : 0;
    const worst = Math.max(reqsFrac, toksFrac);
    el.classList.remove("quota-warn", "quota-crit");
    if (worst >= 0.95) el.classList.add("quota-crit");
    else if (worst >= 0.80) el.classList.add("quota-warn");
    const tokK = (n) => n >= 1000 ? `${(n / 1000).toFixed(0)}K` : `${n}`;
    el.innerHTML =
      `<i class="fa-solid fa-gauge-high"></i> ` +
      `quota: ${q.reqs_used || 0}/${q.reqs_limit || 0} req · ` +
      `${tokK(q.tokens_used || 0)}/${tokK(q.tokens_limit || 0)} tok · ` +
      `resets ${escapeHtml(_humanTimeUntil(q.resets_at))}`;
  }

  // Tables longer than this many rows get collapsed by default (visible
  // height capped, "Show all" button added).
  const TABLE_COLLAPSE_THRESHOLD = 10;

  function applyTableCollapsing(bubble) {
    if (!bubble) return;
    bubble.querySelectorAll("table").forEach((tbl) => {
      const rowCount = tbl.querySelectorAll("tbody tr").length || tbl.querySelectorAll("tr").length - 1;
      if (rowCount <= TABLE_COLLAPSE_THRESHOLD || tbl.dataset.collapseWired === "1") return;
      tbl.dataset.collapseWired = "1";
      const wrapper = document.createElement("div");
      wrapper.className = "table-collapsed";
      tbl.parentNode.insertBefore(wrapper, tbl);
      wrapper.appendChild(tbl);
      const toggle = document.createElement("button");
      toggle.className = "table-toggle-btn";
      toggle.innerHTML = `<i class="fa-solid fa-chevron-down"></i> Show all ${rowCount} rows`;
      let expanded = false;
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        wrapper.classList.toggle("table-collapsed", !expanded);
        toggle.innerHTML = expanded
          ? `<i class="fa-solid fa-chevron-up"></i> Collapse table`
          : `<i class="fa-solid fa-chevron-down"></i> Show all ${rowCount} rows`;
      });
      wrapper.insertAdjacentElement("afterend", toggle);
    });
  }

  // Scroll behavior: auto-stick to bottom ONLY when the user is already
  // near the bottom. If they've scrolled up to read earlier content, leave
  // their position alone and show a "jump to latest" pill so they can opt
  // back in. ~80px tolerance handles small jitter during streaming.
  const SCROLL_BOTTOM_TOLERANCE_PX = 80;

  function isNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_TOLERANCE_PX;
  }

  function autoScrollIfPinned(el) {
    if (!el) return;
    if (STATE.chat.userScrolledUp) return;
    el.scrollTop = el.scrollHeight;
  }

  function showJumpToLatestPill() {
    const body = $("convThreadBody");
    if (!body) return;
    let pill = $("convJumpToLatest");
    if (!pill) {
      pill = document.createElement("button");
      pill.id = "convJumpToLatest";
      pill.className = "conv-jump-pill";
      pill.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Jump to latest';
      pill.addEventListener("click", () => {
        STATE.chat.userScrolledUp = false;
        autoScrollIfPinned(body);
        pill.remove();
      });
      body.parentElement.appendChild(pill);
    }
  }

  function hideJumpToLatestPill() {
    $("convJumpToLatest")?.remove();
  }

  function attachScrollListener() {
    const body = $("convThreadBody");
    if (!body || body.dataset.scrollWired) return;
    body.dataset.scrollWired = "1";
    body.addEventListener("scroll", () => {
      const near = isNearBottom(body);
      if (near) {
        STATE.chat.userScrolledUp = false;
        hideJumpToLatestPill();
      } else {
        STATE.chat.userScrolledUp = true;
      }
    });
  }

  function showThinkingIndicator() {
    const body = $("convThreadBody");
    if (!body || body.querySelector("#convThinking")) return;
    const el = document.createElement("div");
    el.className = "msg-ai msg-thinking";
    el.id = "convThinking";
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `<span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span> <span class="thinking-label">Thinking…</span>`;
    body.appendChild(el);
    autoScrollIfPinned(body);
  }

  function removeThinkingIndicator() {
    const el = document.getElementById("convThinking");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Is this conversation the one currently displayed? All DOM writes from a
  // stream are gated on this — a background conversation never paints here.
  function _isOnScreen(convId) {
    return convId && convId === STATE.chat.currentConvId;
  }

  // Paint the streaming bubble for `convId` from its accumulated buffer, but
  // only if that conversation is the one on screen.
  function paintStreamingBubble(convId) {
    if (!_isOnScreen(convId)) return;
    const st = streams.get(convId);
    const body = $("convThreadBody");
    if (!body || !st || !st.asstId) return;
    removeThinkingIndicator();
    let bubble = body.querySelector(`[data-mid="${st.asstId}"]`);
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "msg-ai msg-stream";
      bubble.dataset.mid = st.asstId;
      body.appendChild(bubble);
    }
    bubble.innerHTML = renderMarkdown(st.buffer);
    if (STATE.chat.userScrolledUp) showJumpToLatestPill();
    else autoScrollIfPinned(body);
  }

  // Build a tool-call breadcrumb DOM element from a stored tool-call object.
  // Used both live (on the tool_call event) and when re-projecting a stream
  // after switching back into its conversation.
  function buildBreadcrumbEl(tc) {
    const extCall = !!tc.external;
    const div = document.createElement("div");
    div.className =
      "tool-breadcrumb tool-breadcrumb-running" + (extCall ? " tool-breadcrumb-external" : "");
    div.dataset.toolUseId = tc.id || "";
    const input = tc.args || {};
    let label, argsPreview, icon;
    if (extCall) {
      label = extDbName(tc.adapter || "");
      argsPreview = String(input.query || input.symbol || "");
      icon = "fa-globe";
    } else {
      label = tc.adapter || "tool";
      const argsStr = JSON.stringify(input);
      argsPreview = argsStr.length > 90 ? argsStr.slice(0, 87) + "…" : argsStr;
      icon = "fa-circle-notch fa-spin";
    }
    div.innerHTML = `
      <span class="tool-icon"><i class="fa-solid ${icon}"></i></span>
      <span class="tool-name">${escapeHtml(label)}</span>
      <span class="tool-args">${escapeHtml(argsPreview)}</span>
      <span class="tool-status">${extCall ? "looking up…" : "running…"}</span>
    `;
    if (tc.result) applyBreadcrumbResult(div, tc.result);
    return div;
  }

  function applyBreadcrumbResult(div, result) {
    div.classList.remove("tool-breadcrumb-running");
    const icon = result.is_error ? "fa-circle-exclamation" : "fa-circle-check";
    div.classList.add(result.is_error ? "tool-breadcrumb-error" : "tool-breadcrumb-ok");
    const statusEl = div.querySelector(".tool-status");
    if (statusEl) {
      const cachedTag = result.cached ? " · cached" : "";
      statusEl.innerHTML = `<i class="fa-solid ${icon}"></i> ${escapeHtml(result.summary || "done")} · ${result.latency_ms || 0}ms${cachedTag}`;
    }
    const refs = result.references || [];
    if (refs.length && !div.querySelector(".tool-refs")) {
      const refDiv = document.createElement("div");
      refDiv.className = "tool-refs";
      refDiv.innerHTML = refs
        .map(
          (r) =>
            `<a href="${escapeHtml(safeHref(r.url))}" target="_blank" rel="noopener noreferrer" class="tool-ref"><i class="fa-solid fa-up-right-from-square"></i> ${escapeHtml(r.label || r.ref_id || "source")}</a>`
        )
        .join("");
      div.appendChild(refDiv);
    }
  }

  // Live tool_call: record on the stream, render only if on screen.
  function renderToolCall(convId, tc) {
    streams.addToolCall(convId, tc);
    if (!_isOnScreen(convId)) return;
    const body = $("convThreadBody");
    if (body) {
      body.appendChild(buildBreadcrumbEl(tc));
      autoScrollIfPinned(body);
    }
  }

  // Live tool_result: patch the stream's tool call, update DOM if on screen.
  function renderToolResult(convId, toolUseId, result) {
    streams.patchToolResult(convId, toolUseId, result);
    if (!_isOnScreen(convId) || !toolUseId) return;
    const body = $("convThreadBody");
    const div = body?.querySelector(`.tool-breadcrumb[data-tool-use-id="${toolUseId}"]`);
    if (div) applyBreadcrumbResult(div, result);
  }

  // When switching INTO a conversation that has an in-flight (or just-finished
  // but not-yet-reloaded) stream, rebuild its breadcrumbs + streaming bubble
  // from the accumulated state so the user sees its live progress.
  function reprojectStream(convId) {
    const st = streams.get(convId);
    const body = $("convThreadBody");
    if (!st || !body) return;
    for (const tc of st.toolCalls) {
      if (!body.querySelector(`.tool-breadcrumb[data-tool-use-id="${tc.id}"]`)) {
        body.appendChild(buildBreadcrumbEl(tc));
      }
    }
    if (st.redactedText != null) {
      // The answer was redacted — show the refusal, never the replaced buffer
      // as a normal answer.
      removeThinkingIndicator();
      let bubble = st.asstId && body.querySelector(`[data-mid="${st.asstId}"]`);
      if (!bubble) {
        bubble = document.createElement("div");
        bubble.className = "msg-ai";
        if (st.asstId) bubble.dataset.mid = st.asstId;
        body.appendChild(bubble);
      }
      bubble.classList.remove("msg-stream");
      bubble.innerHTML = `<div class="msg-error">${escapeHtml(st.redactedText)}</div>`;
      return;
    }
    // Paint whatever has accumulated — whether still streaming or just finished
    // (the brief reload window after an off-screen finish). Harmless if the
    // subsequent canonical reload re-renders.
    if (st.buffer) paintStreamingBubble(convId);
    else if (st.active) showThinkingIndicator();
  }

  function finalizeStreaming(convId) {
    if (!_isOnScreen(convId)) return;
    const st = streams.get(convId);
    const body = $("convThreadBody");
    removeThinkingIndicator();
    if (!body || !st || !st.asstId) return;
    let bubble = body.querySelector(`[data-mid="${st.asstId}"]`);
    if (!bubble) {
      // No delta arrived (tool-only / empty completion) — still finalize so
      // the turn doesn't vanish.
      bubble = document.createElement("div");
      bubble.className = "msg-ai";
      bubble.dataset.mid = st.asstId;
      body.appendChild(bubble);
    }
    bubble.classList.remove("msg-stream");
    // SECURITY: a redacted answer must stay an error notice — never get
    // re-rendered as a normal grounded answer with provenance/regenerate.
    if (st.redactedText != null) {
      bubble.innerHTML = `<div class="msg-error">${escapeHtml(st.redactedText)}</div>`;
      return;
    }
    const ex = st.extras || {};
    const inner = renderMarkdown(st.buffer);
    const tempMsg = {
      id: st.asstId,
      role: "assistant",
      content: st.buffer,
      provider: ex.provider,
      model: ex.model,
      input_tokens: ex.input_tokens,
      output_tokens: ex.output_tokens,
      cost_usd: ex.cost_usd,
      citations: ex.citations || [],
      tool_calls: st.toolCalls || [],
      attachments: [],
      status: "complete",
      error: "",
    };
    bubble.innerHTML = `
      ${inner}
      <div class="msg-action-bar">
        ${provenanceBadge(tempMsg)}
        <span class="msg-action-spacer"></span>
        <button class="msg-action-btn" data-action="regenerate" data-mid="${escapeHtml(tempMsg.id)}" title="Regenerate this answer"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button class="msg-action-btn" data-action="pin" data-mid="${escapeHtml(tempMsg.id)}" title="Pin this message"><i class="fa-solid fa-thumbtack"></i></button>
        <button class="msg-action-btn" data-action="copy" data-mid="${escapeHtml(tempMsg.id)}" title="Copy answer"><i class="fa-solid fa-copy"></i></button>
      </div>
      ${renderProvenancePanel(tempMsg)}
      ${ex.followups ? followupChipsHtml(ex.followups) : ""}
      ${metaFooter(tempMsg)}
    `;
    bubble.querySelectorAll(".followup-chip[data-question]").forEach((el) => {
      el.addEventListener("click", () => sendMessage(el.dataset.question));
    });
    applyTableCollapsing(bubble);
    wireMessageActions();
    autoScrollIfPinned(body);
  }

  function setStreamingControls(active) {
    const sendBtn = $("convSendBtn");
    const stopBtn = $("convStopBtn");
    if (sendBtn) sendBtn.style.display = active ? "none" : "";
    if (stopBtn) stopBtn.style.display = active ? "" : "none";
    // Keep the composer ENABLED while streaming so the user can draft their
    // next message; the double-submit guard in sendMessage prevents a second
    // concurrent stream from actually starting.
    const input = $("convInput");
    if (input) input.disabled = false;
    const attachBtn = $("convAttachBtn");
    if (attachBtn) attachBtn.disabled = !STATE.chat.currentConvId;
  }

  // --- Attachments (composer-side staging until send) ------------------

  function renderAttachStrip() {
    const strip = $("convAttachStrip");
    if (!strip) return;
    const pending = STATE.chat.pendingAttachments || [];
    if (!pending.length) {
      strip.style.display = "none";
      strip.innerHTML = "";
      return;
    }
    strip.style.display = "";
    strip.innerHTML = pending
      .map((att) => {
        const isImg = att.kind === "image";
        const thumb = isImg && att.thumbDataUrl
          ? `<img src="${att.thumbDataUrl}" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:3px"/>`
          : `<i class="fa-solid ${isImg ? "fa-image" : "fa-file-lines"}"></i>`;
        return `
          <span class="attach-chip" data-att-id="${escapeHtml(att.id)}">
            ${thumb}
            <span>${escapeHtml(att.filename)}</span>
            <span style="color:var(--text-muted);font-size:0.7rem">${escapeHtml(humanSize(att.size_bytes))}</span>
            <button class="btn btn-ghost btn-sm" data-remove="${escapeHtml(att.id)}" title="Remove" style="padding:0 0.2rem;line-height:1"><i class="fa-solid fa-xmark"></i></button>
          </span>
        `;
      })
      .join("");
    strip.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const aid = btn.getAttribute("data-remove");
        await removePendingAttachment(aid);
      });
    });
  }

  async function uploadAttachmentFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return [];
    if (!STATE.chat.currentConvId) {
      toast("Open a chat first to attach files", "info");
      return [];
    }

    // Local pre-flight: extension + size caps. Lets us bail before sending
    // anything to the server.
    let imgCount = (STATE.chat.pendingAttachments || []).filter(
      (a) => a.kind === "image"
    ).length;
    for (const f of files) {
      const ext = extOf(f.name);
      if (!ALLOWED_EXTS.has(ext)) {
        toast(`Type '${ext || "unknown"}' not allowed`, "error");
        return [];
      }
      const isImg = IMAGE_EXTS.has(ext);
      const cap = isImg ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (f.size > cap) {
        toast(
          `${f.name} is ${humanSize(f.size)} > ${humanSize(cap)}`,
          "error"
        );
        return [];
      }
      if (isImg) imgCount += 1;
    }
    if (imgCount > MAX_IMAGES_PER_TURN) {
      toast(`Max ${MAX_IMAGES_PER_TURN} images per turn`, "error");
      return [];
    }

    // Build thumbnails for images BEFORE upload so we can show them
    // optimistically (the server doesn't return image bytes).
    const thumbs = await Promise.all(
      files.map((f) => (isImageExt(f.name) ? readDataUrl(f) : Promise.resolve(null)))
    );

    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    try {
      const headers = new Headers();
      if (STATE.sessionToken) {
        headers.set("Authorization", `Bearer ${STATE.sessionToken}`);
      }
      const resp = await fetch(
        `/api/conversations/${STATE.chat.currentConvId}/attachments`,
        { method: "POST", headers, body: form }
      );
      if (!resp.ok) {
        const txt = await resp.text();
        let detail = txt;
        try {
          const p = JSON.parse(txt);
          detail = p?.detail || p?.message || txt;
        } catch (_) {}
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      const created = await resp.json();
      created.forEach((row, i) => {
        STATE.chat.pendingAttachments.push({
          id: row.id,
          filename: row.filename,
          mime_type: row.mime_type,
          size_bytes: row.size_bytes,
          kind: row.kind,
          thumbDataUrl: thumbs[i] || null,
        });
      });
      renderAttachStrip();
      // Newly uploaded files show up under the "My files" context tab.
      loadContextPanel();
      return created;
    } catch (err) {
      toast(`Attachment upload failed: ${err.message}`, "error");
      return [];
    }
  }

  async function removePendingAttachment(attId) {
    // Best-effort server-side delete; UI removes optimistically.
    STATE.chat.pendingAttachments = (STATE.chat.pendingAttachments || []).filter(
      (a) => a.id !== attId
    );
    renderAttachStrip();
    try {
      await apiJson(`/api/attachments/${attId}`, { method: "DELETE" });
    } catch (_) {
      // Already gone or permissions — UI state is what the user sees.
    }
  }

  function clearPendingAttachments() {
    STATE.chat.pendingAttachments = [];
    renderAttachStrip();
  }

  // escapeHtml neutralizes HTML metacharacters but NOT URL schemes, so a
  // `javascript:`/`data:` href from an external-lookup result would survive
  // attribute-escaping and execute on click. Allow only web/mail schemes;
  // anything else collapses to "#".
  function safeHref(url) {
    const u = (url == null ? "" : String(url)).trim();
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
    return "#";
  }

  function openFilePicker() {
    let picker = $("convFilePicker");
    if (!picker) {
      picker = document.createElement("input");
      picker.type = "file";
      picker.id = "convFilePicker";
      picker.multiple = true;
      picker.accept = Array.from(ALLOWED_EXTS).join(",");
      picker.style.display = "none";
      picker.addEventListener("change", (e) => uploadAttachmentFiles(e.target.files));
      document.body.appendChild(picker);
    }
    picker.value = "";
    picker.click();
  }

  function wireDropAndPaste() {
    const dropTarget = $("convThreadBody") || $("chatShell");
    if (dropTarget && !dropTarget.dataset.dropWired) {
      dropTarget.dataset.dropWired = "1";
      dropTarget.addEventListener("dragover", (e) => {
        if (!STATE.chat.currentConvId) return;
        e.preventDefault();
        dropTarget.classList.add("dragover");
      });
      dropTarget.addEventListener("dragleave", () => dropTarget.classList.remove("dragover"));
      dropTarget.addEventListener("drop", (e) => {
        e.preventDefault();
        dropTarget.classList.remove("dragover");
        if (e.dataTransfer?.files?.length) {
          uploadAttachmentFiles(e.dataTransfer.files);
        }
      });
    }
    const composerInput = $("convInput");
    if (composerInput && !composerInput.dataset.pasteWired) {
      composerInput.dataset.pasteWired = "1";
      composerInput.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const pasted = [];
        for (const item of items) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f) pasted.push(f);
          }
        }
        if (pasted.length) {
          e.preventDefault();
          uploadAttachmentFiles(pasted);
        }
      });
    }
  }

  // --- API calls --------------------------------------------------------

  // ===================================================================
  // P9 — Context Panel + @-mention picker
  // ===================================================================

  function refKey(r) {
    return (r.kind || "") + ":" + (r.run_id || "") + ":" + (r.rel_path || r.attachment_id || r.label || "");
  }

  function ctxFamilyIcon(family) {
    const p = (family || "").split(".")[0];
    return {
      volcano: "fa-chart-simple", network: "fa-circle-nodes", go: "fa-dna",
      cells: "fa-bacterium", input: "fa-table", report: "fa-file-lines",
    }[p] || "fa-file";
  }

  function refIcon(it) {
    if (it.kind === "attachment") return isImageExt(it.label) ? "fa-image" : "fa-paperclip";
    return ctxFamilyIcon(it.family);
  }

  async function loadContextPanel() {
    const cid = STATE.chat.currentConvId;
    if (!cid) { STATE.chat.contextPanel = null; renderContextPanel(); return; }
    try {
      STATE.chat.contextPanel = await apiJson(`/api/conversations/${cid}/context-panel`);
    } catch (e) {
      STATE.chat.contextPanel = { run_artifacts: [], local_files: [] };
    }
    renderContextPanel();
  }

  function ctxItemHtml(it, idx) {
    const persistent = (STATE.chat.persistentRefs || []).some((r) => refKey(r) === refKey(it));
    const pending = (STATE.chat.pendingRefs || []).some((r) => refKey(r) === refKey(it));
    const meta = it.row_count
      ? `${Number(it.row_count).toLocaleString()} rows`
      : (it.size_bytes ? humanSize(it.size_bytes) : "");
    const runPrefix = it.run_label ? `<span class="ctx-item-size">${escapeHtml(it.run_label)}</span>` : "";
    return `<div class="ctx-item" data-ctx-idx="${idx}">
      <i class="fa-solid ${refIcon(it)} ctx-item-icon"></i>
      <span class="ctx-item-name" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</span>
      ${runPrefix}
      <span class="ctx-item-size">${escapeHtml(meta)}</span>
      <button class="ctx-pin-btn${persistent ? " pinned" : ""}" data-ctx-pin="${idx}" title="${persistent ? "Pinned persistently" : (pending ? "Pinned to next message via @ mention" : "Pin persistently")}">
        <i class="fa-solid ${persistent ? "fa-circle-check" : "fa-circle-plus"}"></i>
      </button>
    </div>`;
  }

  function renderContextPanel() {
    const body = $("ctxBody");
    if (!body) return;
    const cp = STATE.chat.contextPanel;
    const tab = STATE.chat.ctxTab || "run";
    document.querySelectorAll(".ctx-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.ctxTab === tab));
    STATE.chat.ctxFlatItems = [];
    if (!STATE.chat.currentConvId) {
      body.innerHTML = `<div class="ctx-empty">Open a chat to browse and pin its files.</div>`;
      return;
    }
    if (!cp) { body.innerHTML = `<div class="ctx-empty">Loading…</div>`; return; }

    let html = "";
    if (tab === "run") {
      const groups = cp.run_artifacts || [];
      if (!groups.length) {
        body.innerHTML = `<div class="ctx-empty">No run artifacts found for this conversation.</div>`;
        return;
      }
      groups.forEach((g) => {
        html += `<div class="ctx-group-h">${escapeHtml(g.group)}</div>`;
        (g.items || []).forEach((it) => {
          const flat = { kind: "run_artifact", label: it.label, rel_path: it.rel_path,
            family: it.family, size_bytes: it.size_bytes, row_count: it.row_count };
          html += ctxItemHtml(flat, STATE.chat.ctxFlatItems.length);
          STATE.chat.ctxFlatItems.push(flat);
        });
      });
    } else if (tab === "local") {
      const files = cp.local_files || [];
      if (!files.length) {
        body.innerHTML = `<div class="ctx-empty">No files uploaded to this chat yet.<br>Drop a file into the message box to add one.</div>`;
        return;
      }
      files.forEach((f) => {
        const flat = { kind: "attachment", label: f.label, attachment_id: f.attachment_id,
          size_bytes: f.size_bytes };
        html += ctxItemHtml(flat, STATE.chat.ctxFlatItems.length);
        STATE.chat.ctxFlatItems.push(flat);
      });
    } else {
      const runs = (cp.workspace_runs || []).filter((r) => !r.current);
      if (!runs.length) {
        body.innerHTML = `<div class="ctx-empty">No other completed runs found in this workspace.</div>`;
        return;
      }
      runs.forEach((run) => {
        html += `<div class="ctx-group-h">${escapeHtml(run.label || run.run_id)}</div>`;
        const artifacts = run.artifacts || [];
        if (!artifacts.length) {
          html += `<div class="ctx-empty">No indexed artifacts for this run.</div>`;
          return;
        }
        artifacts.forEach((it) => {
          const flat = { kind: "run_artifact", run_id: run.run_id, run_label: run.label,
            label: `${run.label || run.run_id} / ${it.label}`, rel_path: it.rel_path,
            family: it.family, size_bytes: it.size_bytes, row_count: it.row_count };
          html += ctxItemHtml(flat, STATE.chat.ctxFlatItems.length);
          STATE.chat.ctxFlatItems.push(flat);
        });
      });
    }
    body.innerHTML = html;
    body.querySelectorAll("[data-ctx-pin]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const it = STATE.chat.ctxFlatItems[parseInt(btn.dataset.ctxPin, 10)];
        if (it) togglePersistentRef(it);
      });
    });
  }

  function switchCtxTab(tab) {
    STATE.chat.ctxTab = tab;
    renderContextPanel();
  }

  function toggleContextPanel() {
    STATE.chat.ctxCollapsed = !STATE.chat.ctxCollapsed;
    $("chatShell")?.classList.toggle("ctx-collapsed", STATE.chat.ctxCollapsed);
  }

  function togglePendingRef(it) {
    const refs = STATE.chat.pendingRefs || (STATE.chat.pendingRefs = []);
    const i = refs.findIndex((r) => refKey(r) === refKey(it));
    if (i >= 0) refs.splice(i, 1);
    else refs.push(it);
    renderPinnedStrip();
    renderContextPanel();
  }

  function addPendingRef(it) {
    const refs = STATE.chat.pendingRefs || (STATE.chat.pendingRefs = []);
    if (!refs.some((r) => refKey(r) === refKey(it))) refs.push(it);
    renderPinnedStrip();
    renderContextPanel();
  }

  async function savePersistentRefs(refs) {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    const saved = await apiJson(`/api/conversations/${cid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned_refs: refs }),
    });
    STATE.chat.persistentRefs = saved.pinned_refs || [];
    renderPinnedStrip();
    renderContextPanel();
  }

  async function togglePersistentRef(it) {
    const refs = [...(STATE.chat.persistentRefs || [])];
    const i = refs.findIndex((r) => refKey(r) === refKey(it));
    if (i >= 0) refs.splice(i, 1);
    else refs.push({
      kind: it.kind,
      run_id: it.run_id || null,
      rel_path: it.rel_path || null,
      attachment_id: it.attachment_id || null,
      label: it.label || "",
    });
    try {
      await savePersistentRefs(refs);
    } catch (err) {
      toast(`Pin update failed: ${err.message}`, "error");
    }
  }

  async function removePersistentRef(idx) {
    const refs = [...(STATE.chat.persistentRefs || [])];
    refs.splice(idx, 1);
    try {
      await savePersistentRefs(refs);
    } catch (err) {
      toast(`Unpin failed: ${err.message}`, "error");
    }
  }

  function removePendingRef(idx) {
    (STATE.chat.pendingRefs || []).splice(idx, 1);
    renderPinnedStrip();
    renderContextPanel();
  }

  function clearPendingRefs() {
    STATE.chat.pendingRefs = [];
    renderPinnedStrip();
    renderContextPanel();
  }

  function renderPinnedStrip() {
    const strip = $("convPinnedStrip");
    if (!strip) return;
    const persistent = STATE.chat.persistentRefs || [];
    const pending = STATE.chat.pendingRefs || [];
    const refs = [
      ...persistent.map((r, i) => ({ ...r, _pinKind: "persistent", _pinIndex: i })),
      ...pending.map((r, i) => ({ ...r, _pinKind: "pending", _pinIndex: i })),
    ];
    if (!refs.length) { strip.style.display = "none"; strip.innerHTML = ""; return; }
    strip.style.display = "flex";
    strip.innerHTML = refs.map((r, i) =>
      `<span class="pinned-chip ${r._pinKind === "persistent" ? "persistent" : ""}" title="${escapeHtml(r.label)}">
        <i class="fa-solid ${refIcon(r)}"></i>
        <span class="pinned-chip-name">${escapeHtml(r.label)}</span>
        <button data-pin-kind="${r._pinKind}" data-pin-idx="${r._pinIndex}" title="Unpin">✕</button>
      </span>`).join("");
    strip.querySelectorAll("[data-pin-idx]").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = parseInt(b.dataset.pinIdx, 10);
        if (b.dataset.pinKind === "persistent") removePersistentRef(idx);
        else removePendingRef(idx);
      });
    });
  }

  function allMentionItems() {
    const cp = STATE.chat.contextPanel;
    if (!cp) return [];
    const out = [];
    (cp.run_artifacts || []).forEach((g) =>
      (g.items || []).forEach((it) => out.push({ kind: "run_artifact", label: it.label,
        rel_path: it.rel_path, family: it.family, size_bytes: it.size_bytes,
        row_count: it.row_count, tag: g.group })));
    (cp.local_files || []).forEach((f) => out.push({ kind: "attachment", label: f.label,
      attachment_id: f.attachment_id, size_bytes: f.size_bytes, tag: "My files" }));
    (cp.workspace_runs || []).filter((r) => !r.current).forEach((run) =>
      (run.artifacts || []).forEach((it) => out.push({ kind: "run_artifact",
        run_id: run.run_id, label: `${run.label || run.run_id} / ${it.label}`,
        rel_path: it.rel_path, family: it.family, size_bytes: it.size_bytes,
        row_count: it.row_count, tag: run.label || "Other run" })));
    return out;
  }

  function getActiveMention(input) {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const query = before.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { atStart: at, query };
  }

  function updateMentionDropdown() {
    const input = $("convInput");
    const dd = $("mentionDropdown");
    if (!input || !dd) return;
    const m = getActiveMention(input);
    if (!m) { closeMentionDropdown(); return; }
    STATE.chat.mentionCtx = m;
    const q = m.query.toLowerCase();
    const opts = allMentionItems()
      .filter((it) => !q || it.label.toLowerCase().includes(q))
      .slice(0, 8);
    STATE.chat.mentionOpts = opts;
    STATE.chat.mentionIdx = 0;
    if (!opts.length) {
      dd.innerHTML = `<div class="mention-empty">No matching files${q ? ` for "${escapeHtml(m.query)}"` : ""}.</div>`;
    } else {
      dd.innerHTML = `<div class="mention-dd-h">Pin a file into your message</div>` +
        opts.map((it, i) =>
          `<div class="mention-opt${i === 0 ? " active" : ""}" data-m-idx="${i}">
            <i class="fa-solid ${refIcon(it)} mention-opt-icon"></i>
            <span class="mention-opt-name">${escapeHtml(it.label)}</span>
            <span class="mention-opt-tag">${escapeHtml(it.tag || "")}</span>
          </div>`).join("");
      dd.querySelectorAll("[data-m-idx]").forEach((el) =>
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectMention(STATE.chat.mentionOpts[parseInt(el.dataset.mIdx, 10)]);
        }));
    }
    dd.classList.add("open");
  }

  function highlightMention() {
    const dd = $("mentionDropdown");
    if (!dd) return;
    dd.querySelectorAll(".mention-opt").forEach((el, i) =>
      el.classList.toggle("active", i === (STATE.chat.mentionIdx || 0)));
  }

  function handleMentionKeydown(e) {
    const dd = $("mentionDropdown");
    if (!dd || !dd.classList.contains("open")) return false;
    const opts = STATE.chat.mentionOpts || [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      STATE.chat.mentionIdx = Math.min(opts.length - 1, (STATE.chat.mentionIdx || 0) + 1);
      highlightMention(); return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      STATE.chat.mentionIdx = Math.max(0, (STATE.chat.mentionIdx || 0) - 1);
      highlightMention(); return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (!opts.length) { closeMentionDropdown(); return false; }
      e.preventDefault();
      selectMention(opts[STATE.chat.mentionIdx || 0]);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); closeMentionDropdown(); return true; }
    return false;
  }

  function selectMention(opt) {
    if (!opt) { closeMentionDropdown(); return; }
    const input = $("convInput");
    const m = STATE.chat.mentionCtx;
    if (input && m) {
      const v = input.value;
      const pos = input.selectionStart;
      input.value = v.slice(0, m.atStart) + v.slice(pos);
      input.setSelectionRange(m.atStart, m.atStart);
      input.focus();
    }
    addPendingRef({ kind: opt.kind, label: opt.label, rel_path: opt.rel_path,
      attachment_id: opt.attachment_id, family: opt.family,
      size_bytes: opt.size_bytes, row_count: opt.row_count });
    closeMentionDropdown();
  }

  function closeMentionDropdown() {
    const dd = $("mentionDropdown");
    if (dd) { dd.classList.remove("open"); dd.innerHTML = ""; }
    STATE.chat.mentionCtx = null;
    STATE.chat.mentionOpts = [];
  }

  async function refreshList(runId) {
    if (!runId) return;
    STATE.chat.activeRunId = runId;
    try {
      const items = await apiJson(`/api/runs/${runId}/conversations`);
      STATE.chat.conversations = items;
      setConvListItems(items);
    } catch (err) {
      toast(`Failed to load chats: ${err.message}`, "error");
    }
  }

  async function openConversation(convId) {
    STATE.chat.currentConvId = convId;
    // Monotonic token to discard stale responses: if the user switches
    // conversations before this fetch resolves, an older (slower) response
    // must not overwrite the newer thread.
    const openSeq = (STATE.chat._openSeq || 0) + 1;
    STATE.chat._openSeq = openSeq;
    setConvListItems(STATE.chat.conversations);
    // Per-turn refs reset when switching; persistent refs come from the conversation.
    STATE.chat.pendingRefs = [];
    renderPinnedStrip();
    closeMentionDropdown();
    // Show a loading placeholder so the previous thread doesn't sit there
    // looking frozen while the new one loads.
    const _body = $("convThreadBody");
    if (_body) {
      _body.innerHTML =
        `<div class="msg-empty"><span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span><div style="margin-top:0.6rem">Loading conversation…</div></div>`;
    }
    try {
      const conv = await apiJson(`/api/conversations/${convId}`);
      // Bail if a newer openConversation started while we were awaiting.
      if (STATE.chat._openSeq !== openSeq) return;
      STATE.chat.persistentRefs = conv.pinned_refs || [];
      STATE.chat.currentMessages = conv.messages || [];
      setThreadHeader(conv);
      renderPinnedStrip();
      renderThread();
      // If this conversation has a stream still in flight (it kept running in
      // the background while another chat was on screen), re-project its
      // accumulated progress and reflect its streaming controls.
      if (streams.isActive(convId)) {
        reprojectStream(convId);
        setStreamingControls(true);
      } else {
        setStreamingControls(false);
      }
    } catch (err) {
      if (STATE.chat._openSeq !== openSeq) return;
      toast(`Failed to open chat: ${err.message}`, "error");
    }
    // Only fetch the context panel for the open that actually won — a
    // superseded open (user switched again mid-fetch) must not fire a
    // redundant context-panel request.
    if (STATE.chat._openSeq === openSeq) loadContextPanel();
  }

  async function createConversation() {
    const runId = STATE.chat.activeRunId || STATE.currentRunId;
    if (!runId) {
      toast("Open a run first to start a chat", "info");
      return;
    }
    try {
      const conv = await apiJson(`/api/runs/${runId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await refreshList(runId);
      await openConversation(conv.id);
    } catch (err) {
      toast(`Failed to create chat: ${err.message}`, "error");
    }
  }

  async function clearCurrent() {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    if (!confirm("Clear all messages in this chat?")) return;
    try {
      await apiJson(`/api/conversations/${cid}/clear`, { method: "POST" });
      STATE.chat.currentMessages = [];
      renderThread();
      await refreshList(STATE.chat.activeRunId);
      toast("Chat cleared", "info");
    } catch (err) {
      toast(`Failed to clear: ${err.message}`, "error");
    }
  }

  async function deleteCurrent() {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    const conv = STATE.chat.conversations.find((c) => c.id === cid);
    await deleteConversation(cid, conv?.title);
  }

  async function renameCurrentInline() {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    const conv = STATE.chat.conversations.find((c) => c.id === cid);
    if (!conv) return;
    const titleEl = $("convThreadTitle");
    if (!titleEl) return;
    const original = conv.title || "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "conv-thread-title-input";
    input.value = original;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      if (commit && input.value.trim() && input.value.trim() !== original) {
        await renameConversation(cid, input.value);
      } else {
        const restored = document.createElement("div");
        restored.className = "conv-thread-title";
        restored.id = "convThreadTitle";
        restored.textContent = original;
        restored.title = "Double-click to rename";
        restored.addEventListener("dblclick", renameCurrentInline);
        input.replaceWith(restored);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function toggleExtLookups(target) {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    const desired = target.checked;
    // For the FIRST time the user flips this ON in a conversation, show consent.
    const conv = STATE.chat.conversations.find((c) => c.id === cid);
    const needConsent =
      desired && conv && !conv.external_lookups_enabled && !STATE.chat.consentGiven;
    if (needConsent) {
      STATE.chat.pendingExtLookupsToggle = true;
      target.checked = false; // revert until consent
      $("extLookupsConsent")?.classList.add("active");
      return;
    }
    await applyExtLookupsToggle(desired);
  }

  async function applyExtLookupsToggle(desired) {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    try {
      await apiJson(`/api/conversations/${cid}/external-lookups`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: desired }),
      });
      const conv = STATE.chat.conversations.find((c) => c.id === cid);
      if (conv) conv.external_lookups_enabled = desired;
      const toggle = $("convExtLookupsToggle");
      if (toggle) toggle.checked = desired;
      toast(
        desired ? "External lookups enabled" : "External lookups disabled",
        "info"
      );
    } catch (err) {
      toast(`Failed: ${err.message}`, "error");
    }
  }

  async function updateDiscoveryMode(value) {
    const cid = STATE.chat.currentConvId;
    if (!cid) return;
    // Disable the select while the PATCH is in flight so the user can't queue
    // conflicting writes by spam-changing it.
    const sel = $("convDiscoveryMode");
    if (sel) sel.disabled = true;
    try {
      const saved = await apiJson(`/api/conversations/${cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discovery_mode: value || "auto" }),
      });
      const conv = STATE.chat.conversations.find((c) => c.id === cid);
      if (conv) conv.discovery_mode = saved.discovery_mode || "auto";
      setThreadHeader(saved);
      toast("Discovery mode updated", "info");
    } catch (err) {
      toast(`Discovery update failed: ${err.message}`, "error");
      const current = await apiJson(`/api/conversations/${cid}`).catch(() => null);
      if (current) setThreadHeader(current);
    } finally {
      if (sel) sel.disabled = false;
    }
  }

  async function sendMessage(textArg) {
    const input = $("convInput");
    const text = typeof textArg === "string" ? textArg : input ? input.value : "";
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    if (!STATE.chat.currentConvId) {
      await createConversation();
      if (!STATE.chat.currentConvId) return;
    }
    // Bind this stream to the conversation it starts for. Everything below
    // refers to `convId`, never the live global, so navigating away can't
    // redirect or blank this stream.
    const convId = STATE.chat.currentConvId;
    // Per-conversation double-send guard: don't start a second stream for the
    // SAME conversation, but DO allow other conversations to stream
    // concurrently (each chat is its own agent).
    if (streams.isActive(convId)) return;
    if (input && typeof textArg !== "string") input.value = "";

    // Optimistically append user bubble.
    STATE.chat.currentMessages.push({
      id: "tmp-" + Date.now(),
      role: "user",
      content: trimmed,
      citations: [],
    });
    renderThread();

    // Reset scroll-pin at the start of every new turn — the user clicked
    // Send, so they want to see the answer they just asked for.
    STATE.chat.userScrolledUp = false;
    hideJumpToLatestPill();

    const ctl = new AbortController();
    streams.start(convId, ctl);
    if (_isOnScreen(convId)) {
      setStreamingControls(true);
      // Immediate "thinking" placeholder so there's no dead air before the
      // first streamed token.
      showThinkingIndicator();
    }

    try {
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      });
      if (STATE.sessionToken) {
        headers.set("Authorization", `Bearer ${STATE.sessionToken}`);
      }
      const attachmentIds = (STATE.chat.pendingAttachments || []).map((a) => a.id);
      const pinnedRefs = (STATE.chat.pendingRefs || []).map((r) => ({
        kind: r.kind,
        run_id: r.run_id || null,
        rel_path: r.rel_path || null,
        attachment_id: r.attachment_id || null,
        label: r.label || "",
      }));
      const resp = await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: trimmed,
          attachment_ids: attachmentIds,
          pinned_refs: pinnedRefs,
        }),
        signal: ctl.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        let detail = txt;
        let parsedDetail = null;
        try {
          const parsed = JSON.parse(txt);
          parsedDetail = parsed?.detail;
          detail = parsedDetail?.message || parsedDetail || parsed?.message || txt;
        } catch (_) {}
        const err = new Error(detail || `HTTP ${resp.status}`);
        err._httpStatus = resp.status;
        err._quotaProblem = resp.status === 429;
        err._quotaDetail = (resp.status === 429 && typeof parsedDetail === "object") ? parsedDetail : null;
        throw err;
      }
      // Server accepted the turn and linked any attachments/refs to it — now
      // it's safe to clear the staging strips. (Doing this before the ok-check
      // wiped the user's attachments on a failed send, forcing a re-attach.)
      clearPendingAttachments();
      clearPendingRefs();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let evt;
            try {
              evt = JSON.parse(line.slice(6));
            } catch (_) {
              continue;
            }
            if (evt.type === "start") {
              streams.setAsstId(convId, evt.assistant_message_id);
              streams.mergeExtras(convId, { provider: evt.provider, model: evt.model });
            } else if (evt.type === "delta") {
              streams.appendDelta(convId, evt.text || "");
              paintStreamingBubble(convId);
            } else if (evt.type === "tool_call") {
              renderToolCall(convId, {
                adapter: evt.tool_call?.name || "",
                args: evt.tool_call?.input || {},
                status: "called",
                id: evt.tool_call?.id || "",
                external: !!evt.external,
              });
            } else if (evt.type === "tool_result") {
              renderToolResult(convId, evt.tool_use_id, {
                is_error: !!evt.is_error,
                rows_returned: evt.rows_returned || 0,
                latency_ms: evt.latency_ms || 0,
                error_kind: evt.error_kind || null,
                cited_files: evt.cited_files || [],
                references: evt.references || [],
                external: !!evt.external,
                cached: !!evt.cached,
                summary: evt.summary || "done",
              });
            } else if (evt.type === "usage") {
              streams.mergeExtras(convId, {
                input_tokens: evt.input_tokens,
                output_tokens: evt.output_tokens,
                cost_usd: evt.cost_usd,
              });
              // Roll into the session-wide meter (aggregate across chats).
              STATE.chat.sessionInputTokens += evt.input_tokens || 0;
              STATE.chat.sessionOutputTokens += evt.output_tokens || 0;
              STATE.chat.sessionCostUsd += parseFloat(evt.cost_usd || 0) || 0;
              updateSessionMeter();
              STATE.chat.lastKeySource = evt.key_source || null;
              if (evt.platform_quota) {
                STATE.chat.platformQuota = evt.platform_quota;
              }
              updateQuotaGauge();
            } else if (evt.type === "finish") {
              streams.mergeExtras(convId, {
                citations: evt.citations || [],
                followups: evt.followups || [],
              });
            } else if (evt.type === "followups") {
              // Server emits this AFTER finish. Update the just-rendered bubble
              // in-place — only if this conversation is on screen.
              if (_isOnScreen(convId)) {
                const st = streams.get(convId);
                const body = $("convThreadBody");
                const bubble = body?.querySelector(`[data-mid="${st?.asstId}"]`);
                if (bubble && Array.isArray(evt.items) && evt.items.length) {
                  bubble.insertAdjacentHTML("beforeend", followupChipsHtml(evt.items));
                  bubble.querySelectorAll(".followup-chip[data-question]").forEach((el) => {
                    el.addEventListener("click", () => sendMessage(el.dataset.question));
                  });
                  autoScrollIfPinned(body);
                }
              }
            } else if (evt.type === "redacted") {
              // SECURITY: the output classifier flagged the streamed answer.
              streams.setRedacted(convId, evt.text || "");
              if (_isOnScreen(convId)) {
                const st = streams.get(convId);
                const body = $("convThreadBody");
                const bubble = body?.querySelector(`[data-mid="${st?.asstId}"]`);
                if (bubble) {
                  bubble.classList.remove("msg-stream");
                  bubble.innerHTML = `<div class="msg-error">${escapeHtml(evt.text || "")}</div>`;
                }
              }
            } else if (evt.type === "error") {
              const err = new Error(evt.error || "Provider error");
              err._authProblem = evt.error_code === "auth"
                || /authentication_error|invalid x-api-key|401/i.test(evt.error || "");
              throw err;
            }
          }
        }
      }
      streams.finish(convId);
      finalizeStreaming(convId);
      // Reload canonical state for THIS conversation — never the live global,
      // so a stream that finished in the background can't blank whatever the
      // user is now looking at.
      const conv = await apiJson(`/api/conversations/${convId}`);
      if (_isOnScreen(convId)) {
        STATE.chat.currentMessages = conv.messages || [];
        renderThread();
      }
      await refreshList(STATE.chat.activeRunId);
    } catch (err) {
      streams.fail(convId, err);
      if (err.name === "AbortError") {
        toast("Stopped", "info");
      } else if (!_isOnScreen(convId)) {
        // A background conversation's stream failed — surface a toast but do
        // NOT paint an error bubble into the conversation currently on screen.
        toast(`A background chat failed: ${err.message}`, "error");
      } else {
        const isAuth = err._authProblem
          || /authentication_error|invalid x-api-key|401/i.test(err.message || "");
        const isQuota = err._quotaProblem
          || /platform.*quota|429/i.test(err.message || "");
        const body = $("convThreadBody");
        if (body) {
          const div = document.createElement("div");
          div.className = "msg-ai";
          if (isQuota) {
            const detail = err._quotaDetail || {};
            const resetsAt = detail.resets_at ? _humanTimeUntil(detail.resets_at) : "tomorrow (UTC midnight)";
            const reqLimit = detail.reqs_limit || "the daily limit";
            div.innerHTML = `
              <div class="msg-error">
                <strong>Daily platform-key quota exhausted.</strong><br>
                You've used your share (${reqLimit} requests) of the shared platform key today.
                The quota resets in <strong>${escapeHtml(resetsAt)}</strong>.<br>
                To keep chatting now, add your own Anthropic API key in Settings.
                Personal keys have no platform quota — they bill directly to your Anthropic account.
              </div>
              <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
                <button class="btn btn-primary btn-sm" data-action="open-settings">
                  <i class="fa-solid fa-gear"></i> Open Settings &amp; Add Key
                </button>
              </div>
            `;
            div.querySelector("[data-action='open-settings']")?.addEventListener("click", openSettings);
          } else if (isAuth) {
            div.innerHTML = `
              <div class="msg-error">
                <strong>Anthropic rejected the saved API key.</strong><br>
                The key may be mistyped, have trailing whitespace, be revoked, or
                lack access to this model. Open Settings, clear the saved key,
                and paste a fresh one from <code>console.anthropic.com</code>.
                You can also click <strong>Test connection</strong> there to verify.
              </div>
              <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
                <button class="btn btn-primary btn-sm" data-action="open-settings">
                  <i class="fa-solid fa-gear"></i> Open Settings
                </button>
              </div>
            `;
            div.querySelector("[data-action='open-settings']")?.addEventListener("click", openSettings);
          } else {
            div.innerHTML = `
              <div class="msg-error">${escapeHtml(err.message)}</div>
              <div style="margin-top:0.5rem;display:flex;gap:0.5rem">
                <button class="btn btn-ghost btn-sm" data-action="retry-send">
                  <i class="fa-solid fa-arrow-rotate-right"></i> Retry
                </button>
              </div>
            `;
            div.querySelector("[data-action='retry-send']")?.addEventListener("click", () => {
              div.remove();
              sendMessage(trimmed);
            });
          }
          body.appendChild(div);
          autoScrollIfPinned(body);
        }
        if (!isAuth && !isQuota) toast(`Chat failed: ${err.message}`, "error");
      }
    } finally {
      streams.finish(convId);
      // Server is now canonical for this conversation; drop its stream state.
      streams.clear(convId);
      // Only touch the on-screen controls if the conversation that just ended
      // is the one being displayed; otherwise leave the current view alone.
      if (_isOnScreen(convId)) {
        removeThinkingIndicator();
        setStreamingControls(streams.isActive(STATE.chat.currentConvId));
      }
    }
  }

  function stopStream() {
    // Abort only the conversation currently on screen.
    streams.abort(STATE.chat.currentConvId);
  }

  // --- Settings drawer --------------------------------------------------

  // --- Modal/drawer accessibility: focus management + Escape + focus trap ---
  let _modalReturnFocus = null;

  function _focusables(container) {
    if (!container) return [];
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
  }

  function _openModalA11y(el) {
    if (!el) return;
    _modalReturnFocus = document.activeElement;
    // Defer so the element is visible/painted before we move focus.
    setTimeout(() => {
      const f = _focusables(el);
      (f[0] || el).focus?.();
    }, 30);
  }

  function _closeModalA11y() {
    if (_modalReturnFocus && _modalReturnFocus.focus) {
      try { _modalReturnFocus.focus(); } catch (_) {}
    }
    _modalReturnFocus = null;
  }

  function _topOpenModal() {
    const consent = $("extLookupsConsent");
    if (consent && consent.classList.contains("active")) return consent;
    const drawer = $("aiSettingsDrawer");
    if (drawer && drawer.classList.contains("open")) return drawer;
    return null;
  }

  function _handleModalKeydown(e) {
    const modal = _topOpenModal();
    if (!modal) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (modal.id === "extLookupsConsent") cancelExtLookupsConsent();
      else closeSettings();
      return;
    }
    if (e.key === "Tab") {
      const f = _focusables(modal);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  async function openSettings() {
    const drawer = $("aiSettingsDrawer");
    if (!drawer) return;
    drawer.classList.add("open");
    _openModalA11y(drawer);
    try {
      const [settings, providers] = await Promise.all([
        apiJson("/api/settings/ai"),
        apiJson("/api/settings/ai/providers"),
      ]);
      STATE.chat.settings = settings;
      STATE.chat.providers = providers;
      // Workspace admin settings — only admins get a 200; members get 403,
      // in which case the admin panel simply isn't shown.
      STATE.chat.workspaceSettings = null;
      const wsId = STATE.currentWorkspaceId;
      if (wsId) {
        try {
          STATE.chat.workspaceSettings = await apiJson(
            `/api/workspaces/${wsId}/ai-settings`
          );
        } catch (e) {
          /* non-admin — admin panel stays hidden */
        }
      }
      renderSettingsDrawer();
    } catch (err) {
      $("aiDrawerBody").innerHTML = `<div class="msg-error">Could not load settings: ${escapeHtml(err.message)}</div>`;
    }
  }

  function closeSettings() {
    $("aiSettingsDrawer")?.classList.remove("open");
    _closeModalA11y();
  }

  function renderWorkspaceAdminBlock() {
    // Rendered only for workspace admins (the GET returns 403 otherwise, so
    // STATE.chat.workspaceSettings stays null and members see nothing).
    const ws = STATE.chat.workspaceSettings;
    if (!ws) return "";
    const policies = [
      ["default_off", "Default off — members may opt in"],
      ["default_on", "Default on — members may opt out"],
      ["allow", "Allow — members control it per chat"],
      ["deny", "Deny — disabled for the whole workspace"],
    ];
    const policyOpts = policies
      .map(
        ([v, lbl]) =>
          `<option value="${v}"${ws.external_lookups_policy === v ? " selected" : ""}>${lbl}</option>`
      )
      .join("");
    const usageRows = (ws.adapter_usage || [])
      .map((u) => {
        const limit = u.daily_limit || 0;
        const pct = limit ? Math.min(100, Math.round((100 * u.used_today) / limit)) : 0;
        const tone = pct >= 95 ? "crit" : pct >= 80 ? "warn" : "ok";
        return `<div class="ws-usage-row">
          <span class="ws-usage-name">${escapeHtml(u.adapter)}</span>
          <span class="ws-usage-bar"><span class="ws-usage-fill ws-usage-${tone}" style="width:${pct}%"></span></span>
          <span class="ws-usage-num">${u.used_today}/${limit}</span>
        </div>`;
      })
      .join("");
    return `
      <div class="ai-drawer-section">
        <div style="font-weight:600;font-size:0.85rem;margin-bottom:0.5rem">
          <i class="fa-solid fa-shield-halved"></i> Workspace admin — external lookups
        </div>
        <div class="ai-drawer-field">
          <label>Policy for this workspace</label>
          <select id="wsExtPolicy">${policyOpts}</select>
        </div>
        <div class="ai-drawer-field" style="margin-top:0.6rem">
          <label style="display:flex;align-items:center;gap:0.45rem;cursor:pointer">
            <input type="checkbox" id="wsParallel"${ws.parallel_tool_calls ? " checked" : ""}>
            Allow concurrent external lookups (faster; higher API load)
          </label>
        </div>
        <div class="ai-drawer-field" style="margin-top:0.6rem">
          <label>External database usage today</label>
          <div class="ws-usage">${usageRows || '<div class="hint">No external lookups yet today.</div>'}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="wsSettingsSaveBtn" style="margin-top:0.55rem">
          <i class="fa-solid fa-floppy-disk"></i> Save workspace settings
        </button>
        <div id="wsSettingsResult" style="font-size:0.78rem;margin-top:0.35rem"></div>
      </div>
    `;
  }

  async function saveWorkspaceSettings() {
    const wsId = STATE.currentWorkspaceId;
    if (!wsId) return;
    const resEl = $("wsSettingsResult");
    const btn = $("wsSettingsSaveBtn");
    if (btn) btn.disabled = true;
    try {
      const updated = await apiJson(`/api/workspaces/${wsId}/ai-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          external_lookups_policy: $("wsExtPolicy")?.value,
          parallel_tool_calls: !!$("wsParallel")?.checked,
        }),
      });
      if (STATE.chat.workspaceSettings) {
        STATE.chat.workspaceSettings.external_lookups_policy =
          updated.external_lookups_policy;
        STATE.chat.workspaceSettings.parallel_tool_calls = updated.parallel_tool_calls;
      }
      if (resEl) resEl.innerHTML = `<span style="color:var(--success)">Saved.</span>`;
      toast("Workspace settings saved", "info");
    } catch (err) {
      if (resEl)
        resEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(err.message)}</span>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderSettingsDrawer() {
    const body = $("aiDrawerBody");
    if (!body) return;
    const s = STATE.chat.settings || {};
    const provs = STATE.chat.providers || [];
    const q = s.platform_quota || {};
    const anthropic = provs.find((p) => p.id === "anthropic") || { models: [], label: "Anthropic" };
    const modelOpts = (anthropic.models || [])
      .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === s.model ? " selected" : ""}>${escapeHtml(m.label)}</option>`)
      .join("");
    const hasKey = !!s.has_anthropic_key;
    const preview = s.anthropic_key_preview || "";
    const label = s.anthropic_key_label || "";
    const platformConfigured =
      s.providers && s.providers.anthropic && s.providers.anthropic.source === "platform";
    const quotaRelevant = platformConfigured && !hasKey;
    const resetIso = (q.resets_at || "").replace("Z", "");
    const resetWhen = resetIso ? new Date(resetIso).toLocaleString() : "tomorrow";

    body.innerHTML = `
      <div class="ai-drawer-section">
        <div class="ai-drawer-field">
          <label>Model</label>
          <select id="aiModelSelect">${modelOpts}</select>
          <div class="hint">SignalFold uses Anthropic Claude in v1. Other providers may be added later if requested.</div>
        </div>
      </div>

      <div class="ai-drawer-section">
        <div style="font-weight:600;font-size:0.85rem;margin-bottom:0.5rem">Anthropic API key</div>

        ${hasKey ? `
          <div class="key-status-card">
            <div class="key-status-row">
              <div>
                <div class="key-status-label">
                  <i class="fa-solid fa-circle-check" style="color:var(--success)"></i>
                  ${label ? escapeHtml(label) : "Saved key"}
                </div>
                <div class="key-status-preview"><code>${escapeHtml(preview)}</code></div>
              </div>
              <button class="btn btn-ghost btn-sm" id="aiKeyClearBtn" title="Remove this key">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        ` : ""}

        <div class="ai-drawer-field" style="margin-top:0.65rem">
          <label>${hasKey ? "Replace key" : "Paste your key"}</label>
          <input type="password" id="aiKey_anthropic" autocomplete="new-password"
                 placeholder="${hasKey ? "Paste new key to replace current one…" : "sk-ant-…"}" />
          <div class="hint">Stored encrypted at rest. Never returned by the API. Get a key at <code>console.anthropic.com</code>.</div>
        </div>

        <div class="ai-drawer-field" style="margin-top:0.65rem">
          <label>Label (optional)</label>
          <input type="text" id="aiKey_label" maxlength="60"
                 value="${escapeHtml(label)}"
                 placeholder="e.g. Personal · Lab account · Grant XYZ" />
          <div class="hint">A nickname to help you remember which key this is.</div>
        </div>
      </div>

      ${quotaRelevant ? `
      <div class="ai-drawer-section">
        <div class="ai-drawer-quota">
          <strong>Platform quota</strong> (used while no personal key is configured)<br>
          ${q.reqs_used || 0}/${q.reqs_limit || 0} requests · ${q.tokens_used || 0}/${q.tokens_limit || 0} tokens · resets ${escapeHtml(resetWhen)}
        </div>
      </div>
      ` : `
      <div class="ai-drawer-section">
        <div class="ai-drawer-quota" style="opacity:0.7">
          <strong>Platform quota</strong>: not relevant — your own Anthropic key is being used for billing. (Quota only applies when no user key is set.)
        </div>
      </div>
      `}

      ${renderWorkspaceAdminBlock()}

      <div class="ai-drawer-section" style="display:flex;gap:0.5rem;justify-content:space-between;align-items:center">
        <button class="btn btn-ghost btn-sm" id="aiSettingsTestBtn" ${hasKey ? "" : "disabled title='Save a key first'"}>
          <i class="fa-solid fa-plug"></i> Test connection
        </button>
        <div style="display:flex;gap:0.5rem">
          <button class="btn btn-ghost" id="aiSettingsCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="aiSettingsSaveBtn">Save</button>
        </div>
      </div>
      <div id="aiTestResult" style="font-size:0.78rem;margin-top:-0.5rem"></div>
    `;

    $("aiSettingsCancelBtn").addEventListener("click", closeSettings);
    $("aiSettingsSaveBtn").addEventListener("click", saveSettings);
    $("wsSettingsSaveBtn")?.addEventListener("click", saveWorkspaceSettings);
    $("aiKeyClearBtn")?.addEventListener("click", clearStoredKey);
    $("aiSettingsTestBtn")?.addEventListener("click", testConnection);
  }

  async function testConnection() {
    const btn = $("aiSettingsTestBtn");
    const out = $("aiTestResult");
    if (!btn || !out) return;
    btn.disabled = true;
    const prev = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Testing…';
    out.innerHTML = "";
    try {
      const result = await apiJson("/api/settings/ai/test", { method: "POST" });
      if (result.ok) {
        out.innerHTML = `<span style="color:var(--success)"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(result.detail || "Key works.")}</span>`;
      } else {
        out.innerHTML = `<span style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(result.detail || "Test failed.")}</span>`;
      }
    } catch (err) {
      out.innerHTML = `<span style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = prev;
    }
  }

  async function clearStoredKey() {
    if (!confirm("Remove the stored Anthropic API key? Chat will fall back to the platform key (if available) or stop until you paste a new one.")) {
      return;
    }
    try {
      const updated = await apiJson("/api/settings/ai/keys/anthropic", { method: "DELETE" });
      STATE.chat.settings = updated;
      toast("Key removed", "info");
      renderSettingsDrawer();
    } catch (err) {
      toast(`Failed to clear key: ${err.message}`, "error");
    }
  }

  async function saveSettings() {
    const body = {
      provider: "anthropic",
      model: $("aiModelSelect")?.value,
    };
    const keyVal = ($("aiKey_anthropic")?.value || "").trim();
    if (keyVal) {
      body.anthropic_key = keyVal;
    }
    const labelVal = $("aiKey_label")?.value;
    if (labelVal !== undefined) {
      // Always send label (allows clearing it). Trim long input.
      body.anthropic_key_label = (labelVal || "").trim();
    }
    try {
      const updated = await apiJson("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      STATE.chat.settings = updated;
      toast("AI settings saved", "info");
      closeSettings();
    } catch (err) {
      toast(`Save failed: ${err.message}`, "error");
    }
  }

  // --- External lookups consent ----------------------------------------

  function askExtLookupsConsent() {
    const m = $("extLookupsConsent");
    m?.classList.add("active");
    _openModalA11y(m);
  }
  function cancelExtLookupsConsent() {
    $("extLookupsConsent")?.classList.remove("active");
    STATE.chat.pendingExtLookupsToggle = null;
    const t = $("convExtLookupsToggle");
    if (t) t.checked = false;
    _closeModalA11y();
  }
  async function confirmExtLookupsConsent() {
    $("extLookupsConsent")?.classList.remove("active");
    _closeModalA11y();
    STATE.chat.consentGiven = true;
    await applyExtLookupsToggle(true);
    STATE.chat.pendingExtLookupsToggle = null;
  }

  // --- Init -------------------------------------------------------------

  function init() {
    // Scroll behavior — must be wired before any messages render so the
    // listener catches user scroll intent from turn one.
    STATE.chat.userScrolledUp = false;
    attachScrollListener();
    // Modal/drawer a11y: Escape-to-close + Tab focus-trap (wired once).
    if (!document._chatModalKeyWired) {
      document.addEventListener("keydown", _handleModalKeydown);
      document._chatModalKeyWired = true;
    }
    // Buttons & wiring (idempotent).
    $("convNewBtn")?.addEventListener("click", createConversation);
    $("aiSettingsBtn")?.addEventListener("click", openSettings);
    $("convClearBtn")?.addEventListener("click", clearCurrent);
    $("convExportBtn")?.addEventListener("click", exportCurrent);
    $("convSendBtn")?.addEventListener("click", () => sendMessage());
    $("convStopBtn")?.addEventListener("click", stopStream);
    $("convAttachBtn")?.addEventListener("click", openFilePicker);
    $("convExtLookupsToggle")?.addEventListener("change", (e) => toggleExtLookups(e.target));
    $("convDiscoveryMode")?.addEventListener("change", (e) => updateDiscoveryMode(e.target.value));
    $("convInput")?.addEventListener("keydown", (e) => {
      // The @-mention dropdown gets first refusal on Enter / arrows / Esc.
      if (handleMentionKeydown(e)) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $("convInput")?.addEventListener("input", updateMentionDropdown);
    $("convInput")?.addEventListener("blur", () => setTimeout(closeMentionDropdown, 120));
    // P9 — context panel controls.
    $("ctxToggleBtn")?.addEventListener("click", toggleContextPanel);
    $("ctxCollapseBtn")?.addEventListener("click", toggleContextPanel);
    document.querySelectorAll(".ctx-tab").forEach((t) =>
      t.addEventListener("click", () => switchCtxTab(t.dataset.ctxTab)));
    wireDropAndPaste();
    setStreamingControls(false);
    setThreadHeader(null);
    renderThread();
    renderAttachStrip();
    renderPinnedStrip();
    renderContextPanel();
    showShell(true);
  }

  function bindToRun(runId) {
    if (!runId) {
      STATE.chat.activeRunId = null;
      STATE.chat.conversations = [];
      STATE.chat.currentConvId = null;
      STATE.chat.currentMessages = [];
      setConvListItems([]);
      setThreadHeader(null);
      renderThread();
      return;
    }
    refreshList(runId).then(() => {
      // Auto-open most-recent conversation, if any.
      const first = STATE.chat.conversations[0];
      if (first) openConversation(first.id);
      else {
        STATE.chat.currentConvId = null;
        STATE.chat.currentMessages = [];
        setThreadHeader(null);
        renderThread();
      }
    });
  }

  return {
    init,
    bindToRun,
    refresh: refreshList,
    create: createConversation,
    open: openConversation,
    send: sendMessage,
    stop: stopStream,
    clear: clearCurrent,
    delete: deleteCurrent,
    openSettings,
    closeSettings,
    saveSettings,
    askExtLookupsConsent,
    confirmExtLookupsConsent,
    cancelExtLookupsConsent,
  };
}
