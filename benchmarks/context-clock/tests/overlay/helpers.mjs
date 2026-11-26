// Shared fixtures for the overlay tests. The snapshot strings follow the forms of src/core/clock/feedback/index.ts
// (renderClockSnapshot and renderClockLine), written by hand: nothing under benchmarks/ imports from src/.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OVERLAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runner", "overlay");

export const FULL_BLOCK = [
  "[context-clock] tick=7 seq=42 state_rev=3",
  "session=4f1c2a9e-77b0 agent=claude-code",
  "current: src/parser.ts v=9a8b7c6d 62% of 1840 lines",
  "source: tests/parser.test.ts v=1f2e3d4c lines 1-120",
  "source: README.md v=00aa11bb observed only (stale version)",
  "sources: +2 more",
  "summary (agent claim): The tokenizer handles nested quotes; the lexer still drops CRLF.",
  "finding 1 (agent claim): parseHeader returns null for an empty file.",
  "status: mcp__plugin_context-mode_context-mode__ctx_clock_status",
  "limits: 2 part(s) observed only. Delivery to the model is not confirmed (certainty at most returned_to_host).",
  "[/context-clock]",
].join("\n");

export const LINE_FORM = "[context-clock] tick=7 seq=42 state_rev=3 src=src/parser.ts 62% of 1840 lines | model delivery not confirmed";
export const LINE_FORM_STALE = "[context-clock] tick=12 seq=99 state_rev=0 src=docs/guide.md lines 1-40 (stale) | model delivery not confirmed";

/** A block with non-ASCII text, so byte length and character length differ. */
export const FULL_BLOCK_UTF8 = [
  "[context-clock] tick=1 seq=5 state_rev=1",
  "session=ab12 agent=claude-code",
  "current: notes/café-menü.md v=deadbeef lines 3-9",
  "summary (agent claim): Ünïcödé näme ✓ handled",
  "status: ctx_clock_status",
  "limits: 0 part(s) observed only. Delivery to the model is not confirmed (certainty at most returned_to_host).",
  "[/context-clock]",
].join("\n");

export function tempDir(prefix = "ccb-overlay-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export const bytesOf = (s) => Buffer.byteLength(s, "utf8");

/** Writes a script into dir and returns its path. */
export function writeScript(dir, name, code) {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, code);
  return p;
}
