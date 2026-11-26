// Helpers shared by the host parsers: JSON lines, the [context-clock] snapshot count, and rate limit detection.

export const SNAPSHOT_OPEN = "[context-clock]";
export const SNAPSHOT_CLOSE = "[/context-clock]";

/** Parse JSON lines. A line that is not JSON is skipped and counted. */
export function jsonLines(text) {
  const events = [];
  let bad = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      bad += 1;
    }
  }
  return { events, bad };
}

function strings(v, out) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** The distinct snapshot blocks inside one value: from the open marker to the close marker, or to the end of the string. */
export function snapshotBlocks(value) {
  const blocks = new Set();
  for (const s of strings(value, [])) {
    let i = s.indexOf(SNAPSHOT_OPEN);
    while (i >= 0) {
      const end = s.indexOf(SNAPSHOT_CLOSE, i);
      const block = end >= 0 ? s.slice(i, end + SNAPSHOT_CLOSE.length) : s.slice(i);
      blocks.add(block);
      i = s.indexOf(SNAPSHOT_OPEN, i + SNAPSHOT_OPEN.length);
    }
  }
  return [...blocks];
}

/** { count, bytes } over events that the host produced (the caller leaves out the model's own text). */
export function countSnapshots(events) {
  let count = 0;
  let bytes = 0;
  for (const e of events) {
    for (const b of snapshotBlocks(e)) {
      count += 1;
      bytes += Buffer.byteLength(b, "utf8");
    }
  }
  return { count, bytes };
}

const LIMIT_TEXT = /(rate[ _-]?limit(ed)?|usage limit|limit reached|too many requests|\b429\b|overloaded|quota exceeded|exceeded your|try again (later|in))/i;

/** True when text from a failed turn names a rate or usage limit. */
export function isLimitText(text) {
  return LIMIT_TEXT.test(String(text ?? ""));
}

export function addUsage(a, b) {
  const out = {};
  for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]) {
    const x = a?.[k];
    const y = b?.[k];
    out[k] = x == null && y == null ? null : (x ?? 0) + (y ?? 0);
  }
  return out;
}

export const EMPTY_USAGE = Object.freeze({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });

// ---------- snapshot channels ----------
// tool_reply:    inside the tool result of a Context Mode tool
// hook_context:  from a PostToolUse or PostToolUseFailure hook
// session_start: from a SessionStart hook (startup, resume, compact)
// other:         a snapshot block anywhere else in host output (kept so the total stays complete)
export const CHANNELS = Object.freeze(["tool_reply", "hook_context", "session_start", "other"]);

export function emptyChannels() {
  return Object.fromEntries(CHANNELS.map((c) => [c, { count: 0, bytes: 0 }]));
}

export function addChannels(a, b) {
  const out = emptyChannels();
  for (const c of CHANNELS) {
    out[c].count = (a?.[c]?.count ?? 0) + (b?.[c]?.count ?? 0);
    out[c].bytes = (a?.[c]?.bytes ?? 0) + (b?.[c]?.bytes ?? 0);
  }
  return out;
}

export function channelTotal(ch) {
  let count = 0;
  let bytes = 0;
  for (const c of CHANNELS) {
    count += ch?.[c]?.count ?? 0;
    bytes += ch?.[c]?.bytes ?? 0;
  }
  return { count, bytes };
}

/** Add the distinct snapshot blocks of `value` to channel `channel` of `acc`. */
export function addBlocks(acc, channel, value) {
  for (const b of snapshotBlocks(value)) {
    acc[channel].count += 1;
    acc[channel].bytes += Buffer.byteLength(b, "utf8");
  }
  return acc;
}

/** True for a Context Mode tool name (Claude: mcp__plugin_context-mode_context-mode__ctx_*, Codex: mcp__context-mode__ctx_*). */
export function isContextModeTool(name) {
  const n = String(name ?? "");
  return /context-mode/i.test(n) || /(^|__)ctx_[a-z_]+$/.test(n);
}
