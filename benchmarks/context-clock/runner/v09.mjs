// Runner side of v0.9 (EXPERIMENT-V09.md "Arms", "Part 2: automatic compaction").
// - Mode R: mode Q with configs/precompact-general-instruction.txt as the PreCompact output.
// - Automatic compaction mode (suite field autoCompact: true): the runner sends no /compact. After each turn it reads the
//   stream of that turn and records each compact_boundary line, the mark that also confirms a manual compaction, as an
//   automatic compaction of the host. After a stage turn with such a compaction it asks the probes of that stage.
// - contextTokens of each turn: the context size after the turn, from the usage of the last assistant message of the
//   main chain (input + cache read + cache creation + output tokens).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonLines } from "./stream.mjs";
import { CONFIGS_DIR, TRIGGER_ENV } from "./workspace.mjs";

export const V09_TRIGGER_MODES = Object.freeze(["R"]);
export const PRECOMPACT_GENERAL_INSTRUCTION_FILE = join(CONFIGS_DIR, TRIGGER_ENV.R.CCB_PRECOMPACT_FILE);
/** The mechanism of a compaction that the host made by itself (compactions[].mechanism). */
export const AUTO_COMPACT_MECHANISM = "host automatic compaction: compact_boundary line in the stream of a turn";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** batch.json: { file, sha256 } of the PreCompact text of mode R, else null. */
export function v09Records(modes) {
  return {
    precompactGeneralInstruction: modes.includes("R")
      ? { file: `configs/${TRIGGER_ENV.R.CCB_PRECOMPACT_FILE}`, sha256: sha256(readFileSync(PRECOMPACT_GENERAL_INSTRUCTION_FILE, "utf8").trim()) }
      : null,
  };
}

/**
 * Each compact_boundary line of one stream, in order: { trigger, preTokens }. trigger is compact_metadata.trigger
 * ("manual" or "auto") or null; preTokens is compact_metadata.pre_tokens or null.
 */
export function compactBoundariesOf(streamText) {
  const out = [];
  for (const e of jsonLines(String(streamText ?? "")).events) {
    if (e?.type !== "system" || e.subtype !== "compact_boundary") continue;
    const m = e.compact_metadata ?? e.compactMetadata ?? null;
    const pre = m?.pre_tokens ?? m?.preTokens;
    const trigger = typeof m?.trigger === "string" ? m.trigger : null;
    out.push({ trigger, preTokens: isCount(pre) ? pre : null });
  }
  return out;
}

/**
 * The context size after a turn: the usage sum of the last assistant message of the main chain (no
 * parent_tool_use_id), or null when the stream has none.
 */
export function contextTokensOf(streamText) {
  let last = null;
  for (const e of jsonLines(String(streamText ?? "")).events) {
    if (e?.type !== "assistant" || e.parent_tool_use_id) continue;
    const u = e.message?.usage;
    if (!u) continue;
    const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens].filter(isCount);
    if (parts.length > 0) last = parts.reduce((a, b) => a + b, 0);
  }
  return last;
}

/** The compactions[] entries of the automatic compactions in the stream of one turn. */
export function autoCompactionEntries(streamText, { afterStage, turn }) {
  return compactBoundariesOf(streamText).map((b) => ({
    afterStage, turn, confirmed: true, mechanism: AUTO_COMPACT_MECHANISM, preTokens: b.preTokens, trigger: "auto", hostTrigger: b.trigger,
  }));
}

/** A task with no compaction stage, whose probes the runner asks after a detected automatic compaction. */
export function hasCompactionPlan(task) {
  return (task.stages ?? []).some((s) => s.compactAfter === true);
}
