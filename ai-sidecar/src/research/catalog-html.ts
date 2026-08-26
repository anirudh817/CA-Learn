type CatalogUsage = {
  read?: boolean;
  cited?: boolean;
  fetched?: boolean;
  stagedUnused?: boolean;
  used?: boolean;
  staged?: boolean;
};

type CatalogEntry = {
  path?: string;
  role?: string;
  family?: string;
  stage?: string;
  bytes?: number;
  rowCount?: number | null;
  description?: string;
  derivation?: string;
  usage?: CatalogUsage;
  staged?: boolean;
};

export type ResearchCatalogPayload = {
  runId?: string;
  scopeManifestHash?: string;
  stagedCount?: number;
  usedCount?: number;
  stagedUnusedCount?: number;
  catalog?: CatalogEntry[];
};

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanBytes(value: unknown) {
  const size = Number(value || 0);
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function usageLabel(entry: CatalogEntry) {
  const usage = entry.usage || {};
  const parts = [
    usage.read ? "read" : "",
    usage.cited ? "cited" : "",
    usage.fetched ? "fetched" : "",
    usage.stagedUnused ? "staged unused" : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  if (usage.staged || entry.staged) return "staged";
  return "available";
}

function sortRank(entry: CatalogEntry) {
  const usage = entry.usage || {};
  if (usage.used) return 0;
  if (usage.stagedUnused) return 1;
  return 2;
}

export function renderResearchCatalogHtml(payload: ResearchCatalogPayload): string {
  const catalog = [...(payload.catalog || [])].sort((a, b) => {
    const rank = sortRank(a) - sortRank(b);
    return rank || String(a.path || "").localeCompare(String(b.path || ""));
  });
  const rows = catalog.map((entry) => {
    const meta = [
      entry.family || entry.role || "",
      entry.stage || "",
      humanBytes(entry.bytes),
      entry.rowCount ? `${entry.rowCount} rows` : "",
    ].filter(Boolean).join(" · ");
    return `<tr>
      <td><strong>${esc(entry.path || "artifact")}</strong><div class="meta">${esc(meta)}</div></td>
      <td>${esc(entry.description || "")}<div class="derivation">${esc(entry.derivation || "")}</div></td>
      <td><span class="usage">${esc(usageLabel(entry))}</span></td>
    </tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Artifact Catalog - ${esc(payload.runId || "run")}</title>
  <style>
    :root { --text:#1f2933; --muted:#657381; --line:#d9e0e6; --accent:#2e7d5a; --soft:#f7f9f8; }
    body { margin:0; padding:32px; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--text); background:#fff; }
    header { margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    .sub { color:var(--muted); font-size:14px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th { text-align:left; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; background:var(--soft); border-bottom:1px solid var(--line); padding:10px 12px; }
    td { vertical-align:top; border-bottom:1px solid var(--line); padding:12px; line-height:1.45; }
    .meta,.derivation { margin-top:4px; color:var(--muted); font-size:12px; }
    .derivation { line-height:1.4; }
    .usage { display:inline-block; padding:3px 8px; border-radius:999px; background:var(--soft); color:var(--accent); border:1px solid var(--line); font-size:11px; font-weight:700; white-space:nowrap; }
  </style>
</head>
<body>
  <header>
    <h1>Artifact Catalog</h1>
    <div class="sub">Run ${esc(payload.runId || "")} - ${catalog.length} artifacts available to the agent · ${Number(payload.usedCount || 0)} used · ${Number(payload.stagedUnusedCount || 0)} staged but unread</div>
  </header>
  <table>
    <thead><tr><th>Artifact</th><th>Description</th><th>Usage</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
