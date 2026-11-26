// Runner side of the v0.7 arms (EXPERIMENT-V07.md "Arms", "Measurements").
// - Modes N, T and P set the trigger variables of workspace.mjs TRIGGER_ENV. The overlay hooks deliver the texts: N the
//   standing instruction at SessionStart, T the reminder after a tool call above the context threshold, P the
//   PreCompact output. No stage message names the state file, and the runner sends the plain /compact.
// - Modes N and T add Write to the stage tools (the agent writes clock-state.md when the text asks for it). P does not.
// - telemetry.triggers from the shim log channels "standing", "reminder" and "precompact".
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRIGGER_CHANNELS } from "./overlay-run.mjs";
import { CONFIGS_DIR, DEFAULT_REMIND_THRESHOLD, TRIGGER_ENV } from "./workspace.mjs";

import { WRITE_TRIGGER_MODES } from "./v05.mjs";

export { DEFAULT_REMIND_THRESHOLD, TRIGGER_CHANNELS, TRIGGER_ENV, WRITE_TRIGGER_MODES };
export const TRIGGER_MODES = Object.freeze(["N", "T", "P"]);
export const STANDING_INSTRUCTION_FILE = join(CONFIGS_DIR, "standing-instruction.txt");
export const REMINDER_INSTRUCTION_FILE = join(CONFIGS_DIR, "reminder-instruction.txt");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const readText = (file) => readFileSync(file, "utf8").trim();

/** The fixed standing instruction of mode N (trimmed). It names no task value. */
export function standingInstruction() {
  return readText(STANDING_INSTRUCTION_FILE);
}

/** The fixed reminder of mode T (trimmed). It names no task value. */
export function reminderInstruction() {
  return readText(REMINDER_INSTRUCTION_FILE);
}

/**
 * batch.json: { file, sha256 } of the standing instruction (mode N) and the reminder (mode T), else null, and the
 * reminder threshold when mode T is in the batch. The compaction instruction of mode P is in
 * v05.mjs instructionRecords (compactInstruction).
 */
export function triggerRecords(modes, remindThreshold = DEFAULT_REMIND_THRESHOLD) {
  return {
    standingInstruction: modes.includes("N") ? { file: "configs/standing-instruction.txt", sha256: sha256(standingInstruction()) } : null,
    reminderInstruction: modes.includes("T") ? { file: "configs/reminder-instruction.txt", sha256: sha256(reminderInstruction()) } : null,
    remindThreshold: modes.includes("T") ? remindThreshold : null,
  };
}

// ---------------------------------------------------------------- shim log

function logLines(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** The number of non-empty lines of the shim log now. The runner reads it after each turn to know which turn wrote a line. */
export function shimLineCount(file) {
  return logLines(file).length;
}

export function emptyTriggers() {
  return {
    standing: { deliveries: 0 }, reminder: { fired: [], unreadable: 0 }, precompact: { deliveries: 0 }, periodic: { fired: [], prompts: 0 },
    precompactByTrigger: { manual: 0, auto: 0, unknown: 0 },
    precompactProduct: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } },
    precompactPlain: { deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } },
    // v12 mode Z: the PreCompact output of the standalone plugin, from the host records (runner/plain.mjs standaloneTelemetry).
    precompactStandalone: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: null },
  };
}

/** The reasons of the overlay (runner/overlay/triggers.mjs) for a reminder line that could not read the transcript. */
export const UNREADABLE_REASONS = Object.freeze(["no transcript_path", "transcript missing", "no usage record"]);

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * telemetry.triggers: { standing: { deliveries }, reminder: { fired: [{ turn, estimate, threshold }], unreadable },
 * precompact: { deliveries } }.
 * `marks` is [{ turn, lines }] in turn order: the runner turn label and the shim log line count after that turn. A log
 * line belongs to the first turn whose count is above its index (null when it came after the last mark).
 * - standing, precompact: each line counts as a delivery unless it has delivered: false.
 * - reminder: a line with unreadable: true, or with fired: false and a reason of UNREADABLE_REASONS (the form the
 *   overlay writes), counts as unreadable (the hook could not read the transcript). Any other line is a reminder that
 *   fired, unless it has fired: false. estimate and threshold are numbers or null.
 * - precompactByTrigger (EXPERIMENT-V09.md): the precompact deliveries by the trigger field of the line ("manual",
 *   "auto", anything else or no field: unknown).
 * - periodic (EXPERIMENT-V08.md, mode U): { channel, event: "UserPromptSubmit", n, fired, bytes }, one line for each
 *   user message the hook saw. prompts counts the lines; fired lists { n, turn } of each line with fired: true.
 * A line with an error field is a shim error and readShimLog counts it. Here it is skipped.
 */
export function triggerTelemetry(file, marks = []) {
  const out = emptyTriggers();
  const lines = logLines(file);
  const turnOf = (i) => marks.find((m) => m.lines > i)?.turn ?? null;
  // Context Clock v0.3: precompactProduct from the "precompact_product" lines of the hook shim. calls counts the
  // lines; a line with bytes > 0 is a delivery, with its sha256 (of the trimmed stdout) and its trigger.
  lines.forEach((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || e.error !== undefined || !TRIGGER_CHANNELS.includes(e.channel)) return;
    if (e.channel === "standing") {
      if (e.delivered !== false) out.standing.deliveries++;
    } else if (e.channel === "precompact") {
      if (e.delivered !== false) {
        out.precompact.deliveries++;
        out.precompactByTrigger[e.trigger === "manual" || e.trigger === "auto" ? e.trigger : "unknown"]++;
        // EXPERIMENT-V11.md: the PreCompact hook of the plain arm I also logs the sha256 of the text it printed.
        if (typeof e.sha256 === "string") {
          const p = out.precompactPlain;
          p.deliveries++;
          p.bytes += Number.isInteger(e.bytes) && e.bytes > 0 ? e.bytes : 0;
          p.sha256s.push(e.sha256);
          p.byTrigger[e.trigger === "manual" || e.trigger === "auto" ? e.trigger : "unknown"]++;
        }
      }
    } else if (e.channel === "precompact_product") {
      const p = out.precompactProduct;
      p.calls++;
      const bytes = Number.isInteger(e.bytes) && e.bytes > 0 ? e.bytes : 0;
      if (bytes > 0) {
        p.deliveries++;
        p.bytes += bytes;
        p.sha256s.push(typeof e.sha256 === "string" ? e.sha256 : "");
        p.byTrigger[e.trigger === "manual" || e.trigger === "auto" ? e.trigger : "unknown"]++;
      }
    } else if (e.channel === "periodic") {
      out.periodic.prompts++;
      if (e.fired === true) out.periodic.fired.push({ n: Number.isInteger(e.n) ? e.n : null, turn: turnOf(i) });
    } else if (e.unreadable === true || (e.fired === false && UNREADABLE_REASONS.includes(e.reason))) {
      out.reminder.unreadable++;
    } else if (e.fired !== false) {
      out.reminder.fired.push({ turn: turnOf(i), estimate: numOrNull(e.estimate), threshold: numOrNull(e.threshold) });
    }
  });
  return out;
}
