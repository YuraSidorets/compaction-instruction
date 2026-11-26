// Runner side of v0.6 (EXPERIMENT-V06.md "Records for each compaction" and "Interfaces").
// - The state file copy: directly before each /compact, in every mode, <workspace>/clock-state.md goes to
//   state-file-<N>.md in the raw attempt folder. No file: no copy.
// - preTokens: the context size before a compaction, from the compact_boundary line of the host stream.
// - costUsd: the cost of one turn. Claude Code reports total_cost_usd on each result line as the running total of the
//   session (one persistent process, or a resumed session: earlier spend included). The runner records the increment
//   against the previous total of the same attempt and never adds up the totals.
// The modes J, K and L and telemetry.stateFile.reads are in v05.mjs, next to mode H.
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { jsonLines } from "./stream.mjs";
import { CLOCK_STATE_FILE_NAME } from "./workspace.mjs";

/** The file name of the copy of the state file before the compaction after stage `n`. */
export function stateFileCopyName(n) {
  return `state-file-${n}.md`;
}

/**
 * Copy <workspace>/clock-state.md to <rawDir>/state-file-<n>.md. Returns { stateFileCopied, stateFileBytes }:
 * { false, null } when the workspace has no state file. A copy error is thrown (the runner marks the run infra_failed).
 */
export function copyStateFile(workspace, rawDir, n) {
  const src = join(workspace, CLOCK_STATE_FILE_NAME);
  if (!existsSync(src) || !statSync(src).isFile()) return { stateFileCopied: false, stateFileBytes: null };
  const dest = join(rawDir, stateFileCopyName(n));
  copyFileSync(src, dest);
  return { stateFileCopied: true, stateFileBytes: statSync(dest).size };
}

const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** pre_tokens of the compact_boundary line of one stream (compact_metadata or compactMetadata), else null. */
export function preTokensOf(streamText) {
  for (const e of jsonLines(String(streamText ?? "")).events) {
    if (e?.type !== "system" || e.subtype !== "compact_boundary") continue;
    const m = e.compact_metadata ?? e.compactMetadata ?? null;
    const v = m?.pre_tokens ?? m?.preTokens;
    return isCount(v) ? v : null;
  }
  return null;
}

/** total_cost_usd of the last result line of one stream (the host running total of the session), else null. */
export function hostCostOf(streamText) {
  let v = null;
  for (const e of jsonLines(String(streamText ?? "")).events) {
    if (e?.type === "result" && typeof e.total_cost_usd === "number" && Number.isFinite(e.total_cost_usd)) v = e.total_cost_usd;
  }
  return v;
}

/**
 * The cost tracker of one attempt (one session). `next(total)` takes the host running total of a turn and returns the
 * cost of that turn: total minus the last known total. It returns null when the turn has no total, or when the total
 * went down (the host can report a zeroed total after a crash); in that case the next increment starts from this total.
 */
export function createCostTracker() {
  let last = 0;
  return {
    next(total) {
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
      const prev = last;
      last = total;
      if (total < prev) return null;
      return Math.round((total - prev) * 1e9) / 1e9;
    },
  };
}
