// Plain SVG charts written without a dependency. Each chart has an explicit light background and dark text,
// so it reads the same in light and dark viewers. Deterministic: fixed sizes, fixed number formats.
import { CATEGORIES, MODE_NAMES } from "./metrics.mjs";
import { fmtNum, fmtPct, fmtSigned } from "./util.mjs";

const BG = "#ffffff";
const INK = "#1f2937";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";
const MODE_COLOR = { A: "#6b7280", B: "#2563eb", C: "#d97706" };
const POS = "#15803d";
const NEG = "#b91c1c";
const FONT = "font-family=\"system-ui, -apple-system, Segoe UI, Roboto, sans-serif\"";

function esc(s) {
  return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\"").join("&quot;");
}

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

function frame(width, height, title, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${BG}"/>`,
    `<text x="16" y="24" ${FONT} font-size="15" font-weight="600" fill="${INK}">${esc(title)}</text>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

function modeColor(m) {
  return MODE_COLOR[m] ?? MUTED;
}

/** Vertical bars, one per mode. `values` are fractions in [0, 1] or null. */
function modeBars(title, modes, valueOf, labelOf, tickLabel = (i) => i * 25 + "%") {
  const W = 480, H = 300, left = 56, right = 16, top = 44, bottom = 52;
  const ph = H - top - bottom, pw = W - left - right;
  const slot = pw / Math.max(1, modes.length);
  const body = [];
  for (let i = 0; i <= 4; i++) {
    const y = top + ph - (ph * i) / 4;
    body.push(`<line x1="${left}" y1="${f1(y)}" x2="${W - right}" y2="${f1(y)}" stroke="${GRID}" stroke-width="1"/>`);
    body.push(`<text x="${left - 6}" y="${f1(y + 4)}" ${FONT} font-size="11" text-anchor="end" fill="${MUTED}">${esc(tickLabel(i))}</text>`);
  }
  modes.forEach((m, i) => {
    const v = valueOf(m);
    const x = left + slot * i + slot * 0.2;
    const w = slot * 0.6;
    const h = v === null ? 0 : ph * Math.max(0, Math.min(1, v));
    body.push(`<rect x="${f1(x)}" y="${f1(top + ph - h)}" width="${f1(w)}" height="${f1(h)}" fill="${modeColor(m)}"/>`);
    body.push(`<text x="${f1(x + w / 2)}" y="${f1(top + ph - h - 6)}" ${FONT} font-size="12" text-anchor="middle" fill="${INK}">${esc(labelOf(v))}</text>`);
    body.push(`<text x="${f1(x + w / 2)}" y="${f1(H - bottom + 18)}" ${FONT} font-size="12" text-anchor="middle" fill="${INK}">${esc(m + " " + (MODE_NAMES[m] ?? ""))}</text>`);
  });
  return frame(W, H, title, body);
}

export function successChart(summary) {
  const modes = summary.modeList ?? Object.keys(summary.modes);
  return modeBars("Task success rate by mode", modes, (m) => summary.modes[m].successRate, (v) => fmtPct(v));
}

export function scoreByCategoryChart(summary) {
  const modes = summary.modeList ?? Object.keys(summary.modes);
  const cats = [...CATEGORIES];
  const W = 640, H = 320, left = 56, right = 16, top = 44, bottom = 64;
  const ph = H - top - bottom, pw = W - left - right;
  const slot = pw / cats.length;
  const bw = (slot * 0.8) / Math.max(1, modes.length);
  const body = [];
  for (let i = 0; i <= 4; i++) {
    const y = top + ph - (ph * i) / 4;
    body.push(`<line x1="${left}" y1="${f1(y)}" x2="${W - right}" y2="${f1(y)}" stroke="${GRID}" stroke-width="1"/>`);
    body.push(`<text x="${left - 6}" y="${f1(y + 4)}" ${FONT} font-size="11" text-anchor="end" fill="${MUTED}">${fmtNum(i / 4)}</text>`);
  }
  cats.forEach((c, ci) => {
    modes.forEach((m, mi) => {
      const v = summary.modes[m].byCategory[c]?.meanScore ?? null;
      const x = left + slot * ci + slot * 0.1 + bw * mi;
      const h = v === null ? 0 : ph * Math.max(0, Math.min(1, v));
      body.push(`<rect x="${f1(x)}" y="${f1(top + ph - h)}" width="${f1(bw - 2)}" height="${f1(h)}" fill="${modeColor(m)}"><title>${esc(m + " " + c + ": " + fmtNum(v, 3))}</title></rect>`);
    });
    body.push(`<text x="${f1(left + slot * ci + slot / 2)}" y="${f1(top + ph + 18)}" ${FONT} font-size="12" text-anchor="middle" fill="${INK}">Category ${esc(c)}</text>`);
  });
  modes.forEach((m, i) => {
    const x = left + i * 120;
    body.push(`<rect x="${x}" y="${H - 22}" width="12" height="12" fill="${modeColor(m)}"/>`);
    body.push(`<text x="${x + 18}" y="${H - 12}" ${FONT} font-size="12" fill="${INK}">${esc(m + " " + (MODE_NAMES[m] ?? ""))}</text>`);
  });
  return frame(W, H, "Mean score by mode and task category", body);
}

export function pairedDiffChart(summary) {
  const first = (summary.comparisons ?? [{ id: "C-B", x: "C", y: "B" }])[0];
  const cmp = first === undefined ? undefined : summary.paired[first.id];
  const rows = cmp?.perTask ?? [];
  const rowH = 20, left = 200, right = 60, top = 44, bottom = 32;
  const W = 640, H = top + bottom + Math.max(1, rows.length) * rowH;
  const pw = W - left - right;
  const zero = left + pw / 2;
  const body = [
    `<line x1="${f1(zero)}" y1="${top - 4}" x2="${f1(zero)}" y2="${H - bottom + 4}" stroke="${MUTED}" stroke-width="1"/>`,
    `<text x="${left}" y="${H - 10}" ${FONT} font-size="11" fill="${MUTED}">-1.0</text>`,
    `<text x="${f1(zero)}" y="${H - 10}" ${FONT} font-size="11" text-anchor="middle" fill="${MUTED}">0</text>`,
    `<text x="${W - right}" y="${H - 10}" ${FONT} font-size="11" text-anchor="end" fill="${MUTED}">+1.0</text>`,
  ];
  if (rows.length === 0) body.push(`<text x="${left}" y="${top + 14}" ${FONT} font-size="12" fill="${MUTED}">No complete pairs for ${esc(first?.id ?? "the primary comparison")}.</text>`);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const v = Math.max(-1, Math.min(1, r.meanDiff ?? 0));
    const w = (pw / 2) * Math.abs(v);
    const x = v >= 0 ? zero : zero - w;
    body.push(`<text x="${left - 8}" y="${f1(y + 14)}" ${FONT} font-size="11" text-anchor="end" fill="${INK}">${esc(r.taskId)}</text>`);
    body.push(`<rect x="${f1(x)}" y="${f1(y + 3)}" width="${f1(Math.max(w, 0.5))}" height="${rowH - 6}" fill="${v >= 0 ? POS : NEG}"/>`);
    body.push(`<text x="${f1(v >= 0 ? zero + w + 4 : zero - w - 4)}" y="${f1(y + 14)}" ${FONT} font-size="11" text-anchor="${v >= 0 ? "start" : "end"}" fill="${INK}">${esc(fmtSigned(r.meanDiff, 2))}</text>`);
  });
  return frame(W, H, "Paired score difference per task, " + (first === undefined ? "primary comparison" : first.x + " minus " + first.y) + " (mean over repetitions)", body);
}

export function tokenOverheadChart(summary) {
  const modes = summary.modeList ?? Object.keys(summary.modes);
  const vals = modes.map((m) => summary.modes[m].cost.totalTokens.mean);
  const max = Math.max(1, ...vals.filter((v) => v !== null));
  const baseMode = summary.baseline ?? "A";
  const base = summary.modes[baseMode]?.cost.totalTokens.mean ?? null;
  return modeBars(
    "Mean total tokens per run by mode (label: tokens, change against " + baseMode + ")",
    modes,
    (m) => {
      const v = summary.modes[m].cost.totalTokens.mean;
      return v === null ? null : v / max;
    },
    (frac) => {
      if (frac === null) return "n/a";
      const v = frac * max;
      const pct = base !== null && base > 0 ? " (" + fmtSigned(((v - base) / base) * 100, 1) + "%)" : "";
      return String(Math.round(v)) + pct;
    },
    (i) => String(Math.round((max * i) / 4)),
  );
}

/** File name to SVG text. */
export function renderCharts(summary) {
  return {
    "success-rate.svg": successChart(summary),
    "score-by-category.svg": scoreByCategoryChart(summary),
    "paired-diff-primary.svg": pairedDiffChart(summary),
    "token-overhead.svg": tokenOverheadChart(summary),
  };
}
