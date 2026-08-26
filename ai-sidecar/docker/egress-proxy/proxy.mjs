// SignalFold per-job egress proxy — the ONLY route to the internet for a
// network-mode skill container. It is a TLS-INTERCEPTING forward proxy (decision
// (a)): the skill trusts a baked CA, so the proxy terminates TLS, inspects the
// decrypted request, and re-originates it to the real host. That lets it enforce
// three controls a plain CONNECT tunnel cannot:
//   1. an EXACT-host allowlist (the job's approved curated-source + skill hosts),
//   2. an outbound anti-exfiltration scan (refuse a request carrying a credential,
//      provider key, or internal host path), and
//   3. byte / request-count / time caps,
// while logging every outbound request (host, method, path, status, bytes,
// response sha256) to an audit file the host folds into the ExecutionReceipt.
//
// Plain-HTTP proxying is refused outright — only CONNECT (HTTPS) is supported, so
// nothing leaves in cleartext. Dependency-free (Node builtins only) so it is easy
// to audit and needs no package install in the image. The host/exfil logic mirrors
// src/research/egress-policy.ts (kept in lockstep; that module is unit-tested).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PROXY_PORT || 8080);
const CERT_DIR = process.env.EGRESS_CERT_DIR || "/opt/egress-certs";
const AUDIT_PATH = process.env.EGRESS_AUDIT_LOG || "/work/egress/audit.jsonl";
const ALLOWLIST = new Set(String(process.env.EGRESS_ALLOWLIST || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
const CAPS = {
  maxRequests: Number(process.env.EGRESS_MAX_REQUESTS || 40),
  maxRequestBytes: Number(process.env.EGRESS_MAX_REQUEST_BYTES || 64 * 1024),
  maxResponseBytes: Number(process.env.EGRESS_MAX_RESPONSE_BYTES || 8 * 1024 * 1024),
  timeoutMs: Number(process.env.EGRESS_TIMEOUT_MS || 15000),
};

// --- policy (mirror of egress-policy.ts) -----------------------------------
function normalizeHost(target) {
  let host = String(target || "").trim().toLowerCase();
  if (!host.startsWith("[") && host.split(":").length === 2) host = host.split(":")[0];
  return host.replace(/^\[/, "").replace(/\](?::\d+)?$/, "");
}
function isIpLiteral(host) {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(":")) return true;
  if (/^\d+$/.test(h)) return true;
  return false;
}
function hostAllowed(host) {
  const n = normalizeHost(host);
  if (!n || isIpLiteral(n)) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(n)) return false;
  return ALLOWLIST.has(n);
}
const EXFIL_PATTERNS = [
  ["provider-key", /\bsk-(?:or|ant|proj)?[-_a-zA-Z0-9]{8,}\b/],
  ["secret-assignment", /(?:api[_-]?key|secret|password|authorization|bearer)["']?\s*[:=]\s*\S{6,}/i],
  ["internal-unix-path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ["internal-windows-path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ["provider-env-key", /\b(?:OPENROUTER|ANTHROPIC)_API_KEY\b/i],
];
function scanRequestForExfil(text) {
  const sample = String(text || "").slice(0, 256 * 1024);
  for (const [name, re] of EXFIL_PATTERNS) if (re.test(sample)) return name;
  return null;
}

// --- certificates (pre-minted per host at image build) ---------------------
// Our egress CA signs the leaves we present to the SKILL (the inner server). The
// upstream leg (proxy → real host) validates against Node's DEFAULT public CA
// bundle, NOT our CA — the real host presents a publicly-signed cert.
const contexts = new Map();
for (const file of fs.readdirSync(CERT_DIR)) {
  if (!file.endsWith(".crt") || file === "ca.crt") continue;
  const host = file.replace(/\.crt$/, "");
  try {
    contexts.set(host, tls.createSecureContext({ key: fs.readFileSync(path.join(CERT_DIR, `${host}.key`)), cert: fs.readFileSync(path.join(CERT_DIR, file)) }));
  } catch { /* skip a host with an incomplete keypair */ }
}
const defaultHost = [...contexts.keys()][0];
if (!defaultHost) { console.error("egress-proxy: no leaf certs in", CERT_DIR); process.exit(1); }

// --- audit -----------------------------------------------------------------
let requestCount = 0;
fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
function audit(entry) {
  try { fs.appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch { /* audit best-effort */ }
}

// --- inner server: ALREADY-DECRYPTED requests from CONNECTed sockets --------
const defaultKey = fs.readFileSync(path.join(CERT_DIR, `${defaultHost}.key`));
const defaultCert = fs.readFileSync(path.join(CERT_DIR, `${defaultHost}.crt`));
const sniCallback = (servername, cb) => {
  const ctx = contexts.get(normalizeHost(servername));
  if (ctx && hostAllowed(servername)) cb(null, ctx);
  else cb(new Error(`egress: no context for ${servername}`)); // fail closed
};

// One handler for an already-parsed request, shared by the TLS-terminating inner
// server (HTTPS via CONNECT) and the plain-HTTP proxy path below. Both enforce the
// SAME allowlist + outbound exfil scan + caps, and forward UPSTREAM OVER HTTPS — so
// an http:// skill request (e.g. gseapy defaults Enrichr to http://maayanlab.cloud)
// is upgraded and never leaves the box in cleartext — then stream the capped
// response back and audit it (host, status, bytes, sha256, or the block reason).
function serveProxied(creq, cres, host, targetPath) {
  const reqStart = Date.now(); // per-request latency, so the OCC can attribute egress slowness to a host/endpoint
  const deny = (code, reason) => { audit({ host, method: creq.method, path: targetPath, blocked: reason, status: code, durationMs: Date.now() - reqStart }); cres.writeHead(code, { "content-type": "text/plain" }); cres.end(`egress blocked: ${reason}`); };
  if (!hostAllowed(host)) return deny(403, "host-not-allowed");
  if (requestCount >= CAPS.maxRequests) return deny(429, "request-cap");
  const chunks = []; let size = 0; let aborted = false;
  creq.on("data", (d) => {
    if (aborted) return;
    size += d.length;
    if (size > CAPS.maxRequestBytes) { aborted = true; deny(413, "request-too-large"); creq.destroy(); return; }
    chunks.push(d);
  });
  creq.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const headerText = Object.entries(creq.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
    const exfil = scanRequestForExfil(`${creq.method} ${targetPath}\n${headerText}\n\n${body.toString("utf8")}`);
    if (exfil) return deny(451, `outbound-exfil:${exfil}`);
    requestCount += 1;
    const headers = { ...creq.headers, host }; delete headers["proxy-connection"]; delete headers["connection"];
    const upstream = https.request({ host, servername: host, port: 443, method: creq.method, path: targetPath, headers, timeout: CAPS.timeoutMs }, (ures) => {
      let respBytes = 0; const hash = crypto.createHash("sha256");
      cres.writeHead(ures.statusCode || 502, ures.headers);
      ures.on("data", (d) => {
        respBytes += d.length;
        if (respBytes > CAPS.maxResponseBytes) { ures.destroy(); audit({ host, method: creq.method, path: targetPath, status: ures.statusCode, respBytes, blocked: "response-too-large", durationMs: Date.now() - reqStart }); cres.end(); return; }
        hash.update(d); cres.write(d);
      });
      ures.on("end", () => { audit({ host, method: creq.method, path: targetPath, status: ures.statusCode, reqBytes: body.length, respBytes, respSha256: hash.digest("hex"), durationMs: Date.now() - reqStart }); cres.end(); });
    });
    upstream.on("timeout", () => { upstream.destroy(new Error("upstream timeout")); });
    upstream.on("error", (err) => { audit({ host, method: creq.method, path: targetPath, blocked: `upstream-error:${err.message}`, durationMs: Date.now() - reqStart }); if (!cres.headersSent) cres.writeHead(502); cres.end(); });
    upstream.end(body);
  });
}

// Inner: HTTPS via CONNECT. A real LISTENING TLS-terminating server (SNI-selected
// leaf); each gated CONNECT is piped byte-for-byte to it on loopback (below) — far
// more robust than emit("connection"), which silently fails to deliver requests.
const inner = https.createServer({ key: defaultKey, cert: defaultCert, SNICallback: sniCallback }, (creq, cres) => {
  serveProxied(creq, cres, normalizeHost(creq.headers.host || ""), creq.url);
});
inner.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* noop */ } });

// --- outer proxy ------------------------------------------------------------
// Plain-HTTP proxied requests arrive in absolute-form (GET http://host/path); we
// serve them too (upgraded to HTTPS upstream) so http:// skill clients work. A
// non-proxied direct hit (no scheme/host) is refused. HTTPS is handled by CONNECT.
const proxy = http.createServer((req, res) => {
  const match = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(req.url || "");
  if (!match) { res.writeHead(400, { "content-type": "text/plain" }); res.end("egress proxy: use as an HTTP(S) forward proxy"); return; }
  serveProxied(req, res, normalizeHost(match[1]), match[2] || "/");
});
proxy.on("connect", (req, clientSocket, head) => {
  const host = normalizeHost(req.url || "");
  if (!hostAllowed(host)) { audit({ host, phase: "connect", blocked: "host-not-allowed" }); clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); clientSocket.destroy(); return; }
  clientSocket.on("error", () => { /* client vanished mid-tunnel */ });
  const innerPort = inner.address() && inner.address().port;
  const innerConn = net.connect(innerPort, "127.0.0.1", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) innerConn.write(head);
    clientSocket.pipe(innerConn).pipe(clientSocket);
  });
  innerConn.on("error", (err) => { try { clientSocket.destroy(); } catch { /* noop */ } });
});
proxy.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* noop */ } });
inner.listen(0, "127.0.0.1", () => {
  proxy.listen(PORT, () => console.log(`egress-proxy listening :${PORT} | inner :${inner.address().port} | allow=[${[...ALLOWLIST].join(",")}] | certs=${contexts.size}`));
});
