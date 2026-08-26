const state = {
  runs: [], runId: "", conversations: [], conversation: null, messages: [],
  config: null, models: [], modelBenchmark: null, context: [], artifacts: [], rail: "context",
  streaming: false, turnController: null, attachments: [], runCost: 0, runCostBreakdown: { standardUsd: 0, researchUsd: 0 }, openRouterSpend: null, modelDraft: null, tierDraft: null, defaultTierDraft: "", modelOverride: null,
  selectMode: false, selectedConvs: new Set(), pinnedToBottom: true,
  researchWorkflows: [], researchSkills: [], researchJobs: [], researchJob: null, researchTimer: null,
  researchTemplates: [], researchFollowupTab: "ask", researchExtendMode: "compute", researchFollowupDraft: "", researchArbiterRole: "distill",
  researchWorkflowId: "", researchPreview: null, researchObjectiveDraft: "", researchTitleDraft: "", researchLauncherValues: {}, researchModelDraft: "",
  // Live frozen-scope preview for the launch composer, keyed by run+pins (see scopePreviewKey).
  researchScopePreview: null,
  // Snapshots of child extension jobs referenced by the open job's conversation, so
  // their progress/answer thread inline (refreshResearchChildren / renderChildExtension).
  researchChildJobs: {},
  // Lazy per-job run-data catalog + usage (which files were read/cited/fetched),
  // keyed by jobId: { open, loading, data, error }. Loaded on expanding "Data used".
  researchCatalog: {},
  // True while a follow-up Ask/Extend turn is in flight, so the composer shows a waiting
  // state and a second click can't fire a duplicate turn.
  researchFollowupSending: false,
  // One-shot scroll request for research-thread actions. Follow-up answers can land
  // below a long prior response, so after a send/arbiter/rerun we bring the newest
  // message into view without forcing scroll position during ordinary polling.
  researchScrollTarget: "",
  // Whether the "Re-run exactly" split-button's model menu is open.
  rerunMenuOpen: false,
  // Whether the Arbiter's (i) role-info popover is open.
  arbiterInfoOpen: false,
  // @-mentions selected in the Standard composer / Deep Research launch screen,
  // the editable plan + expanded-deliverable previews, and the in-panel
  // pinned-files picker for Deep Research.
  mentions: [], mentionPicker: null, planDraft: null, deliverableViews: {}, pinPicker: null,
  // Deliverables collapse the long, low-traffic tiers by default (outputs stay open).
  deliverableGroups: { provenance: false, code: false },
};
const RESEARCH_SOURCES = ["uniprot", "pubmed", "pmc", "reactome", "string", "quickgo"];
// Arbiter roles surfaced in the follow-up panel — id, label, and the one-line blurb
// shown behind the (i) info popover. Display-only mirror of src/research/arbiter.ts
// (the server owns the actual prompt templates).
const ARBITER_ROLES_UI = [
  { id: "distill", label: "Distill", blurb: "Compares the responses, flags disagreements and gaps, then merges them into one integrated answer." },
  { id: "critique", label: "Critique", blurb: "Fair-minded critique of each response — factual errors, reasoning gaps, omissions. No synthesis." },
  { id: "counsel", label: "Counsel", blurb: "Reads the responses as an advisor, not a judge: what resonates, what to question, what is missing." },
  { id: "steelman", label: "Steelman", blurb: "Builds the strongest possible version of each response's argument, then judges which is most compelling." },
  { id: "extend", label: "Extend — push further", blurb: "Treats the responses as a starting point and pushes the thinking further: second-order implications, adjacent questions." },
  { id: "contrast", label: "Contrast", blurb: "Isolates where and why the responses diverge, with a hypothesis for each disagreement. No synthesis." },
  { id: "referee", label: "Referee", blurb: "For two answers: shared ground, concrete disagreements, evaluation, and a final recommendation." },
];
const sourceLabel = (source) => source === "string" ? "STRING" : source[0].toUpperCase() + source.slice(1);
const baseName = (value) => String(value || "").split("/").pop() || String(value || "");
const generatedCodeIntent = (text) => {
  const first = String(text || "").split(/\r?\n/, 1)[0] || "";
  const match = first.match(/^\s*#\s*Intent\s*:\s*(.+)$/i);
  return match ? match[1].trim() : "";
};
const queueResearchThreadScroll = () => {
  state.researchScrollTarget = "latest";
};
const flushResearchThreadScroll = () => {
  if (!state.researchScrollTarget) return;
  state.researchScrollTarget = "";
  requestAnimationFrame(() => {
    const thread = document.querySelector(".research-thread");
    const messages = thread ? [...thread.querySelectorAll(".research-message")] : [];
    const target = messages.at(-1) || thread;
    target?.scrollIntoView({ block: "end", behavior: "smooth" });
  });
};
// Compact, date-aware timestamp for left-rail rows. Mirrors the OCC time column,
// but the rail spans many days, so older rows fold in the date: time-of-day for
// today, "Jun 12" within this year, "Jun 12, 2024" beyond it.
const stamp = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const money = (value) => `$${Number(value || 0).toFixed(4)}`;
const modelCost = (model) => {
  const input = Number(model.promptCost || 0);
  const output = Number(model.completionCost || 0);
  const cache = Number.isFinite(model.cacheReadCost) ? Number(model.cacheReadCost) : input;
  return (7 * cache + 2 * input + output) / 10;
};
const modelCostLabel = (model) => `$${modelCost(model).toFixed(2)} blend · $${Number(model.promptCost || 0).toFixed(2)}/$${Number(model.completionCost || 0).toFixed(2)} in/out per 1M`;
const intelligenceLabel = (model) => Number.isFinite(model.intelligenceIndex) ? `AA ${Number(model.intelligenceIndex).toFixed(1)}` : "AA n/a";
const sortModels = (models) => [...models].sort((a, b) => {
  const mode = state.config?.modelSort || "intelligence";
  const ai = Number.isFinite(a.intelligenceIndex) ? a.intelligenceIndex : -1;
  const bi = Number.isFinite(b.intelligenceIndex) ? b.intelligenceIndex : -1;
  const ac = modelCost(a);
  const bc = modelCost(b);
  if (mode === "cost") return ac - bc || bi - ai || a.name.localeCompare(b.name);
  if (mode === "value") {
    const av = ai < 0 ? -1 : ai / Math.max(ac, 0.01);
    const bv = bi < 0 ? -1 : bi / Math.max(bc, 0.01);
    return bv - av || bi - ai || ac - bc;
  }
  return bi - ai || ac - bc || a.name.localeCompare(b.name);
});
const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    // Only declare a JSON body when one is actually sent. A body-less request
    // (e.g. DELETE a research job) carrying Content-Type: application/json makes
    // Fastify reject it with 400 FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be
    // empty…"), which silently broke "Discard plan" and template deletion.
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status})`);
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("json") ? response.json() : response.text();
};
const toast = (text, tone = "default") => {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = `toast ${tone}`;
  node.textContent = text;
  document.body.append(node);
  setTimeout(() => node.remove(), 4200);
};
const icon = (name) => {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16v4Zm9-13 4 4"/>',
    download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5M4 21h16"/>',
    clear: '<path d="m4 7 3-3h13v16H7l-3-3 5-5-5-5Zm7 2 6 6m0-6-6 6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v6m4-6v6"/>',
    paperclip: '<path d="m9 17 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l8-8"/>',
    send: '<path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 5-5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-3.5 2-1-2-4-2 .5-1.5-1L15 4h-6l-.5 2.5-1.5 1L5 7l-2 4 2 1v2l-2 1 2 4 2-.5 1.5 1L9 22h6l.5-2.5 1.5-1 2 .5 2-4-2-1v-2Z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
};

export const AIInsightsApp = {
  async mount(root, options = {}) {
    this.root = root;
    this.options = options;
    root.innerHTML = shell();
    bind(root);
    const params = new URLSearchParams(location.search);
    try {
      const [config, runsPayload] = await Promise.all([api("/api/config"), api("/api/runs")]);
      state.config = config;
      state.runs = runsPayload.runs;
      void refreshOpenRouterSpend(false); // account-wide; fire-and-forget so it never blocks load

      state.runId = options.runId || params.get("run") || state.runs[0]?.id || "";
      await this.loadModels();
      await this.selectRun(state.runId, false);
      if (params.get("conversation")) await this.openConversation(params.get("conversation"));
      this.render();
    } catch (error) {
      toast(error.message, "error");
      this.render();
    }
    return this;
  },

  async loadModels(refresh = false) {
    try {
      const payload = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
      state.models = payload.models;
      state.modelBenchmark = payload.benchmark || null;
    } catch {
      state.models = [];
      state.modelBenchmark = null;
    }
  },

  async selectRun(runId, updateUrl = true) {
    state.runId = runId || "";
    state.conversation = null;
    state.messages = [];
    state.attachments = [];
    state.mentions = [];
    state.planDraft = null;
    state.mentionPicker = null;
    state.pinPicker = null;
    state.deliverableViews = {};
    state.researchWorkflowId = "";
    state.researchPreview = null;
    state.researchObjectiveDraft = "";
    state.selectMode = false;
    state.selectedConvs.clear();
    if (!runId) {
      state.conversations = [];
      state.context = [];
      state.artifacts = [];
      this.render();
      return;
    }
    const [conversations, context, artifacts, workflows, skills, jobs, templates] = await Promise.all([
      api(`/api/conversations?runId=${encodeURIComponent(runId)}`),
      api(`/api/runs/${encodeURIComponent(runId)}/context`),
      api(`/api/artifacts?runId=${encodeURIComponent(runId)}`),
      api(`/api/research/workflows?runId=${encodeURIComponent(runId)}`),
      api("/api/research/skills"),
      api(`/api/research/jobs?runId=${encodeURIComponent(runId)}`),
      api("/api/research/templates"),
    ]);
    state.conversations = conversations.conversations;
    state.runCost = conversations.runCostUsd;
    state.runCostBreakdown = conversations.runCostBreakdown || { standardUsd: 0, researchUsd: 0 };
    state.context = context.items;
    state.artifacts = artifacts.artifacts;
    state.researchWorkflows = workflows.workflows;
    state.researchSkills = skills.skills;
    state.researchJobs = jobs.jobs;
    state.researchTemplates = templates.templates;
    state.researchJob = state.researchJob && state.researchJob.runId === runId ? state.researchJob : null;
    if (updateUrl) history.replaceState({}, "", `?run=${encodeURIComponent(runId)}`);
    this.render();
  },

  async newConversation() {
    if (!state.runId) return toast("Select a completed run first", "error");
    const payload = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        runId: state.runId,
        policy: selectedPolicy(),
        model: selectedModel(),
        defaultSources: selectedSources(),
      }),
    });
    state.conversations.unshift(payload.conversation);
    state.modelOverride = null;
    clearTimeout(state.researchTimer);
    state.researchJob = null;
    state.planDraft = null;
    await this.openConversation(payload.conversation.id);
  },

  // "New research" in Deep Research mode. Unlike Standard, this deliberately does
  // NOT create an ai_conversations row. Deep Research is job-centric: jobs own
  // their storage and show in the left rail by objective, and they never write
  // back to a conversation. Creating one here only produced an empty, never-
  // renamed "New research chat" that leaked into the Standard conversation rail
  // and flipped the app into Deep Research when clicked. So we just return to the
  // launch screen with a clean slate; createResearch() makes the job later.
  newResearch() {
    if (!state.runId) return toast("Select a completed run first", "error");
    this.deselectConversation();
    state.modelOverride = null;
    this.render();
  },

  // Leave the open conversation WITHOUT deleting it, clearing the transient
  // per-conversation/per-job state and the ?conversation= URL param. Used by
  // "New research" and when the policy picker switches modes.
  deselectConversation() {
    clearTimeout(state.researchTimer);
    state.conversation = null;
    state.messages = [];
    state.researchJob = null;
    state.planDraft = null;
    if (state.runId) history.replaceState({}, "", `?run=${encodeURIComponent(state.runId)}`);
  },

  async openConversation(id) {
    const payload = await api(`/api/conversations/${id}`);
    state.conversation = payload.conversation;
    state.messages = payload.messages;
    history.replaceState({}, "", `?run=${encodeURIComponent(state.runId)}&conversation=${encodeURIComponent(id)}`);
    this.render();
    setTimeout(() => scrollBottom(true));
  },
  // Leave the open Deep Research job and return to the conversation it was
  // launched from. If that conversation is itself Deep Research, its research
  // workspace reopens (launch screen); if Standard, its chat thread.
  async backToConversation(id) {
    clearTimeout(state.researchTimer);
    state.researchJob = null;
    state.planDraft = null;
    await this.openConversation(id);
  },

  async patchConversation(patch) {
    if (!state.conversation) return;
    const payload = await api(`/api/conversations/${state.conversation.id}`, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    state.conversation = payload.conversation;
    state.conversations = state.conversations.map((item) => item.id === state.conversation.id ? state.conversation : item);
    this.render();
  },

  async rename() {
    if (!state.conversation) return;
    const title = prompt("Rename conversation:", state.conversation.title);
    if (title?.trim()) await this.patchConversation({ title: title.trim() });
  },
  async clear() {
    if (!state.conversation || !confirm("Clear all messages in this conversation?")) return;
    await api(`/api/conversations/${state.conversation.id}/clear`, { method: "POST", body: "{}" });
    state.messages = [];
    this.render();
  },
  toggleSelectMode() {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selectedConvs.clear();
    renderConversations();
  },
  async bulkDelete() {
    const ids = [...state.selectedConvs];
    if (!ids.length) return;
    // The left rail shows research jobs in Deep Research mode and conversations
    // otherwise; route the same multi-select to the matching purge endpoint.
    const deep = selectedPolicy() === "deep-research";
    const noun = deep ? "research job" : "conversation";
    const plural = ids.length === 1 ? `this ${noun}` : `these ${ids.length} ${noun}s`;
    if (!confirm(`Delete ${plural}? They will be zipped to your Trash, then removed from the app and the Operational Control Center.`)) return;
    const result = await api(deep ? "/api/research/jobs/bulk-delete" : "/api/conversations/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) });
    state.selectMode = false;
    state.selectedConvs.clear();
    const n = result.deleted.length;
    toast(`Moved ${n} ${noun}${n === 1 ? "" : "s"} to Trash`, "info");
    if (deep) {
      if (state.researchJob && ids.includes(state.researchJob.id)) state.researchJob = null;
      await this.refreshResearch();
      this.render();
    } else {
      await this.selectRun(state.runId);
    }
  },
  export() {
    if (state.conversation) window.open(`/api/conversations/${state.conversation.id}/export`, "_blank", "noopener");
  },

  async send() {
    if (state.streaming) return;
    const input = this.root.querySelector("#prompt");
    const message = input.value.trim();
    if (!message) return;
    if (!state.conversation) await this.newConversation();
    const model = selectedModel();
    if (!model) return toast("Choose a model from the conversation menu", "error");
    input.value = "";
    state.messages.push({ id: `local-${Date.now()}`, role: "user", content: message, effectiveSources: selectedSources(), costUsd: 0 });
    const assistant = { id: `stream-${Date.now()}`, role: "assistant", content: "", status: "streaming", model, costUsd: 0, trace: [] };
    state.messages.push(assistant);
    state.streaming = true;
    const controller = new AbortController();
    state.turnController = controller;
    this.render();
    scrollBottom(true);

    try {
      const response = await fetch(`/api/conversations/${state.conversation.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message, model, policy: selectedPolicy(), sources: selectedSources(),
          attachmentIds: state.attachments.map((item) => item.id),
          mentions: state.mentions.map((item) => ({ scope: item.scope, path: item.path })),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).detail || "Turn failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((value) => value.startsWith("data: "));
          if (!line) continue;
          const frame = JSON.parse(line.slice(6));
          if (frame.type === "text_delta") assistant.content += frame.delta;
          if (frame.type === "thinking_delta") appendTrace(assistant, "Reasoning", frame.delta);
          if (frame.type === "tool_start") appendTrace(assistant, "Tool", `${frame.toolName} started`);
          if (frame.type === "usage") assistant.costUsd = frame.costUsd;
          if (frame.type === "message_saved") assistant.id = frame.messageId;
          if (frame.type === "error") {
            assistant.status = "failed";
            assistant.content = assistant.content.trim()
              ? `${assistant.content}\n\nResponse failed: ${frame.message}`
              : `Response failed: ${frame.message}`;
          }
          if (!patchStreamingMessage(assistant)) renderMessages();
          scrollBottom();
        }
        if (done) break;
      }
      if (assistant.status === "streaming") assistant.status = "complete";
      state.attachments = [];
      state.mentions = [];
      await this.refreshConversation();
    } catch (error) {
      assistant.status = "failed";
      if (error.name === "AbortError") {
        assistant.content = assistant.content || "Response stopped by the user.";
      } else {
        assistant.content = assistant.content || `Response failed: ${error.message}`;
        toast(error.message, "error");
      }
    } finally {
      if (state.turnController === controller) state.turnController = null;
      state.streaming = false;
      this.render();
      scrollBottom();
    }
  },

  async stop() {
    if (!state.conversation) return;
    const conversationId = state.conversation.id;
    // End the browser request immediately; the server abort is a separate
    // best-effort cleanup and must never keep the UI stuck on Stop.
    state.turnController?.abort();
    void api(`/api/conversations/${conversationId}/abort`, { method: "POST", body: "{}" })
      .catch((error) => toast(`The response stopped locally, but server cleanup failed: ${error.message}`, "error"));
    toast("Stopping this response…", "info");
  },
  async refreshConversation() {
    if (!state.conversation) return;
    const openTraces = new Set(state.messages.flatMap((message) => (message.trace || [])
      .map((trace, index) => trace.open ? `${message.id}:${index}` : null).filter(Boolean)));
    const payload = await api(`/api/conversations/${state.conversation.id}`);
    state.messages = payload.messages.map((message) => ({
      ...message,
      trace: (message.trace || []).map((trace, index) => ({ ...trace, open: openTraces.has(`${message.id}:${index}`) })),
    }));
    state.conversation = payload.conversation;
    const conversations = await api(`/api/conversations?runId=${encodeURIComponent(state.runId)}`);
    state.conversations = conversations.conversations;
    state.runCost = conversations.runCostUsd;
    state.runCostBreakdown = conversations.runCostBreakdown || { standardUsd: 0, researchUsd: 0 };
    state.artifacts = (await api(`/api/artifacts?runId=${encodeURIComponent(state.runId)}`)).artifacts;
  },
  async feedback(messageId, rating, note = "") {
    await api(`/api/messages/${messageId}/feedback`, { method: "POST", body: JSON.stringify({ rating, note }) });
    state.artifacts = (await api(`/api/artifacts?runId=${encodeURIComponent(state.runId)}`)).artifacts;
    this.render();
    toast(note ? "Note appended to the run ledger" : "Feedback saved");
  },
  async pin(messageId, pinned) {
    await api(`/api/messages/${messageId}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
    const message = state.messages.find((item) => item.id === messageId);
    if (message) message.pinned = pinned;
    this.render();
    toast(pinned ? "Answer pinned" : "Answer unpinned");
  },
  async upload(file) {
    if (!state.conversation) await this.newConversation();
    if (file.size > 10 * 1024 * 1024) return toast("Attachments are limited to 10 MB", "error");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const payload = await api("/api/attachments", {
      method: "POST",
      body: JSON.stringify({ runId: state.runId, conversationId: state.conversation.id, name: file.name, mimeType: file.type, dataBase64: data }),
    });
    state.attachments.push(payload.artifact);
    this.render();
  },

  // --- @-mentions / file references (Standard + Deep Research) ---------------
  // Every run file is referenceable as @context/file, @myfiles/file (uploads),
  // or @artifacts/file (generated). In Standard mode a reference becomes a turn
  // mention; while editing a Deep Research plan it becomes a pinned scope file.
  referenceFile(scope, filePath, name) {
    const entry = { scope, path: filePath, name: name || baseName(filePath) };
    if (state.planDraft) {
      harvestPlanDraft();
      if (!state.planDraft.pinned.some((item) => item.path === filePath)) state.planDraft.pinned.push(entry);
    } else if (!state.mentions.some((item) => item.path === filePath)) {
      state.mentions.push(entry);
    }
    state.mentionPicker = null;
    this.render();
  },
  removeMention(filePath) {
    state.mentions = state.mentions.filter((item) => item.path !== filePath);
    this.render();
  },
  toggleMentionPicker() {
    state.mentionPicker = state.mentionPicker ? null : { query: "" };
    this.render();
    if (state.mentionPicker) setTimeout(() => this.root.querySelector("#mentionSearch")?.focus(), 0);
  },

  // --- Deep Research plan editor --------------------------------------------
  startPlanDraft() {
    const plan = state.researchJob?.plan || {};
    state.planDraft = {
      objective: plan.objective || state.researchJob?.objective || "",
      title: state.researchJob?.title || "",
      steps: (plan.steps || []).map((step) => ({ skillId: step.skillId, entrypoint: step.entrypoint, parameters: step.parameters || {} })),
      sources: [...(plan.sources || [])],
      pinned: [...(plan.pinned || [])],
      maxCostUsd: Number(plan.maxCostUsd || 0),
    };
  },
  planAddStep() {
    harvestPlanDraft();
    const skill = (state.researchSkills || []).find((item) => item.ready) || state.researchSkills?.[0];
    if (!skill) return toast("No research skills are available", "error");
    state.planDraft.steps.push({ skillId: skill.id, entrypoint: skill.entrypoints?.[0]?.id || "", parameters: {} });
    this.render();
  },
  planRemoveStep(index) {
    harvestPlanDraft();
    state.planDraft.steps.splice(index, 1);
    this.render();
  },
  planMoveStep(index, dir) {
    harvestPlanDraft();
    const target = index + dir;
    const steps = state.planDraft.steps;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    this.render();
  },
  removePin(filePath) {
    harvestPlanDraft();
    state.planDraft.pinned = state.planDraft.pinned.filter((item) => item.path !== filePath);
    this.render();
  },
  // The "+ Add file" picker lives inside the PINNED FILES panel. It reuses the
  // existing referenceFile() → planDraft.pinned plumbing (the @-mention buttons
  // carry data-ref-*), so the only new surface is this in-panel entry point.
  togglePinPicker() {
    if (state.planDraft) harvestPlanDraft();
    state.pinPicker = state.pinPicker ? null : { query: "" };
    this.render();
    if (state.pinPicker) setTimeout(() => this.root.querySelector("#pinSearch")?.focus(), 0);
  },
  async savePlan(thenApprove = false) {
    if (!state.researchJob) return;
    harvestPlanDraft();
    const draft = state.planDraft;
    if (!draft.objective.trim()) return toast("Describe the objective", "error");
    if (!draft.steps.length) return toast("Add at least one skill step", "error");
    for (const step of draft.steps) {
      try { step.parameters = typeof step.parameters === "string" ? (step.parameters.trim() ? JSON.parse(step.parameters) : {}) : step.parameters; }
      catch { return toast(`Invalid JSON parameters for ${step.skillId}`, "error"); }
      const problems = planValidateParams(planParamSchema(step.skillId, step.entrypoint), step.parameters);
      if (problems.length) return toast(`${step.skillId} parameters: ${problems.join("; ")}`, "error");
    }
    const payload = { objective: draft.objective, title: draft.title, steps: draft.steps, sources: draft.sources, pinned: draft.pinned, maxCostUsd: draft.maxCostUsd };
    const edited = await api(`/api/research/jobs/${state.researchJob.id}/plan`, { method: "PATCH", body: JSON.stringify(payload) });
    state.researchJob = edited.job;
    state.planDraft = null;
    if (thenApprove) {
      if (edited.job.plan?.preflight?.ready === false) { await this.refreshResearch(); this.render(); return toast(edited.job.error || "Preflight blocked — resolve before running", "error"); }
      const approved = await api(`/api/research/jobs/${state.researchJob.id}/approve`, { method: "POST", body: "{}" });
      state.researchJob = approved.job;
      await this.researchAction("run");
    } else {
      await this.refreshResearch();
      this.render();
      toast("Plan saved");
    }
  },

  // A proposed plan is already persisted server-side (plan_json) the moment it is
  // proposed; closing the drawer only nulls the in-memory draft and orphans the
  // job row. "Discard plan" wires the editor to the same delete cascade as the
  // job list (archive to Trash → hard-delete rows + on-disk dir → clear the OCC)
  // and returns to the workflow picker.
  async discardPlan() {
    if (!state.researchJob) return;
    if (!confirm("Discard this plan? The draft job is zipped to your Trash, then removed from the app and the Operational Control Center.")) return;
    const id = state.researchJob.id;
    await api(`/api/research/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.selectedConvs.delete(id);
    state.researchJob = null;
    state.planDraft = null;
    state.pinPicker = null;
    await this.refreshResearch();
    this.render();
    toast("Plan discarded — moved to Trash", "info");
  },
  // Save the tuned plan (steps + sources + cost cap) as a reusable template. The
  // objective and pinned files are intentionally NOT saved — they are per
  // investigation. The server re-validates the steps against the skill catalog.
  async saveAsTemplate() {
    if (!state.researchJob) return;
    if (!state.planDraft) this.startPlanDraft();
    harvestPlanDraft();
    const draft = state.planDraft;
    if (!draft.steps.length) return toast("Add at least one skill step before saving a template", "error");
    let steps;
    try {
      steps = draft.steps.map((step) => ({ skillId: step.skillId, entrypoint: step.entrypoint,
        parameters: typeof step.parameters === "string" ? (step.parameters.trim() ? JSON.parse(step.parameters) : {}) : (step.parameters || {}) }));
    } catch { return toast("Fix invalid JSON parameters before saving a template", "error"); }
    const label = (prompt("Name this template — its steps, sources, and cost cap are reused; objective and pinned files are not.") || "").trim();
    if (!label) return;
    await api("/api/research/templates", { method: "POST", body: JSON.stringify({ label, workflowId: state.researchJob.workflowId, steps, sources: draft.sources, maxCostUsd: draft.maxCostUsd }) });
    await this.refreshTemplates();
    this.render();
    toast(`Template “${label}” saved`);
  },
  // "Start from template" on the workflow picker: create a job on the template's
  // origin workflow, propose, then apply the saved skeleton + any launch-screen
  // pins. The objective is taken from the picker textarea (per investigation).
  async createFromTemplate(templateId) {
    const objective = document.querySelector("#researchObjective")?.value?.trim();
    if (!objective) return toast("Describe the decision or uncertainty to investigate", "error");
    const template = (state.researchTemplates || []).find((item) => item.id === templateId);
    if (!template) return toast("That template is no longer available", "error");
    const created = await api("/api/research/jobs", { method: "POST", body: JSON.stringify({ runId: state.runId, workflowId: template.workflowId, objective, model: state.researchModelDraft || researchDefaultModel(), conversationId: state.conversation?.id, budgetUsd: template.maxCostUsd }) });
    await api(`/api/research/jobs/${created.job.id}/plan`, { method: "POST", body: "{}" });
    const patch = { objective, steps: template.steps, sources: template.sources, maxCostUsd: template.maxCostUsd };
    if (state.mentions.length) patch.pinned = state.mentions;
    const job = (await api(`/api/research/jobs/${created.job.id}/plan`, { method: "PATCH", body: JSON.stringify(patch) })).job;
    state.mentions = [];
    state.researchModelDraft = "";  // next job re-seeds to the medium-tier default
    state.researchJob = job;
    state.planDraft = null;
    await this.refreshResearch();
    this.render();
  },
  async deleteTemplate(templateId) {
    const template = (state.researchTemplates || []).find((item) => item.id === templateId);
    if (template && !confirm(`Delete the template “${template.label}”?`)) return;
    await api(`/api/research/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
    await this.refreshTemplates();
    this.render();
    toast("Template deleted");
  },
  async refreshTemplates() {
    state.researchTemplates = (await api("/api/research/templates")).templates;
  },

  // Collapse/expand a deliverable tier (provenance, code). Collapsed groups don't
  // render their rows, so previews inside them aren't fetched until opened.
  toggleDeliverableGroup(key) {
    state.deliverableGroups = { ...(state.deliverableGroups || {}), [key]: !(state.deliverableGroups || {})[key] };
    this.render();
  },
  // --- Inline deliverable preview -------------------------------------------
  async toggleDeliverable(id, mimeType) {
    const view = state.deliverableViews[id];
    if (view && view.open) { view.open = false; this.render(); return; }
    state.deliverableViews[id] = { open: true, loading: true, mimeType };
    this.render();
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}/content`);
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const text = await response.text();
      state.deliverableViews[id] = { open: true, loading: false, mimeType, text };
    } catch (error) {
      state.deliverableViews[id] = { open: true, loading: false, mimeType, error: error.message };
    }
    this.render();
  },

  async openResearch(jobId) {
    state.researchJob = await api(`/api/research/jobs/${jobId}`);
    if (state.runId) state.artifacts = (await api(`/api/artifacts?runId=${encodeURIComponent(state.runId)}`)).artifacts;
    this.render();
    this.watchResearch();
  },
  // One-click launch. Everything before run is deterministic and free, so the single
  // Investigate click drives create -> plan -> (pin) -> approve -> run with no separate
  // confirm screen. Nothing is billed until run; the cost cap + frozen scope are shown
  // inline above the button. A preflight-blocked run still parks on the (now job-backed)
  // plan editor so the blocker is visible and editable.
  async createResearch(workflowId) {
    const objective = document.querySelector("#researchObjective")?.value?.trim();
    if (!objective) return toast("Describe the decision or uncertainty to investigate", "error");
    const title = document.querySelector("#researchTitle")?.value?.trim() || "";
    const capInput = document.querySelector("#researchBudget");
    const budgetUsd = capInput ? Math.max(0, Number(capInput.value) || 0) : Number(state.config?.research?.defaultBudgetUsd ?? 0);
    const model = state.researchModelDraft || researchDefaultModel();
    try {
      const created = await api("/api/research/jobs", { method: "POST", body: JSON.stringify({ runId: state.runId, workflowId, objective, title, model, conversationId: state.conversation?.id, budgetUsd }) });
      let job = (await api(`/api/research/jobs/${created.job.id}/plan`, { method: "POST", body: "{}" })).job;
      // Carry any files referenced on the launch screen into the proposed plan as pins.
      if (state.mentions.length) job = (await api(`/api/research/jobs/${created.job.id}/plan`, { method: "PATCH", body: JSON.stringify({ pinned: state.mentions }) })).job;
      if (job.plan?.preflight?.ready === false) {
        state.researchJob = job; state.planDraft = null; state.mentions = [];
        await this.refreshResearch(); this.render();
        return toast(job.error || "Preflight blocked — adjust the scope before running", "error");
      }
      const approved = (await api(`/api/research/jobs/${created.job.id}/approve`, { method: "POST", body: "{}" })).job;
      state.researchJob = approved;
      state.mentions = [];
      state.researchTitleDraft = "";
      state.researchObjectiveDraft = "";
      state.researchModelDraft = "";  // next job re-seeds to the medium-tier default
      state.researchScopePreview = null;
      state.planDraft = null;
      await this.researchAction("run");  // POST /run (idempotent) + start watching
    } catch (error) {
      toast(error.message || "Could not start the investigation", "error");
    }
  },
  // Live frozen-scope preview for the composer, fetched before any job exists. Keyed by
  // run+pins (scopePreviewKey) so it refetches only when those change, never per keystroke.
  async refreshScopePreview(key) {
    if (!state.runId) { state.researchScopePreview = null; return; }
    try {
      const objective = document.querySelector("#researchObjective")?.value?.trim() || state.researchObjectiveDraft || "";
      const preview = await api("/api/research/scope-preview", { method: "POST", body: JSON.stringify({ runId: state.runId, workflowId: "freeform", objective, pinned: state.mentions, maxCostUsd: Number(state.config?.research?.defaultBudgetUsd ?? 0) }) });
      state.researchScopePreview = { key, preflight: preview.preflight };
    } catch (error) {
      state.researchScopePreview = { key, error: error.message };
    }
    if (!state.researchJob && selectedPolicy() === "deep-research") this.render();
  },
  selectResearchWorkflow(workflowId) {
    // Every card is a LAUNCHER for the open-investigation path: selecting one shows a
    // short, run-aware form (seeded with its defaults), not a fixed-pipeline
    // canvas. Open investigation is the prompt-first card and has no form.
    state.researchWorkflowId = workflowId;
    state.researchPreview = null;
    state.researchLauncherValues = workflowId && workflowId !== "freeform" ? defaultLauncherValues(state.researchWorkflows.find((item) => item.id === workflowId)) : {};
    this.render();
  },
  // "Open in investigation": compose the card's form into a guard-bearing objective,
  // drop it into the investigation box, and switch to the investigation view so the user
  // can edit and launch. This NEVER starts a fixed pipeline.
  async composeToInvestigation(workflowId) {
    const { objective } = await api(`/api/research/workflows/${encodeURIComponent(workflowId)}/compose`, { method: "POST", body: JSON.stringify({ runId: state.runId, values: state.researchLauncherValues || {} }) });
    state.researchObjectiveDraft = String(objective || "");
    state.researchWorkflowId = "";
    state.researchLauncherValues = {};
    state.researchScopePreview = null;  // re-scope against the freshly composed objective
    this.render();
    const box = document.querySelector("#researchObjective");
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  },
  async researchAction(action, opts = {}) {
    if (!state.researchJob) return;
    // Re-run defaults to the job's OWN model (what it actually ran on) so it never
    // silently swaps — but the split-button menu can pass an explicit model override.
    const body = action === "rerun" ? JSON.stringify({ model: opts.model || state.researchJob.model || researchDefaultModel() }) : "{}";
    const payload = await api(`/api/research/jobs/${state.researchJob.id}/${action}`, { method: "POST", body, headers: action === "run" ? { "Idempotency-Key": `ui-${state.researchJob.id}` } : {} });
    state.researchJob = payload.job;
    await this.refreshResearch();
    this.render();
    this.watchResearch();
  },
  // "Re-run exactly" is a split button: the main face re-runs on the job's own model;
  // the caret opens a menu to re-run on a different one. Open attaches an outside-click
  // closer; closeRerunMenu removes it so the listener never leaks.
  toggleRerunMenu() {
    if (state.rerunMenuOpen) return this.closeRerunMenu();
    state.rerunMenuOpen = true;
    this.render();
    this._rerunDocHandler = (event) => { if (!event.target.closest(".rerun-split")) this.closeRerunMenu(); };
    setTimeout(() => document.addEventListener("mousedown", this._rerunDocHandler, true), 0);
  },
  closeRerunMenu() {
    state.rerunMenuOpen = false;
    if (this._rerunDocHandler) { document.removeEventListener("mousedown", this._rerunDocHandler, true); this._rerunDocHandler = null; }
    this.render();
  },
  // In-thread re-run: reproduce the completed investigation on the same model (no
  // arg) or a different one (from the caret menu) and thread it into THIS job's
  // conversation — no navigation to a new job. Accumulating answers from different
  // models here is what unlocks the Arbiter.
  async rerunInThread(model) {
    const job = state.researchJob; if (!job) return;
    this.closeRerunMenu();
    try {
      await api(`/api/research/jobs/${encodeURIComponent(job.id)}/rerun-thread`, { method: "POST", body: JSON.stringify({ model: model || job.model || researchDefaultModel() }) });
      state.researchJob = await api(`/api/research/jobs/${encodeURIComponent(job.id)}`);
      await this.refreshResearch();
      queueResearchThreadScroll();
      toast("Re-run threaded below — it appears as it runs");
    } catch (error) {
      toast(error.message || "Re-run failed — try again", "error");
    } finally {
      this.render();
      this.watchResearch();  // the threaded re-run child now streams its progress inline
    }
  },
  // Arbiter: run the chosen role over the thread's completed model answers (original
  // report + re-runs). Reads role + model from the panel at click time; the reply
  // threads in like an Ask answer.
  async runArbiter() {
    const job = state.researchJob; if (!job) return;
    if (state.researchFollowupSending) return;
    const role = document.querySelector("#arbiterRole")?.value || state.researchArbiterRole || "distill";
    const model = document.querySelector("#arbiterModel")?.value || job.model;
    state.researchArbiterRole = role;
    state.researchFollowupSending = true;
    this.render();
    try {
      await api(`/api/research/jobs/${encodeURIComponent(job.id)}/arbiter`, { method: "POST", body: JSON.stringify({ role, model }) });
      state.researchJob = await api(`/api/research/jobs/${encodeURIComponent(job.id)}`);
      await this.refreshResearch();
      queueResearchThreadScroll();
      toast("Arbiter synthesis added to the thread");
    } catch (error) {
      toast(error.message || "Arbiter failed — try again", "error");
    } finally {
      state.researchFollowupSending = false;
      this.render();
    }
  },
  // The (i) popover lists what every arbiter role does so the user can read before
  // picking from the dropdown. Outside-click closes it (handler removed on close).
  toggleArbiterInfo() {
    if (state.arbiterInfoOpen) return this.closeArbiterInfo();
    state.arbiterInfoOpen = true;
    this.render();
    this._arbiterInfoHandler = (event) => { if (!event.target.closest(".arbiter-info-wrap, .arbiter-info-pop")) this.closeArbiterInfo(); };
    setTimeout(() => document.addEventListener("mousedown", this._arbiterInfoHandler, true), 0);
  },
  closeArbiterInfo() {
    state.arbiterInfoOpen = false;
    if (this._arbiterInfoHandler) { document.removeEventListener("mousedown", this._arbiterInfoHandler, true); this._arbiterInfoHandler = null; }
    this.render();
  },
  // Ask = constrained Standard Mode (read-only, answers inline). Extend = compute or
  // external, which spawns a traced child run. autoApprove (the "Run extension" button)
  // composes -> approves -> queues the child atomically; "Plan only" (autoApprove=false)
  // stops at an editable child plan. The mode is the visible tab, not a buried dropdown.
  async sendResearchMessage(autoApprove = true) {
    const job = state.researchJob; if (!job) return;
    if (state.researchFollowupSending) return;  // ignore double-clicks while a turn is in flight
    const query = document.querySelector("#researchFollowupQuery")?.value?.trim();
    if (!query) return toast("Write a follow-up question", "error");
    const tab = state.researchFollowupTab || "ask";
    const runtimePolicy = tab === "ask" ? "read_only" : (state.researchExtendMode === "external" ? "external" : "compute");
    // Read every input BEFORE the busy re-render rebuilds the DOM (which would reset them).
    const includes = [...document.querySelectorAll("[data-research-include]:checked")].map((node) => ({ ref: node.value, mode: node.parentElement?.querySelector("[data-include-mode]")?.value || node.dataset.mode || "slice" }));
    const allowedSkills = [...document.querySelectorAll("[data-research-skill]:checked")].map((node) => node.value);
    const sources = [...document.querySelectorAll("[data-research-source]:checked")].map((node) => node.value);
    const capInput = document.querySelector("#researchFollowupBudget");
    const budgetUsd = capInput ? Math.max(0, Number(capInput.value) || 0) : undefined;
    const requestedModel = document.querySelector("#researchFollowupModel")?.value || job.model;
    // Show a waiting state immediately: disable the buttons + textarea and keep the typed
    // text visible, so the model round-trip is never an unindicated hang (and the user
    // can't fire a second turn by clicking again).
    state.researchFollowupSending = true;
    state.researchFollowupDraft = query;
    this.render();
    try {
      const payload = await api(`/api/research/jobs/${encodeURIComponent(job.id)}/messages`, { method: "POST", body: JSON.stringify({ query, requestedModel, includes, allowedSkills, runtimePolicy, sourcePolicy: runtimePolicy === "external" ? { sources } : {}, autoApprove: runtimePolicy === "read_only" ? false : autoApprove, budgetUsd }) });
      state.researchFollowupDraft = "";
      state.researchJob = await api(`/api/research/jobs/${encodeURIComponent(job.id)}`);
      await this.refreshResearch();
      queueResearchThreadScroll();
      const outcome = payload.conversation.messages.at(-1)?.outcome;
      toast(outcome === "extension_run" ? "Extension running — it will thread below" : outcome === "extension_plan" ? "Extension plan created for approval" : "Answered from the completed report");
    } catch (error) {
      toast(error.message || "Follow-up failed — try again", "error");  // draft is preserved for retry
    } finally {
      state.researchFollowupSending = false;
      this.render();
      this.watchResearch();  // a queued child extension now threads its progress inline
    }
  },
  useResearchSuggestion() {
    const suggestion = state.researchJob?.conversation?.suggestion;
    state.researchFollowupDraft = suggestion?.question || "";
    // Seed the right mode: curated external -> Extend/external; recommended compute
    // skills -> Extend/compute; otherwise a read-only Ask.
    if (suggestion?.external_access === "curated") { state.researchFollowupTab = "extend"; state.researchExtendMode = "external"; }
    else if (Array.isArray(suggestion?.recommended_skills) && suggestion.recommended_skills.length) { state.researchFollowupTab = "extend"; state.researchExtendMode = "compute"; }
    else state.researchFollowupTab = "ask";
    this.render();
    document.querySelector("#researchFollowupQuery")?.focus();
  },
  setFollowupTab(tab) {
    const node = document.querySelector("#researchFollowupQuery"); if (node) state.researchFollowupDraft = node.value;
    state.researchFollowupTab = tab; this.render();
  },
  setExtendMode(mode) {
    const node = document.querySelector("#researchFollowupQuery"); if (node) state.researchFollowupDraft = node.value;
    state.researchExtendMode = mode; this.render();
  },
  async generateResearchSuggestion() {
    const job = state.researchJob; if (!job) return;
    await api(`/api/research/jobs/${encodeURIComponent(job.id)}/followup-suggestion`, { method: "POST", body: "{}" });
    state.researchJob = await api(`/api/research/jobs/${encodeURIComponent(job.id)}`); this.render();
  },
  async approveAndRun() {
    if (!state.researchJob) return;
    if (!state.planDraft) this.startPlanDraft();
    await this.savePlan(true);
  },
  async refreshResearch() {
    if (!state.runId) return;
    state.researchJobs = (await api(`/api/research/jobs?runId=${encodeURIComponent(state.runId)}`)).jobs;
    if (state.researchJob) state.researchJob = await api(`/api/research/jobs/${state.researchJob.id}`);
    state.artifacts = (await api(`/api/artifacts?runId=${encodeURIComponent(state.runId)}`)).artifacts;
    await this.refreshResearchChildren();
  },
  // Pull fresh snapshots of any child extension jobs the open conversation references,
  // so their inline progress/answer (renderChildExtension) stays current as they run.
  async refreshResearchChildren() {
    const conv = state.researchJob?.conversation;
    const ids = conv ? [...new Set((conv.messages || []).map((message) => message.childJobId).filter(Boolean))] : [];
    if (!ids.length) { state.researchChildJobs = {}; return; }
    const next = {};
    for (const childId of ids) {
      try { next[childId] = await api(`/api/research/jobs/${encodeURIComponent(childId)}`); }
      catch { next[childId] = (state.researchChildJobs || {})[childId] || null; }
    }
    state.researchChildJobs = next;
  },
  watchResearch() {
    clearTimeout(state.researchTimer);
    const main = state.researchJob;
    if (!main) return;
    const mainBusy = ["queued", "running", "approved"].includes(main.state);
    const childBusy = Object.values(state.researchChildJobs || {}).some((child) => child && ["queued", "running", "approved"].includes(child.state));
    if (!mainBusy && !childBusy) return;
    state.researchTimer = setTimeout(async () => {
      try { await this.refreshResearch(); this.render(); this.watchResearch(); } catch (error) { toast(error.message, "error"); }
    }, 700);
  },

  render() {
    const root = this.root;
    const run = root.querySelector("#runPicker");
    run.innerHTML = state.runs.length
      ? state.runs.map((item) => `<option value="${esc(item.id)}" ${item.id === state.runId ? "selected" : ""}>${esc(item.name || item.id)}</option>`).join("")
      : '<option value="">No completed runs</option>';
    renderModelPicker();
    root.querySelector("#policyPicker").value = selectedPolicy();
    root.querySelector("#policyPicker").disabled = !state.config?.deepResearchEnabled || state.streaming;
    renderConversations();
    renderMessages();
    renderRightRail();
    renderStatus();
    flushResearchThreadScroll();
    root.querySelector("#operationsBtn").classList.toggle("hidden", !state.config?.operationsCenter);
    root.querySelector("#attachmentStrip").innerHTML = state.attachments.map((item) => `<span class="attachment">${icon("paperclip")}${esc(item.relPath.split("/").pop())}</span>`).join("");
    root.querySelector("#mentionStrip").innerHTML = state.mentions.map((item) => `<span class="mention-chip">@${esc(item.scope)}/${esc(item.name)}<button data-remove-mention="${esc(item.path)}" aria-label="Remove reference">${icon("close")}</button></span>`).join("");
    renderMentionPicker();
    const send = root.querySelector("#sendBtn");
    send.classList.toggle("stop", state.streaming);
    send.innerHTML = state.streaming ? `${icon("stop")} Stop` : `${icon("send")} Send`;
    root.querySelector("#modelPicker").disabled = state.streaming;
    const deep = selectedPolicy() === "deep-research";
    // The header model picker is Standard's sticky per-conversation control. Deep
    // Research picks its model per job in the launch form (and per turn in
    // follow-ups), so the top selector is hidden in DR mode to kill the old
    // "one floating override for everything" ambiguity.
    root.querySelector(".model-field")?.classList.toggle("hidden", deep);
    root.querySelector("#newBtn").innerHTML = `${icon("plus")} ${deep ? "New research" : "New conversation"}`;
    root.querySelector(".composer-wrap").classList.toggle("hidden", deep);
    root.querySelector("#messages").classList.toggle("research-workspace", deep);
    renderDrawer();
  },
};

function appendTrace(message, label, text) {
  const last = message.trace.at(-1);
  if (last?.label === label) last.text += text;
  else message.trace.push({ label, text });
}
function groundingFamilyLabel(family) {
  return ({
    "differential-expression": "Differential expression",
    "module-assignments": "Module assignments",
    "module-traits": "Module–trait correlations",
    "go-enrichment": "GO enrichment",
    "cell-type": "Cell-type enrichment",
    "sample-metadata": "Sample metadata",
    "run-metadata": "Run metadata",
  })[family] || (family ? String(family) : "Run artifact");
}
// Renders the "which run files grounded this answer" panel beneath an assistant
// message, sourced from the persisted provenance (see server grounding_selected).
function renderGrounding(message) {
  if (message.status === "streaming") return "";
  const provenance = Array.isArray(message.provenance) ? message.provenance : [];
  const runFiles = provenance.filter((item) => item && item.kind === "run-artifact");
  const runCard = provenance.find((item) => item && item.kind === "run-card");
  const externals = provenance.filter((item) => item && item.kind === "external-allowed");
  if (!runFiles.length && !runCard) return ""; // legacy message, grounding not recorded
  const externalLine = externals.length
    ? `<div class="grounding-ext">External sources allowed this turn: ${esc(externals.map((item) => item.source).join(", "))}</div>`
    : "";
  if (!runFiles.length) {
    return `<div class="grounding-note"><b>Grounding</b> · Answered from the run overview card only — no run files were retrieved for this question.</div>${externalLine}`;
  }
  const rows = runFiles.map((file) => {
    const name = String(file.path || "").split("/").pop() || String(file.path || "");
    const meta = [groundingFamilyLabel(file.family), Number(file.rowsReturned) ? `${file.rowsReturned} rows used` : "", file.truncated ? "truncated to budget" : ""].filter(Boolean).join(" · ");
    const why = file.reason ? `<div class="grounding-why">${esc(file.reason)}</div>` : "";
    return `<div class="grounding-file"><div class="grounding-file-name" title="${esc(file.path)}">${esc(name)}</div>${meta ? `<div class="grounding-file-meta">${esc(meta)}</div>` : ""}${why}</div>`;
  }).join("");
  const label = `${runFiles.length} run file${runFiles.length === 1 ? "" : "s"}`;
  return `<details class="grounding"><summary>Grounding · ${label}</summary><div class="grounding-intro">Files from this run that were read to ground the answer.</div>${rows}${externalLine}</details>`;
}
function enabledModelIds() {
  return state.config?.enabledModels?.length ? state.config.enabledModels : [state.config?.defaultModel].filter(Boolean);
}
function modelChoices() {
  const enabled = new Set(enabledModelIds());
  const choices = state.models.filter((model) => enabled.has(model.id));
  const currentId = state.conversation?.model;
  if (currentId && !choices.some((model) => model.id === currentId)) {
    choices.push(state.models.find((model) => model.id === currentId) || { id: currentId, name: currentId.replace(/^openrouter\//, ""), provider: currentId.startsWith("openrouter/") ? "openrouter" : "anthropic" });
  }
  return sortModels(choices);
}
function selectedModel() {
  // Standard mode only: an open conversation's own sticky model, else the
  // header pick captured for a not-yet-created conversation (modelOverride,
  // consumed on the first send), else the configured default tier. Deep
  // Research no longer reads this — its model is an explicit per-job field
  // (researchDefaultModel / state.researchModelDraft) so it can never silently
  // revert to the default tier between launches the way the old override did.
  return state.conversation?.model || state.modelOverride || state.config?.defaultModel || "";
}
// Deep Research seeds its per-job model from the MEDIUM tier configured in the
// Configuration Panel — a balanced model for a long agentic run — NOT the global
// default tier, so a cheap default tier can't silently capture every research
// job. Falls back to the default tier, then the configured model.
function researchDefaultModel() {
  return state.config?.modelTiers?.medium || state.config?.defaultModel || "";
}
// Options for the Deep Research launch picker: the enabled-model menu, plus the
// currently-seeded model if it isn't in that menu (so the medium-tier default is
// always selectable even when it was left out of the conversation menu).
function researchModelChoices() {
  const want = state.researchModelDraft || researchDefaultModel();
  const choices = modelChoices();
  if (want && !choices.some((model) => model.id === want)) {
    choices.unshift(state.models.find((model) => model.id === want) || { id: want, name: want.replace(/^openrouter\//, "") });
  }
  return { want, choices };
}
function selectedPolicy() {
  return state.conversation?.policy || document.querySelector("#policyPicker")?.value || state.config?.defaultPolicy || "standard";
}
function selectedSources() {
  return [...document.querySelectorAll("[data-source]:checked")].map((node) => node.dataset.source);
}
// Unified, run-scoped file universe for @-mentions and pins. Run-relative paths
// match the backend: context files as-is; uploads/generated under ai_insights/.
function runFileCatalog() {
  const context = (state.context || []).map((item) => ({ scope: "context", path: item.path, name: item.name }));
  const uploads = (state.artifacts || []).filter((item) => item.kind === "attachment").map((item) => ({ scope: "myfiles", path: `ai_insights/${item.relPath}`, name: baseName(item.relPath) }));
  const generated = (state.artifacts || []).filter((item) => item.kind !== "attachment").map((item) => ({ scope: "artifacts", path: `ai_insights/${item.relPath}`, name: baseName(item.relPath) }));
  return { context, uploads, generated };
}
function allRunFiles() {
  const { context, uploads, generated } = runFileCatalog();
  return [...context, ...uploads, ...generated];
}
// Read the live plan-editor DOM back into the draft so reorder/add/remove and
// save never lose in-progress edits to fields that haven't fired change yet.
function harvestPlanDraft() {
  if (!state.planDraft) return;
  const root = AIInsightsApp.root;
  const objective = root.querySelector("#planObjective");
  if (objective) state.planDraft.objective = objective.value;
  const planTitle = root.querySelector("#planTitle");
  if (planTitle) state.planDraft.title = planTitle.value;
  const budget = root.querySelector("#planBudget");
  if (budget) state.planDraft.maxCostUsd = Math.max(0, Number(budget.value) || 0);
  if (root.querySelector("[data-plan-source]")) state.planDraft.sources = [...root.querySelectorAll("[data-plan-source]:checked")].map((node) => node.dataset.planSource);
  root.querySelectorAll("[data-plan-step][data-field]").forEach((node) => {
    const step = state.planDraft.steps[Number(node.dataset.planStep)];
    if (!step) return;
    if (node.dataset.field === "skillId") step.skillId = node.value;
    else if (node.dataset.field === "entrypoint") step.entrypoint = node.value;
    else if (node.dataset.field === "params") step.parameters = node.value;
  });
}

// Live-validate a params textarea against its entrypoint schema without a full
// re-render, so the inline error tracks each keystroke.
function updatePlanParamError(node) {
  const index = Number(node.dataset.planStep);
  const step = state.planDraft?.steps[index];
  if (!step) return;
  const schema = planParamSchema(step.skillId, step.entrypoint);
  const raw = node.value.trim();
  let problems;
  if (!raw) problems = planValidateParams(schema, {});
  else { try { problems = planValidateParams(schema, JSON.parse(raw)); } catch { problems = ["Invalid JSON"]; } }
  node.classList.toggle("invalid", problems.length > 0);
  const slot = node.parentElement?.querySelector(`[data-plan-error="${index}"]`);
  if (slot) slot.textContent = problems.length ? problems.join("; ") : "";
}

function bind(root) {
  root.addEventListener("change", (event) => void handleChange(event).catch((error) => toast(error.message, "error")));
  root.addEventListener("click", (event) => void handleClick(event).catch((error) => toast(error.message, "error")));
  root.addEventListener("input", (event) => {
    if (event.target.id === "modelSearch") renderModelConfiguration(event.target.value);
    if (event.target.id === "mentionSearch" && state.mentionPicker) { state.mentionPicker.query = event.target.value; renderMentionPicker(); }
    if (event.target.id === "pinSearch" && state.pinPicker) { state.pinPicker.query = event.target.value; renderPinPicker(); }
    if (event.target.id === "researchObjective") state.researchObjectiveDraft = event.target.value;
    if (event.target.id === "researchTitle") state.researchTitleDraft = event.target.value;
    if (event.target.dataset.launcherField) captureLauncherField(event.target);
    // Typing "@" in the composer opens the file-reference picker.
    if (event.target.id === "prompt" && event.data === "@" && !state.mentionPicker) AIInsightsApp.toggleMentionPicker();
    if (event.target.classList?.contains("plan-params")) updatePlanParamError(event.target);
  });
  root.querySelector("#prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void AIInsightsApp.send(); }
  });
  root.querySelector("#fileInput").addEventListener("change", (event) => {
    for (const file of event.target.files) void AIInsightsApp.upload(file);
    event.target.value = "";
  });
  // Track whether the reader is pinned to the bottom so streaming auto-scroll
  // never fights a user who has scrolled up to read the reasoning trace. The
  // #messages element persists across renders (only its children are replaced),
  // so this listener is wired once.
  const messages = root.querySelector("#messages");
  messages.addEventListener("scroll", () => {
    state.pinnedToBottom = isNearBottom(messages);
  });
}
// Mirror a launcher form field into state without re-rendering (which would
// drop focus / transient checkbox state). Multiselects re-read every box for
// that field so the stored value is always the full current selection.
function captureLauncherField(el) {
  const id = el.dataset.launcherField;
  if (!id) return;
  const values = state.researchLauncherValues || (state.researchLauncherValues = {});
  if (el.dataset.multi) values[id] = [...document.querySelectorAll(`input[data-launcher-field="${id}"][data-multi]`)].filter((box) => box.checked).map((box) => box.value);
  else if (el.type === "checkbox") values[id] = el.checked;
  else if (el.type === "number") values[id] = el.value === "" ? "" : Number(el.value);
  else values[id] = el.value;
}
async function handleChange(event) {
  const target = event.target;
  if (target.dataset.launcherField) return captureLauncherField(target);
  if (target.id === "researchModel") state.researchModelDraft = target.value;
  if (target.dataset.arbiterRole !== undefined) state.researchArbiterRole = target.value;
  // Changing a step's skill or operation repopulates the entrypoint menu and
  // resets that step's parameters to the new operation's schema defaults.
  if (target.dataset.planStep && (target.dataset.field === "skillId" || target.dataset.field === "entrypoint")) {
    harvestPlanDraft();
    const step = state.planDraft?.steps[Number(target.dataset.planStep)];
    if (step) {
      if (target.dataset.field === "skillId") step.entrypoint = planEntrypoint(step.skillId)?.id || "";
      step.parameters = planDefaultParams(planParamSchema(step.skillId, step.entrypoint));
    }
    AIInsightsApp.render();
    return;
  }
  if (target.dataset.select) {
    target.checked ? state.selectedConvs.add(target.dataset.select) : state.selectedConvs.delete(target.dataset.select);
    renderConversations();
    return;
  }
  if (target.matches("[data-model-enabled]")) {
    if (!state.modelDraft) state.modelDraft = new Set(enabledModelIds());
    target.checked ? state.modelDraft.add(target.value) : state.modelDraft.delete(target.value);
    const count = document.querySelector("#modelCount");
    if (count) count.textContent = `${state.modelDraft.size} selected`;
  }
  if (target.id === "modelSort") {
    state.config.modelSort = target.value;
    renderModelPicker();
    renderModelConfiguration(document.querySelector("#modelSearch")?.value || "");
  }
  if (target.dataset.tier) {
    if (!state.tierDraft) state.tierDraft = { high: "", medium: "", low: "" };
    state.tierDraft[target.dataset.tier] = target.value;
    // Assigning a model to a tier when none is the default yet promotes it.
    if (target.value && !state.defaultTierDraft) state.defaultTierDraft = target.dataset.tier;
    updateTierHint();
  }
  if (target.dataset.defaultTier !== undefined && target.checked) {
    state.defaultTierDraft = target.value;
    updateTierHint();
  }
  if (target.id === "networkSkillsToggle") {
    // Single switch — persist immediately; revert the box if the server rejects.
    const enabled = target.checked;
    try {
      const payload = await api("/api/settings/research", { method: "PUT", body: JSON.stringify({ networkSkillsEnabled: enabled }) });
      state.config.research = { ...(state.config.research || {}), networkSkillsEnabled: payload.networkSkillsEnabled };
      toast(payload.networkSkillsEnabled ? "Network skills enabled — a job must still approve each one" : "Network skills disabled");
    } catch (error) { target.checked = !enabled; throw error; }
  }
  if (target.id === "runPicker") await AIInsightsApp.selectRun(target.value);
  if (target.id === "policyPicker") {
    // The picker is a MODE selector, not a "convert this conversation" control.
    // If an open conversation's policy differs from the chosen mode, leave it
    // intact in the rail and switch modes with a clean slate (DR launch screen /
    // Standard composer). Patching an open Standard chat to deep-research used to
    // orphan its thread and leave a phantom in the rail; and since selectedPolicy()
    // prefers an open conversation's policy over the picker, the switch couldn't
    // even take effect without deselecting first.
    if (state.conversation && state.conversation.policy !== target.value) AIInsightsApp.deselectConversation();
    if (target.value === "deep-research") await AIInsightsApp.refreshResearch();
    AIInsightsApp.render();
  }
  if (target.id === "modelPicker") {
    // Open conversation: persist the model to it. New launch (no conversation):
    // record a one-shot override for this staging session (cleared on launch).
    if (state.conversation) await AIInsightsApp.patchConversation({ model: target.value });
    else state.modelOverride = target.value;
  }
}
async function handleClick(event) {
  const button = event.target.closest("button,[data-conversation]");
  if (!button) return;
  if (button.dataset.conversation) {
    if (!state.selectMode) return AIInsightsApp.openConversation(button.dataset.conversation);
    const id = button.dataset.conversation;
    state.selectedConvs.has(id) ? state.selectedConvs.delete(id) : state.selectedConvs.add(id);
    renderConversations();
    return;
  }
  if (button.id === "newBtn") return selectedPolicy() === "deep-research" ? AIInsightsApp.newResearch() : AIInsightsApp.newConversation();
  if (button.id === "renameBtn") return AIInsightsApp.rename();
  if (button.id === "clearBtn") return AIInsightsApp.clear();
  if (button.id === "convSelectToggle") return AIInsightsApp.toggleSelectMode();
  if (button.id === "convDeleteSelected") return AIInsightsApp.bulkDelete();
  if (button.id === "exportBtn") return AIInsightsApp.export();
  if (button.id === "sendBtn") return state.streaming ? AIInsightsApp.stop() : AIInsightsApp.send();
  if (button.dataset.rail) { if (state.planDraft) harvestPlanDraft(); state.rail = button.dataset.rail; AIInsightsApp.render(); return; }
  if (button.dataset.researchCatalog) return toggleResearchDataUsed(button.dataset.researchCatalog);
  if (button.id === "orResync") return refreshOpenRouterSpend(true);
  if (button.id === "settingsBtn") return toggleDrawer(true);
  if (button.id === "closeSettings" || button.id === "drawerBackdrop") return toggleDrawer(false);
  if (button.dataset.feedback) return AIInsightsApp.feedback(button.dataset.feedback, Number(button.dataset.rating));
  if (button.dataset.pin) return AIInsightsApp.pin(button.dataset.pin, button.dataset.pinned !== "true");
  if (button.dataset.note) {
    const note = prompt("Append a note to this answer's run ledger:");
    if (note !== null) return AIInsightsApp.feedback(button.dataset.note, null, note);
  }
  if (button.id === "saveKey") return saveCredential();
  if (button.id === "saveModels") return saveModelConfiguration();
  if (button.id === "saveModelTiers") return saveModelTiers();
  if (button.id === "refreshModels") {
    button.disabled = true;
    await AIInsightsApp.loadModels(true);
    renderModelConfiguration();
    button.disabled = false;
    return toast("Model catalog refreshed");
  }
  if (button.id === "attachBtn" || button.id === "railUploadBtn") AIInsightsApp.root.querySelector("#fileInput").click();
  if (button.id === "mentionBtn") return AIInsightsApp.toggleMentionPicker();
  if (button.dataset.refScope) return AIInsightsApp.referenceFile(button.dataset.refScope, button.dataset.refPath, button.dataset.refName);
  if (button.dataset.removeMention !== undefined) return AIInsightsApp.removeMention(button.dataset.removeMention);
  if (button.dataset.deliverable !== undefined) return AIInsightsApp.toggleDeliverable(button.dataset.deliverable, button.dataset.mime || "");
  if (button.dataset.deliverableGroup) return AIInsightsApp.toggleDeliverableGroup(button.dataset.deliverableGroup);
  if (button.id === "planAddStep") return AIInsightsApp.planAddStep();
  if (button.id === "planAddPin") return AIInsightsApp.togglePinPicker();
  if (button.dataset.planMove !== undefined) return AIInsightsApp.planMoveStep(Number(button.dataset.planMove), button.dataset.dir === "up" ? -1 : 1);
  if (button.dataset.planRemove !== undefined) return AIInsightsApp.planRemoveStep(Number(button.dataset.planRemove));
  if (button.dataset.planUnpin !== undefined) return AIInsightsApp.removePin(button.dataset.planUnpin);
  if (button.dataset.researchTemplate) return AIInsightsApp.createFromTemplate(button.dataset.researchTemplate);
  if (button.dataset.templateDelete !== undefined) return AIInsightsApp.deleteTemplate(button.dataset.templateDelete);
  if (button.dataset.openConversation) return AIInsightsApp.backToConversation(button.dataset.openConversation);
  if (button.dataset.researchJob) {
    if (!state.selectMode) return AIInsightsApp.openResearch(button.dataset.researchJob);
    const id = button.dataset.researchJob;
    state.selectedConvs.has(id) ? state.selectedConvs.delete(id) : state.selectedConvs.add(id);
    renderConversations();
    return;
  }
  if (button.dataset.researchWorkflow) return AIInsightsApp.selectResearchWorkflow(button.dataset.researchWorkflow);
  if (button.dataset.researchCompose) return AIInsightsApp.composeToInvestigation(button.dataset.researchCompose);
  if (button.dataset.researchStart) return AIInsightsApp.createResearch(button.dataset.researchStart);
  if (button.dataset.researchFollowupTab) return AIInsightsApp.setFollowupTab(button.dataset.researchFollowupTab);
  if (button.dataset.researchExtendMode) return AIInsightsApp.setExtendMode(button.dataset.researchExtendMode);
  if (button.id === "researchFollowupSend") return AIInsightsApp.sendResearchMessage(true);
  if (button.id === "researchFollowupPlan") return AIInsightsApp.sendResearchMessage(false);
  if (button.dataset.rerunMenu !== undefined) return AIInsightsApp.toggleRerunMenu();
  if (button.dataset.rerunThread !== undefined) return AIInsightsApp.rerunInThread();
  if (button.dataset.rerunThreadModel) return AIInsightsApp.rerunInThread(button.dataset.rerunThreadModel);
  if (button.id === "arbiterRun") return AIInsightsApp.runArbiter();
  if (button.dataset.arbiterInfo !== undefined) return AIInsightsApp.toggleArbiterInfo();
  if (button.id === "researchUseSuggestion") return AIInsightsApp.useResearchSuggestion();
  if (button.id === "researchGenerateSuggestion") return AIInsightsApp.generateResearchSuggestion();
  if (button.dataset.researchAction === "save-plan") return AIInsightsApp.savePlan(false);
  if (button.dataset.researchAction === "approve-run") return AIInsightsApp.approveAndRun();
  if (button.dataset.researchAction === "discard-plan") return AIInsightsApp.discardPlan();
  if (button.dataset.researchAction === "save-template") return AIInsightsApp.saveAsTemplate();
  if (button.dataset.researchAction) return AIInsightsApp.researchAction(button.dataset.researchAction);
}

async function saveCredential() {
  const provider = document.querySelector("#keyProvider").value;
  const apiKey = document.querySelector("#apiKey").value;
  await api("/api/settings/credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey }) });
  document.querySelector("#apiKey").value = "";
  state.config = await api("/api/config");
  AIInsightsApp.render();
  toast(`${provider === "openrouter" ? "OpenRouter" : "Anthropic"} key encrypted and saved`);
}
async function saveModelConfiguration() {
  const modelIds = [...(state.modelDraft || new Set(enabledModelIds()))];
  const payload = await api("/api/settings/models", { method: "PUT", body: JSON.stringify({ modelIds, sortMode: state.config?.modelSort || "intelligence" }) });
  state.config.enabledModels = payload.enabledModels;
  state.config.modelSort = payload.modelSort;
  state.modelDraft = new Set(payload.enabledModels);
  AIInsightsApp.render();
  toast("Conversation model menu updated");
}
async function saveModelTiers() {
  const tiers = state.tierDraft || { high: "", medium: "", low: "" };
  const defaultTier = state.defaultTierDraft || "";
  if (!["high", "medium", "low"].includes(defaultTier)) return toast("Choose which tier is the default", "error");
  if (!tiers[defaultTier]) return toast(`Assign a model to the ${defaultTier} tier before making it the default`, "error");
  const payload = await api("/api/settings/model-tiers", { method: "PUT", body: JSON.stringify({ tiers, defaultTier }) });
  state.config.modelTiers = payload.modelTiers;
  state.config.defaultTier = payload.defaultTier;
  state.config.defaultModel = payload.defaultModel;
  AIInsightsApp.render();
  toast("Default models updated");
}

function renderModelPicker() {
  const picker = document.querySelector("#modelPicker");
  if (!picker) return;
  const choices = modelChoices();
  // An open conversation's model is the source of truth (changing the picker
  // patches it). A NEW launch (no conversation) shows the configured default
  // tier unless the researcher made an explicit pick this staging session
  // (modelOverride) — which survives the launcher's re-renders but is cleared on
  // launch/new/reload, so each run starts at the default (non-sticky).
  const current = state.conversation?.model || state.modelOverride || state.config?.defaultModel || "";
  picker.innerHTML = choices.length
    ? choices.map((model) => `<option value="${esc(model.id)}" ${model.id === current ? "selected" : ""}>${esc(model.name)} · ${esc(intelligenceLabel(model))} · ${esc(modelCostLabel(model))}</option>`).join("")
    : '<option value="">Configure models first</option>';
}
function renderConversations() {
  if (selectedPolicy() === "deep-research") {
    document.querySelector(".conv-heading .label").textContent = "Research jobs";
    if (!state.researchJobs.length) state.selectMode = false;
    // Drop any selected ids that no longer exist (e.g. after a delete, or when
    // switching here from the conversation list which shares the selection set).
    const presentJobs = new Set(state.researchJobs.map((job) => job.id));
    for (const id of [...state.selectedConvs]) if (!presentJobs.has(id)) state.selectedConvs.delete(id);
    const jobToggle = document.querySelector("#convSelectToggle");
    if (jobToggle) {
      jobToggle.classList.toggle("hidden", state.researchJobs.length === 0);
      jobToggle.textContent = state.selectMode ? "Cancel" : "Select";
    }
    document.querySelector("#conversationList").innerHTML = state.researchJobs.length
      ? state.researchJobs.map((job) => {
          const checkbox = state.selectMode
            ? `<label class="conv-select"><input type="checkbox" data-select="${esc(job.id)}" ${state.selectedConvs.has(job.id) ? "checked" : ""} aria-label="Select research job"></label>`
            : "";
          return `<li class="conv-li${state.selectMode ? " selecting" : ""}">${checkbox}<button class="conv-row ${job.id === state.researchJob?.id ? "active" : ""}" data-research-job="${esc(job.id)}"><span class="conv-title">${esc(job.title || job.objective)}</span><span class="conv-meta"><span class="conv-meta-main">${esc(job.state.replaceAll("_", " ")) } · ${esc(job.workflowId)}</span><time class="conv-time">${esc(stamp(job.updatedAt))}</time></span></button></li>`;
        }).join("")
      : '<li class="rail-empty">No research jobs for this run yet.</li>';
    renderConvBulkBar();
    return;
  }
  document.querySelector(".conv-heading .label").textContent = "Conversations";
  if (!state.conversations.length) state.selectMode = false;
  // Drop any selected ids that no longer exist (e.g. after a delete/run switch).
  const present = new Set(state.conversations.map((conversation) => conversation.id));
  for (const id of [...state.selectedConvs]) if (!present.has(id)) state.selectedConvs.delete(id);
  const toggle = document.querySelector("#convSelectToggle");
  if (toggle) {
    toggle.classList.toggle("hidden", state.conversations.length === 0);
    toggle.textContent = state.selectMode ? "Cancel" : "Select";
  }
  document.querySelector("#conversationList").innerHTML = state.conversations.length
    ? state.conversations.map((conversation) => {
        const checkbox = state.selectMode
          ? `<label class="conv-select"><input type="checkbox" data-select="${esc(conversation.id)}" ${state.selectedConvs.has(conversation.id) ? "checked" : ""} aria-label="Select conversation"></label>`
          : "";
        return `<li class="conv-li${state.selectMode ? " selecting" : ""}">${checkbox}<button class="conv-row ${conversation.id === state.conversation?.id ? "active" : ""}" data-conversation="${esc(conversation.id)}"><span class="conv-title">${esc(conversation.title)}</span><span class="conv-meta"><span class="conv-meta-main">${esc(conversation.policy === "deep-research" ? "Deep Research" : "Standard")} · ${esc(conversation.model?.split("/").pop() || "No model")}</span><time class="conv-time">${esc(stamp(conversation.updatedAt))}</time></span></button></li>`;
      }).join("")
    : '<li class="rail-empty">No conversations for this run yet.</li>';
  renderConvBulkBar();
}
function renderConvBulkBar() {
  const bar = document.querySelector("#convBulkBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !state.selectMode);
  if (!state.selectMode) { bar.innerHTML = ""; return; }
  const count = state.selectedConvs.size;
  bar.innerHTML = `<span class="conv-bulk-count">${count} selected</span><div class="conv-bulk-actions"><button id="convDeleteSelected" class="btn danger tiny" ${count === 0 ? "disabled" : ""} title="Zip to Trash and delete">${icon("trash")} Delete</button></div>`;
}
function renderMessages() {
  const host = document.querySelector("#messages");
  if (selectedPolicy() === "deep-research") return renderResearchWorkspace(host);
  if (!state.messages.length) {
    host.innerHTML = `<div class="empty"><div class="empty-mark">SF</div><p class="eyebrow">Grounded research workspace</p><h1>Ask the run a better question.</h1><p>SignalFold AI reads immutable pipeline evidence, keeps every conversation with its run, and shows the model and cost behind each answer.</p><div class="starter-grid"><button data-starter="Summarize the strongest biological signal in this run.">Summarize the biological signal</button><button data-starter="Which findings are robust, and which need validation?">Separate evidence from uncertainty</button></div></div>`;
    host.querySelectorAll("[data-starter]").forEach((button) => button.addEventListener("click", () => {
      document.querySelector("#prompt").value = button.dataset.starter;
      document.querySelector("#prompt").focus();
    }));
    return;
  }
  host.innerHTML = state.messages.map(renderMessageHTML).join("");
  wireTraceToggles(host);
}

// Friendly labels for the durable research deliverables so the completed view
// can link each file by what it is, not its internal kind slug.
const RESEARCH_ARTIFACT_LABELS = {
  "research-report": "HTML report", "decision-summary": "Decision summary", "evidence-record": "Evidence record",
  "computation-manifest": "Computation manifest", "research-artifact-index": "Artifact index", "research-rerun": "Re-run action",
  "research-open-questions": "Open questions", "research-next-step": "Recommended next step", "research-scope-manifest": "Frozen scope manifest",
  "research-external-evidence": "External evidence", "research-data": "Computed data", "research-table": "Computed table", "research-figure": "Computed figure",
  "research-answer": "Answer record",
};
// Defaults for a card's short form, taken straight from its launcher spec.
function defaultLauncherValues(workflow) {
  return Object.fromEntries(((workflow?.launcher?.fields) || []).map((field) => [field.id, Array.isArray(field.default) ? [...field.default] : field.default]));
}
const launcherOption = (opt) => (typeof opt === "string" ? { value: opt, label: opt } : opt);
// One form field -> HTML. Values carry a data-launcher-field id so the change/
// input listeners can mirror them into state.researchLauncherValues.
function renderLauncherField(field, values) {
  const current = values[field.id] ?? field.default;
  const help = field.help ? `<small class="muted">${esc(field.help)}</small>` : "";
  if (field.type === "select") {
    const opts = (field.options || []).map((opt) => { const o = launcherOption(opt); return `<option value="${esc(o.value)}" ${String(current) === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`; }).join("");
    const blank = field.from === "candidates" ? `<option value="" ${current ? "" : "selected"}>${(field.options || []).length ? "— optional —" : "(no run-derived target — run-level question)"}</option>` : "";
    return `<label class="launcher-field"><span>${esc(field.label)}</span><select data-launcher-field="${esc(field.id)}">${blank}${opts}</select>${help}</label>`;
  }
  if (field.type === "multiselect") {
    const chosen = Array.isArray(current) ? current.map(String) : [];
    const boxes = (field.options || []).map((opt) => { const o = launcherOption(opt); return `<label class="launcher-chk" title="${esc(o.hint || "")}"><input type="checkbox" data-launcher-field="${esc(field.id)}" data-multi="1" value="${esc(o.value)}" ${chosen.includes(String(o.value)) ? "checked" : ""}><span>${esc(o.label)}</span></label>`; }).join("");
    return `<div class="launcher-field"><span>${esc(field.label)}</span><div class="launcher-checks">${boxes || '<small class="muted">No run-derived options.</small>'}</div>${help}</div>`;
  }
  if (field.type === "toggle") {
    return `<label class="launcher-field launcher-toggle"><input type="checkbox" data-launcher-field="${esc(field.id)}" ${current ? "checked" : ""}><span>${esc(field.label)}</span>${help}</label>`;
  }
  if (field.type === "number") {
    return `<label class="launcher-field"><span>${esc(field.label)}</span><input type="number" step="any" data-launcher-field="${esc(field.id)}" value="${esc(current)}">${help}</label>`;
  }
  return `<label class="launcher-field"><span>${esc(field.label)}</span><input type="text" data-launcher-field="${esc(field.id)}" value="${esc(current ?? "")}" placeholder="${esc(field.placeholder || "")}">${help}</label>`;
}
// A card is a LAUNCHER for open investigation: a short, run-aware form whose values
// compose a guard-bearing objective. One button drops that objective into the
// investigation box; no fixed pipeline is ever started here.
function renderWorkflowLauncher(workflow) {
  if (!workflow) return "";
  const fields = (workflow.launcher?.fields) || [];
  const values = state.researchLauncherValues || {};
  const rows = fields.map((field) => renderLauncherField(field, values)).join("");
  return `<section class="workflow-canvas launcher" aria-label="${esc(workflow.label)} launcher">
    <div class="workflow-canvas-head"><div><p class="eyebrow">Template · ${esc(workflow.label)}</p><h2>${esc(workflow.decisionPrompt)}</h2></div><span class="workflow-readiness executable">Runs code</span></div>
    <p class="launcher-lede">${esc(workflow.description)} Answer a few run-specific inputs and we build a guard-correct investigation prompt you can edit before launching.</p>
    <div class="launcher-form">${rows || '<small class="muted">This preset needs no inputs.</small>'}</div>
    <div class="workflow-launch-actions"><span>Composes an investigation objective from these inputs and drops it in the box above — you edit, then launch.</span><button class="btn primary" data-research-compose="${esc(workflow.id)}">Fill the question ↑</button></div>
  </section>`;
}
// Prompt-first launcher for the open-investigation (primary) path. It reuses the
// workflow-canvas shell but leads with a single objective textarea — the agent
// derives its own targets/method, so there is no 7-panel decision canvas. The
// CTA creates a "freeform" job through the same create -> plan -> approve -> run
// flow as the structured cards.
// Cache key for the live scope preview: it only depends on the run and the pinned
// files, so it refetches when those change but not on every keystroke.
function scopePreviewKey() {
  return `${state.runId}|${state.mentions.map((item) => item.path).sort().join(",")}`;
}
function renderInvestigationLauncher() {
  const draft = state.researchObjectiveDraft || "";
  const budget = Number(state.config?.research?.defaultBudgetUsd ?? 0);
  const { want, choices } = researchModelChoices();
  const modelOptions = choices.length
    ? choices.map((model) => `<option value="${esc(model.id)}" ${model.id === want ? "selected" : ""}>${esc(model.name)}${Number.isFinite(model.intelligenceIndex) ? ` · ${esc(intelligenceLabel(model))}` : ""}</option>`).join("")
    : '<option value="">Configure models first</option>';
  // Live scope line — the same frozen-scope counts the old plan screen showed, but
  // before any job exists. Fetched lazily and keyed by run+pins; a hard block (the
  // run lacks required evidence) disables Investigate and says why.
  const sp = state.researchScopePreview;
  const spKey = scopePreviewKey();
  let scopeLine = "", blocked = false;
  if (state.runId) {
    if (!sp || sp.key !== spKey) { setTimeout(() => AIInsightsApp.refreshScopePreview(spKey), 0); scopeLine = `<div class="composer-scope checking">Checking what's in scope…</div>`; }
    else if (sp.error) { scopeLine = `<div class="composer-scope checking">Scope preview unavailable — Investigate still validates before it runs.</div>`; }
    else {
      const pf = sp.preflight || {};
      blocked = pf.ready === false;
      const reasons = (pf.missingCapabilities && pf.missingCapabilities.length ? pf.missingCapabilities : pf.missingFamilies || []).join("; ");
      scopeLine = blocked
        ? `<div class="composer-scope blocked">Not runnable on this run: ${esc(reasons || "missing required evidence")}</div>`
        : `<div class="composer-scope ok">In scope: ${pf.selectedArtifacts || 0} artifact${pf.selectedArtifacts === 1 ? "" : "s"} (${pf.pinnedArtifacts || 0} pinned) · ${pf.stageConfigs || 0} config${pf.stageConfigs === 1 ? "" : "s"} · offline compute $0</div>`;
    }
  }
  return `<section class="workflow-canvas investigation-launch" aria-label="Open investigation launcher">
    <div class="workflow-canvas-head"><div><h2>What do you want to know about this run?</h2></div><span class="workflow-readiness executable">Runs code</span></div>
    <div class="investigation-body">
      <input id="researchTitle" class="research-title-input" type="text" maxlength="140" placeholder="Title (optional — auto-generated from your question)" value="${esc(state.researchTitleDraft || "")}">
      <textarea id="researchObjective" class="research-objective" rows="4" placeholder="e.g. Which protein shows the strongest case-vs-control change, and how many proteins are significant at adjusted p < 0.05?">${esc(draft)}</textarea>
      <div class="composer-knobs">
        <label class="research-model-field"><span>Model</span><select id="researchModel" class="control model-picker" aria-label="Research model">${modelOptions}</select></label>
        <label class="research-cap-field"><span>Cost cap (USD)</span><input id="researchBudget" class="control" type="number" min="0" step="0.05" value="${esc(budget)}" aria-label="Cost cap"></label>
      </div>
      <small class="muted composer-note">Model defaults to your medium tier; this job runs — and re-runs — on it. The cap ceilings model spend; offline compute is $0.</small>
      ${scopeLine}
      <div class="investigation-meta"><span>A sandboxed agent investigates with all skills loaded and its own choice of method; generated code is captured and hashed (inspect it in Operations → Activity). Findings are self-declared, then every cited claim is resolved to a real frozen file — unsupported claims are dropped.</span>
        <ul class="investigation-points"><li>No network, no host filesystem — confined to this run's frozen inputs</li><li>Verdict is context-dependent; treat findings as exploratory, then confirm</li></ul></div>
    </div>
    <div class="workflow-launch-actions"><span>Sandboxed · no network. Nothing is billed until it runs.</span><button class="btn primary" data-research-start="freeform" ${blocked ? "disabled" : ""}>Investigate</button></div>
  </section>`;
}
// "Re-run exactly" as a split button: the main face re-runs on the job's own model;
// the attached caret opens a menu to re-run on a different one. Both thread the re-run
// INTO this job's conversation (rerunInThread) rather than spawning a separate job.
// Re-running on different models is how a user accumulates the answers the Arbiter needs.
function renderRerunSplit(job) {
  const open = state.rerunMenuOpen;
  const { choices } = researchModelChoices();
  const currentName = (state.models.find((model) => model.id === job.model)?.name) || (job.model || "").replace(/^openrouter\//, "") || "the same model";
  const menu = open ? `<div class="rerun-menu" role="menu"><div class="rerun-menu-head">Re-run on a different model</div>${choices.map((model) => `<button role="menuitemradio" aria-checked="${model.id === job.model}" class="rerun-menu-item ${model.id === job.model ? "current" : ""}" data-rerun-thread-model="${esc(model.id)}"><span>${esc(model.name)}</span>${model.id === job.model ? "<small>current</small>" : (Number.isFinite(model.intelligenceIndex) ? `<small>${esc(intelligenceLabel(model))}</small>` : "")}</button>`).join("")}</div>` : "";
  return `<div class="rerun-split ${open ? "open" : ""}"><button class="btn subtle rerun-main" data-rerun-thread title="Re-run on ${esc(currentName)} — threads into this conversation">Re-run exactly</button><button class="btn subtle rerun-caret" data-rerun-menu aria-haspopup="menu" aria-expanded="${open}" aria-label="Re-run on a different model">▾</button>${menu}</div>`;
}
function renderResearchWorkspace(host) {
  const job = state.researchJob;
  if (!job) {
    state.planDraft = null;
    state.pinPicker = null;
    // Pinned evidence sits directly under the investigation box. These @-mentions are
    // carried into the proposed plan as pins (createResearch -> plan PATCH), forced
    // into the frozen scope on approval, staged into the jail, and listed in the
    // job Inspector — so the label states that contract.
    const pins = state.mentions.length ? `<div class="launch-pins"><span class="launch-pins-label">${icon("paperclip")} Pinned evidence · added to this run's frozen scope on launch</span><div class="mention-strip">${state.mentions.map((item) => `<span class="mention-chip">@${esc(item.scope)}/${esc(item.name)}<button data-remove-mention="${esc(item.path)}" aria-label="Remove">${icon("close")}</button></span>`).join("")}</div></div>` : "";
    const workflowLabel = (id) => (state.researchWorkflows.find((item) => item.id === id)?.label) || id;
    const templates = state.researchTemplates || [];
    const templateBlock = templates.length
      ? `<div class="research-templates"><div class="research-templates-head"><b>Start from a saved template</b><span class="muted small">Your tuned steps, sources, and cost cap. Type an objective above, then pick one.</span></div><div class="research-template-grid">${templates.map((tpl) => `<div class="research-template"><button class="research-template-start" data-research-template="${esc(tpl.id)}"><b>${esc(tpl.label)}</b><span>${esc(workflowLabel(tpl.workflowId))} · ${tpl.steps.length} step${tpl.steps.length === 1 ? "" : "s"}${tpl.sources.length ? ` · ${esc(tpl.sources.join(", "))}` : ""} · ${money(tpl.maxCostUsd)} cap</span></button><button class="research-template-del" data-template-delete="${esc(tpl.id)}" title="Delete template" aria-label="Delete template">${icon("trash")}</button></div>`).join("")}</div></div>`
      : "";
    // Open investigation is the primary, prompt-first path; the catalog workflows are
    // structured presets. A card is "selected" only when it is one of the
    // structured workflows — otherwise investigation is active and we show the
    // prompt launcher instead of a per-card canvas.
    const structuredId = state.researchWorkflowId && state.researchWorkflowId !== "freeform" ? state.researchWorkflowId : "";
    const selected = structuredId ? state.researchWorkflows.find((item) => item.id === structuredId) : null;
    const investigationActive = !selected;
    const investigationCard = `<button role="tab" aria-selected="${investigationActive}" class="research-workflow investigation ${investigationActive ? "active" : ""}" data-research-workflow="freeform"><b>Open investigation</b><span>Ask anything. A sandboxed agent writes and runs its own analysis over this run's frozen evidence, then every claim is checked back to a real file.</span><small>Sandboxed agent · every claim traced to a file</small></button>`;
    const presetCards = state.researchWorkflows.map((workflow) => { const readiness = workflow.capabilities?.readiness || workflow.executionStatus || "preview"; return `<button role="tab" aria-selected="${workflow.id === state.researchWorkflowId}" class="research-workflow ${workflow.id === state.researchWorkflowId ? "active" : ""}" data-research-workflow="${esc(workflow.id)}"><b>${esc(workflow.label)}</b><span>${esc(workflow.description)}</span><small>${esc(readiness.replaceAll("-", " "))} · ${workflow.targetCandidates?.length || 0} run-derived target${workflow.targetCandidates?.length === 1 ? "" : "s"}</small></button>`; }).join("");
    // Prompt-first: the investigation card leads and its box is ALWAYS shown — it is
    // the primary input and the destination a selected template composes into. A
    // selected preset renders its launcher form below the presets (canvas); its
    // "Open in investigation →" drops the composed objective up into the box above,
    // so the box never disappears and there is no view swap when picking a template.
    const body = renderInvestigationLauncher();
    const canvas = selected ? renderWorkflowLauncher(selected) : "";
    host.innerHTML = `<div class="research-launch"><p class="eyebrow">Deep Research</p><h1>Ask the run anything</h1><p>Open investigation turns your question loose on this run's frozen evidence — a sandboxed agent (no network, no host filesystem) writes and runs Python, and each claim is validated against a real file before you see it. Or start from a template to fill the question, then edit and launch. Use <b>My Files</b> to pin extra evidence.</p><div class="research-workflows" role="tablist" aria-label="Open investigation">${investigationCard}</div>${body}${pins}<div class="research-presets-label">Or start from a template</div><div class="research-workflows" role="tablist" aria-label="Templates">${presetCards}</div>${canvas}${templateBlock}</div>`;
    return;
  }
  // Keep an editable draft alive only while the plan is being proposed.
  if (job.state === "plan_proposed") { if (!state.planDraft || state.planDraft.jobId !== job.id) { AIInsightsApp.startPlanDraft(); state.planDraft.jobId = job.id; } }
  else if (state.planDraft) state.planDraft = null;
  const steps = job.steps || [];
  const stateLabel = job.state.replaceAll("_", " ");
  const controls = job.state === "approved" ? `<button class="btn primary" data-research-action="run">Run approved plan</button><button class="btn danger" data-research-action="stop">Stop</button>`
    : ["queued", "running"].includes(job.state) ? `<button class="btn subtle" data-research-action="pause">Pause</button><button class="btn danger" data-research-action="stop">Stop</button>`
    : job.state === "paused" ? `<button class="btn primary" data-research-action="resume">Resume</button><button class="btn danger" data-research-action="stop">Stop</button>`
    : job.state === "failed" ? `<button class="btn primary" data-research-action="resume">Retry from checkpoint</button>`
    : "";
  const body = job.state === "plan_proposed" ? renderPlanEditor(job) : renderProgress(job, steps);
  // The synthesized answer is the primary deliverable: it sits above the progress
  // detail and supersedes the raw findings card. When a workflow has no synthesis
  // (or it degraded) the answer is empty and the findings card renders as before.
  const answer = renderAnswer(job);
  // A job is launched from a conversation; offer a way back to it (with the title
  // when it is still loaded). Hidden when the job has no originating conversation.
  const originConv = job.conversationId ? (state.conversations || []).find((item) => item.id === job.conversationId) : null;
  const backLink = job.conversationId
    ? `<button class="research-back" data-open-conversation="${esc(job.conversationId)}" title="Open the conversation this research was launched from">${icon("back")}<span>Back to conversation</span>${originConv ? `<span class="research-back-title">· ${esc(originConv.title)}</span>` : ""}</button>`
    : "";
  // Inspector (frozen scope, skills, sources, cost cap, in-scope files) sits with
  // the job it describes. Hidden while the plan is still being edited — the plan
  // editor already surfaces the preflight scope.
  const inspector = job.state === "plan_proposed" ? "" : renderResearchInspector(job);
  // The job header shows the short, editable title as the heading; the full
  // objective (a long, guard-laden investigation prompt) is a calm sub-line, shown
  // only outside the plan editor (which already echoes it in an editable field).
  const objective = job.objective || "";
  const title = job.title || objective;
  const objectiveSub = job.state !== "plan_proposed" && objective && objective !== title
    ? `<p class="research-objective-sub" title="${esc(objective)}">${esc(objective)}</p>`
    : "";
  host.innerHTML = `<div class="research-job-view"><div class="research-title-row"><div>${backLink}<p class="eyebrow">${esc(job.workflowId)}</p><h1>${esc(title)}</h1>${objectiveSub}<span class="research-state ${esc(job.state)}">${esc(stateLabel)}</span></div><div class="research-actions">${controls}</div></div>${inspector}${renderResearchDataUsed(job)}${answer}${body}${job.error ? `<div class="research-error">${esc(job.error)}</div>` : ""}${answer ? "" : renderFindings(job)}${renderDeliverables(job)}${job.state === "completed" ? renderResearchConversation(job) : ""}</div>`;
}
// The answer panel — bottom-line-up-front. Verdict chip, headline, the model
// narrative (clearly labeled + confidence) or the deterministic summary, the
// decision, cited key figures, and a link to the full report. Reads the enriched
// claim the synthesis phase wrote; renders nothing pre-completion.
function renderAnswer(job) {
  if (job.state !== "completed") return "";
  const claim = (job.claims || [])[0];
  if (!claim || !claim.headline) {
    // Lenient, but expressed: don't render blank when synthesis is absent.
    return (job.claims || []).length ? "" : `<section class="research-answer pending"><p class="eyebrow">Answer</p><p class="muted">Synthesis is not available for this workflow yet — the computed evidence is in the deliverables below.</p></section>`;
  }
  const verdict = String(claim.verdictLabel || "");
  const narr = claim.narrative;
  const narrated = narr && narr.generatedBy === "model";
  const conf = narr && narr.groundingConfidence;
  const badge = narrated ? `<span class="answer-badge" title="${conf === "high" ? "Every figure verified against the computed evidence" : "Some figures are model-stated, not matched to the evidence"}">narrated · ${esc(narr.model || "model")}${conf === "high" ? " · verified" : conf === "partial" ? " · partial" : ""}</span>` : `<span class="answer-badge deterministic">deterministic</span>`;
  const narrativeText = narrated ? esc(narr.text) : esc(claim.summary || "");
  const metrics = (claim.metrics || []).slice(0, 4).map((metric) => `<div class="answer-metric"><b>${esc(String(metric.value))}</b><span>${esc(metric.label)}</span></div>`).join("");
  const report = (state.artifacts || []).find((item) => item.relPath.includes(`research/jobs/${job.id}/`) && item.kind === "research-report");
  return `<section class="research-answer verdict-${esc(verdict)}">
    <div class="answer-head"><span class="answer-verdict">${esc(verdict.replaceAll("-", " ") || "answered")}</span>${badge}</div>
    <h2 class="answer-headline">${esc(claim.headline)}</h2>
    ${narrativeText ? `<p class="answer-narrative">${narrativeText}</p>` : ""}
    <p class="answer-implication"><b>Decision.</b> ${esc(claim.decisionImplication)}</p>
    ${metrics ? `<div class="answer-metrics">${metrics}</div>` : ""}
    <div class="answer-cta">${report ? `<a class="btn primary" href="/api/artifacts/${encodeURIComponent(report.id)}/content" target="_blank" rel="noopener">Open full report</a>` : ""}<span class="answer-caveat">${esc((claim.limitations || [])[0] || "")}</span></div>
  </section>`;
}
// The research inspector — frozen scope hash, skills, external sources, cost cap,
// and the in-scope run files. This metadata used to hijack the right rail's
// Context tab in Deep Research mode; it now lives in the job's own center panel
// (collapsible, above the answer) so Context can show pipeline files in both
// modes. Reuses researchScopeSets() and renderScopeArtifactList() unchanged.
function renderResearchInspector(job) {
  if (!job) return "";
  const sources = job.plan?.sources || [];
  const scopeSets = researchScopeSets(job);
  const inScope = scopeSets ? [...scopeSets.inScope.values()] : [];
  const excluded = scopeSets ? scopeSets.excluded.size : 0;
  const skills = (job.steps || []).map((step) => step.skillId).filter(Boolean).join(" · ") || "Defined by plan";
  const items = [
    ["Frozen scope", job.scopeManifestHash || "Created on approval"],
    ["Skills", skills],
    ["External sources", sources.length ? sources.join(" · ") : "Off (run-only)"],
    ["Cost cap", `${money(job.plan?.maxCostUsd ?? job.budgetUsd ?? 0)} · spend ${money(job.spendUsd || 0)} (model ${money(job.modelSpendUsd || 0)} + lookup ${money(job.lookupSpendUsd || 0)})`],
    ["In scope", `${inScope.length} run artifact${inScope.length === 1 ? "" : "s"} · ${excluded} excluded`],
  ];
  return `<details class="research-panel research-inspector"><summary><b>Inspector</b><span>Frozen scope · skills · sources · limits</span></summary>`
    + `<div class="research-inspector-grid">${items.map(([label, value]) => `<div class="ri-item"><span class="ri-label">${esc(label)}</span><span class="ri-value">${esc(value)}</span></div>`).join("")}</div>`
    + `${renderScopeArtifactList(inScope)}</details>`;
}
// "Data used" — the companion to the Inspector. The Inspector shows what is in
// SCOPE (available to the agent); this shows what the agent ACTUALLY used in the
// run: each catalog file tagged read (opened in its code) / cited (backs a claim)
// / fetched (pulled on demand), plus the staged-but-unread waste signal. Collapsed
// by default and lazy-loaded (the usage join is off the hot job poll), keyed by
// state.researchCatalog[jobId]. Hidden until a catalog exists and the plan is set.
function renderResearchDataUsed(job) {
  const count = job?.scope?.catalogCount || 0;
  if (!count || job.state === "plan_proposed") return "";
  const cat = state.researchCatalog[job.id];
  const open = Boolean(cat && cat.open);
  let body = "";
  if (open) {
    if (cat.loading) body = '<p class="datause-status muted small">Loading the run catalog…</p>';
    else if (cat.error) body = `<p class="datause-status muted small">${esc(cat.error)}</p>`;
    else if (cat.data) body = renderDataUsedBody(cat.data, job.id);
  }
  const summary = cat && cat.data && typeof cat.data.usedCount === "number" ? `${cat.data.usedCount} of ${count} used` : `${count} files`;
  return `<section class="research-panel research-datause">
    <button class="datause-head" data-research-catalog="${esc(job.id)}" aria-expanded="${open}">
      <span class="deliverable-caret">${open ? "▾" : "▸"}</span>
      <span class="datause-title"><b>Data used</b><span>Which of this run's files the investigation actually read, cited, or fetched</span></span>
      <span class="datause-count">${esc(summary)}</span>
    </button>${body}</section>`;
}
function renderDataUsedBody(data, jobId) {
  const all = data.catalog || [];
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const used = all.filter((e) => e.usage && e.usage.used).sort(byPath);
  const stagedUnused = all.filter((e) => e.usage && e.usage.stagedUnused).sort(byPath);
  const available = all.filter((e) => e.usage && !e.usage.used && !e.usage.stagedUnused).sort(byPath);
  const line = `<p class="datause-summary"><b>${used.length}</b> used · <b>${stagedUnused.length}</b> pre-staged but unread · <b>${available.length}</b> available, pulled on demand</p>`;
  const catalogLink = jobId ? `<p class="datause-catalog-link"><a href="/api/research/jobs/${encodeURIComponent(jobId)}/catalog.html" target="_blank" rel="noopener noreferrer">Open artifact catalog</a><span>Full frozen catalog with descriptions and usage tags</span></p>` : "";
  const group = (label, items, cls) => (items.length ? `<div class="datause-group"><p class="datause-group-label ${cls}">${esc(label)} · ${items.length}</p><ul class="scope-artifact-list">${items.map(dataUsedRow).join("")}</ul></div>` : "");
  const usedBlock = used.length ? group("Used in this run", used, "used") : `<p class="muted small">No catalog files were used beyond the pre-staged set${stagedUnused.length ? " — and the staged files were left unread" : ""}.</p>`;
  // The available long tail (often ~90 files) is collapsed so the panel leads with usage.
  const availBlock = available.length ? `<details class="datause-avail"><summary>Available, not used (${available.length})</summary><ul class="scope-artifact-list">${available.map(dataUsedRow).join("")}</ul></details>` : "";
  return `<div class="datause-body">${line}${catalogLink}${usedBlock}${group("Staged but unread", stagedUnused, "warn")}${availBlock}</div>`;
}
function dataUsedChips(u) {
  if (!u) return "";
  const chips = [];
  if (u.read) chips.push('<span class="use-chip read">read</span>');
  if (u.cited) chips.push('<span class="use-chip cited">cited</span>');
  if (u.fetched) chips.push('<span class="use-chip fetched">fetched</span>');
  if (u.stagedUnused) chips.push('<span class="use-chip unused">staged · unused</span>');
  return chips.join("");
}
function dataUsedRow(e) {
  return `<li class="scope-artifact"><div class="scope-artifact-name">${esc(baseName(e.path))}${dataUsedChips(e.usage)}</div>`
    + `<div class="scope-artifact-meta">${esc(groundingFamilyLabel(e.family))} · <span class="scope-artifact-path" title="${esc(e.path)}">${esc(e.path)}</span></div></li>`;
}
// Lazy toggle for the "Data used" panel: cache the catalog+usage per job so the
// expensive usage join is fetched once. Mirrors the OCC's toggleResearchCatalog.
async function toggleResearchDataUsed(jobId) {
  const cur = state.researchCatalog[jobId];
  if (cur && cur.open) { state.researchCatalog[jobId] = { ...cur, open: false }; AIInsightsApp.render(); return; }
  if (cur && cur.data) { state.researchCatalog[jobId] = { ...cur, open: true }; AIInsightsApp.render(); return; }
  state.researchCatalog[jobId] = { open: true, loading: true }; AIInsightsApp.render();
  try { const data = await api(`/api/research/jobs/${encodeURIComponent(jobId)}/catalog`); state.researchCatalog[jobId] = { open: true, loading: false, data }; }
  catch (error) { state.researchCatalog[jobId] = { open: true, loading: false, error: error.message || "Failed to load the run catalog" }; }
  AIInsightsApp.render();
}
// A child extension threads inline in the parent conversation: its progress while
// running, its answer headline when done, or a review link if it stopped at a plan.
// "Open run" loads the child job in the workspace (data-research-job → openResearch).
function renderChildExtension(childId, kind) {
  const child = (state.researchChildJobs || {})[childId];
  const noun = kind === "rerun" ? "Re-run" : "Extension";
  const open = `<button class="btn subtle tiny" data-research-job="${esc(childId)}">Open run</button>`;
  if (!child) return `<div class="child-extension"><span>${noun} queued…</span>${open}</div>`;
  const st = String(child.state || "");
  if (["queued", "running", "approved"].includes(st)) {
    const steps = child.steps || [];
    const done = steps.filter((step) => step.state === "complete").length;
    return `<div class="child-extension running"><span>${noun} running — ${esc(st)}${steps.length ? ` · ${done}/${steps.length} steps` : ""}</span>${open}</div>`;
  }
  if (st === "completed") {
    const claim = (child.claims || [])[0];
    return `<div class="child-extension done"><span><b>${esc(claim?.headline || `${noun} complete`)}</b></span>${open}</div>`;
  }
  if (st === "failed") return `<div class="child-extension failed"><span>${noun} failed${child.error ? ` — ${esc(child.error)}` : ""}</span>${open}</div>`;
  if (st === "plan_proposed") return `<div class="child-extension"><span>${noun} plan ready</span><button class="btn subtle tiny" data-research-job="${esc(childId)}">Review plan</button></div>`;
  return `<div class="child-extension"><span>${noun} ${esc(st)}</span>${open}</div>`;
}
// Distinct models that have answered this job's objective in-thread: the parent's own
// model plus each completed in-thread re-run's model. The Arbiter unlocks at >= 2.
function arbiterThreadModels(job) {
  const models = new Set();
  if (job.model) models.add(job.model);
  ((job.conversation?.messages) || []).filter((m) => m.outcome === "rerun" && m.childJobId).forEach((m) => {
    const child = (state.researchChildJobs || {})[m.childJobId];
    if (child && child.state === "completed" && child.model) models.add(child.model);
  });
  return models;
}
function renderResearchConversation(job) {
  const conversation = job.conversation;
  if (!conversation) return `<section class="research-conversation"><p class="muted">The completed-job conversation is being initialized. Reload this job in a moment.</p></section>`;
  const suggestion = conversation.suggestion;
  const suggestionCard = suggestion ? `<div class="research-suggestion"><div><p class="eyebrow">Best next research question</p><h3>${esc(suggestion.question)}</h3><p>${esc(suggestion.why_now)}</p><small>Same model: ${esc(suggestion.model || job.model)} · report ${esc(String(suggestion.reportSha256 || "").slice(0, 12))} · editable, not evidence</small></div><button id="researchUseSuggestion" class="btn subtle">Use this question</button></div>` : `<div class="research-suggestion"><div><p class="eyebrow">Best next research question</p><p>Generate once from the immutable report using this job's model; no tools, skills, or network.</p></div><button id="researchGenerateSuggestion" class="btn subtle">Generate suggestion</button></div>`;
  const messages = (conversation.messages || []).map((message) => {
    // Label the meta line by intent: Arbiter shows its role, a re-run says so, everything
    // else shows its runtime policy (read_only / compute / external) as before.
    const label = message.outcome === "arbiter" ? `Arbiter · ${esc(message.sourcePolicy?.arbiterRole || "role")}` : message.outcome === "rerun" ? "Re-run" : esc(message.runtimePolicy);
    return `<article class="research-message ${esc(message.role)}"><div class="research-message-meta"><b>${message.role === "user" ? "You" : "Deep Research"}</b><span>${label} · ${esc(message.effectiveModel || message.requestedModel || "deterministic")} · ${money(message.costUsd)}</span></div><p>${esc(message.content)}</p>${message.role === "assistant" ? `<small>${esc((message.citations || []).map((item) => item.ref).join(" · "))}</small>` : ""}${message.childJobId ? renderChildExtension(message.childJobId, message.outcome) : ""}</article>`;
  }).join("");
  const approved = new Set(job.plan?.allowedSkills || []);
  const skills = (state.researchSkills || []).filter((skill) => skill.ready && approved.has(skill.id));
  const scopeIncludes = (job.scope?.artifacts || []).slice(0, 6).map((item) => `@context/${item.path}`);
  const models = modelChoices();
  const currentModel = job.model || selectedModel();
  let tab = state.researchFollowupTab || "ask";
  const extendMode = state.researchExtendMode || "compute";
  const draft = esc(state.researchFollowupDraft || "");
  const sending = state.researchFollowupSending;
  const busy = sending ? "disabled" : "";
  // The Arbiter unlocks once two or more distinct models have answered this objective
  // in-thread (original report + completed re-runs). If the user is parked on the
  // Arbiter tab but it is no longer available, fall back to Ask.
  const arbiterModels = arbiterThreadModels(job);
  const arbiterAvailable = arbiterModels.size >= 2;
  const arbiterCount = 1 + (conversation.messages || []).filter((m) => m.outcome === "rerun" && m.childJobId && (state.researchChildJobs || {})[m.childJobId]?.state === "completed").length;
  if (tab === "arbiter" && !arbiterAvailable) tab = "ask";
  // Grounding chips (Answer / Full report / Evidence tables) replace the raw @context
  // path dump; the per-file list moves behind "Add specific files" with an explicit
  // summary/full toggle — no hidden slice-vs-full magic.
  const chip = (ref, label, on) => `<label class="research-chip"><input type="checkbox" data-research-include value="${ref}" data-mode="slice" ${on ? "checked" : ""}><span>${label}</span></label>`;
  const groundChips = chip("@answer", "Answer", true) + chip("@report", "Full report", true) + chip("@evidence", "Evidence tables", false);
  const specificFiles = scopeIncludes.length ? `<details class="research-addfiles"><summary>Add specific files (${scopeIncludes.length})</summary><div class="research-addfiles-list">${scopeIncludes.map((ref) => `<label class="research-file"><input type="checkbox" data-research-include value="${esc(ref)}" data-mode="full"><span>${esc(ref.replace("@context/", ""))}</span><select data-include-mode class="research-file-mode"><option value="slice">summary</option><option value="full" selected>full</option></select></label>`).join("")}</div></details>` : "";
  const grounding = `<div class="research-ground"><span class="research-ground-label">Ground the answer in</span><div class="research-chips">${groundChips}</div>${specificFiles}</div>`;
  // Tab row: Ask | Extend | (Arbiter, only when >=2 models have answered) plus the
  // "Re-run exactly" split button, now living beside the tabs (it threads in-place).
  const arbiterTab = arbiterAvailable ? `<button role="tab" aria-selected="${tab === "arbiter"}" class="research-followup-tab ${tab === "arbiter" ? "on" : ""}" data-research-followup-tab="arbiter">Arbiter${arbiterModels.size > 2 ? ` (${arbiterModels.size})` : ""}</button>` : "";
  const tabBar = `<div class="research-followup-tabrow"><div class="research-followup-tabs" role="tablist"><button role="tab" aria-selected="${tab === "ask"}" class="research-followup-tab ${tab === "ask" ? "on" : ""}" data-research-followup-tab="ask">Ask</button><button role="tab" aria-selected="${tab === "extend"}" class="research-followup-tab ${tab === "extend" ? "on" : ""}" data-research-followup-tab="extend">Extend</button>${arbiterTab}</div>${renderRerunSplit(job)}</div>`;
  let panel, composer;
  if (tab === "arbiter") {
    // Arbiter panel: pick a role (with an (i) popover describing all roles) and the
    // model that will arbitrate; Run sends the chosen template over the thread's answers.
    const arbiterRole = state.researchArbiterRole || "distill";
    const roleOptions = ARBITER_ROLES_UI.map((r) => `<option value="${r.id}" ${r.id === arbiterRole ? "selected" : ""}>${esc(r.label)}</option>`).join("");
    const infoOpen = state.arbiterInfoOpen;
    const infoPopover = infoOpen ? `<div class="arbiter-info-pop" role="dialog" aria-label="What each arbiter role does"><div class="arbiter-info-head">What each role does</div>${ARBITER_ROLES_UI.map((r) => `<div class="arbiter-info-row"><b>${esc(r.label)}</b><span>${esc(r.blurb)}</span></div>`).join("")}</div>` : "";
    const arbiterModelSelect = `<label class="research-model"><span>Arbiter model</span><select id="arbiterModel" class="control">${models.map((model) => `<option value="${esc(model.id)}" ${model.id === currentModel ? "selected" : ""}>${esc(model.name)}</option>`).join("")}</select></label>`;
    panel = `<p class="research-followup-lede">A council step: one model reasons over the ${arbiterCount} model answer${arbiterCount === 1 ? "" : "s"} already in this thread (the original report + your re-runs). Read-only — no tools, skills, or network.</p><div class="arbiter-controls"><label class="research-model arbiter-role-field"><span>Role</span><div class="arbiter-info-wrap"><select id="arbiterRole" class="control" data-arbiter-role>${roleOptions}</select><button type="button" class="arbiter-info-btn" data-arbiter-info aria-label="What each role does" aria-expanded="${infoOpen}" title="What each role does">i</button></div></label>${arbiterModelSelect}</div>${infoPopover}`;
    composer = `<div class="research-followup-composer arbiter-composer"><button id="arbiterRun" class="btn primary" ${busy} aria-busy="${sending}">${sending ? "Arbitrating…" : "Run arbiter"}</button></div><p class="composer-hint">${sending ? "The arbiter model is reasoning over the responses — this can take a few seconds." : `Synthesizes across ${arbiterModels.size} models using the selected role.`}</p>`;
  } else if (tab === "ask") {
    const modelSelect = `<label class="research-model"><span>Model</span><select id="researchFollowupModel" class="control">${models.map((model) => `<option value="${esc(model.id)}" ${model.id === currentModel ? "selected" : ""}>${esc(model.name)}</option>`).join("")}</select></label>`;
    panel = `<p class="research-followup-lede">Standard mode — answers from the frozen report. No tools, skills, or network.</p>${grounding}${modelSelect}`;
    composer = `<div class="research-followup-composer"><textarea id="researchFollowupQuery" rows="3" placeholder="Ask about this report…" ${busy}>${draft}</textarea><button id="researchFollowupSend" class="btn primary" ${busy} aria-busy="${sending}">${sending ? "Asking…" : "Ask"}</button></div><p class="composer-hint">${sending ? "Waiting for the model — this can take a few seconds." : "A constrained Standard-Mode reply, grounded in what the run already produced."}</p>`;
  } else {
    const facetBar = `<div class="research-extend-facets"><button class="research-facet ${extendMode === "compute" ? "on" : ""}" data-research-extend-mode="compute">Run analysis</button><button class="research-facet ${extendMode === "external" ? "on" : ""}" data-research-extend-mode="external">Add sources</button></div>`;
    const facetBody = extendMode === "compute"
      ? `<div class="research-facet-body"><span class="research-ground-label">Approved skills</span><div class="research-chips">${skills.length ? skills.map((skill) => `<label class="research-chip"><input type="checkbox" data-research-skill value="${esc(skill.id)}"><span>${esc(skill.name || skill.id)}</span></label>`).join("") : '<span class="muted small">No approved compute skills.</span>'}</div></div>`
      : `<div class="research-facet-body"><span class="research-ground-label">Curated sources</span><div class="research-chips">${RESEARCH_SOURCES.map((source) => `<label class="research-chip"><input type="checkbox" data-research-source value="${esc(source)}"><span>${esc(sourceLabel(source))}</span></label>`).join("")}</div></div>`;
    const extendCap = Number(job.plan?.maxCostUsd ?? job.budgetUsd ?? 0);
    const knobs = `<div class="composer-knobs"><label class="research-model-field"><span>Model</span><select id="researchFollowupModel" class="control">${models.map((model) => `<option value="${esc(model.id)}" ${model.id === currentModel ? "selected" : ""}>${esc(model.name)}</option>`).join("")}</select></label><label class="research-cap-field"><span>Cost cap (USD)</span><input id="researchFollowupBudget" class="control" type="number" min="0" step="0.05" value="${esc(extendCap)}"></label></div>`;
    panel = `<p class="research-followup-lede">Adds compute or curated sources as a traced child run, parented to this report (which stays immutable). One click composes, approves, and runs it — model and cap are set right here.</p>${facetBar}${grounding}${facetBody}${knobs}`;
    composer = `<div class="research-followup-composer"><textarea id="researchFollowupQuery" rows="3" placeholder="Describe the analysis or evidence to add…" ${busy}>${draft}</textarea><div class="research-followup-actions"><button id="researchFollowupPlan" class="btn subtle" ${busy}>Plan only</button><button id="researchFollowupSend" class="btn primary" ${busy} aria-busy="${sending}">${sending ? "Working…" : "Run extension →"}</button></div></div><p class="composer-hint">${sending ? "Setting up the extension — this can take a few seconds." : "Run extension launches immediately; Plan only stops at an editable plan for review."}</p>`;
  }
  return `<section class="research-conversation"><div class="research-conversation-head"><div><p class="eyebrow">Continue from this report</p><h2>Keep working from the immutable report</h2></div><span>${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"}</span></div>${suggestionCard}<div class="research-thread">${messages || '<p class="muted">Ask a report-grounded question or create a traced extension plan.</p>'}</div>${tabBar}<div class="research-followup-panel">${panel}</div>${composer}</section>`;
}
function stepProgressIcon(step) { return step.state === "complete" ? "✓" : step.state === "running" ? "…" : step.state === "failed" ? "!" : step.ordinal; }
function renderProgress(job, steps) {
  const compFor = (step) => (job.computations || []).find((item) => item.stepId === step.id);
  const stepDetail = (step) => {
    const comp = compFor(step);
    if (!comp) return esc(step.state);
    if (comp.exitStatus === "failed") return "failed";
    const count = comp.outputs?.length || 0;
    return `${count} output${count === 1 ? "" : "s"} · ${Math.max(1, Math.round(comp.durationMs || 0))} ms`;
  };
  const stepper = steps.map((step) => `<li class="research-step ${esc(step.state)}"><span>${stepProgressIcon(step)}</span><div><b>${esc(step.skillId || step.type)}</b><small>${esc(step.entrypoint || "")} · ${stepDetail(step)}</small>${step.error ? `<em>${esc(step.error)}</em>` : ""}</div></li>`).join("");
  const sources = (job.plan?.sources || []);
  return `<section class="research-panel"><h2>Progress</h2><ul class="research-stepper">${stepper}</ul><p class="muted">Checkpoint ${job.checkpoint}/${steps.length} · spend ${money(job.spendUsd || 0)} of ${money(job.plan?.maxCostUsd ?? job.budgetUsd ?? 0)} cap (model ${money(job.modelSpendUsd || 0)} + lookup ${money(job.lookupSpendUsd || 0)}) · external ${sources.length ? esc(sources.join(", ")) : "off"} · scope ${esc(job.scopeManifestHash?.slice(0, 16) || "pending")}</p></section>`;
}
// --- Schema-aware plan-step helpers ----------------------------------------
// Each skill entrypoint now ships a parameter schema (a small JSON-Schema subset
// served by /api/research/skills). These helpers read that contract to drive the
// per-operation example, default prefill, and inline validation. The server's
// validateSteps remains the authoritative gate (src/skills/param-validation.ts).
function planSkill(skillId) { return (state.researchSkills || []).find((item) => item.id === skillId); }
function planEntrypoint(skillId, entrypointId) {
  const entries = planSkill(skillId)?.entrypoints || [];
  return (entrypointId && entries.find((item) => item.id === entrypointId)) || entries[0];
}
function planParamSchema(skillId, entrypointId) { return planEntrypoint(skillId, entrypointId)?.params; }
function planParamHasFields(schema) { return Boolean(schema && schema.properties && Object.keys(schema.properties).length); }
function planDefaultParams(schema) {
  const out = {};
  for (const [key, spec] of Object.entries(schema?.properties || {})) if (spec.default !== undefined) out[key] = spec.default;
  return out;
}
function planParamExample(schema) { return (schema?.examples && schema.examples[0]) || planDefaultParams(schema); }
// Mirror of the server param-validation subset for inline feedback only.
function planValidateParams(schema, value) {
  if (!schema || schema.type !== "object") return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["parameters must be a JSON object"];
  const props = schema.properties || {};
  const typeName = (v) => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const errors = [];
  for (const key of schema.required || []) if (!(key in value)) errors.push(`missing required parameter "${key}"`);
  if (schema.additionalProperties !== true) for (const key of Object.keys(value)) if (!(key in props)) errors.push(`unknown parameter "${key}"`);
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in value)) continue;
    const v = value[key];
    if (spec.type === "array") {
      if (!Array.isArray(v)) { errors.push(`"${key}" must be an array`); continue; }
      if (typeof spec.minItems === "number" && v.length < spec.minItems) errors.push(`"${key}" needs at least ${spec.minItems} item(s)`);
      if (spec.items) v.forEach((item, i) => { const ok = spec.items.type === "integer" ? typeof item === "number" && Number.isInteger(item) : typeName(item) === spec.items.type; if (!ok) errors.push(`"${key}[${i}]" must be a ${spec.items.type}`); });
    } else if (spec.type === "integer") { if (typeof v !== "number" || !Number.isInteger(v)) errors.push(`"${key}" must be an integer`); }
    else if (spec.type === "number") { if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`"${key}" must be a number`); }
    else if (typeName(v) !== spec.type) errors.push(`"${key}" must be a ${spec.type}`);
    if (typeof v === "number") { if (typeof spec.minimum === "number" && v < spec.minimum) errors.push(`"${key}" must be ≥ ${spec.minimum}`); if (typeof spec.maximum === "number" && v > spec.maximum) errors.push(`"${key}" must be ≤ ${spec.maximum}`); }
    if (spec.enum && !spec.enum.includes(v)) errors.push(`"${key}" must be one of: ${spec.enum.join(", ")}`);
  }
  return errors;
}
// Parse a step's params (string-while-editing or object) and validate.
function planParamProblems(step) {
  let value = step.parameters;
  if (typeof value === "string") {
    if (!value.trim()) value = {};
    else { try { value = JSON.parse(value); } catch { return ["Invalid JSON"]; } }
  }
  return planValidateParams(planParamSchema(step.skillId, step.entrypoint), value);
}
function planEntrypointMeta(entry) {
  return [
    entry?.deterministic ? "deterministic" : null,
    entry?.network?.policy === "none" ? "offline" : entry?.network?.policy === "llm" ? "LLM" : entry?.network?.policy === "curated" ? "external" : null,
    entry?.primaryScript ? `runs ${entry.primaryScript}` : null,
  ].filter(Boolean).join(" · ");
}

// Shared "which run files are in the frozen scope" renderer. Used by the plan
// editor's preflight (the live preview artifacts[]) and the deep-research
// inspector (the frozen scope). Expandable so the default view stays compact.
// Each item: { path, family, reason, pinned } — the shape preflight + the frozen
// scope both expose.
function renderScopeArtifactList(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) return '<p class="muted small scope-empty">No run artifacts are in scope yet.</p>';
  const pinned = artifacts.filter((item) => item.pinned).length;
  const rows = artifacts.map((item) => `<li class="scope-artifact${item.pinned ? " pinned" : ""}"><div class="scope-artifact-name">${esc(baseName(item.path))}${item.pinned ? '<span class="scope-pill">pinned</span>' : ""}</div><div class="scope-artifact-meta">${esc(groundingFamilyLabel(item.family))} · <span class="scope-artifact-path" title="${esc(item.path)}">${esc(item.path)}</span></div>${item.reason ? `<div class="scope-artifact-why">${esc(item.reason)}</div>` : ""}</li>`).join("");
  return `<details class="scope-artifacts"><summary>${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} in scope${pinned ? ` · ${pinned} pinned` : ""}</summary><ul class="scope-artifact-list">${rows}</ul></details>`;
}
// In-scope vs excluded run files for the current research job: the frozen scope
// post-approval, else the live preflight preview while the plan is proposed.
// Lets the right rail reconcile the whole run catalog against the N scoped files.
function researchScopeSets(job) {
  const scope = job?.scope || job?.plan?.preflight || null;
  if (!scope || (!scope.artifacts && !scope.exclusions)) return null;
  return {
    inScope: new Map((scope.artifacts || []).map((item) => [item.path, item])),
    excluded: new Set((scope.exclusions || []).map((item) => item.path)),
  };
}
// The pinned-files picker list (run files not already pinned). Split from the
// search input so a keystroke re-renders only the list, never blurring the input.
function pinPickerListMarkup() {
  const pinned = new Set((state.planDraft?.pinned || []).map((item) => item.path));
  const query = (state.pinPicker?.query || "").toLowerCase();
  const files = allRunFiles().filter((file) => !pinned.has(file.path) && (!query || `${file.scope}/${file.name}`.toLowerCase().includes(query))).slice(0, 40);
  return files.length
    ? files.map((file) => `<button class="mention-row" data-ref-scope="${esc(file.scope)}" data-ref-path="${esc(file.path)}" data-ref-name="${esc(file.name)}"><b>@${esc(file.scope)}/${esc(file.name)}</b></button>`).join("")
    : '<div class="rail-empty small">No matching files.</div>';
}
function renderPinPicker() {
  const list = document.querySelector("#pinPickerList");
  if (list) list.innerHTML = pinPickerListMarkup();
}

// The plan editor: edit/reorder/remove steps, edit each skill's parameters,
// approve external sources, set the budget cap, and review pinned files.
function renderPlanEditor(job) {
  const draft = state.planDraft;
  const skills = (state.researchSkills || []);
  const skillOptions = (selected) => skills.map((skill) => `<option value="${esc(skill.id)}" ${skill.id === selected ? "selected" : ""} ${skill.ready ? "" : "disabled"}>${esc(skill.label || skill.id)}${skill.ready ? "" : " (unavailable)"}</option>`).join("");
  const entrypointOptions = (skillId, selected) => {
    const skill = skills.find((item) => item.id === skillId);
    return (skill?.entrypoints || []).map((entry) => `<option value="${esc(entry.id)}" ${entry.id === selected ? "selected" : ""}>${esc(entry.id)}</option>`).join("") || `<option value="${esc(selected || "")}">${esc(selected || "default")}</option>`;
  };
  const stepCards = draft.steps.map((step, index) => {
    const params = typeof step.parameters === "string" ? step.parameters : JSON.stringify(step.parameters || {}, null, 2);
    const entry = planEntrypoint(step.skillId, step.entrypoint);
    const schema = entry?.params;
    const desc = entry?.summary || planSkill(step.skillId)?.description || "";
    const meta = planEntrypointMeta(entry);
    const problems = planParamProblems(step);
    const paramLabel = planParamHasFields(schema)
      ? `Parameters (JSON) — e.g. <code>${esc(JSON.stringify(planParamExample(schema)))}</code>`
      : `Parameters — <span class="muted">this operation takes no parameters.</span>`;
    return `<div class="plan-step"><div class="plan-step-head"><span class="plan-step-n">${index + 1}</span>
      <select class="control" data-plan-step="${index}" data-field="skillId" aria-label="Skill">${skillOptions(step.skillId)}</select>
      <select class="control" data-plan-step="${index}" data-field="entrypoint" aria-label="Entrypoint">${entrypointOptions(step.skillId, step.entrypoint)}</select>
      <div class="plan-step-ctrl"><button class="icon-btn" data-plan-move="${index}" data-dir="up" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-btn" data-plan-move="${index}" data-dir="down" title="Move down" ${index === draft.steps.length - 1 ? "disabled" : ""}>↓</button><button class="icon-btn danger" data-plan-remove="${index}" title="Remove step">${icon("trash")}</button></div></div>
      ${desc ? `<p class="plan-step-desc">${esc(desc)}${meta ? ` <span class="plan-step-meta">${esc(meta)}</span>` : ""}</p>` : ""}
      <label class="plan-param-label">${paramLabel}</label>
      <textarea class="control plan-params${problems.length ? " invalid" : ""}" data-plan-step="${index}" data-field="params" rows="3" spellcheck="false">${esc(params)}</textarea>
      <div class="plan-param-error" data-plan-error="${index}">${problems.length ? esc(problems.join("; ")) : ""}</div></div>`;
  }).join("");
  // Open investigation is unconstrained: its plan is a fixed investigate -> synthesize
  // pipeline the agent fills in itself, so the per-skill step editor (skill /
  // entrypoint / params dropdowns) does not apply. Show a plain description of
  // how it runs instead. harvestPlanDraft() only overwrites steps when step DOM
  // nodes exist, so omitting them keeps the proposed investigation steps intact for
  // save/approve. External sources are off (investigation is offline-only).
  const isInvestigation = job.workflowId === "freeform";
  const sourceChips = RESEARCH_SOURCES.map((source) => `<label class="plan-source"><input type="checkbox" data-plan-source="${source}" ${draft.sources.includes(source) ? "checked" : ""}><span>${esc(sourceLabel(source))}</span></label>`).join("");
  const cost = Number(state.config?.research?.externalCostUsd ?? 0);
  const pinChips = draft.pinned.length
    ? `<div class="mention-strip">${draft.pinned.map((item) => `<span class="mention-chip">@${esc(item.scope)}/${esc(baseName(item.path))}<button data-plan-unpin="${esc(item.path)}" aria-label="Remove">${icon("close")}</button></span>`).join("")}</div>`
    : `<p class="muted small">No pinned files yet — a pin forces a file into the frozen scope even when retrieval didn't pick it.</p>`;
  const pinPicker = state.pinPicker
    ? `<div id="pinPicker" class="mention-picker"><input id="pinSearch" class="control" type="search" placeholder="Filter run files to pin…" value="${esc(state.pinPicker.query || "")}"><div id="pinPickerList" class="mention-list">${pinPickerListMarkup()}</div></div>`
    : "";
  const pinPanel = `${pinChips}<button class="btn subtle small" id="planAddPin">${icon("plus")} Add file</button>${pinPicker}`;
  const pf = job.plan?.preflight || {};
  const preflight = `<div class="research-preflight ${pf.ready === false ? "blocked" : ""}"><b>${pf.ready ? "Ready to approve" : "Preflight blocked"}</b><span>${pf.selectedArtifacts || 0} artifacts (${pf.pinnedArtifacts || 0} pinned) · ${pf.stageConfigs || 0} configs${isInvestigation ? "" : ` · external ${draft.sources.length ? esc(draft.sources.join(", ")) : "off"}`} · ${money(draft.maxCostUsd)} cap</span></div>${renderScopeArtifactList(pf.artifacts || [])}`;
  const planBody = isInvestigation
    ? `<label class="label plan-section-label">How it runs</label><ol class="investigation-plan-steps"><li><b>Investigate</b> — a sandboxed agent (all skills loaded, no network, no host filesystem) writes and runs its own Python over the frozen run.</li><li><b>Synthesize</b> — each self-declared claim is resolved to a real frozen file; unsupported claims are dropped and the rest become the cited answer.</li></ol>`
    : `<label class="label plan-section-label">Skill steps</label><div class="plan-steps">${stepCards}</div><button class="btn subtle small" id="planAddStep">${icon("plus")} Add step</button>
    <label class="label plan-section-label">External sources <span class="muted small">(${cost > 0 ? `${money(cost)} per lookup, gated by the cost cap` : "free"})</span></label>
    <div class="plan-sources">${sourceChips}</div>`;
  const actions = isInvestigation
    ? `<button class="btn subtle plan-discard" data-research-action="discard-plan">Discard plan</button><button class="btn primary" data-research-action="approve-run">Approve &amp; run</button>`
    : `<button class="btn subtle plan-discard" data-research-action="discard-plan">Discard plan</button><button class="btn subtle" data-research-action="save-template">Save as template</button><button class="btn subtle" data-research-action="save-plan">Save plan</button><button class="btn primary" data-research-action="approve-run">Approve &amp; run</button>`;
  return `<section class="research-panel plan-editor">
    <div class="plan-editor-head"><h2>${isInvestigation ? "Confirm investigation plan" : "Edit plan"}</h2><span class="muted small">Nothing runs until you approve.</span></div>
    <label class="label">Title</label>
    <input id="planTitle" class="research-title-input" type="text" maxlength="140" placeholder="Short name shown in the header and the rail" value="${esc(draft.title || "")}">
    <label class="label">${isInvestigation ? "Question" : "Objective"}</label>
    <textarea id="planObjective" class="research-objective" rows="${isInvestigation ? 3 : 2}">${esc(draft.objective)}</textarea>
    ${planBody}
    <div class="plan-grid"><div><label class="label">Cost cap (USD)</label><input id="planBudget" class="control" type="number" min="0" step="0.05" value="${esc(draft.maxCostUsd)}"><p class="muted small">${isInvestigation ? "Ceilings the model spend; offline compute is $0." : "Offline skills are $0. The cap ceilings external-lookup spend."}</p></div>
    <div><label class="label">Pinned files</label>${pinPanel}</div></div>
    ${preflight}
    <p class="muted small">${esc((job.plan?.limitations || []).join(" "))}</p>
    <div class="plan-actions">${actions}</div>
  </section>`;
}
function renderFindings(job) {
  return (job.claims || []).map((claim) => {
    const arm = (name) => claim.evidence?.filter((edge) => edge.arm === name).length || 0;
    const ext = arm("external");
    return `<article class="finding-card"><header><b>${esc(claim.text)}</b><span>${esc(claim.claimType)} · ${esc(claim.verdict)}</span></header><p><strong>Decision implication.</strong> ${esc(claim.decisionImplication)}</p><div class="finding-arms"><div><b>Pipeline evidence</b><small>${arm("pipeline")} immutable artifact references</small></div><div><b>New computation</b><small>${arm("computation")} manifest-backed computations</small></div><div><b>External evidence</b><small>${ext ? `${ext} corroboration lookup${ext === 1 ? "" : "s"}` : "Not assessed (no source approved)"}</small></div></div><p class="muted">${esc((claim.limitations || []).join(" · "))}</p></article>`;
  }).join("");
}
// Deliverables grouped by role so the manifest doesn't bury the report: the
// outputs a scientist reads stay open; the long, low-traffic provenance and
// generated-code tiers collapse behind a count. Row-level inline preview is
// unchanged. The catch-all `research-data` kind is split by filename — *.py is
// generated code; findings.json / activity-trace.json are provenance.
const DELIVERABLE_OUTPUT_ORDER = ["research-report", "decision-summary", "research-next-step", "research-open-questions", "research-answer", "research-table", "research-figure"];
const DELIVERABLE_OUTPUT_KINDS = new Set(DELIVERABLE_OUTPUT_ORDER);
function deliverableTier(item) {
  if (item.kind === "research-data") return baseName(item.relPath).toLowerCase().endsWith(".py") ? "code" : "provenance";
  return DELIVERABLE_OUTPUT_KINDS.has(item.kind) ? "outputs" : "provenance";
}
function deliverableLabel(item) {
  if (item.kind === "research-data") {
    const name = baseName(item.relPath).toLowerCase();
    if (name === "findings.json") return "Findings";
    if (name === "activity-trace.json") return "Activity trace";
    if (name.endsWith(".py")) return "Generated code";
  }
  return RESEARCH_ARTIFACT_LABELS[item.kind] || item.kind;
}
function renderDeliverableRow(item) {
  const view = state.deliverableViews[item.id];
  const open = Boolean(view?.open);
  const intent = open && view?.text && baseName(item.relPath).toLowerCase().endsWith(".py") ? generatedCodeIntent(view.text) : "";
  const inner = !open ? "" : view.loading
    ? '<div class="deliverable-body muted">Loading…</div>'
    : view.error ? `<div class="deliverable-body"><div class="research-error">${esc(view.error)}</div></div>`
    : `<div class="deliverable-body">${intent ? `<div class="callout ok"><b>Intent</b> ${esc(intent)}</div>` : ""}${renderDeliverableContent(item, view.text)}</div>`;
  return `<div class="deliverable ${open ? "open" : ""}"><div class="deliverable-head"><button class="deliverable-toggle" data-deliverable="${esc(item.id)}" data-mime="${esc(item.mimeType || "")}"><span class="deliverable-caret">${open ? "▾" : "▸"}</span><b>${esc(deliverableLabel(item))}</b><small>${esc(baseName(item.relPath))}${intent ? ` · ${esc(intent)}` : ""}</small></button><a class="deliverable-open" href="/api/artifacts/${encodeURIComponent(item.id)}/content" target="_blank" rel="noopener" title="Open in new tab">↗</a></div>${inner}</div>`;
}
function renderDeliverables(job) {
  const jobArtifacts = (state.artifacts || []).filter((item) => item.relPath.includes(`research/jobs/${job.id}/`));
  if (!jobArtifacts.length) return "";
  const tiers = { outputs: [], provenance: [], code: [] };
  for (const item of jobArtifacts) tiers[deliverableTier(item)].push(item);
  tiers.outputs.sort((a, b) => DELIVERABLE_OUTPUT_ORDER.indexOf(a.kind) - DELIVERABLE_OUTPUT_ORDER.indexOf(b.kind));
  const groups = state.deliverableGroups || {};
  const collapsible = (key, label, hint, countLabel, items) => {
    if (!items.length) return "";
    const open = Boolean(groups[key]);
    return `<div class="deliverable-group ${open ? "open" : ""}"><button class="deliverable-group-head" data-deliverable-group="${esc(key)}"><span class="deliverable-caret">${open ? "▾" : "▸"}</span><b>${esc(label)}</b><small>${esc(hint)}</small><span class="deliverable-group-count">${esc(countLabel(items.length))}</span></button>${open ? `<div class="deliverable-group-body">${items.map(renderDeliverableRow).join("")}</div>` : ""}</div>`;
  };
  const outputsBlock = tiers.outputs.map(renderDeliverableRow).join("");
  const provBlock = collapsible("provenance", "Provenance & audit", "evidence, manifests, scope, trace", (n) => `${n} file${n === 1 ? "" : "s"}`, tiers.provenance);
  const codeBlock = collapsible("code", "Generated code", "the agent's captured Python · also in Operations → Activity", (n) => `${n} cell${n === 1 ? "" : "s"}`, tiers.code);
  const summary = `${jobArtifacts.length} immutable file${jobArtifacts.length === 1 ? "" : "s"} · ${tiers.outputs.length} output${tiers.outputs.length === 1 ? "" : "s"} · ${tiers.provenance.length} provenance · ${tiers.code.length} code cell${tiers.code.length === 1 ? "" : "s"}`;
  return `<section class="research-panel"><div class="deliverables-head"><h2>Deliverables</h2><span class="muted small">${esc(summary)}</span></div><p class="muted">Immutable, hash-stamped files. Click a row to preview inline; ↗ opens the raw file.</p><div class="research-deliverables-list">${outputsBlock ? `<p class="deliverable-tier-label">Outputs</p>${outputsBlock}` : ""}${provBlock || codeBlock ? `<p class="deliverable-tier-label">Audit trail</p>${provBlock}${codeBlock}` : ""}</div></section>`;
}
// Render one deliverable's content by type: SVG inline, HTML in a sandboxed
// same-origin iframe, JSON pretty-printed, CSV/TSV as a small table, else text.
function renderDeliverableContent(item, text) {
  const mime = (item.mimeType || "").toLowerCase();
  const name = item.relPath.toLowerCase();
  if (mime.includes("svg") || name.endsWith(".svg")) return `<div class="deliverable-svg">${text}</div>`;
  if (mime.includes("html") || name.endsWith(".html")) return `<iframe class="deliverable-frame" src="/api/artifacts/${encodeURIComponent(item.id)}/content" sandbox title="Report preview"></iframe>`;
  if (mime.includes("json") || name.endsWith(".json")) { try { return `<pre class="deliverable-pre">${esc(JSON.stringify(JSON.parse(text), null, 2))}</pre>`; } catch { return `<pre class="deliverable-pre">${esc(text)}</pre>`; } }
  if (mime.includes("csv") || mime.includes("tsv") || name.endsWith(".csv") || name.endsWith(".tsv")) return renderCsvTable(text, name.endsWith(".tsv") || mime.includes("tsv") ? "\t" : ",");
  return `<pre class="deliverable-pre">${esc(text)}</pre>`;
}
function renderCsvTable(text, delimiter) {
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return '<div class="muted">Empty file.</div>';
  const cells = (line) => line.split(delimiter);
  const header = cells(lines[0]);
  const rows = lines.slice(1, 51).map(cells);
  const more = lines.length - 1 > 50 ? `<p class="muted small">Showing first 50 of ${lines.length - 1} rows.</p>` : "";
  return `<div class="deliverable-table-wrap"><table class="deliverable-table"><thead><tr>${header.map((cell) => `<th>${esc(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${more}`;
}
// Markup for a single message. Shared by the full-thread render and the
// per-frame streaming patch so the two paths can never drift apart.
function renderMessageHTML(message) {
  if (message.role === "user") return `<article class="message user"><div class="bubble">${esc(message.content)}</div></article>`;
  const streaming = message.status === "streaming";
  const failed = message.status === "failed";
  const content = message.content
    ? esc(message.content)
    : streaming
      ? '<span class="thinking"><span></span><span></span><span></span><b>Analyzing run evidence…</b></span>'
      : '<span class="failure-copy">This response ended without answer text. Retry the turn or choose another model.</span>';
  return `<article class="message assistant ${streaming ? "streaming" : ""} ${failed ? "failed" : ""}" data-message-id="${esc(message.id)}"><div class="assistant-card"><div class="assistant-content">${content}</div>${(message.trace || []).map((trace, traceIndex) => `<details class="trace" data-message-id="${esc(message.id)}" data-trace-index="${traceIndex}" ${trace.open ? "open" : ""}><summary>${esc(trace.label)}</summary><p>${esc(trace.text)}</p></details>`).join("")}${renderGrounding(message)}<div class="message-meta"><span>${esc(message.model || "Model unavailable")}</span><span>${money(message.costUsd)}</span><span>${esc((message.effectiveSources || []).join(", ") || "Run evidence")}</span></div>${!streaming ? `<div class="answer-actions"><button data-feedback="${esc(message.id)}" data-rating="1" title="Helpful" aria-label="Helpful answer">Useful</button><button data-feedback="${esc(message.id)}" data-rating="-1" title="Not helpful" aria-label="Not helpful answer">Needs work</button><button data-note="${esc(message.id)}">Add note</button><button data-pin="${esc(message.id)}" data-pinned="${Boolean(message.pinned)}">${message.pinned ? "Pinned" : "Pin"}</button></div>` : ""}</div></article>`;
}
function wireTraceToggles(scope) {
  scope.querySelectorAll("details.trace[data-message-id]").forEach((details) => {
    details.addEventListener("toggle", () => {
      const message = state.messages.find((item) => item.id === details.dataset.messageId);
      const trace = message?.trace?.[Number(details.dataset.traceIndex)];
      if (trace) trace.open = details.open;
    });
  });
}
// Streaming fast path: only the trailing assistant bubble changes as deltas
// arrive, so swap just that <article> instead of rebuilding every message's
// innerHTML each frame (the old approach was O(messages × frames) and visibly
// janked long threads). Falls back to a full render if the bubble isn't mounted.
function patchStreamingMessage(message) {
  const host = document.querySelector("#messages");
  const current = host?.querySelector("article.assistant.streaming");
  if (!current) return false;
  const template = document.createElement("template");
  template.innerHTML = renderMessageHTML(message);
  const fresh = template.content.firstElementChild;
  current.replaceWith(fresh);
  wireTraceToggles(fresh);
  return true;
}
function renderRightRail() {
  document.querySelectorAll(".rail-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.rail === state.rail));
  const body = document.querySelector("#railBody");
  const deep = selectedPolicy() === "deep-research";
  const { context, uploads } = runFileCatalog();
  // In deep-research mode the rail lists the whole run catalog, which is why it
  // shows more files than the N in scope. Reconcile each against the job's scope
  // (frozen post-approval, else the live preflight preview) so a file reads as
  // in-scope, pinned, or explicitly excluded.
  const scopeSets = deep ? researchScopeSets(state.researchJob) : null;
  const scopeBadge = (file) => {
    if (!scopeSets) return "";
    const hit = scopeSets.inScope.get(file.path);
    if (hit) return `<span class="scope-tag ${hit.pinned ? "pinned" : "in"}">${hit.pinned ? "pinned" : "in scope"}</span>`;
    if (scopeSets.excluded.has(file.path)) return '<span class="scope-tag out">excluded</span>';
    return "";
  };
  const refBtn = (file) => `<button class="rail-ref" data-ref-scope="${esc(file.scope)}" data-ref-path="${esc(file.path)}" data-ref-name="${esc(file.name)}" title="${deep ? "Pin into the research scope" : "Reference in your next message"}">@</button>`;
  const fileRow = (file, meta) => `<div class="context-row file-ref"><div class="context-name">${esc(file.name)}</div><div class="context-path">@${esc(file.scope)}/${esc(file.name)}${meta ? ` · ${esc(meta)}` : ""}</div>${scopeBadge(file)}${refBtn(file)}</div>`;
  if (state.rail === "myfiles") {
    // My Files = run-scoped uploads ONLY. Run pipeline files live in Context;
    // generated outputs live in Artifacts (row-scoped). The @-mention picker and
    // the pin picker both source the full run catalog via allRunFiles() directly,
    // so dropping the extra groups here does not affect what users can @-reference.
    const uploadRows = uploads.length ? uploads.map((file) => fileRow(file)).join("") : '<div class="rail-empty small">No uploaded files yet.</div>';
    body.innerHTML = `<div class="rail-intro"><b>My files</b><span>Upload evidence, then reference any file with “@” — ${deep ? "pins it into the frozen research scope" : "adds it to your next message"}.</span></div>`
      + `<button id="railUploadBtn" class="btn subtle full small">${icon("plus")} Upload a file</button>`
      + `<div class="rail-group-label">Uploads (@myfiles)</div>${uploadRows}`;
    return;
  }
  // Context = run-scoped pipeline files in BOTH modes. In Deep Research the scope
  // badges (in scope / excluded / pinned) reconcile each file against the job's
  // frozen scope. The research inspector that used to hijack this tab now renders
  // in the DR center panel via renderResearchInspector() — "where the job lives."
  if (state.rail === "context") {
    body.innerHTML = context.length
      ? `<div class="rail-intro"><b>Immutable run evidence</b><span>${context.length} files available to ground this conversation.</span></div>${context.map((file, i) => fileRow(file, `${Math.max(1, Math.ceil((state.context[i]?.bytes || 0) / 1024))} KB`)).join("")}`
      : '<div class="rail-empty">No immutable run context is available.</div>';
    return;
  }
  // Artifacts: scope to the SELECTED left-rail row, not the whole run.
  //  - Deep Research deliverables carry no conversation_id/job_id column — they
  //    are linked only by their research/jobs/{id}/ rel_path prefix, the exact
  //    filter renderDeliverables() uses in the center panel.
  //  - Standard outputs carry conversationId (store.ts listArtifacts maps it).
  //  - notes.md is run-shared (written with no conversation_id, one per run) so it
  //    is intentionally absent from any single conversation's view.
  // Deleting the conversation/job purges these rows (commit 5933963), so there is
  // deliberately no artifact-delete UI here.
  const selected = deep ? state.researchJob : state.conversation;
  if (!selected) {
    body.innerHTML = `<div class="rail-empty">${deep ? "Select a research job to see its deliverables." : "Open a conversation to see its generated files."}</div>`;
    return;
  }
  const scoped = deep
    ? state.artifacts.filter((item) => item.relPath.includes(`research/jobs/${selected.id}/`))
    : state.artifacts.filter((item) => item.conversationId === selected.id);
  body.innerHTML = scoped.length
    ? scoped.map((item) => `<div class="artifact-row file-ref"><a href="/api/artifacts/${encodeURIComponent(item.id)}/content" target="_blank" rel="noopener">${esc(item.relPath)}</a><div class="context-path">${esc(item.kind)} · ${esc(item.createdAt)}</div>${refBtn({ scope: item.kind === "attachment" ? "myfiles" : "artifacts", path: `ai_insights/${item.relPath}`, name: baseName(item.relPath) })}</div>`).join("")
    : `<div class="rail-empty">${deep ? "This job's deliverables will appear here once it runs." : "Generated files and notes for this conversation will appear here."}</div>`;
}
// The Standard composer's @-mention picker (file search → insert a mention chip).
function renderMentionPicker() {
  const host = document.querySelector("#mentionPicker");
  if (!host) return;
  if (!state.mentionPicker) { host.classList.add("hidden"); host.innerHTML = ""; return; }
  const query = (state.mentionPicker.query || "").toLowerCase();
  const files = allRunFiles().filter((file) => !query || `${file.scope}/${file.name}`.toLowerCase().includes(query)).slice(0, 40);
  host.classList.remove("hidden");
  host.innerHTML = `<input id="mentionSearch" class="control" type="search" placeholder="Filter run files…" value="${esc(state.mentionPicker.query || "")}">`
    + `<div class="mention-list">${files.length ? files.map((file) => `<button class="mention-row" data-ref-scope="${esc(file.scope)}" data-ref-path="${esc(file.path)}" data-ref-name="${esc(file.name)}"><b>@${esc(file.scope)}/${esc(file.name)}</b></button>`).join("") : '<div class="rail-empty small">No matching files.</div>'}</div>`;
}
function statusLabel(value) {
  return ({ environment: "From .env", "encrypted-byok": "Encrypted key", missing: "Not configured" })[value] || value || "Not configured";
}
function renderStatus() {
  const config = state.config || { keyStatus: {} };
  document.querySelector("#runCost").textContent = money(state.runCost);
  const split = state.runCostBreakdown || { standardUsd: 0, researchUsd: 0 };
  document.querySelector("#runCostStandard").textContent = money(split.standardUsd);
  document.querySelector("#runCostResearch").textContent = money(split.researchUsd);
  const orEl = document.querySelector("#orSpend");
  const orBtn = document.querySelector("#orResync");
  if (orEl) {
    const or = state.openRouterSpend;
    orEl.textContent = !or ? "—"
      : or.loading ? "syncing…"
      : or.configured === false ? "no .env key"
      : or.error ? "resync failed"
      : `${money(or.totalUsage)} spent · ${money(or.remaining)} left`;
    orEl.title = or && or.error ? String(or.error) : or && or.fetchedAt ? `Synced ${new Date(or.fetchedAt).toLocaleTimeString()}` : "";
    if (orBtn) orBtn.classList.toggle("spinning", Boolean(or && or.loading));
  }
  for (const provider of ["anthropic", "openrouter"]) {
    const value = config.keyStatus?.[provider] || "missing";
    const element = document.querySelector(`#${provider}Status`);
    element.className = `provider-status ${value === "missing" ? "missing" : "ready"}`;
    element.innerHTML = `<span class="status-dot"></span>${esc(statusLabel(value))}`;
  }
  document.querySelector("#threadTitle").textContent = state.conversation?.title || "New research conversation";
  document.querySelector("#threadSub").textContent = state.runId ? `Run ${state.runId} · durable, run-scoped workspace` : "Select a completed run";
  document.querySelectorAll(".conversation-action").forEach((button) => { button.disabled = !state.conversation || state.streaming; });
}

// Pull OpenRouter's authoritative account-wide spend via the .env key (no login).
// force=true bypasses the server-side 60s cache (the manual resync button).
async function refreshOpenRouterSpend(force = false) {
  state.openRouterSpend = { ...(state.openRouterSpend || {}), loading: true };
  renderStatus();
  try {
    state.openRouterSpend = { ...(await api(`/api/cost/openrouter${force ? "?refresh=1" : ""}`)), loading: false };
  } catch (error) {
    state.openRouterSpend = { error: error.message || "resync failed", loading: false };
  }
  renderStatus();
}

function toggleDrawer(open) {
  document.querySelector("#settingsDrawer").classList.toggle("hidden", !open);
  document.querySelector("#drawerBackdrop").classList.toggle("hidden", !open);
  if (open) {
    state.modelDraft = new Set(enabledModelIds());
    state.tierDraft = { high: "", medium: "", low: "", ...(state.config?.modelTiers || {}) };
    state.defaultTierDraft = state.config?.defaultTier || "";
    renderDrawer();
    setTimeout(() => document.querySelector("#closeSettings")?.focus(), 0);
  }
}
function renderDrawer() {
  const body = document.querySelector("#drawerBody");
  if (!body || document.querySelector("#settingsDrawer").classList.contains("hidden")) return;
  const config = state.config || { keyStatus: {} };
  body.innerHTML = `
    <section class="drawer-section">
      <div class="section-heading"><div><p class="eyebrow">Credentials</p><h3>Provider access</h3></div></div>
      <div class="provider-cards">${["openrouter", "anthropic"].map((provider) => {
        const value = config.keyStatus?.[provider] || "missing";
        return `<div class="provider-card"><span class="status-dot ${value === "missing" ? "" : "ok"}"></span><div><b>${provider === "openrouter" ? "OpenRouter" : "Anthropic"}</b><small>${esc(statusLabel(value))}</small></div></div>`;
      }).join("")}</div>
      <p class="drawer-help">Keys are intentionally never populated back into this screen. SignalFold returns only their source and status.</p>
      ${config.credentialStorageEnabled ? `<div class="credential-form"><select id="keyProvider" class="control"><option value="openrouter">OpenRouter</option><option value="anthropic">Anthropic</option></select><input id="apiKey" class="control" type="password" autocomplete="new-password" placeholder="Paste a new API key"><button id="saveKey" class="btn primary">Encrypt &amp; save</button></div>` : `<div class="notice"><b>Encrypted key storage is off.</b><span>Add a stable <code>SESSION_SECRET</code> to <code>ai-sidecar/.env</code> to save keys here. Environment keys continue to work.</span></div>`}
    </section>
    <section class="drawer-section">
      <div class="section-heading"><div><p class="eyebrow">Conversation menu</p><h3>Visible models</h3></div><button id="refreshModels" class="btn subtle">${icon("refresh")} Refresh catalog</button></div>
      <p class="drawer-help">Choose the models researchers may switch between in the conversation header. The server allowlist remains the outer safety boundary.</p>
      <label class="sort-field"><span>Sort model menus by</span><select id="modelSort" class="control"><option value="intelligence" ${config.modelSort === "intelligence" ? "selected" : ""}>Intelligence — highest first</option><option value="cost" ${config.modelSort === "cost" ? "selected" : ""}>Cost — lowest first</option><option value="value" ${config.modelSort === "value" ? "selected" : ""}>Intelligence per dollar</option></select></label>
      <p class="drawer-help metric-note">Scores are the Artificial Analysis Intelligence Index. Value uses Artificial Analysis' recommended 7:2:1 cache-input-output blended price per 1M tokens.</p>
      <input id="modelSearch" class="control" type="search" placeholder="Filter ${state.models.length} tool-capable models…">
      <div id="modelConfigList" class="model-config-list"></div>
      <div class="drawer-actions"><span id="modelCount" class="muted"></span><button id="saveModels" class="btn primary">Save model menu</button></div>
    </section>
    ${renderModelTiersSection()}
    <section class="drawer-section">
      <div class="section-heading"><div><p class="eyebrow">Deep Research</p><h3>Network skills</h3></div></div>
      <p class="drawer-help">Reviewed network skills (e.g. pathway enrichment via Enrichr) run in a per-job container behind a TLS-intercepting egress proxy — allowlisted hosts only, every request audited. <code>run_python</code> and offline skills always stay sealed (<code>--network none</code>). Off by default.</p>
      <div class="model-config-list" style="max-height:none">
        <label class="model-option"><input type="checkbox" id="networkSkillsToggle" ${config.research?.networkSkillsEnabled ? "checked" : ""}><span class="model-check">${icon("check")}</span><span><b>Allow approved network skills (egress proxy)</b><small>Off → no plan can approve one and the agent refuses to run one. A job must still approve each network skill into its scope.</small></span></label>
      </div>
      <p class="drawer-help metric-note">Requires the network images — build once with <code>ai-sidecar/run.sh net-build</code> (the sidecar fails closed if they are missing).</p>
    </section>
    <section class="drawer-section runtime-summary">
      <p class="eyebrow">Runtime summary</p><h3>One durable Pi workspace</h3>
      <dl><div><dt>Turn deadline</dt><dd>${esc(config.turnTimeoutSeconds)} seconds</dd></div><div><dt>Python</dt><dd>${esc(config.pythonExecution || "disabled")}</dd></div><div><dt>Policies</dt><dd>Standard · Deep Research</dd></div><div><dt>Operations trace</dt><dd>${config.operationsCenter ? `On · ${esc(config.operationsRetentionTurns)} turns` : "Off"}</dd></div></dl>
      ${config.operationsCenter ? `<a class="btn subtle full" href="/operations" target="_blank" rel="noopener">Open operational control center</a>` : ""}
    </section>`;
  renderModelConfiguration();
}
function renderModelConfiguration(query = "") {
  const host = document.querySelector("#modelConfigList");
  if (!host) return;
  const enabled = state.modelDraft || new Set(enabledModelIds());
  const needle = query.trim().toLowerCase();
  const visible = sortModels(state.models.filter((model) => !needle || `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(needle)));
  host.innerHTML = visible.length ? visible.map((model) => `<label class="model-option"><input type="checkbox" data-model-enabled value="${esc(model.id)}" ${enabled.has(model.id) ? "checked" : ""}><span class="model-check">${icon("check")}</span><span><b>${esc(model.name)}</b><small>${esc(model.id)} · ${esc(intelligenceLabel(model))} · ${esc(modelCostLabel(model))}</small></span></label>`).join("") : '<div class="rail-empty">No matching models.</div>';
  const count = document.querySelector("#modelCount");
  if (count) count.textContent = `${enabled.size} currently visible`;
}
const TIER_META = { high: "Most capable — hardest reasoning", medium: "Balanced — everyday default", low: "Fast & cheap — simple tasks" };
// Options for a tier selector: the visible (enabled) models, plus the currently
// saved value even if it has since left the menu, plus a blank "none".
function tierOptionsHtml(selectedId) {
  const enabled = new Set(enabledModelIds());
  let choices = sortModels(state.models.filter((model) => enabled.has(model.id)));
  if (selectedId && !choices.some((model) => model.id === selectedId)) {
    const found = state.models.find((model) => model.id === selectedId) || { id: selectedId, name: selectedId.replace(/^openrouter\//, "") };
    choices = [found, ...choices];
  }
  return `<option value="" ${!selectedId ? "selected" : ""}>— none —</option>`
    + choices.map((model) => `<option value="${esc(model.id)}" ${model.id === selectedId ? "selected" : ""}>${esc(model.name)} · ${esc(intelligenceLabel(model))}</option>`).join("");
}
// Three model tiers (high/medium/low) + a radio marking which is THE default
// model used across chat and Deep Research. All three are passed to the research
// agent for future task-aware switching.
function renderModelTiersSection() {
  const tiers = state.tierDraft || { high: "", medium: "", low: "" };
  const def = state.defaultTierDraft || "";
  const rows = ["high", "medium", "low"].map((tier) => `
      <div class="tier-row${def === tier ? " is-default" : ""}">
        <label class="tier-default" title="Use this tier as the default model"><input type="radio" name="defaultTier" data-default-tier value="${tier}" ${def === tier ? "checked" : ""}><span>Default</span></label>
        <div class="tier-meta"><b>${tier[0].toUpperCase()}${tier.slice(1)}</b><small>${esc(TIER_META[tier])}</small></div>
        <select class="control tier-select" data-tier="${tier}" aria-label="${tier} tier model">${tierOptionsHtml(tiers[tier])}</select>
      </div>`).join("");
  return `<section class="drawer-section">
      <div class="section-heading"><div><p class="eyebrow">Default model</p><h3>Model tiers</h3></div></div>
      <p class="drawer-help">Assign three models from your visible menu — high, medium and low capability — and mark one as the default actually used across chat and Deep Research. All three are passed to the research agent so it can switch models as tasks change (switching coming soon).</p>
      <div class="tier-grid">${rows}</div>
      <div class="drawer-actions"><span id="tierHint" class="muted">${tierHintText(tiers, def)}</span><button id="saveModelTiers" class="btn primary">Save default models</button></div>
    </section>`;
}
function tierHintText(tiers, def) {
  return def && tiers[def] ? `Default: ${esc(tiers[def].split("/").pop())}` : "Pick a default tier and assign it a model";
}
// Light in-place refresh on a tier/default change — avoids a full drawer rebuild
// (which would reset the model search filter and scroll).
function updateTierHint() {
  const tiers = state.tierDraft || {};
  const def = state.defaultTierDraft || "";
  const hint = document.querySelector("#tierHint");
  if (hint) hint.innerHTML = tierHintText(tiers, def);
  document.querySelectorAll("[data-default-tier]").forEach((radio) => { radio.checked = radio.value === def; });
  document.querySelectorAll(".tier-row").forEach((row) => {
    const select = row.querySelector("[data-tier]");
    row.classList.toggle("is-default", !!select && select.dataset.tier === def);
  });
}
// Auto-stick to the bottom ONLY when the reader is already near it. While the
// model streams, the reasoning trace and answer text both grow and every frame
// calls this; forcing scrollTop unconditionally meant a user scrolling up to
// read the reasoning was yanked back down on the next delta. Gating on
// `pinnedToBottom` lets them scroll up and stay there. Pass force=true for
// deliberate jumps (opening a conversation, sending a new message).
const SCROLL_PIN_TOLERANCE_PX = 80;
function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < SCROLL_PIN_TOLERANCE_PX;
}
function scrollBottom(force = false) {
  const element = document.querySelector("#messages");
  if (!element) return;
  if (!force && !state.pinnedToBottom) return;
  element.scrollTop = element.scrollHeight;
  state.pinnedToBottom = true;
}

function shell() {
  const sources = ["uniprot", "reactome", "string", "pubmed"];
  return `<div class="ai-app">
    <aside class="rail left-rail">
      <div class="brand"><span class="brand-mark">SF</span><span><b>SignalFold</b><small>AI Insights</small></span></div>
      <div class="rail-section"><label class="label" for="runPicker">Completed run</label><select id="runPicker" class="control"></select></div>
      <div class="rail-section compact"><button id="newBtn" class="btn primary full">${icon("plus")} New conversation</button></div>
      <div class="conv-heading"><span class="label">Conversations</span><button id="convSelectToggle" class="conv-select-toggle hidden" type="button">Select</button></div><div id="convBulkBar" class="conv-bulk-bar hidden"></div><ul id="conversationList" class="conv-list"></ul>
      <div class="rail-footer"><div class="run-cost"><span>Run AI cost</span><b id="runCost">$0.0000</b></div><div class="run-cost-split"><span>Standard <b id="runCostStandard">$0.0000</b></span><span>Deep Research <b id="runCostResearch">$0.0000</b></span></div><div class="provider-row"><span>OpenRouter</span><span id="openrouterStatus"></span></div><div class="provider-row or-billed"><span>Billed <small>(account)</small></span><span class="or-billed-val"><b id="orSpend">—</b><button id="orResync" class="resync-btn" type="button" title="Resync spend from OpenRouter" aria-label="Resync OpenRouter spend">${icon("refresh")}</button></span></div><div class="provider-row"><span>Anthropic</span><span id="anthropicStatus"></span></div><a id="operationsBtn" class="btn subtle full hidden" href="/operations" target="_blank" rel="noopener">Operational control center</a><button id="settingsBtn" class="btn subtle full">${icon("settings")} Configuration &amp; summary</button></div>
    </aside>
    <main class="workspace">
      <header class="thread-head"><div class="thread-copy"><div id="threadTitle" class="thread-title"></div><div id="threadSub" class="thread-sub"></div></div><div class="thread-controls"><div class="action-group"><button id="renameBtn" class="icon-btn conversation-action" title="Rename conversation" aria-label="Rename conversation">${icon("edit")}</button><button id="exportBtn" class="icon-btn conversation-action" title="Export conversation" aria-label="Export conversation">${icon("download")}</button><button id="clearBtn" class="icon-btn conversation-action" title="Clear messages" aria-label="Clear messages">${icon("clear")}</button></div><label class="compact-field"><span>Policy</span><select id="policyPicker" class="control policy"><option value="standard">Standard</option><option value="deep-research">Deep Research</option></select></label><label class="compact-field model-field"><span>Model</span><select id="modelPicker" class="control model-picker" aria-label="Conversation model"></select></label></div></header>
      <section id="messages" class="messages" aria-live="polite"></section>
      <footer class="composer-wrap"><div class="source-row"><span class="label inline">This turn may use</span>${sources.map((source) => `<label class="source-chip"><input type="checkbox" data-source="${source}"><span>${source === "string" ? "STRING" : source[0].toUpperCase() + source.slice(1)}</span></label>`).join("")}</div><div id="mentionPicker" class="mention-picker hidden"></div><div id="attachmentStrip" class="attachment-strip"></div><div id="mentionStrip" class="mention-strip"></div><div class="composer"><button id="attachBtn" class="icon-btn" title="Attach evidence" aria-label="Attach evidence">${icon("paperclip")}</button><button id="mentionBtn" class="icon-btn" title="Reference a run file (@)" aria-label="Reference a run file">@</button><input id="fileInput" type="file" class="hidden" multiple><textarea id="prompt" rows="1" placeholder="Ask about proteins, modules, enrichment… use @ to reference a file"></textarea><button id="sendBtn" class="btn primary send">${icon("send")} Send</button></div><p class="composer-hint">Enter to send · Shift+Enter for a new line · @ references run files</p></footer>
    </main>
    <aside class="rail right-rail"><div class="rail-tabs"><button class="rail-tab active" data-rail="context">Context</button><button class="rail-tab" data-rail="myfiles">My Files</button><button class="rail-tab" data-rail="artifacts">Artifacts</button></div><div id="railBody" class="rail-body"></div></aside>
  </div>
  <button id="drawerBackdrop" class="drawer-backdrop hidden" aria-label="Close configuration"></button>
  <aside id="settingsDrawer" class="drawer hidden" aria-label="AI configuration"><div class="drawer-head"><div><p class="eyebrow">SignalFold AI</p><h2>Configuration &amp; summary</h2></div><button id="closeSettings" class="icon-btn" aria-label="Close configuration">${icon("close")}</button></div><div id="drawerBody" class="drawer-body"></div></aside>`;
}
