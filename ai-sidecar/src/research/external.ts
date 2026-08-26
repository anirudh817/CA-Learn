import crypto from "node:crypto";
import { assertExternalUrlAllowed, inspectPrompt, sanitizeExternalQuery, scrubOutput } from "../security.js";

// Curated external-corroboration arm for Deep Research. Each adapter hits one
// reviewed public biology API for a single safe entity token and returns a short
// summary + citations. Everything sits behind a safety chain so a flaky or slow
// endpoint can never stall or crash a job: cache → circuit breaker → bounded
// timeout → single retry. Networked execution is OPT-IN per job (plan.sources);
// when no source is approved this module is never invoked.

export const EXTERNAL_SOURCE_CAPABILITIES = {
  uniprot: { operations: ["protein-search"], adapterVersion: "uniprot-v1" },
  pubmed: { operations: ["literature-search"], adapterVersion: "ncbi-eutils-v1" },
  pmc: { operations: ["open-full-text-search"], adapterVersion: "ncbi-pmc-v1" },
  reactome: { operations: ["pathway-search"], adapterVersion: "reactome-v1" },
  string: { operations: ["identifier-resolution"], adapterVersion: "string-v1" },
  quickgo: { operations: ["annotation-search"], adapterVersion: "quickgo-v1" },
} as const;
export const EXTERNAL_SOURCES = Object.keys(EXTERNAL_SOURCE_CAPABILITIES);

export type ExternalStatus = "ok" | "empty" | "cache" | "circuit-open" | "quota" | "timeout" | "blocked" | "quarantined" | "error";

export interface ExternalEvidenceItem {
  source: string;
  term: string;
  ok: boolean;
  status: ExternalStatus;
  summary: string;
  url: string;
  count: number;
  citations: Array<{ title: string; id: string; url: string; verified?: boolean }>;
  fetchedAt: string;
  operation?: string;
  snapshot?: { schemaVersion: "1.0"; source: string; operation: string; querySha256: string; responseSha256: string; requestUrl: string; adapterVersion: string; citationsVerified: boolean; quarantined: boolean; fetchedAt: string };
  error?: string;
}

export type ExternalLookup = (input: { source: string; term: string; operation?: string; signal?: AbortSignal }) => Promise<ExternalEvidenceItem>;

interface AdapterResult { summary: string; count: number; citations: ExternalEvidenceItem["citations"] }

const enc = encodeURIComponent;

const defaultOperation = (source: string) => EXTERNAL_SOURCE_CAPABILITIES[source as keyof typeof EXTERNAL_SOURCE_CAPABILITIES]?.operations[0] || "";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function buildUrl(source: string, term: string, operation: string, ncbiApiKey?: string): string {
  switch (source) {
    case "uniprot":
      return `https://rest.uniprot.org/uniprotkb/search?query=${enc(term)}&format=json&fields=accession,protein_name,gene_names,organism_name&size=1`;
    case "reactome":
      return `https://reactome.org/ContentService/search/query?query=${enc(term)}&species=Homo%20sapiens&cluster=true`;
    case "string":
      return `https://string-db.org/api/json/get_string_ids?identifiers=${enc(term)}&species=9606&limit=1&format=json`;
    case "pubmed":
      return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${enc(term)}&retmode=json&retmax=3${ncbiApiKey ? `&api_key=${enc(ncbiApiKey)}` : ""}`;
    case "pmc":
      return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&term=${enc(term)}%20AND%20open%20access[filter]&retmode=json&retmax=3${ncbiApiKey ? `&api_key=${enc(ncbiApiKey)}` : ""}`;
    case "quickgo":
      return `https://www.ebi.ac.uk/QuickGO/services/annotation/search?geneProductId=${enc(term)}&limit=3`;
    default:
      throw new Error(`Unknown external source: ${source}`);
  }
}

function parse(source: string, term: string, body: unknown): AdapterResult {
  const cite = (title: string, id: string, url: string) => ({ title: scrubOutput(String(title || "")).slice(0, 200), id: String(id || ""), url });
  if (source === "uniprot") {
    const results = (body as { results?: any[] })?.results || [];
    const hit = results[0];
    if (!hit) return { summary: "", count: 0, citations: [] };
    const name = hit.proteinDescription?.recommendedName?.fullName?.value || hit.uniProtkbId || hit.primaryAccession || "";
    const genes = (hit.genes || []).map((gene: any) => gene?.geneName?.value).filter(Boolean).join(", ");
    return { summary: `UniProt ${hit.primaryAccession || ""}: ${name}${genes ? ` (genes ${genes})` : ""}`.trim(), count: results.length, citations: [cite(name || hit.primaryAccession, hit.primaryAccession, `https://www.uniprot.org/uniprotkb/${hit.primaryAccession}`)] };
  }
  if (source === "reactome") {
    const groups = (body as { results?: any[] })?.results || [];
    const entries = groups.flatMap((group: any) => group?.entries || []).slice(0, 3);
    if (!entries.length) return { summary: "", count: 0, citations: [] };
    const total = groups.reduce((sum: number, group: any) => sum + (group?.entries?.length || 0), 0);
    return { summary: `Reactome: ${entries.map((entry: any) => entry.name).filter(Boolean).slice(0, 3).join("; ")}`, count: total, citations: entries.map((entry: any) => cite(entry.name, entry.stId || entry.id, `https://reactome.org/content/detail/${entry.stId || entry.id}`)) };
  }
  if (source === "string") {
    const hits = Array.isArray(body) ? body : [];
    const hit = hits[0];
    if (!hit) return { summary: "", count: 0, citations: [] };
    return { summary: `STRING ${hit.preferredName || term}: ${(hit.annotation || "").slice(0, 220)}`.trim(), count: hits.length, citations: [cite(hit.preferredName || term, hit.stringId || "", `https://string-db.org/network/${hit.stringId || ""}`)] };
  }
  if (source === "quickgo") {
    const hits = (body as { results?: any[] })?.results || [];
    if (!hits.length) return { summary: "", count: 0, citations: [] };
    return { summary: `QuickGO: ${hits.slice(0, 3).map((item: any) => `${item.goId || "GO"} ${item.goName || item.qualifier || "annotation"}`).join("; ")}`, count: Number((body as any)?.numberOfHits || hits.length), citations: hits.slice(0, 3).map((item: any) => cite(item.goName || item.goId, item.goId || item.id, `https://www.ebi.ac.uk/QuickGO/term/${item.goId || ""}`)) };
  }
  // PubMed / PMC share NCBI esearch.
  const result = (body as { esearchresult?: { count?: string; idlist?: string[] } })?.esearchresult;
  const ids = (result?.idlist || []).slice(0, 3);
  const count = Number(result?.count || ids.length || 0);
  if (!count) return { summary: "", count: 0, citations: [] };
  const pmc = source === "pmc";
  return { summary: `${pmc ? "PMC open full text" : "PubMed"}: ${count} record${count === 1 ? "" : "s"} for "${term}"`, count, citations: ids.map((id) => cite(`${pmc ? "PMCID" : "PMID"} ${id}`, id, pmc ? `https://pmc.ncbi.nlm.nih.gov/articles/PMC${String(id).replace(/^PMC/i, "")}/` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`)) };
}

/** Build the safety-chained external lookup. `fetchImpl` is injectable so tests
 *  run fully offline and deterministically. */
export function createExternalLookup(options: {
  timeoutMs?: number;
  ttlMs?: number;
  ncbiApiKey?: string;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  maxRequestsPerSource?: number;
  quotaWindowMs?: number;
  maxConcurrency?: number;
  fetchImpl?: typeof fetch;
} = {}): ExternalLookup {
  const timeoutMs = Math.max(500, options.timeoutMs ?? 6000);
  const ttlMs = Math.max(0, options.ttlMs ?? 6 * 60 * 60 * 1000);
  const breakerThreshold = Math.max(1, options.breakerThreshold ?? 3);
  const breakerCooldownMs = Math.max(1000, options.breakerCooldownMs ?? 60_000);
  const fetchImpl = options.fetchImpl || fetch;
  const maxRequestsPerSource = Math.max(1, options.maxRequestsPerSource ?? 60);
  const quotaWindowMs = Math.max(1000, options.quotaWindowMs ?? 60 * 60 * 1000);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
  const cache = new Map<string, { at: number; value: ExternalEvidenceItem }>();
  const breaker = new Map<string, { failures: number; openUntil: number }>();
  const quota = new Map<string, number[]>();
  let active = 0; const waiters: Array<() => void> = [];
  const acquire = async () => { if (active >= maxConcurrency) await new Promise<void>((resolve) => waiters.push(resolve)); active += 1; };
  const release = () => { active = Math.max(0, active - 1); waiters.shift()?.(); };

  return async ({ source, term, operation: requestedOperation }) => {
    const fetchedAt = new Date().toISOString();
    const safe = sanitizeExternalQuery(term);
    const operation = requestedOperation || defaultOperation(source);
    const base: ExternalEvidenceItem = { source, term: safe, operation, ok: false, status: "error", summary: "", url: "", count: 0, citations: [], fetchedAt };
    if (!EXTERNAL_SOURCES.includes(source)) return { ...base, status: "blocked", error: `Unknown external source: ${source}` };
    const capability = EXTERNAL_SOURCE_CAPABILITIES[source as keyof typeof EXTERNAL_SOURCE_CAPABILITIES];
    if (!(capability.operations as readonly string[]).includes(operation)) return { ...base, status: "blocked", error: `Operation ${operation || "(empty)"} is not allowed for ${source}` };
    if (!safe) return { ...base, status: "blocked", error: "Query rejected by the egress guard" };

    const key = `${source}|${operation}|${safe.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return { ...cached.value, status: "cache", fetchedAt };

    const gate = breaker.get(source);
    if (gate && gate.openUntil > Date.now()) return { ...base, status: "circuit-open", error: `Circuit open for ${source}` };
    const recent = (quota.get(source) || []).filter((at) => Date.now() - at < quotaWindowMs);
    if (recent.length >= maxRequestsPerSource) return { ...base, status: "quota", error: `Quota reached for ${source}` };
    recent.push(Date.now()); quota.set(source, recent);

    let url = "";
    try {
      url = buildUrl(source, safe, operation, options.ncbiApiKey);
      assertExternalUrlAllowed(url, source);
    } catch (error) {
      return { ...base, status: "blocked", error: error instanceof Error ? error.message : String(error) };
    }

    let lastError = "";
    await acquire();
    try { for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const bodyJson = stableJson(body);
        const hostile = !inspectPrompt(bodyJson.slice(0, 200_000)).allowed;
        const snapshotBase = { schemaVersion: "1.0" as const, source, operation, querySha256: digest(safe), responseSha256: digest(bodyJson), requestUrl: url, adapterVersion: capability.adapterVersion, fetchedAt };
        if (hostile) return { ...base, url, status: "quarantined", error: "External response quarantined by prompt-injection policy", snapshot: { ...snapshotBase, citationsVerified: false, quarantined: true } };
        const parsed = parse(source, safe, body);
        const citations = parsed.citations.map((citation) => { let verified = Boolean(citation.id && citation.url); try { assertExternalUrlAllowed(citation.url, source); } catch { verified = false; } return { ...citation, verified }; });
        const citationsVerified = citations.every((citation) => citation.verified);
        const item: ExternalEvidenceItem = {
          source, term: safe, ok: parsed.count > 0, status: parsed.count > 0 ? "ok" : "empty",
          operation, summary: scrubOutput(parsed.summary).slice(0, 600), url, count: parsed.count, citations, fetchedAt,
          snapshot: { ...snapshotBase, citationsVerified, quarantined: false },
        };
        cache.set(key, { at: Date.now(), value: item });
        breaker.set(source, { failures: 0, openUntil: 0 });
        return item;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 0) continue;
      }
    } } finally { release(); }
    const failures = (breaker.get(source)?.failures || 0) + 1;
    breaker.set(source, { failures, openUntil: failures >= breakerThreshold ? Date.now() + breakerCooldownMs : 0 });
    const timedOut = /abort|timeout|timed out/i.test(lastError);
    return { ...base, status: timedOut ? "timeout" : "error", error: scrubOutput(lastError) };
  };
}
