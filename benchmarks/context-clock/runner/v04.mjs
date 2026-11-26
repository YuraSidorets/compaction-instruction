// Runner side of the v0.4 arms (EXPERIMENT-V04.md "Arms", "Commit instruction" and "Interfaces").
// - Modes E and F: the fixed paragraph of configs/commit-instruction.txt ends each stage message.
// - Mode G: before each compaction the runner writes the reference state of that stage to CCB_STATE_FILE.
// - telemetry.commits: the ctx_clock_commit calls of the raw streams, ok or rejected by error code.
// The state block itself is the overlay worker's (runner/overlay/state-block.mjs and the hook shim).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines } from "./stream.mjs";
import { STATE_FILE_MODES, stateFileInstruction, stateFileParagraphApplies } from "./v05.mjs";
import { STATE_FILE_NAME } from "./workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const COMMIT_INSTRUCTION_FILE = join(HERE, "..", "configs", "commit-instruction.txt");
/** Modes whose stage messages end with the commit paragraph. */
export const COMMIT_MODES = Object.freeze(["E", "F"]);
/** Modes whose SessionStart:compact reply gets a state block from the overlay shim. */
export const STATE_BLOCK_MODES = Object.freeze(["F", "G", "H", "K"]);
/** Mode G: the reference state file in the data folder of the run (set as CCB_STATE_FILE by modeEnv). */
export { STATE_FILE_NAME };
/** EXPERIMENT-V04.md: the text of one reference state is at most 1900 bytes. */
export const REFERENCE_TEXT_MAX_BYTES = 1900;

let cached = null;

/** The fixed commit paragraph (trimmed). It names no task value. */
export function commitInstruction(file = COMMIT_INSTRUCTION_FILE) {
  if (file !== COMMIT_INSTRUCTION_FILE) return readFileSync(file, "utf8").trim();
  if (cached === null) cached = readFileSync(file, "utf8").trim();
  return cached;
}

/** sha256 of the paragraph as the runner sends it, for batch.json. */
export function commitInstructionSha() {
  return createHash("sha256").update(commitInstruction(), "utf8").digest("hex");
}

/**
 * The stage message of a mode: the v0.3 stage prompt, plus the commit paragraph in modes E and F, or the state file
 * paragraph in modes H and J (EXPERIMENT-V05.md, EXPERIMENT-V06.md). Modes K and L add it only when `stage` has
 * compactAfter true; without `stage` they add nothing.
 */
export function stageMessage(prompt, mode, stage = null) {
  const extra = COMMIT_MODES.includes(mode) ? commitInstruction() : STATE_FILE_MODES.includes(mode) && stateFileParagraphApplies(mode, stage) ? stateFileInstruction() : null;
  return extra ? prompt.replace(/\s+$/, "") + "\n\n" + extra + "\n" : prompt;
}

/** The reference folder of a task folder: <tasks>/reference, next to generated/ (tasksDir may name generated/). */
export function referenceDirOf(tasksDir) {
  return basename(tasksDir) === "generated" ? join(dirname(tasksDir), "reference") : join(tasksDir, "reference");
}

/**
 * The reference state of one task ({ schema: 1, taskId, states: [{ afterStage, text }] }), checked against the task:
 * one entry for each compaction stage, text at most 1900 bytes. Throws with the reason.
 */
export function loadReferenceState(tasksDir, task) {
  const file = join(referenceDirOf(tasksDir), `${task.taskId}.state.json`);
  if (!existsSync(file)) throw new Error(`mode G needs the reference state ${file}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`reference state ${file} is not JSON: ${err.message}`);
  }
  if (doc?.schema !== 1 || doc.taskId !== task.taskId || !Array.isArray(doc.states)) {
    throw new Error(`reference state ${file} must be { schema: 1, taskId: "${task.taskId}", states: [...] }`);
  }
  for (const s of task.stages ?? []) {
    if (s.compactAfter !== true) continue;
    const e = doc.states.find((x) => x?.afterStage === s.stage);
    if (!e || typeof e.text !== "string") throw new Error(`reference state ${file} has no text for the compaction after stage ${s.stage}`);
    if (Buffer.byteLength(e.text, "utf8") > REFERENCE_TEXT_MAX_BYTES) throw new Error(`reference state ${file}: the text after stage ${s.stage} is above ${REFERENCE_TEXT_MAX_BYTES} bytes`);
  }
  return doc;
}

/** Mode G: write the reference text of the compaction after `stage` to `file` (overwrites the earlier one). */
export function writeReferenceState(file, ref, stage) {
  const e = ref.states.find((x) => x?.afterStage === stage);
  if (!e) throw new Error(`reference state of ${ref.taskId} has no text for the compaction after stage ${stage}`);
  writeFileSync(file, e.text);
  return Buffer.byteLength(e.text, "utf8");
}

// ---------------------------------------------------------------- commits from the stream

const COMMIT_TOOL = /(^|__)ctx_clock_commit$/;
const ERROR_CODE = /^ctx_clock_commit: ([A-Z][A-Z0-9_]+):/;

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/**
 * The error code of a rejected commit reply. The product replies "ctx_clock_commit: <CODE>: ..." (REVISION_CONFLICT,
 * UNKNOWN_EVIDENCE, other store codes). A malformed call is "ctx_clock_commit: <what was wrong>. Correct call: ..."
 * (INVALID_INPUT). Any other error (a host or permission error) is TOOL_ERROR.
 */
export function commitErrorCode(text) {
  const t = String(text ?? "").trim();
  const m = ERROR_CODE.exec(t);
  if (m) return m[1];
  if (/^ctx_clock_commit: /.test(t) && /Correct call:/.test(t)) return "INVALID_INPUT";
  return "TOOL_ERROR";
}

/** The ctx_clock_commit calls of one Claude-format stream: [{ ok, code }]. A call without a result is NO_RESULT. */
export function commitCallsOf(streamText) {
  const calls = new Map();
  for (const e of jsonLines(streamText).events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && COMMIT_TOOL.test(String(b.name ?? ""))) calls.set(b.id, { ok: false, code: "NO_RESULT" });
      if (b?.type === "tool_result" && calls.has(b.tool_use_id)) {
        const text = resultText(b.content);
        const bad = b.is_error === true || ERROR_CODE.test(text.trim());
        calls.set(b.tool_use_id, bad ? { ok: false, code: commitErrorCode(text) } : { ok: true, code: null });
      }
    }
  }
  return [...calls.values()];
}

export function emptyCommits(stages = 0) {
  return { calls: 0, ok: 0, rejected: {}, stagesWithCommit: 0, stages };
}

/**
 * telemetry.commits: { calls, ok, rejected: { <code>: n }, stagesWithCommit, stages }. `streams` is [{ turn, text }]
 * with turn labels as the runner writes them (stage-N, checkpoint-N, final, ...). A stage counts as a stage with a
 * commit when its stage turn has at least one ok commit. `stages` is the number of stage turns that ran.
 */
export function commitTelemetry(streams, stages) {
  const out = emptyCommits(stages);
  const withCommit = new Set();
  for (const s of streams) {
    for (const c of commitCallsOf(s.text)) {
      out.calls++;
      if (c.ok) {
        out.ok++;
        if (/^stage-\d+$/.test(s.turn)) withCommit.add(s.turn);
      } else out.rejected[c.code] = (out.rejected[c.code] ?? 0) + 1;
    }
  }
  out.rejected = Object.fromEntries(Object.entries(out.rejected).sort(([a], [b]) => a.localeCompare(b)));
  out.stagesWithCommit = withCommit.size;
  return out;
}
