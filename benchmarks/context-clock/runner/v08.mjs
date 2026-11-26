// Runner side of the v0.8 arms (EXPERIMENT-V08.md "Arms", "Measurements").
// - Mode U: the overlay UserPromptSubmit hook adds the text of arm L (configs/state-file-instruction.txt) to each user
//   message n of the session with (n - offset) % every == 0 and n > offset (CCB_PERIODIC_EVERY, CCB_PERIODIC_OFFSET).
//   The hook counts messages, not stages. The runner maps the stages that a suite names (periodicStages) to message
//   numbers from the real prompt order of each task (promptSequence) and checks that the suite's every and offset
//   reach exactly those stage messages and no other message. Without periodicEvery and periodicOffset it solves them.
// - Mode Q: mode P with configs/precompact-strong-instruction.txt as the PreCompact output.
// - telemetry.costUsd: the sum of the turn costs (each one the increment of the host session total).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointsOf } from "./plan.mjs";
import { CONFIGS_DIR, DEFAULT_PERIODIC, TRIGGER_ENV } from "./workspace.mjs";

export { DEFAULT_PERIODIC };
export const V08_TRIGGER_MODES = Object.freeze(["U", "Q"]);
export const PERIODIC_INSTRUCTION_FILE = join(CONFIGS_DIR, TRIGGER_ENV.U.CCB_PERIODIC_FILE);
export const PRECOMPACT_STRONG_INSTRUCTION_FILE = join(CONFIGS_DIR, TRIGGER_ENV.Q.CCB_PRECOMPACT_FILE);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const textOf = (file) => readFileSync(file, "utf8").trim();

/** The runner label of probe turn `c` of `probes` (the same rule as the run loop of run.mjs). */
export function probeLabel(probes, c, stageNo) {
  const list = probes.filter((x) => x.afterStage === stageNo && x.afterCompaction === c.afterCompaction);
  const n = probes.indexOf(c);
  return list.length > 1 || probes.filter((x) => x.afterStage === stageNo).length > 1 ? `checkpoint-${stageNo}-${n + 1}` : `checkpoint-${stageNo}`;
}

/**
 * The user messages of one run in order, as runner turn labels: intro, each stage, its probes, the compaction
 * ("compact-N", only with countsCompact: true, when the host counts "/compact" as a user message), the probes after
 * it, and final. Message n is element n - 1.
 */
export function promptSequence(task, { countsCompact = false } = {}) {
  const probes = checkpointsOf(task);
  const out = ["intro"];
  for (const s of task.stages) {
    out.push(`stage-${s.stage}`);
    for (const c of probes.filter((x) => x.afterStage === s.stage && !x.afterCompaction)) out.push(probeLabel(probes, c, s.stage));
    if (s.compactAfter === true) {
      if (countsCompact) out.push(`compact-${s.stage}`);
      for (const c of probes.filter((x) => x.afterStage === s.stage && x.afterCompaction)) out.push(probeLabel(probes, c, s.stage));
    }
  }
  out.push("final");
  return out;
}

/** The message numbers 1..total that get the reminder: n > offset and (n - offset) % every == 0. */
export function periodicNumbers(total, every, offset) {
  const out = [];
  for (let n = 1; n <= total; n++) if (n > offset && (n - offset) % every === 0) out.push(n);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Mode U for one task: { every, offset, turns } where turns are the labels of the reminded messages. With `stages`,
 * the reminded messages must be exactly the stage messages of those stages: the given every and offset are checked,
 * or (when both are null) the smallest every, then the smallest offset, that fits is chosen. Throws when none fits.
 * Without `stages`, every and offset (else DEFAULT_PERIODIC) are used as they are.
 */
export function periodicOf(task, { stages = null, every = null, offset = null, countsCompact = false } = {}) {
  const seq = promptSequence(task, { countsCompact });
  const turnsOf = (e, o) => periodicNumbers(seq.length, e, o).map((n) => seq[n - 1]);
  if (!stages) {
    const e = every ?? DEFAULT_PERIODIC.every;
    const o = offset ?? DEFAULT_PERIODIC.offset;
    return { every: e, offset: o, turns: turnsOf(e, o) };
  }
  const missing = stages.filter((s) => !task.stages.some((x) => x.stage === s));
  if (missing.length > 0) throw new Error(`mode U: task ${task.taskId} has no stage ${missing.join(", ")}`);
  const want = [...stages].sort((a, b) => a - b).map((s) => `stage-${s}`);
  if (every !== null || offset !== null) {
    const e = every ?? DEFAULT_PERIODIC.every;
    const o = offset ?? DEFAULT_PERIODIC.offset;
    const got = turnsOf(e, o);
    if (!sameList(got, want)) throw new Error(`mode U: every ${e} and offset ${o} remind ${got.join(", ") || "nothing"} in task ${task.taskId}, not exactly ${want.join(", ")}`);
    return { every: e, offset: o, turns: got };
  }
  for (let e = 1; e <= seq.length; e++) {
    for (let o = 0; o < seq.length; o++) {
      if (sameList(turnsOf(e, o), want)) return { every: e, offset: o, turns: want };
    }
  }
  throw new Error(`mode U: no every and offset remind exactly ${want.join(", ")} in task ${task.taskId} (messages: ${seq.join(", ")})`);
}

/**
 * The mode U plan of a suite: null without mode U. Suite fields: periodicStages (stage numbers), periodicEvery,
 * periodicOffset, periodicCountsCompact (default false). Returns { stages, every, offset, countsCompact, byTask }.
 */
export function periodicPlan(suite, tasks, modes) {
  if (!modes.includes("U")) return null;
  const stages = suite.periodicStages ?? null;
  if (stages !== null && (!Array.isArray(stages) || stages.length === 0 || stages.some((s) => !Number.isInteger(s) || s < 1))) throw new Error("suite periodicStages must be a list of stage numbers");
  const every = suite.periodicEvery ?? null;
  const offset = suite.periodicOffset ?? null;
  if (every !== null && (!Number.isInteger(every) || every < 1)) throw new Error("suite periodicEvery must be a positive integer");
  if (offset !== null && (!Number.isInteger(offset) || offset < 0)) throw new Error("suite periodicOffset must be an integer >= 0");
  const countsCompact = suite.periodicCountsCompact === true;
  const byTask = {};
  for (const t of tasks) byTask[t.taskId] = periodicOf(t, { stages, every, offset, countsCompact });
  return { stages, every, offset, countsCompact, byTask };
}

/** batch.json: { file, sha256 } of the reminder of mode U and of the PreCompact text of mode Q, else null. */
export function v08Records(modes, periodic = null) {
  return {
    periodicInstruction: modes.includes("U") ? { file: `configs/${TRIGGER_ENV.U.CCB_PERIODIC_FILE}`, sha256: sha256(textOf(PERIODIC_INSTRUCTION_FILE)) } : null,
    precompactStrongInstruction: modes.includes("Q") ? { file: `configs/${TRIGGER_ENV.Q.CCB_PRECOMPACT_FILE}`, sha256: sha256(textOf(PRECOMPACT_STRONG_INSTRUCTION_FILE)) } : null,
    periodic: periodic ?? null,
  };
}

/** telemetry.costUsd: the sum of the turn costs that are numbers (rounded to 1e-9), null when no turn has one. */
export function totalCostUsd(turns) {
  const list = (turns ?? []).map((t) => t?.costUsd).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (list.length === 0) return null;
  return Math.round(list.reduce((a, b) => a + b, 0) * 1e9) / 1e9;
}
