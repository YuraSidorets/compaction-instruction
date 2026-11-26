// Task loading, suite selection, the run list and its seeded order (CONTRACT.md "Run record", runner command).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workTaskProblems } from "./worktask.mjs";

export const MODES = Object.freeze(["A", "B", "C", "D", "E", "F", "G", "H", "S", "J", "K", "L", "N", "T", "P", "U", "Q", "R", "V", "M", "O", "I", "Y", "Z", "W"]);
export const ORDERS = Object.freeze(["shuffle", "block"]);
export const CATEGORIES = Object.freeze(["A", "B", "C", "D", "E", "W", "X", "T", "K", "L"]);

/** Minimal schema check of a task file. Returns a list of problems ([] = valid). */
export function validateTask(t) {
  const p = [];
  if (t?.schema !== 1) p.push("schema is not 1");
  if (typeof t?.taskId !== "string" || t.taskId === "") p.push("taskId missing");
  if (!CATEGORIES.includes(t?.category)) p.push("category not A-E, W, X, T or K");
  if (!["long", "compaction"].includes(t?.profile)) p.push("profile not long/compaction");
  if (typeof t?.intro !== "string") p.push("intro missing");
  if (!Array.isArray(t?.stages) || t.stages.length === 0) p.push("stages missing");
  else t.stages.forEach((s, i) => {
    if (s.stage !== i + 1) p.push(`stage ${i + 1} has number ${s.stage}`);
    if (typeof s.prompt !== "string") p.push(`stage ${i + 1} prompt missing`);
  });
  // Plan step 2.6: a work-result task has no final questions; its final turn sends final.prompt.
  const workFinal = Array.isArray(t?.final?.questions) && t.final.questions.length === 0 && typeof t?.final?.prompt === "string" && t.final.prompt.trim() !== "";
  if (!workFinal && (!Array.isArray(t?.final?.questions) || t.final.questions.length === 0)) p.push("final questions missing");
  p.push(...workTaskProblems(t));
  // EXPERIMENT-V09.md part 2: timing after_auto_compaction holds probes for the boundaries of automatic compactions.
  const probes = ["after_compaction", "after_auto_compaction"].includes(t?.checkpoint?.timing) ? t.checkpoint.probes : undefined;
  // EXPERIMENT-V09.md part 2: a task with no compaction stage (empty compaction plan) names any stage in its probes; the
  // runner asks them only after an automatic compaction of the host (suite autoCompact).
  const planned = (t?.stages ?? []).some((s) => s.compactAfter === true);
  if (probes !== undefined) {
    const ids = new Set((t.checkpoint.questions ?? []).map((q) => q.id));
    if (!Array.isArray(probes) || probes.length === 0) p.push("checkpoint.probes is not a list");
    else probes.forEach((c, i) => {
      const s = (t.stages ?? []).find((x) => x.stage === c?.afterStage);
      if (!s || (planned && s.compactAfter !== true)) p.push(`checkpoint.probes[${i}].afterStage is not a compaction stage`);
      if (!Array.isArray(c?.questionIds) || c.questionIds.length === 0 || c.questionIds.some((id) => !ids.has(id))) p.push(`checkpoint.probes[${i}].questionIds do not name checkpoint questions`);
    });
  }
  for (const q of [...(t?.final?.questions ?? []), ...(t?.checkpoint?.questions ?? [])]) {
    if (!["choice", "set", "int", "bool"].includes(q.type)) p.push(`question ${q.id} has type ${q.type}`);
  }
  if (t?.profile === "long" && t.checkpoint !== null && t.checkpoint !== undefined && t.checkpoint.timing !== "after_auto_compaction") p.push("profile long needs checkpoint null");
  if (t?.profile === "compaction" && !planned && !(Array.isArray(probes) && probes.length > 0)) p.push("profile compaction has no compactAfter stage");
  return p;
}

export function loadTasks(dir) {
  if (!existsSync(dir)) return [];
  const tasks = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".task.json")).sort()) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const problems = validateTask(t);
    if (problems.length > 0) throw new Error(`invalid task file ${f}: ${problems.join("; ")}`);
    tasks.push(t);
  }
  return tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** Pick the tasks of a suite. Explicit ids win; else the suite's list; else the automatic pick. */
export function selectTasks(all, suite, explicitIds) {
  const byId = new Map(all.map((t) => [t.taskId, t]));
  const ids = explicitIds?.length ? explicitIds : suite.tasks?.length ? suite.tasks : null;
  // EXPERIMENT-V06.md: a suite can select its tasks by id prefix (taskPrefix), so it needs no task slug.
  // EXPERIMENT-V09.md: or by a list of prefixes (taskPrefixes), in list order, each one with at least one task.
  const prefixes = suite.taskPrefixes ?? (suite.taskPrefix ? [suite.taskPrefix] : null);
  if (!ids && prefixes) {
    const hit = [];
    for (const prefix of prefixes) {
      const some = all.filter((t) => String(t.taskId).startsWith(prefix));
      if (some.length === 0) throw new Error(`no task id starts with ${prefix}`);
      for (const t of some) if (!hit.includes(t)) hit.push(t);
    }
    return hit.slice(0, suite.count ?? hit.length);
  }
  if (ids) {
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(", ")}`);
    return ids.map((id) => byId.get(id));
  }
  let picked;
  if (suite.pick === "one-long-one-compaction") {
    picked = [all.find((t) => t.profile === "long"), all.find((t) => t.profile === "compaction")].filter(Boolean);
    for (const t of all) if (picked.length < suite.count && !picked.includes(t)) picked.push(t);
  } else if (suite.pick === "one-per-compaction-count") {
    // v03-smoke: one task with 1 compaction, one with 2 (then any other task to fill the count).
    const n = (t) => (t.stages ?? []).filter((s) => s.compactAfter === true).length;
    picked = [all.find((t) => n(t) === 1), all.find((t) => n(t) === 2)].filter(Boolean);
    for (const t of all) if (picked.length < suite.count && !picked.includes(t)) picked.push(t);
  } else if (suite.pick === "one-per-category") {
    picked = CATEGORIES.map((c) => all.find((t) => t.category === c)).filter(Boolean);
  } else {
    picked = [...all];
  }
  return picked.slice(0, suite.count);
}

export function runIdOf(host, taskId, mode, rep) {
  return `${host}__${taskId}__${mode}__r${rep}`;
}

/** mulberry32: a small seeded generator. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, seed) {
  const out = [...list];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * All runs of the batch in seeded order. `order` starts at 1.
 * - "shuffle" (default, CONTRACT.md): one seeded shuffle of all runs.
 * - "block" (EXPERIMENT-V03.md): a seeded shuffle of the (task, repetition) blocks, then a seeded shuffle of the modes
 *   inside each block, so the modes of one block run next to each other.
 */
export function buildRunList({ host, tasks, modes, reps, seed, order = "shuffle" }) {
  const make = (t, mode, rep) => ({ runId: runIdOf(host, t.taskId, mode, rep), host, taskId: t.taskId, mode, rep, profile: t.profile });
  if (order === "block") {
    const blocks = [];
    for (const t of tasks) for (let rep = 1; rep <= reps; rep++) blocks.push({ t, rep });
    const r = rng(seed);
    const runs = [];
    shuffle(blocks, seed).forEach((b, i) => {
      const inner = shuffle(modes, (Math.floor(r() * 4294967296) ^ (i + 1)) >>> 0);
      for (const mode of inner) runs.push({ ...make(b.t, mode, b.rep), block: i + 1 });
    });
    return runs.map((x, i) => ({ ...x, order: i + 1 }));
  }
  const runs = [];
  for (const t of tasks) for (const mode of modes) for (let rep = 1; rep <= reps; rep++) runs.push(make(t, mode, rep));
  return shuffle(runs, seed).map((x, i) => ({ ...x, order: i + 1 }));
}

/** The block list of a block-ordered run list: [{ block, taskId, rep, modes }]. */
export function blocksOf(runs) {
  const out = [];
  for (const x of runs) {
    if (x.block === undefined) continue;
    let b = out[out.length - 1];
    if (!b || b.block !== x.block) out.push((b = { block: x.block, taskId: x.taskId, rep: x.rep, modes: [] }));
    b.modes.push(x.mode);
  }
  return out;
}

/**
 * The question turns of a task in run order.
 * - CONTRACT.md: `checkpoint` ({ afterStage, questions }) is one turn directly before the compaction of its stage.
 * - tasks/v03/README.md: with `checkpoint.timing === "after_compaction"` and `checkpoint.probes`
 *   ([{ afterStage, questionIds }]), each probe is one turn directly after the compaction of its stage, with only the
 *   questions of its questionIds, in probe order.
 */
export function checkpointsOf(task) {
  const cp = task.checkpoint;
  if (!cp || !Array.isArray(cp.questions)) return [];
  // after_auto_compaction (EXPERIMENT-V09.md part 2): the same probes, asked only after a detected automatic compaction;
  // its top-level afterStage is never a plain probe.
  if ((cp.timing === "after_compaction" || cp.timing === "after_auto_compaction") && Array.isArray(cp.probes)) {
    const byId = new Map(cp.questions.map((q) => [q.id, q]));
    return cp.probes.map((p) => ({ afterStage: p.afterStage, afterCompaction: true, questions: (p.questionIds ?? []).map((id) => byId.get(id)).filter(Boolean) }));
  }
  return [{ afterStage: cp.afterStage, afterCompaction: false, questions: cp.questions }];
}
