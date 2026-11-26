// Shared helpers for the benchmark analysis: deterministic JSON, seeded random numbers, number formats.
// No clock time and no Math.random anywhere in the analysis.

/** JSON with object keys sorted at every level, 2-space indent, trailing newline. Arrays keep their order. */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

/** mulberry32: a small seeded 32-bit generator. Same seed, same sequence. Returns floats in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounds to `d` decimals for stored numbers. null stays null. */
export function round(x, d = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function mean(xs) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

export function sum(xs) {
  return xs.reduce((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
}

/** Byte-order string compare, so the sort does not depend on the locale. */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- display formats for report.md and the charts ----

export function fmtPct(x, d = 1) {
  return x === null || x === undefined ? "n/a" : (x * 100).toFixed(d) + "%";
}

export function fmtNum(x, d = 2) {
  return x === null || x === undefined ? "n/a" : x.toFixed(d);
}

export function fmtSigned(x, d = 3) {
  if (x === null || x === undefined) return "n/a";
  const r = Number(x.toFixed(d));
  if (r === 0) return (0).toFixed(d);
  return (r > 0 ? "+" : "") + r.toFixed(d);
}

export function fmtInt(x) {
  return x === null || x === undefined ? "n/a" : String(Math.round(x));
}
