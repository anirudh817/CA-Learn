import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type JsonMap = Record<string, unknown>;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; }
};

export interface ConversationInput { runId: string; userId: string; title?: string; policy?: string; model?: string; defaultSources?: string[] }
export interface MessageOptions {
  status?: string; provider?: string; model?: string; requestedSources?: string[]; effectiveSources?: string[];
  provenance?: JsonMap[]; citations?: JsonMap[]; trace?: JsonMap[]; inputTokens?: number; outputTokens?: number; costUsd?: number;
}

export interface OperationTurnInput {
  runId: string;
  conversationId: string;
  userId: string;
  model: string;
  policy: string;
  questionPreview: string;
}

export interface OperationEventInput {
  category: string;
  name: string;
  status?: string;
  durationMs?: number;
  payload?: JsonMap;
}

export class AIStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
        policy TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', default_sources TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, model TEXT,
        requested_sources TEXT NOT NULL DEFAULT '[]', effective_sources TEXT NOT NULL DEFAULT '[]',
        provenance TEXT NOT NULL DEFAULT '[]', citations TEXT NOT NULL DEFAULT '[]', trace TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT, message_id TEXT, kind TEXT NOT NULL,
        rel_path TEXT NOT NULL, mime_type TEXT, sha256 TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_feedback (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, rating INTEGER, note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_credentials (
        user_id TEXT NOT NULL, provider TEXT NOT NULL, encrypted_key TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, provider)
      );
      CREATE TABLE IF NOT EXISTS ai_preferences (
        user_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, name)
      );
      CREATE TABLE IF NOT EXISTS ai_operation_turns (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
        model TEXT NOT NULL, policy TEXT NOT NULL, question_preview TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
        prompt_chars INTEGER NOT NULL DEFAULT 0, grounding_files INTEGER NOT NULL DEFAULT 0,
        grounding_bytes INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        assistant_message_id TEXT, error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS ai_operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES ai_operation_turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, occurred_at TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info', duration_ms INTEGER, payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(turn_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_run ON ai_conversations(run_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_artifacts_run ON ai_artifacts(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_operation_turns_started ON ai_operation_turns(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_operation_turns_run ON ai_operation_turns(run_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_operation_events_turn ON ai_operation_events(turn_id, seq);
    `);
    const messageColumns = new Set((this.db.prepare("PRAGMA table_info(ai_messages)").all() as any[]).map((column) => column.name));
    if (!messageColumns.has("pinned")) this.db.exec("ALTER TABLE ai_messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }

  createConversation(input: ConversationInput) {
    const record = {
      id: id("conv"), runId: input.runId, userId: input.userId, title: (input.title || "New research chat").slice(0, 120),
      policy: input.policy || "standard", model: input.model || "", defaultSources: input.defaultSources || [], createdAt: now(), updatedAt: now(),
    };
    this.db.prepare(`INSERT INTO ai_conversations (id,run_id,user_id,title,policy,model,default_sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.runId, record.userId, record.title, record.policy, record.model, json(record.defaultSources), record.createdAt, record.updatedAt);
    return record;
  }

  listConversations(runId: string, userId = "local") {
    return this.db.prepare("SELECT * FROM ai_conversations WHERE run_id=? AND user_id=? AND archived_at IS NULL ORDER BY updated_at DESC").all(runId, userId).map(mapConversation);
  }

  getConversation(conversationId: string) {
    const row = this.db.prepare("SELECT * FROM ai_conversations WHERE id=? AND archived_at IS NULL").get(conversationId);
    return row ? mapConversation(row) : null;
  }

  updateConversation(conversationId: string, patch: { title?: string; policy?: string; model?: string; defaultSources?: string[] }) {
    const current = this.getConversation(conversationId);
    if (!current) return null;
    const next = {
      ...current,
      title: patch.title ?? current.title,
      policy: patch.policy ?? current.policy,
      model: patch.model ?? current.model,
      defaultSources: patch.defaultSources ?? current.defaultSources,
      updatedAt: now(),
    };
    this.db.prepare("UPDATE ai_conversations SET title=?,policy=?,model=?,default_sources=?,updated_at=? WHERE id=?")
      .run(next.title, next.policy, next.model, json(next.defaultSources), next.updatedAt, conversationId);
    return next;
  }

  archiveConversation(conversationId: string) {
    return this.db.prepare("UPDATE ai_conversations SET archived_at=?,updated_at=? WHERE id=?").run(now(), now(), conversationId).changes > 0;
  }

  clearConversation(conversationId: string) {
    this.db.prepare("DELETE FROM ai_messages WHERE conversation_id=?").run(conversationId);
    this.db.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?").run(now(), conversationId);
  }

  /** Full export bundle for a conversation: metadata, messages, feedback, its
   *  Operations Control Center turns (with events), and conversation-scoped
   *  artifacts. Archived conversations are included so a soft-archived chat can
   *  still be exported on its way to deletion. */
  gatherConversationExport(conversationId: string) {
    const row = this.db.prepare("SELECT * FROM ai_conversations WHERE id=?").get(conversationId);
    if (!row) return null;
    const messages = this.listMessages(conversationId);
    const feedback: Record<string, unknown[]> = {};
    for (const message of messages) {
      if (message.role === "assistant") feedback[message.id] = this.listFeedback(message.id);
    }
    const operationTurns = (this.db.prepare("SELECT * FROM ai_operation_turns WHERE conversation_id=? ORDER BY started_at").all(conversationId) as any[]).map((turn) => ({
      ...mapOperationTurn(turn),
      events: this.db.prepare("SELECT * FROM ai_operation_events WHERE turn_id=? ORDER BY seq").all(turn.id).map(mapOperationEvent),
    }));
    const artifacts = (this.db.prepare("SELECT * FROM ai_artifacts WHERE conversation_id=? ORDER BY created_at").all(conversationId) as any[]).map((artifact) => ({
      id: artifact.id, runId: artifact.run_id, conversationId: artifact.conversation_id, messageId: artifact.message_id,
      kind: artifact.kind, relPath: artifact.rel_path, mimeType: artifact.mime_type, sha256: artifact.sha256, createdAt: artifact.created_at,
    }));
    return { conversation: mapConversation(row), messages, feedback, operationTurns, artifacts };
  }

  /** Hard-delete a conversation and everything tied to it: messages + feedback
   *  (FK cascade), its Operations Control Center turns + events (no FK to a
   *  conversation — deleted explicitly; events cascade off the turn), and its
   *  artifact rows (no FK — deleted explicitly; the files are removed by the
   *  caller via the returned rel-paths). Returns null if it does not exist. */
  purgeConversation(conversationId: string): { runId: string | null; artifactRelPaths: string[] } | null {
    const row = this.db.prepare("SELECT id,run_id FROM ai_conversations WHERE id=?").get(conversationId) as { id: string; run_id: string } | undefined;
    if (!row) return null;
    const artifactRelPaths = (this.db.prepare("SELECT rel_path FROM ai_artifacts WHERE conversation_id=?").all(conversationId) as { rel_path: string }[]).map((a) => a.rel_path);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM ai_operation_turns WHERE conversation_id=?").run(conversationId); // cascades ai_operation_events
      this.db.prepare("DELETE FROM ai_artifacts WHERE conversation_id=?").run(conversationId);
      this.db.prepare("DELETE FROM ai_conversations WHERE id=?").run(conversationId); // cascades ai_messages -> ai_feedback
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { runId: row.run_id || null, artifactRelPaths };
  }

  addMessage(conversationId: string, role: string, content: string, options: MessageOptions = {}) {
    const record = {
      id: id("msg"), conversationId, role, content, status: options.status || "complete", provider: options.provider || null,
      model: options.model || null, requestedSources: options.requestedSources || [], effectiveSources: options.effectiveSources || [],
      provenance: options.provenance || [], citations: options.citations || [], trace: options.trace || [], inputTokens: options.inputTokens || 0,
      outputTokens: options.outputTokens || 0, costUsd: options.costUsd || 0, createdAt: now(),
    };
    this.db.prepare(`INSERT INTO ai_messages (id,conversation_id,role,content,status,provider,model,requested_sources,effective_sources,provenance,citations,trace,input_tokens,output_tokens,cost_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id, conversationId, role, content, record.status, record.provider, record.model, json(record.requestedSources), json(record.effectiveSources), json(record.provenance), json(record.citations), json(record.trace), record.inputTokens, record.outputTokens, record.costUsd, record.createdAt);
    this.db.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?").run(record.createdAt, conversationId);
    return record;
  }

  listMessages(conversationId: string) {
    return this.db.prepare("SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid").all(conversationId).map(mapMessage);
  }

  getMessage(messageId: string) {
    const row = this.db.prepare(`SELECT m.*, c.run_id FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE m.id=?`).get(messageId) as any;
    return row ? { ...mapMessage(row), runId: row.run_id } : null;
  }

  setPinned(messageId: string, pinned: boolean) {
    return this.db.prepare("UPDATE ai_messages SET pinned=? WHERE id=? AND role='assistant'").run(pinned ? 1 : 0, messageId).changes > 0;
  }

  addFeedback(messageId: string, userId: string, rating: number | null, note: string) {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM ai_feedback WHERE message_id=? AND user_id=?").get(messageId, userId) as { revision: number };
    const record = { id: id("feedback"), messageId, userId, rating, note, revision: Number(row.revision), createdAt: now() };
    this.db.prepare("INSERT INTO ai_feedback (id,message_id,user_id,rating,note,revision,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(record.id, messageId, userId, rating, note, record.revision, record.createdAt);
    return record;
  }

  listFeedback(messageId: string) {
    return this.db.prepare("SELECT * FROM ai_feedback WHERE message_id=? ORDER BY revision").all(messageId);
  }

  addArtifact(input: { runId: string; conversationId?: string; messageId?: string; kind: string; relPath: string; mimeType?: string; sha256?: string }) {
    if (path.isAbsolute(input.relPath) || input.relPath.split(/[\\/]/).includes("..") || !input.relPath.trim()) {
      throw new Error("Artifact must use a safe relative path within the run AI root");
    }
    const record = { id: id("artifact"), ...input, createdAt: now() };
    this.db.prepare("INSERT INTO ai_artifacts (id,run_id,conversation_id,message_id,kind,rel_path,mime_type,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(record.id, input.runId, input.conversationId || null, input.messageId || null, input.kind, input.relPath, input.mimeType || null, input.sha256 || null, record.createdAt);
    return record;
  }

  listArtifacts(runId: string) {
    return this.db.prepare("SELECT * FROM ai_artifacts WHERE run_id=? ORDER BY created_at DESC").all(runId).map((row: any) => ({
      id: row.id, runId: row.run_id, conversationId: row.conversation_id, messageId: row.message_id, kind: row.kind,
      relPath: row.rel_path, mimeType: row.mime_type, sha256: row.sha256, createdAt: row.created_at,
    }));
  }

  /** Drop the run-scoped artifact index rows a research job registered (their
   *  rel_path is research/jobs/{jobId}/...). The files live under the job dir and
   *  are removed by the research service; this only clears the index so the
   *  artifacts panel and run-cost tally stop counting a deleted job. */
  deleteResearchArtifacts(runId: string, jobId: string): number {
    const prefix = `research/jobs/${jobId}/`;
    const rows = this.db.prepare("SELECT id,rel_path FROM ai_artifacts WHERE run_id=?").all(runId) as Array<{ id: string; rel_path: string }>;
    const del = this.db.prepare("DELETE FROM ai_artifacts WHERE id=?");
    let removed = 0;
    for (const row of rows) if (row.rel_path.startsWith(prefix)) { del.run(row.id); removed += 1; }
    return removed;
  }

  runCost(runId: string) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(m.cost_usd),0) AS cost FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE c.run_id=?`).get(runId) as { cost: number };
    return Number(row.cost || 0);
  }

  setCredential(userId: string, provider: string, encryptedKey: string) {
    this.db.prepare("INSERT INTO ai_credentials (user_id,provider,encrypted_key,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_key=excluded.encrypted_key,updated_at=excluded.updated_at")
      .run(userId, provider, encryptedKey, now());
  }

  getCredential(userId: string, provider: string) {
    const row = this.db.prepare("SELECT encrypted_key FROM ai_credentials WHERE user_id=? AND provider=?").get(userId, provider) as { encrypted_key?: string } | undefined;
    return row?.encrypted_key || null;
  }

  credentialProviders(userId: string) {
    return (this.db.prepare("SELECT provider FROM ai_credentials WHERE user_id=?").all(userId) as { provider: string }[]).map((row) => row.provider);
  }

  getPreference<T>(userId: string, name: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM ai_preferences WHERE user_id=? AND name=?").get(userId, name) as { value_json?: string } | undefined;
    return parse<T>(row?.value_json, fallback);
  }

  setPreference(userId: string, name: string, value: unknown) {
    this.db.prepare("INSERT INTO ai_preferences (user_id,name,value_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(userId, name, json(value), now());
  }

  startOperationTurn(input: OperationTurnInput, retentionTurns = 100) {
    const record = {
      id: id("op"), ...input, status: "running", startedAt: now(),
      questionPreview: input.questionPreview.replace(/\s+/g, " ").trim().slice(0, 180),
    };
    this.db.prepare(`INSERT INTO ai_operation_turns
      (id,run_id,conversation_id,user_id,model,policy,question_preview,status,started_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.runId, record.conversationId, record.userId, record.model, record.policy, record.questionPreview, record.status, record.startedAt);
    this.db.prepare(`DELETE FROM ai_operation_turns WHERE id IN (
      SELECT id FROM ai_operation_turns ORDER BY started_at DESC LIMIT -1 OFFSET ?
    )`).run(Math.max(10, retentionTurns));
    return record;
  }

  appendOperationEvent(turnId: string, event: OperationEventInput) {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM ai_operation_events WHERE turn_id=?").get(turnId) as { seq: number };
    const record = {
      seq: Number(row.seq), occurredAt: now(), category: event.category, name: event.name,
      status: event.status || "info", durationMs: event.durationMs ?? null, payload: event.payload || {},
    };
    this.db.prepare(`INSERT INTO ai_operation_events
      (turn_id,seq,occurred_at,category,name,status,duration_ms,payload_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run(turnId, record.seq, record.occurredAt, record.category, record.name, record.status, record.durationMs, json(record.payload));
    return record;
  }

  setOperationPromptMetrics(turnId: string, promptChars: number, groundingFiles: number, groundingBytes: number) {
    this.db.prepare("UPDATE ai_operation_turns SET prompt_chars=?,grounding_files=?,grounding_bytes=? WHERE id=?")
      .run(promptChars, groundingFiles, groundingBytes, turnId);
  }

  setOperationUsage(turnId: string, inputTokens: number, outputTokens: number, costUsd: number) {
    this.db.prepare("UPDATE ai_operation_turns SET input_tokens=?,output_tokens=?,cost_usd=? WHERE id=?")
      .run(inputTokens, outputTokens, costUsd, turnId);
  }

  finishOperationTurn(turnId: string, input: { status: string; assistantMessageId?: string; errorMessage?: string }) {
    const completedAt = now();
    const row = this.db.prepare("SELECT started_at FROM ai_operation_turns WHERE id=?").get(turnId) as { started_at?: string } | undefined;
    const durationMs = row?.started_at ? Math.max(0, Date.parse(completedAt) - Date.parse(row.started_at)) : 0;
    this.db.prepare("UPDATE ai_operation_turns SET status=?,completed_at=?,duration_ms=?,assistant_message_id=?,error_message=? WHERE id=?")
      .run(input.status, completedAt, durationMs, input.assistantMessageId || null, input.errorMessage || null, turnId);
  }

  listOperationTurns(input: { runId?: string; conversationId?: string; status?: string; limit?: number } = {}) {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (input.runId) { where.push("t.run_id=?"); values.push(input.runId); }
    if (input.conversationId) { where.push("t.conversation_id=?"); values.push(input.conversationId); }
    if (input.status) { where.push("t.status=?"); values.push(input.status); }
    const limit = Math.min(250, Math.max(1, Number(input.limit || 100)));
    values.push(limit);
    return this.db.prepare(`SELECT t.*,c.title AS conversation_title,
      (SELECT COUNT(*) FROM ai_operation_events e WHERE e.turn_id=t.id) AS event_count
      FROM ai_operation_turns t LEFT JOIN ai_conversations c ON c.id=t.conversation_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.started_at DESC LIMIT ?`).all(...values).map(mapOperationTurn);
  }

  getOperationTurn(turnId: string) {
    const row = this.db.prepare(`SELECT t.*,c.title AS conversation_title
      FROM ai_operation_turns t LEFT JOIN ai_conversations c ON c.id=t.conversation_id WHERE t.id=?`).get(turnId);
    if (!row) return null;
    const events = this.db.prepare("SELECT * FROM ai_operation_events WHERE turn_id=? ORDER BY seq").all(turnId).map(mapOperationEvent);
    const turn = mapOperationTurn(row);
    // Read-only transcript enrichment for the developer console: the full
    // request text, the response text, and the reasoning/tooling trace are
    // pulled from the chat messages this turn produced so triage does not have
    // to reconstruct them from the composed-prompt blob.
    const userMessageId = events.find((event) => event.name === "user_message_saved")?.payload?.messageId;
    return {
      turn,
      events,
      request: this.operationTranscript(typeof userMessageId === "string" ? userMessageId : null),
      response: this.operationTranscript(turn.assistantMessageId),
    };
  }

  private operationTranscript(messageId?: string | null) {
    if (!messageId) return null;
    const row = this.db.prepare("SELECT id,role,content,status,trace,model,created_at FROM ai_messages WHERE id=?").get(messageId) as any;
    if (!row) return null;
    return { id: row.id, role: row.role, content: row.content, status: row.status, trace: parse<JsonMap[]>(row.trace, []), model: row.model, createdAt: row.created_at };
  }

  operationSummary(runId?: string) {
    const where = runId ? "WHERE run_id=?" : "";
    const values = runId ? [runId] : [];
    const summary = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
      COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END),0) AS avg_duration_ms,
      COALESCE(SUM(grounding_bytes),0) AS grounding_bytes,
      COALESCE(SUM(cost_usd),0) AS cost_usd FROM ai_operation_turns ${where}`).get(...values) as any;
    const eventWhere = runId ? "AND t.run_id=?" : "";
    const events = this.db.prepare(`SELECT
      SUM(CASE WHEN e.category='tool' AND e.name LIKE '%start%' THEN 1 ELSE 0 END) AS tool_runs,
      SUM(CASE WHEN e.category='skill' AND e.name LIKE '%start%' THEN 1 ELSE 0 END) AS skill_runs,
      SUM(CASE WHEN e.category='python' AND e.name LIKE '%start%' THEN 1 ELSE 0 END) AS python_runs
      FROM ai_operation_events e JOIN ai_operation_turns t ON t.id=e.turn_id WHERE 1=1 ${eventWhere}`).get(...values) as any;
    return {
      total: Number(summary.total || 0), active: Number(summary.active || 0), complete: Number(summary.complete || 0),
      failed: Number(summary.failed || 0), blocked: Number(summary.blocked || 0), avgDurationMs: Number(summary.avg_duration_ms || 0),
      groundingBytes: Number(summary.grounding_bytes || 0), costUsd: Number(summary.cost_usd || 0),
      toolRuns: Number(events.tool_runs || 0), skillRuns: Number(events.skill_runs || 0), pythonRuns: Number(events.python_runs || 0),
    };
  }

  close() { this.db.close(); }
}

function mapConversation(row: any) {
  return { id: row.id, runId: row.run_id, userId: row.user_id, title: row.title, policy: row.policy, model: row.model,
    defaultSources: parse<string[]>(row.default_sources, []), createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMessage(row: any) {
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, status: row.status,
    provider: row.provider, model: row.model, requestedSources: parse<string[]>(row.requested_sources, []), effectiveSources: parse<string[]>(row.effective_sources, []),
    provenance: parse<JsonMap[]>(row.provenance, []), citations: parse<JsonMap[]>(row.citations, []), trace: parse<JsonMap[]>(row.trace, []),
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: row.cost_usd, pinned: Boolean(row.pinned), createdAt: row.created_at };
}

function mapOperationTurn(row: any) {
  return {
    id: row.id, runId: row.run_id, conversationId: row.conversation_id, conversationTitle: row.conversation_title || "",
    userId: row.user_id, model: row.model, policy: row.policy, questionPreview: row.question_preview, status: row.status,
    startedAt: row.started_at, completedAt: row.completed_at, durationMs: row.duration_ms, promptChars: row.prompt_chars,
    groundingFiles: row.grounding_files, groundingBytes: row.grounding_bytes, inputTokens: row.input_tokens,
    outputTokens: row.output_tokens, costUsd: row.cost_usd, assistantMessageId: row.assistant_message_id,
    errorMessage: row.error_message, eventCount: Number(row.event_count || 0),
  };
}

function mapOperationEvent(row: any) {
  return {
    id: row.id, turnId: row.turn_id, seq: row.seq, occurredAt: row.occurred_at, category: row.category,
    name: row.name, status: row.status, durationMs: row.duration_ms, payload: parse<JsonMap>(row.payload_json, {}),
  };
}
