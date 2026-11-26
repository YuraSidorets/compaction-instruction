// Runner side of the v0.5 arms (EXPERIMENT-V05.md "Arms").
// - Mode H: the fixed paragraph of configs/state-file-instruction.txt ends each stage message. The agent writes the
//   tracked state to clock-state.md in the workspace with one Write call; the hook shim returns the file after a
//   compaction (CCB_RETURN_STATE=file, CCB_STATE_FILE=<workspace>/clock-state.md, set by modeEnv).
// - Mode S: the runner sends "/compact " plus the one line of configs/compact-instruction.txt in place of "/compact".
// - telemetry.stateFile: the Write and Edit calls on clock-state.md in the raw streams, in every mode, and
//   (EXPERIMENT-V06.md) the reads: Read, Grep or Bash calls whose input names clock-state.md.
// - v0.6 (EXPERIMENT-V06.md "Interfaces"): mode J is mode H without the returned file. Modes K and L are H and J with
//   the paragraph only in the stage messages of stages with compactAfter true.
// This module imports nothing from v04.mjs (v04.mjs imports stateFileInstruction from here).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines } from "./stream.mjs";
import { CLOCK_STATE_FILE_NAME } from "./workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_FILE_INSTRUCTION_FILE = join(HERE, "..", "configs", "state-file-instruction.txt");
export const COMPACT_INSTRUCTION_FILE = join(HERE, "..", "configs", "compact-instruction.txt");
/** Modes whose stage messages end with the state file paragraph (K and L: only before a compaction). */
export const STATE_FILE_MODES = Object.freeze(["H", "J", "K", "L"]);
/** EXPERIMENT-V06.md, Experiment B: the paragraph only in the stage message of a stage with compactAfter true. */
export const SPARSE_STATE_FILE_MODES = Object.freeze(["K", "L"]);
/** Modes whose compaction is "/compact <instruction>". All other modes send the plain "/compact". */
export const COMPACT_INSTRUCTION_MODES = Object.freeze(["S"]);
/** EXPERIMENT-V07.md: mode P delivers the same compaction instruction through the PreCompact hook (plain "/compact"). */
export const PRECOMPACT_MODES = Object.freeze(["P"]);
/** EXPERIMENT-V07.md: modes N and T name the state file through a hook, not in a stage message, and allow Write (V08: U). */
export const WRITE_TRIGGER_MODES = Object.freeze(["N", "T", "U"]);
/** Mode H: the tool the agent needs for the state file. The stage tools of configs/hosts.json do not hold it. */
export const STATE_FILE_TOOL = "Write";
export { CLOCK_STATE_FILE_NAME };

const cache = new Map();
function fixedText(file) {
  if (!cache.has(file)) cache.set(file, readFileSync(file, "utf8").trim());
  return cache.get(file);
}
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The fixed state file paragraph (trimmed). It names no task value. */
export function stateFileInstruction() {
  return fixedText(STATE_FILE_INSTRUCTION_FILE);
}

/** The fixed one-line compaction instruction (trimmed). It names no task value. */
export function compactInstruction() {
  const t = fixedText(COMPACT_INSTRUCTION_FILE);
  if (/[\r\n]/.test(t)) throw new Error(`${COMPACT_INSTRUCTION_FILE} must hold one line`);
  return t;
}

/** batch.json records { file, sha256 } of a fixed text when one of the batch modes uses it, else null. */
export function instructionRecords(modes) {
  return {
    stateFileInstruction: modes.some((m) => STATE_FILE_MODES.includes(m)) ? { file: "configs/state-file-instruction.txt", sha256: sha256(stateFileInstruction()) } : null,
    compactInstruction: modes.some((m) => COMPACT_INSTRUCTION_MODES.includes(m) || PRECOMPACT_MODES.includes(m)) ? { file: "configs/compact-instruction.txt", sha256: sha256(compactInstruction()) } : null,
  };
}

/**
 * True when the stage message of `stage` in `mode` ends with the state file paragraph: every stage in H and J, a stage
 * with compactAfter true in K and L.
 */
export function stateFileParagraphApplies(mode, stage) {
  if (!STATE_FILE_MODES.includes(mode)) return false;
  return SPARSE_STATE_FILE_MODES.includes(mode) ? stage?.compactAfter === true : true;
}

/** The compaction instruction of a mode, or null (plain "/compact"). */
export function compactInstructionOf(mode) {
  return COMPACT_INSTRUCTION_MODES.includes(mode) ? compactInstruction() : null;
}

/** The text a host sends for a compaction: "/compact" or "/compact <instruction>". */
export function compactPrompt(instruction) {
  return instruction ? `/compact ${instruction}` : "/compact";
}

/** The stage tools of a mode: modes H, J, K and L add Write (K and L in every stage turn, as H), and N and T (v0.7). */
export function stageToolsOf(tools, mode) {
  const list = [...(tools ?? [])];
  if ((STATE_FILE_MODES.includes(mode) || WRITE_TRIGGER_MODES.includes(mode)) && !list.includes(STATE_FILE_TOOL)) list.push(STATE_FILE_TOOL);
  return list;
}

// ---------------------------------------------------------------- state file writes from the stream

const WRITE_TOOLS = new Set(["Write", "Edit"]);
const STATE_PATH = new RegExp(`(^|[\\\\/])${CLOCK_STATE_FILE_NAME.replace(/\./g, "\\.")}$`);

/** True when a tool input targets clock-state.md (any folder; the guard keeps the agent in the workspace). */
export function isStateFileWrite(name, input) {
  return WRITE_TOOLS.has(String(name ?? "")) && typeof input?.file_path === "string" && STATE_PATH.test(input.file_path.trim());
}

/** The number of Write or Edit calls on clock-state.md in one Claude-format stream. */
export function stateFileWritesOf(streamText) {
  let n = 0;
  for (const e of jsonLines(streamText).events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use" && isStateFileWrite(b.name, b.input)) n++;
  }
  return n;
}

const READ_TOOLS = new Set(["Read", "Grep", "Bash"]);

/** True when a Read, Grep or Bash call names clock-state.md anywhere in its input (EXPERIMENT-V06.md). */
export function isStateFileRead(name, input) {
  if (!READ_TOOLS.has(String(name ?? ""))) return false;
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return text.includes(CLOCK_STATE_FILE_NAME);
}

/** The number of Read, Grep or Bash calls that name clock-state.md in one Claude-format stream. */
export function stateFileReadsOf(streamText) {
  let n = 0;
  for (const e of jsonLines(streamText).events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === "tool_use" && isStateFileRead(b.name, b.input)) n++;
  }
  return n;
}

export function emptyStateFile(stages = 0) {
  return { writes: 0, stagesWithWrite: 0, stages, reads: { total: 0, afterCompaction: 0 }, writeStages: [] };
}

/**
 * telemetry.stateFile: { writes, stagesWithWrite, stages, reads: { total, afterCompaction }, writeStages }. `streams` is
 * [{ turn, text }] in turn order, with the runner turn labels. writes counts the calls of all turns. A stage counts as
 * a stage with a write when its stage turn has at least one call. The count is the call, not its result: a denied call
 * still counts. reads.afterCompaction counts the reads in the turns after the first compact turn.
 * writeStages (EXPERIMENT-V07.md): the stage number of each Write or Edit call in a stage turn, one entry for each call
 * (so a stage with two calls appears two times), in turn order. Calls in other turns are in writes only.
 */
export function stateFileTelemetry(streams, stages) {
  const out = emptyStateFile(stages);
  const withWrite = new Set();
  let compacted = false;
  for (const s of streams) {
    const n = stateFileWritesOf(s.text);
    out.writes += n;
    const stageNo = /^stage-(\d+)$/.exec(s.turn);
    if (n > 0 && stageNo) {
      withWrite.add(s.turn);
      for (let i = 0; i < n; i++) out.writeStages.push(Number(stageNo[1]));
    }
    const r = stateFileReadsOf(s.text);
    out.reads.total += r;
    if (compacted) out.reads.afterCompaction += r;
    if (/^compact-\d+$/.test(s.turn)) compacted = true;
  }
  out.stagesWithWrite = withWrite.size;
  return out;
}
