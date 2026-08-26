const EXTRACTION_PATTERNS = [
  /ignore (all|any|the) (prior|previous|above) instructions/i,
  /(show|reveal|print|repeat|dump).{0,30}(system|developer) prompt/i,
  /(api|provider|openrouter|anthropic)[ _-]?key/i,
  /hidden instructions/i,
  /verbatim.{0,20}(prompt|policy|instructions)/i,
];

export function inspectPrompt(prompt: string): { allowed: boolean; message: string } {
  if (EXTRACTION_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return {
      allowed: false,
      message: "I can't provide hidden instructions, credentials, or internal configuration. I can still help analyze the selected run.",
    };
  }
  return { allowed: true, message: "" };
}

export function scrubOutput(value: string): string {
  return value
    .replace(/\b(sk-(?:or|ant|proj)?[-_a-zA-Z0-9]{8,})\b/g, "[REDACTED_KEY]")
    .replace(/\b(?:OPENROUTER|ANTHROPIC)_API_KEY\s*=\s*\S+/gi, "PROVIDER_API_KEY=[REDACTED]")
    .replace(/\/(?:Users|home)\/[^\s'\"]+/g, "[INTERNAL_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s'\"]+/g, "[INTERNAL_PATH]");
}

/** Remove credentials from structured developer traces while preserving
 * run-relative paths and scientific values needed for grounding validation. */
export function scrubOperationalValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return scrubOutput(value).slice(0, 200_000);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => scrubOperationalValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 500).map(([key, item]) => [
      key,
      /(?:api.?key|secret|authorization|credential|password|(?:access|refresh|provider|session|auth).?token)/i.test(key)
        ? "[REDACTED]"
        : scrubOperationalValue(item, depth + 1),
    ]));
  }
  return value;
}

export function wrapUntrustedAttachment(name: string, text: string): string {
  return `\n<untrusted_attachment name=${JSON.stringify(name)}>\n${text}\n</untrusted_attachment>\n`;
}

// --- External-lookup egress guard -------------------------------------------
// Deep Research may consult curated public biology APIs, but anti-exfiltration
// requires that nothing run-specific leaves the host. Outbound queries are
// reduced to short, safe entity tokens (gene/protein symbols, pathway words);
// anything that looks like a path, URL, credential, or instruction is dropped.
const EXTERNAL_HOST_ALLOWLIST: Record<string, string[]> = {
  uniprot: ["rest.uniprot.org", "www.uniprot.org"],
  reactome: ["reactome.org"],
  string: ["string-db.org", "version-12-0.string-db.org"],
  pubmed: ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"],
  pmc: ["eutils.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"],
  quickgo: ["www.ebi.ac.uk"],
};

/** Reduce a candidate query to a safe, bounded entity token. Returns "" when the
 *  term is empty or carries anything path-/secret-/instruction-like. */
export function sanitizeExternalQuery(term: unknown): string {
  const raw = String(term ?? "").trim();
  if (!raw || raw.length > 80) return raw ? raw.slice(0, 80).replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (/[\\/]|https?:|api[_-]?key|secret|token|password|ignore (?:all|any|the)|system prompt/i.test(raw)) {
    const stripped = raw.replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim();
    return /[\\/]|https?:|api[_-]?key|secret|token|password/i.test(raw) ? "" : stripped;
  }
  return raw.replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Guard a fully-built outbound URL against the per-source host allowlist. */
export function assertExternalUrlAllowed(url: string, source: string): void {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error(`Malformed external URL for ${source}`); }
  if (!(EXTERNAL_HOST_ALLOWLIST[source] || []).includes(host)) throw new Error(`Blocked external host ${host} for source ${source}`);
}

/** Hosts the given curated external sources are permitted to reach — the curated
 *  half of a network-mode job's egress allowlist (the skill half comes from each
 *  approved network skill's egressDomains). Reuses the same single source of truth
 *  the Tier-1 adapters assert against. */
export function hostsForExternalSources(sources: string[]): string[] {
  const hosts = new Set<string>();
  for (const source of sources) for (const host of EXTERNAL_HOST_ALLOWLIST[source] || []) hosts.add(host);
  return [...hosts];
}
