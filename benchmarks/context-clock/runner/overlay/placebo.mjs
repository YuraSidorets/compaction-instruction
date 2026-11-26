// Context Clock v0.3 placebo (EXPERIMENT-V03.md, "Plugin overlay"). Pure: no I/O, no clock time, no random source
// other than a seeded generator. Owner: overlay worker.
//
// The real snapshot forms come from src/core/clock/feedback/index.ts (read, never imported: nothing under benchmarks/
// imports from src/):
//   full block  "[context-clock] tick=<n> seq=<n> state_rev=<n>\n...\n[/context-clock]"   at most 700 bytes
//   one line    "[context-clock] tick=<n> seq=<n> state_rev=<n>[ src=...] | model delivery not confirmed"   at most 200 bytes
// A placebo keeps the UTF-8 byte length of every line and the line count. It depends only on those line lengths.

export const CLOCK_OPEN = "[context-clock]";
export const CLOCK_CLOSE = "[/context-clock]";
const CLOCK_HEAD = CLOCK_OPEN + " tick=";
const LINE_TAIL = " | model delivery not confirmed";
const BLOCK_MAX_BYTES = 700;
const LINE_MAX_BYTES = 200;

export const PLACEBO_OPEN = "[context-note]";
export const PLACEBO_CLOSE = "[/context-note]";
/** Neutral line labels. None names progress, time, coverage or memory. */
export const PLACEBO_LABELS = Object.freeze(["ref", "note", "pad", "item"]);
/** Opaque text alphabet: lowercase consonants, so a placebo word is never an English word or a number. */
const OPAQUE_ALPHABET = "bcdfghjklmnpqrstvwxz";
const PLACEBO_SEED = 0x5eed0003;

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;

/** A real tag padded with trailing spaces to the byte length of the real tag it stands for. */
function padTag(tag, realTag) {
  return tag + " ".repeat(Math.max(0, bytesOf(realTag) - bytesOf(tag)));
}
export const PLACEBO_OPEN_PADDED = padTag(PLACEBO_OPEN, CLOCK_OPEN);
export const PLACEBO_CLOSE_PADDED = padTag(PLACEBO_CLOSE, CLOCK_CLOSE);

// ---------- detection ----------

/**
 * The spans [start, end) of real snapshots in text, left to right. A one-line form is one line that starts with
 * "[context-clock] tick=" and ends with the fixed tail. A full block starts with that head and ends with a line that is
 * the close tag, with no second head inside and at most 700 bytes.
 */
export function findClockSpans(text) {
  const spans = [];
  if (typeof text !== "string") return spans;
  let from = 0;
  for (;;) {
    const i = text.indexOf(CLOCK_HEAD, from);
    if (i < 0) break;
    const nl = text.indexOf("\n", i);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (line.endsWith(LINE_TAIL) && bytesOf(line) <= LINE_MAX_BYTES) {
      spans.push({ start: i, end: lineEnd, form: "line" });
      from = lineEnd;
      continue;
    }
    const close = text.indexOf("\n" + CLOCK_CLOSE, i);
    if (close >= 0) {
      const end = close + 1 + CLOCK_CLOSE.length;
      const block = text.slice(i, end);
      const closedLine = end === text.length || text[end] === "\n" || text[end] === "\r";
      if (closedLine && block.indexOf(CLOCK_HEAD, 1) < 0 && bytesOf(block) <= BLOCK_MAX_BYTES) {
        spans.push({ start: i, end, form: "block" });
        from = end;
        continue;
      }
    }
    from = i + CLOCK_HEAD.length; // an unrecognized fragment: hasResidualClockText reports it
  }
  return spans;
}

/** True if text holds a real snapshot: the full block or the one-line form. */
export function hasClockFeedback(text) {
  return findClockSpans(text).length > 0;
}

/** True if text still holds a clock tag after substitution. A shim in mode D then fails closed. */
export function hasResidualClockText(text) {
  return typeof text === "string" && (text.includes(CLOCK_OPEN) || text.includes(CLOCK_CLOSE));
}

// ---------- placebo ----------

// mulberry32: a small seeded generator. The seed mixes only the line byte lengths.
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(lengths) {
  let h = PLACEBO_SEED;
  for (const n of [lengths.length, ...lengths]) {
    h ^= n;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** n ASCII characters: consonant runs of 3 or more, single spaces between them, no space at either end. */
function opaque(n, rand) {
  let s = "";
  let run = 0;
  for (let i = 0; i < n; i++) {
    const roomAfter = n - i - 1;
    if (run >= 3 && roomAfter >= 3 && rand() < 0.2) {
      s += " ";
      run = 0;
    } else {
      s += OPAQUE_ALPHABET[Math.floor(rand() * OPAQUE_ALPHABET.length)];
      run++;
    }
  }
  return s;
}

/** A body line of exactly n bytes: "<label>: <opaque text>", or opaque text alone when n is too small for a label. */
function labeledLine(n, rand) {
  const label = PLACEBO_LABELS[Math.floor(rand() * PLACEBO_LABELS.length)];
  if (n >= label.length + 3) return label + ": " + opaque(n - label.length - 2, rand);
  return opaque(n, rand);
}

function headLine(n, rand) {
  if (n < bytesOf(PLACEBO_OPEN_PADDED)) return opaque(n, rand);
  return PLACEBO_OPEN_PADDED + labeledLine(n - bytesOf(PLACEBO_OPEN_PADDED), rand);
}

/** The placebo for the given line byte lengths of one snapshot. form "line" is one head line; "block" ends with the close tag. */
export function placeboFor(lengths, form) {
  const rand = generator(seedOf(lengths));
  return lengths.map((n, k) => {
    if (k === 0) return headLine(n, rand);
    if (form === "block" && k === lengths.length - 1 && n === bytesOf(CLOCK_CLOSE)) return PLACEBO_CLOSE_PADDED;
    return labeledLine(n, rand);
  }).join("\n");
}

/** Replaces each real snapshot in text with a placebo of the same byte length and the same line count. */
export function substitutePlacebo(text) {
  if (typeof text !== "string") return { text, replaced: 0, originalBytes: 0, placeboBytes: 0 };
  const spans = findClockSpans(text);
  if (spans.length === 0) return { text, replaced: 0, originalBytes: 0, placeboBytes: 0 };
  let out = "";
  let at = 0;
  let originalBytes = 0;
  let placeboBytes = 0;
  for (const s of spans) {
    const snap = text.slice(s.start, s.end);
    const lines = snap.split("\n");
    const cr = lines.map((l) => l.endsWith("\r"));
    const lengths = lines.map((l, i) => bytesOf(cr[i] ? l.slice(0, -1) : l));
    const placebo = placeboFor(lengths, s.form).split("\n").map((l, i) => (cr[i] ? l + "\r" : l)).join("\n");
    out += text.slice(at, s.start) + placebo;
    at = s.end;
    originalBytes += bytesOf(snap);
    placeboBytes += bytesOf(placebo);
  }
  out += text.slice(at);
  return { text: out, replaced: spans.length, originalBytes, placeboBytes };
}
