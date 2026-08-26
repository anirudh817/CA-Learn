import crypto from "node:crypto";

export const sha = (content: Buffer | string) => crypto.createHash("sha256").update(content).digest("hex");

/** Same column normalization the offline skills use, so synthesis matches a
 *  Stage 1 adj-p / feature column the same way runStability does. */
export const normalizeHeader = (columns: string[]) => columns.map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""));

export function parseDelimited(content: string, filename = "") {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { header: [] as string[], rows: [] as string[][] };
  const delimiter = filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  return { header: lines[0].split(delimiter), rows: lines.slice(1).map((line) => line.split(delimiter)) };
}

export const escapeXml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

/** Deterministic bar chart of the threshold sweep — replaces the placeholder SVG
 *  with an actual picture of features_passing per cutoff. No randomness/dates. */
export function sweepChartSvg(title: string, xLabel: string, yLabel: string, series: Array<{ label: string; value: number }>) {
  const W = 760, H = 320, padL = 64, padR = 24, padT = 56, padB = 64;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...series.map((point) => point.value));
  const slots = Math.max(1, series.length);
  const gap = plotW / slots, barW = gap * 0.6;
  const bars = series.map((point, index) => {
    const x = padL + index * gap + (gap - barW) / 2;
    const height = (point.value / max) * plotH;
    const y = padT + plotH - height;
    return `<g><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${height.toFixed(1)}" rx="4" fill="#2457d6"/>`
      + `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-family="system-ui" font-size="14" font-weight="700" fill="#172033">${escapeXml(point.value)}</text>`
      + `<text x="${(x + barW / 2).toFixed(1)}" y="${(padT + plotH + 20).toFixed(1)}" text-anchor="middle" font-family="system-ui" font-size="12" fill="#475467">${escapeXml(point.label)}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(title)}">`
    + `<rect width="${W}" height="${H}" fill="#ffffff"/>`
    + `<text x="${padL}" y="32" font-family="system-ui" font-size="17" font-weight="700" fill="#172033">${escapeXml(title)}</text>`
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#cbd5e1"/>`
    + `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#cbd5e1"/>`
    + `<text x="18" y="${padT + plotH / 2}" transform="rotate(-90 18 ${padT + plotH / 2})" text-anchor="middle" font-family="system-ui" font-size="12" fill="#475467">${escapeXml(yLabel)}</text>`
    + `<text x="${padL + plotW / 2}" y="${H - 14}" text-anchor="middle" font-family="system-ui" font-size="12" fill="#475467">${escapeXml(xLabel)}</text>`
    + bars + `</svg>`;
}
