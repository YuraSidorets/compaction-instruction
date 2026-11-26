import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE, buildPlan, loadConfigs, parseArgs } from "../../runner/run.mjs";
import { buildRunList, loadTasks, runIdOf, selectTasks, shuffle, validateTask } from "../../runner/plan.mjs";
import { TASKS, readTask } from "./helpers.mjs";

test("the test tasks are valid contract tasks", () => {
  const tasks = loadTasks(TASKS);
  assert.deepEqual(tasks.map((t) => t.taskId), ["T1-runner-long", "T2-runner-compaction"]);
  for (const t of tasks) assert.deepEqual(validateTask(t), []);
  assert.ok(validateTask({ ...readTask("T1-runner-long"), checkpoint: { afterStage: 1, questions: [] } }).length > 0);
});

test("runId follows <host>__<taskId>__<mode>__r<rep>", () => {
  assert.equal(runIdOf("claude", "A1-db", "C", 2), "claude__A1-db__C__r2");
});

test("the run list has every task x mode x rep once, with order 1..N", () => {
  const tasks = loadTasks(TASKS);
  const runs = buildRunList({ host: "claude", tasks, modes: ["A", "B", "C"], reps: 2, seed: 1 });
  assert.equal(runs.length, 12);
  assert.equal(new Set(runs.map((r) => r.runId)).size, 12);
  assert.deepEqual(runs.map((r) => r.order), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const r of runs) assert.equal(r.profile, tasks.find((t) => t.taskId === r.taskId).profile);
});

test("the order is a seeded shuffle: same seed same order, other seed other order", () => {
  const tasks = loadTasks(TASKS);
  const ids = (seed) => buildRunList({ host: "claude", tasks, modes: ["A", "B", "C"], reps: 2, seed }).map((r) => r.runId);
  assert.deepEqual(ids(7), ids(7));
  assert.notDeepEqual(ids(7), ids(8));
  const sorted = [...ids(7)].sort();
  assert.notDeepEqual(ids(7), sorted, "the shuffle changes the plain order");
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], 3).sort(), [1, 2, 3, 4, 5]);
});

test("the modes do not run as a group (no mode fills the first third of a full-size list)", () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ taskId: `X${String(i).padStart(2, "0")}`, profile: "long" }));
  const runs = buildRunList({ host: "claude", tasks, modes: ["A", "B", "C"], reps: 2, seed: 1 });
  const firstThird = new Set(runs.slice(0, 40).map((r) => r.mode));
  assert.equal(firstThird.size, 3);
});

test("suite selection: smoke takes one long and one compaction task, explicit ids win", () => {
  const all = loadTasks(TASKS);
  const { suites } = loadConfigs();
  assert.deepEqual(selectTasks(all, suites.smoke).map((t) => t.profile).sort(), ["compaction", "long"]);
  assert.deepEqual(selectTasks(all, suites.pilot).map((t) => t.category), ["A", "B"]);
  assert.deepEqual(selectTasks(all, suites.smoke, ["T2-runner-compaction"]).map((t) => t.taskId), ["T2-runner-compaction"]);
  assert.throws(() => selectTasks(all, suites.smoke, ["nope"]), /unknown task id/);
});

test("suite sizes match the contract", () => {
  const { suites } = loadConfigs();
  assert.deepEqual([suites.smoke.count, suites.smoke.modes.length, suites.smoke.reps], [2, 3, 1]);
  assert.deepEqual([suites.pilot.count, suites.pilot.modes.length, suites.pilot.reps], [5, 3, 1]);
  assert.deepEqual([suites.full.count, suites.full.modes.length, suites.full.reps], [20, 3, 2]);
});

test("parseArgs reads the contract command line", () => {
  const o = parseArgs(["--host", "codex", "--batch", "b1", "--suite", "pilot", "--tasks", "a,b", "--modes", "a,c", "--reps", "2", "--concurrency", "4", "--model", "haiku", "--seed", "9", "--mock", "--keep"]);
  assert.equal(o.host, "codex");
  assert.deepEqual(o.tasks, ["a", "b"]);
  assert.deepEqual(o.modes, ["A", "C"]);
  assert.equal(o.reps, 2);
  assert.equal(o.concurrency, 4);
  assert.equal(o.model, "haiku");
  assert.equal(o.seed, 9);
  assert.equal(o.mock, true);
  assert.equal(o.keep, true);
  assert.throws(() => parseArgs(["--suite", "smoke"]), /--batch is required/);
  assert.throws(() => parseArgs(["--batch", "b", "--suite", "huge"]), /--suite/);
  assert.throws(() => parseArgs(["--batch", "b", "--suite", "smoke", "--modes", "X"]), /unknown mode/);
  assert.throws(() => parseArgs(["--batch", "../x", "--suite", "smoke"]), /--batch/);
  assert.throws(() => parseArgs(["--batch", "b", "--suite", "smoke", "--bogus"]), /unknown argument/);
  assert.match(USAGE, /--host claude\|codex/);
});

test("buildPlan: --mock keeps the --host name and uses the mock config", () => {
  const p = buildPlan({ ...parseArgs(["--batch", "b", "--suite", "smoke", "--mock"]), tasksDir: TASKS });
  assert.equal(p.hostName, "claude");
  assert.equal(p.runs.length, 6);
  assert.ok(p.runs.every((r) => r.runId.startsWith("claude__")));
  assert.deepEqual(p.hostCfg, loadConfigs().hosts.mock);
  const c = buildPlan({ ...parseArgs(["--batch", "b", "--suite", "smoke", "--model", "sonnet"]), tasksDir: TASKS });
  assert.equal(c.hostName, "claude");
  assert.equal(c.model, "sonnet");
});
