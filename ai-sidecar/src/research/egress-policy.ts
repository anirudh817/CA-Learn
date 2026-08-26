import { SCIENTIFIC_SKILL_POLICIES } from "../skills/scientific-catalog.js";
import { hostsForExternalSources } from "../security.js";

// Pure egress-control policy for network-mode skills. The per-job
// TLS-intercepting proxy (docker/egress-proxy/proxy.mjs) enforces these decisions
// at the network edge; the host derives the allowlist here and the matching +
// anti-exfiltration scan are unit-tested directly (no container needed).
//
// This encodes the (a)+(c) boundary the user chose: only REVIEWED network-skill
// scripts + curated adapters ever get egress (arbitrary run_python stays
// --network none), and the proxy caps/inspects what leaves. A domain allowlist
// controls WHERE traffic goes; TLS interception lets the proxy also refuse a
// request that carries a credential, a provider key, or an internal host path.

export interface EgressCaps {
  maxRequests: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
  timeoutMs: number;
}

/** The hosts a single network skill may reach: approved-external policy AND a
 *  non-empty egressDomains list (the catalog is the one source of truth). */
export function networkSkillEgressDomains(skillId: string): string[] {
  const policy = SCIENTIFIC_SKILL_POLICIES.find((item) => item.id === skillId);
  if (!policy || policy.networkPolicy !== "approved-external") return [];
  return [...(policy.egressDomains || [])];
}

/** Derive a job's egress host allowlist: the approved curated sources' hosts ∪
 *  the egressDomains of the approved network skills. Lowercased + de-duped. The
 *  proxy is started with exactly this list; nothing else resolves or connects. */
export function deriveJobEgressAllowlist(input: { sources?: string[]; networkSkills?: string[] }): string[] {
  const hosts = new Set<string>();
  for (const host of hostsForExternalSources(input.sources || [])) hosts.add(host.toLowerCase());
  for (const skillId of input.networkSkills || []) for (const host of networkSkillEgressDomains(skillId)) hosts.add(host.toLowerCase());
  return [...hosts].sort();
}

/** True when `host` is an IPv4/IPv6 literal — egress to IP literals is refused so
 *  a skill cannot bypass the name-based allowlist or pin a rebinding name to an
 *  attacker IP. */
export function isIpLiteral(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 dotted quad
  if (h.includes(":")) return true;                   // IPv6 (or a host:port mistakenly passed whole)
  if (/^\d+$/.test(h)) return true;                   // bare integer (decimal IP form)
  return false;
}

/** Normalize a CONNECT / Host target to a bare lowercase hostname (drop the port). */
export function normalizeHost(target: string): string {
  let host = String(target || "").trim().toLowerCase();
  if (!host.startsWith("[") && host.split(":").length === 2) host = host.split(":")[0]; // host:port
  host = host.replace(/^\[/, "").replace(/\](?::\d+)?$/, "");                            // [ipv6]:port
  return host;
}

/** Is `host` allowed by this job's allowlist? EXACT hostname match only (the
 *  catalog enumerates exact hosts — no subdomain wildcarding), IP literals and
 *  non-FQDN targets refused. Same strength as security.ts:assertExternalUrlAllowed,
 *  generalized to skill-built URLs. */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const normalized = normalizeHost(host);
  if (!normalized || isIpLiteral(normalized)) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(normalized)) return false; // plausible FQDN
  return new Set(allowlist.map((entry) => entry.toLowerCase())).has(normalized);
}

// Outbound-payload exfiltration signals. A domain allowlist controls WHERE
// traffic goes, not WHAT is in it; with TLS interception the proxy can refuse a
// request whose URL / headers / body carries a credential, an internal host path,
// or a provider key. Identifier tokens (gene/protein symbols) MUST still pass —
// that is the point of network skills — so we block only high-confidence exfil
// markers, never "anything that looks like run data".
const EXFIL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "provider-key", re: /\bsk-(?:or|ant|proj)?[-_a-zA-Z0-9]{8,}\b/ },
  { name: "secret-assignment", re: /(?:api[_-]?key|secret|password|authorization|bearer)["']?\s*[:=]\s*\S{6,}/i },
  { name: "internal-unix-path", re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  { name: "internal-windows-path", re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/ },
  { name: "provider-env-key", re: /\b(?:OPENROUTER|ANTHROPIC)_API_KEY\b/i },
];

/** Scan an outbound request's significant text (request line + headers + body)
 *  for high-confidence exfiltration markers. Returns the first match's name, or
 *  null when clean. */
export function scanRequestForExfil(text: string): string | null {
  const sample = String(text || "").slice(0, 256 * 1024);
  for (const { name, re } of EXFIL_PATTERNS) if (re.test(sample)) return name;
  return null;
}
