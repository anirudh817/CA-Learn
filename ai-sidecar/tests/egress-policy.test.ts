import assert from "node:assert/strict";
import test from "node:test";
import { deriveJobEgressAllowlist, networkSkillEgressDomains, isIpLiteral, normalizeHost, hostAllowed, scanRequestForExfil } from "../src/research/egress-policy.js";

// Pure egress-control policy for network mode: the per-job allowlist derivation,
// exact-host matching with IP-literal / subdomain / rebind refusal, and the
// outbound anti-exfiltration scan. These hold the (a)+(c) boundary the per-job
// TLS-intercepting proxy enforces at the network edge.

test("deriveJobEgressAllowlist unions curated source hosts and approved skill egressDomains", () => {
  const list = deriveJobEgressAllowlist({ sources: ["uniprot"], networkSkills: ["pathway-enrichment"] });
  assert.ok(list.includes("rest.uniprot.org"), "curated uniprot host present");
  assert.ok(list.includes("maayanlab.cloud"), "pathway-enrichment Enrichr host present");
  assert.deepEqual(list, [...new Set(list)].sort(), "de-duped + sorted");
});

test("deriveJobEgressAllowlist with no approvals is empty (an offline job egresses nowhere)", () => {
  assert.deepEqual(deriveJobEgressAllowlist({}), []);
  assert.deepEqual(deriveJobEgressAllowlist({ sources: [], networkSkills: [] }), []);
});

test("networkSkillEgressDomains returns [] for an offline skill or unknown id, hosts for a network skill", () => {
  assert.deepEqual(networkSkillEgressDomains("exploratory-data-analysis"), []);
  assert.deepEqual(networkSkillEgressDomains("not-a-skill"), []);
  assert.ok(networkSkillEgressDomains("gget").includes("rest.ensembl.org"));
});

test("isIpLiteral rejects IPv4/IPv6/decimal forms, accepts DNS names", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "::1", "2001:db8::1", "2130706433", "[::1]"]) assert.equal(isIpLiteral(normalizeHost(ip)), true, `${ip} is an IP literal`);
  for (const name of ["rest.uniprot.org", "maayanlab.cloud"]) assert.equal(isIpLiteral(name), false, `${name} is a DNS name`);
});

test("hostAllowed: exact match only — no subdomain, IP, or rebind tricks slip through", () => {
  const allow = ["rest.uniprot.org", "maayanlab.cloud"];
  assert.equal(hostAllowed("rest.uniprot.org", allow), true);
  assert.equal(hostAllowed("REST.UniProt.ORG:443", allow), true, "case + port tolerated");
  assert.equal(hostAllowed("rest.uniprot.org.evil.test", allow), false, "suffix-append");
  assert.equal(hostAllowed("evil-rest.uniprot.org", allow), false, "prefix glue");
  assert.equal(hostAllowed("maayanlab.cloud.attacker.test", allow), false);
  assert.equal(hostAllowed("127.0.0.1", allow), false, "IP literal");
  assert.equal(hostAllowed("localhost", allow), false, "non-FQDN");
  assert.equal(hostAllowed("string-db.org", allow), false, "not on this job's list");
});

test("scanRequestForExfil blocks credentials/keys/internal paths but passes identifier tokens", () => {
  // Identifiers (the legitimate payload of a network skill) MUST pass:
  assert.equal(scanRequestForExfil("GET /api/search?gene=APOE&species=9606 HTTP/1.1\nHost: maayanlab.cloud"), null);
  assert.equal(scanRequestForExfil('POST /enrich\n\n{"genes":["TREM2","P04075","APOE"]}'), null);
  // Exfil markers MUST be blocked:
  assert.equal(scanRequestForExfil("GET /x?token=sk-or-abcd1234efgh HTTP/1.1"), "provider-key");
  assert.equal(scanRequestForExfil("authorization: Bearer abcdef123456"), "secret-assignment");
  assert.equal(scanRequestForExfil("GET /leak?f=/Users/sdev/Dev/projects/signalfold/data/runs/x HTTP/1.1"), "internal-unix-path");
  assert.equal(scanRequestForExfil("x-key: ANTHROPIC_API_KEY"), "provider-env-key");
});
