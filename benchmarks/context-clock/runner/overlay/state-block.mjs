// Context Clock v0.4 returned state block (EXPERIMENT-V04.md, "Returned state" and "Interfaces"). The hook shim
// appends this block to the SessionStart reply after a compaction, in arms F (committed) and G (reference).
// The table and column names come from src/core/clock/store/schema.ts (read, never imported):
//   clock_state_revisions(session_id, agent_id, revision, summary, findings_json, created_at)
// findings_json is a JSON array of { text, evidenceEventIds }. The finding label is CLAIM_LABEL of
// src/core/clock/state/format.ts. Node built-ins only. Owner: overlay worker.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const STATE_OPEN = "[committed-state]";
export const STATE_CLOSE = "[/committed-state]";
export const STATE_BLOCK_MAX_BYTES = 2000;
/** The product label of a committed finding. */
export const FINDING_LABEL = "reported claim, not verified";
const MAIN_AGENT = "main";

const enc = new TextEncoder();
const bytesOf = (s) => enc.encode(s).length;
// node:sqlite loads only when a database is read, so a shim run that needs no state loads nothing more.
const require = createRequire(import.meta.url);

/** Every context.db under <dataDir>/projects. */
function contextDbs(dataDir) {
  const projects = path.join(dataDir, "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects).sort().map((k) => path.join(projects, k, "context.db")).filter((p) => existsSync(p));
}

/**
 * The latest committed state of agent "main" from every context.db under dataDir, read-only. Null with no commit.
 * "Latest" is the highest created_at, then the highest revision. A database without the clock tables has no commit.
 * Throws when a database cannot be read: the shim then fails closed.
 * @returns {{ revision: number, summary: string, findings: { text: string }[] } | null}
 */
export function readCommittedState(dataDir) {
  if (typeof dataDir !== "string" || dataDir === "") throw new Error("no data folder");
  const { DatabaseSync } = require("node:sqlite");
  let best = null;
  for (const p of contextDbs(dataDir)) {
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clock_state_revisions'").get();
      if (!has) continue;
      const row = db
        .prepare("SELECT revision, summary, findings_json, created_at FROM clock_state_revisions WHERE agent_id = ? ORDER BY created_at DESC, revision DESC LIMIT 1")
        .get(MAIN_AGENT);
      if (!row) continue;
      if (best === null || row.created_at > best.created_at || (row.created_at === best.created_at && row.revision > best.revision)) best = row;
    } finally {
      db.close();
    }
  }
  if (best === null) return null;
  const parsed = JSON.parse(best.findings_json);
  if (!Array.isArray(parsed)) throw new Error("findings_json is not an array");
  const findings = parsed.map((f) => ({ text: typeof f?.text === "string" ? f.text : String(f?.text ?? "") }));
  return { revision: Number(best.revision), summary: String(best.summary ?? ""), findings };
}

/** One line: no line break inside a field. */
const oneLine = (s) => String(s ?? "").replace(/\r\n|\r|\n/g, " ");

/** The longest prefix of s within n UTF-8 bytes, cut at a code point. */
function cutBytes(s, n) {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = bytesOf(ch);
    if (used + b > n) break;
    out += ch;
    used += b;
  }
  return out;
}

/**
 * Wraps body lines in the tags within STATE_BLOCK_MAX_BYTES, tags and line breaks included. Cuts at a line end. When
 * not even the first body line fits, that line is cut at a code point so that the block is never empty of content.
 * @returns {{ text: string, bytes: number, kept: number, cut: boolean }}
 */
function wrapLines(lines) {
  const frame = bytesOf(STATE_OPEN) + 1 + bytesOf(STATE_CLOSE);
  let used = frame;
  const kept = [];
  for (const l of lines) {
    const b = bytesOf(l) + 1;
    if (used + b > STATE_BLOCK_MAX_BYTES) break;
    kept.push(l);
    used += b;
  }
  let cut = kept.length < lines.length;
  if (kept.length === 0 && lines.length > 0) {
    kept.push(cutBytes(lines[0], STATE_BLOCK_MAX_BYTES - frame - 1));
    cut = true;
  }
  const text = [STATE_OPEN, ...kept, STATE_CLOSE].join("\n");
  return { text, bytes: bytesOf(text), kept: kept.length, cut };
}

/**
 * One block inside the byte limit, tags included. Cuts at a line end.
 * Lines: "summary: ..." (when the summary is not empty), then "finding N (reported claim, not verified): ...".
 * findings is the number of finding lines in the block.
 * @returns {{ text: string, bytes: number, findings: number, cut: boolean }}
 */
export function formatStateBlock({ summary, findings }) {
  const lines = [];
  const s = oneLine(summary).trim();
  if (s !== "") lines.push("summary: " + s);
  const list = Array.isArray(findings) ? findings : [];
  list.forEach((f, i) => lines.push(`finding ${i + 1} (${FINDING_LABEL}): ` + oneLine(typeof f === "string" ? f : f?.text).trim()));
  const w = wrapLines(lines);
  const findingLines = Math.max(0, w.kept - (s !== "" ? 1 : 0));
  return { text: w.text, bytes: w.bytes, findings: findingLines, cut: w.cut };
}

/** The same tags and limit around free text (arm G). Empty lines at either end are dropped. */
export function wrapStateText(text) {
  const lines = String(text ?? "").replace(/\r\n|\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  const w = wrapLines(lines);
  return { text: w.text, bytes: w.bytes, cut: w.cut };
}
