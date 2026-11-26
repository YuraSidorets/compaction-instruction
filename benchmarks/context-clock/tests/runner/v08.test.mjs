// v0.8 runner arms (EXPERIMENT-V08.md): mode U (periodic reminder of UserPromptSubmit), mode Q (stronger PreCompact
// text), telemetry.triggers.periodic, telemetry.costUsd, and the v08 suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { STATE_FILE_INSTRUCTION_FILE, stageToolsOf } from "../../runner/v05.mjs";
import { stageMessage } from "../../runner/v04.mjs";
import { triggerTelemetry } from "../../runner/v07.mjs";
import {
  PERIODIC_INSTRUCTION_FILE, PRECOMPACT_STRONG_INSTRUCTION_FILE, periodicNumbers, periodicOf, periodicPlan, promptSequence, totalCostUsd, v08Records,
} from "../../runner/v08.mjs";
import { MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { capture } from "./v06-capture.mjs";
import { V08_TASK_IDS, eightStageTask, v07TaskDir } from "./v07-fixture.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const NAMED = { U: ["CCB_PERIODIC_FILE", "CCB_PERIODIC_EVERY", "CCB_PERIODIC_OFFSET"], Q: ["CCB_PRECOMPACT_FILE"] };
const SEQ = ["intro", "stage-1", "stage-2", "stage-3", "checkpoint-3", "stage-4", "stage-5", "checkpoint-5", "stage-6", "stage-7", "checkpoint-7", "stage-8", "final"];

function fixtureTask() {
  const dir = v07TaskDir(V08_TASK_IDS);
  try {
    return JSON.parse(readFileSync(join(dir, `${V08_TASK_IDS[0]}.task.json`), "utf8"));
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------- modes

test("v08: modes U and Q set the clock as mode B, no returned state, and the named variables only", () => {
  for (const m of ["U", "Q"]) assert.deepEqual(MODE_ENV[m], MODE_ENV.B, m);
  const parent = { PATH: "x", CCB_PERIODIC_FILE: "leak", CCB_PERIODIC_EVERY: "9", CCB_PERIODIC_OFFSET: "9" };
  const b = modeEnv("B", "C:/data", parent, "C:/ws");
  for (const k of NAMED.U) assert.equal(b[k], undefined, `B must not inherit ${k}`);
  for (const m of ["U", "Q"]) {
    const e = modeEnv(m, "C:/data", parent, "C:/ws", { periodic: { every: 3, offset: 0 } });
    assert.equal(e.CCB_RETURN_STATE, undefined);
    assert.equal(e.CCB_STATE_FILE, undefined);
    const diff = Object.keys({ ...e, ...b }).filter((k) => e[k] !== b[k]).sort();
    assert.deepEqual(diff, [...NAMED[m]].sort(), m);
  }
  const u = modeEnv("U", "d", {}, "w", { periodic: { every: 3, offset: 1 } });
  assert.equal(u.CCB_PERIODIC_FILE, PERIODIC_INSTRUCTION_FILE);
  assert.ok(isAbsolute(u.CCB_PERIODIC_FILE));
  assert.deepEqual([u.CCB_PERIODIC_EVERY, u.CCB_PERIODIC_OFFSET], ["3", "1"]);
  assert.deepEqual([modeEnv("U", "d", {}, "w").CCB_PERIODIC_EVERY, modeEnv("U", "d", {}, "w").CCB_PERIODIC_OFFSET], ["2", "0"], "the hook defaults");
  assert.throws(() => modeEnv("U", "d", {}, "w", { periodic: { every: 0, offset: 0 } }), /mode U/);
  const q = modeEnv("Q", "d", {}, "w");
  assert.equal(q.CCB_PRECOMPACT_FILE, PRECOMPACT_STRONG_INSTRUCTION_FILE);
  assert.ok(isAbsolute(q.CCB_PRECOMPACT_FILE) && q.CCB_PRECOMPACT_FILE.endsWith("precompact-strong-instruction.txt"));
  // Tools: U writes the state file, Q has no agent step.
  assert.ok(stageToolsOf(["Read"], "U").includes("Write"));
  assert.deepEqual(stageToolsOf(["Read"], "Q"), stageToolsOf(["Read"], "B"));
  for (const m of ["U", "Q"]) assert.equal(stageMessage("prompt", m, { stage: 3, compactAfter: true }), "prompt");
});

test("v08: the prompts of U and Q are byte-equal to mode B, with the plain /compact", async () => {
  const tasksDir = v07TaskDir(V08_TASK_IDS);
  try {
    const out = await capture({ tasksDir, taskId: V08_TASK_IDS[0], modes: ["B", "U", "Q"], suite: "v08-full", extraArgs: ["--reps", "1"] });
    for (const m of ["U", "Q"]) {
      const x = out[m];
      assert.equal(x.status, "completed", m);
      assert.deepEqual(x.turns, out.B.turns, `${m} prompts`);
      assert.deepEqual(x.compacts, ["/compact", "/compact", "/compact"], m);
      for (const t of x.turns) assert.ok(!t.prompt.includes("clock-state.md"), `${m} ${t.label}`);
      const diff = Object.keys({ ...x.env, ...out.B.env }).filter((k) => x.env[k] !== out.B.env[k]).sort();
      assert.deepEqual(diff, [...NAMED[m]].sort(), `${m} env`);
    }
    assert.deepEqual(out.B.turns.map((t) => t.label), SEQ, "the real prompt order of the run");
    assert.equal(out.U.env.CCB_PERIODIC_EVERY, "3");
    assert.equal(out.U.env.CCB_PERIODIC_OFFSET, "0");
    assert.deepEqual(out.U.tools, [...out.B.tools, "Write"]);
    assert.deepEqual(out.Q.tools, out.B.tools);
  } finally {
    cleanup(tasksDir);
  }
});

// ---------------------------------------------------------------- reminder to stage mapping

test("v08: promptSequence and periodicOf map the reminder to the messages of stages 2, 4, 6 and 8", () => {
  const task = fixtureTask();
  assert.deepEqual(promptSequence(task), SEQ);
  assert.deepEqual(promptSequence(task, { countsCompact: true }).filter((x) => x.startsWith("compact")), ["compact-3", "compact-5", "compact-7"]);
  assert.deepEqual(periodicNumbers(13, 3, 0), [3, 6, 9, 12]);
  assert.deepEqual(periodicNumbers(13, 2, 0), [2, 4, 6, 8, 10, 12]);
  assert.deepEqual(periodicNumbers(13, 4, 3), [7, 11]);
  const want = ["stage-2", "stage-4", "stage-6", "stage-8"];
  assert.deepEqual(periodicOf(task, { stages: [2, 4, 6, 8] }), { every: 3, offset: 0, turns: want }, "solved");
  assert.deepEqual(periodicOf(task, { stages: [8, 2, 6, 4], every: 3, offset: 0 }), { every: 3, offset: 0, turns: want }, "checked");
  // The hook defaults (every 2) would also remind probes and miss stages: the check rejects them.
  assert.throws(() => periodicOf(task, { stages: [2, 4, 6, 8], every: 2, offset: 0 }), /remind stage-1, stage-3, stage-4, checkpoint-5, stage-7, stage-8 in task/);
  // When the host counts each /compact as a user message, no every and offset reach exactly these stages.
  assert.throws(() => periodicOf(task, { stages: [2, 4, 6, 8], countsCompact: true }), /no every and offset/);
  assert.throws(() => periodicOf(task, { stages: [9] }), /no stage 9/);
  // Without stages, the values are used as they are and the reminded messages are reported.
  assert.deepEqual(periodicOf(task, {}), { every: 2, offset: 0, turns: ["stage-1", "stage-3", "stage-4", "checkpoint-5", "stage-7", "stage-8"] });
  // A task with two probe turns after one compaction gets another solution, or a plan error with explicit values.
  const two = structuredClone(task);
  const p5 = two.checkpoint.probes.find((p) => p.afterStage === 5);
  two.checkpoint.probes.splice(two.checkpoint.probes.indexOf(p5) + 1, 0, { afterStage: 5, questionIds: [...p5.questionIds] });
  assert.throws(() => periodicOf(two, { stages: [2, 4, 6, 8], every: 3, offset: 0 }), /not exactly stage-2, stage-4, stage-6, stage-8/);
});

test("v08: periodicPlan reads the suite fields and checks every task", () => {
  const task = fixtureTask();
  assert.equal(periodicPlan({ periodicStages: [2, 4, 6, 8] }, [task], ["B", "Q"]), null, "no mode U");
  const p = periodicPlan({ periodicStages: [2, 4, 6, 8], periodicEvery: 3, periodicOffset: 0 }, [task], ["U"]);
  assert.deepEqual(p, { stages: [2, 4, 6, 8], every: 3, offset: 0, countsCompact: false, byTask: { [task.taskId]: { every: 3, offset: 0, turns: ["stage-2", "stage-4", "stage-6", "stage-8"] } } });
  assert.throws(() => periodicPlan({ periodicStages: [] }, [task], ["U"]), /periodicStages/);
  assert.throws(() => periodicPlan({ periodicEvery: 0 }, [task], ["U"]), /periodicEvery/);
  assert.throws(() => periodicPlan({ periodicOffset: -1 }, [task], ["U"]), /periodicOffset/);
  assert.throws(() => periodicPlan({ periodicStages: [2, 4, 6, 8], periodicCountsCompact: true }, [task], ["U"]), /no every and offset/);
});

// ---------------------------------------------------------------- telemetry

test("v08: triggers.periodic lists each fired message with its turn, and counts the prompts the hook saw", () => {
  const dir = tmp("v08-shim");
  try {
    const file = join(dir, "shim.jsonl");
    const line = (n, fired) => ({ channel: "periodic", event: "UserPromptSubmit", n, fired, bytes: fired ? 583 : 0 });
    const lines = [line(1, false), line(2, false), line(3, true), { channel: "reminder", event: "PostToolUse", fired: false, estimate: null, threshold: 52000, reason: "transcript missing" }, line(4, false), line(5, false), line(6, true), { channel: "periodic", error: "boom" }];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const marks = [{ turn: "intro", lines: 1 }, { turn: "stage-1", lines: 2 }, { turn: "stage-2", lines: 4 }, { turn: "stage-3", lines: 5 }, { turn: "checkpoint-3", lines: 6 }, { turn: "stage-4", lines: 7 }];
    const t = triggerTelemetry(file, marks);
    assert.deepEqual(t.periodic, { fired: [{ n: 3, turn: "stage-2" }, { n: 6, turn: "stage-4" }], prompts: 6 });
    // The overlay form of an unreadable transcript (fired: false with a reason) counts as unreadable.
    assert.deepEqual(t.reminder, { fired: [], unreadable: 1 });
    assert.deepEqual(triggerTelemetry(null, []).periodic, { fired: [], prompts: 0 });
  } finally {
    cleanup(dir);
  }
});

test("v08: telemetry.costUsd sums the turn costs and is null without any", () => {
  assert.equal(totalCostUsd([]), null);
  assert.equal(totalCostUsd([{ costUsd: null }, {}]), null);
  assert.equal(totalCostUsd([{ costUsd: 0.001 }, { costUsd: null }, { costUsd: 0.0005 }, { costUsd: 0.002 }]), 0.0035);
});

test("v08: v08Records names the texts that the batch modes use", () => {
  assert.deepEqual(v08Records(["B", "N"]), { periodicInstruction: null, precompactStrongInstruction: null, periodic: null });
  const r = v08Records(["U", "Q"], { stages: [2] });
  assert.deepEqual(r.periodicInstruction, { file: "configs/periodic-instruction.txt", sha256: sha(readFileSync(PERIODIC_INSTRUCTION_FILE, "utf8").trim()) });
  assert.deepEqual(r.precompactStrongInstruction, { file: "configs/precompact-strong-instruction.txt", sha256: sha(readFileSync(PRECOMPACT_STRONG_INSTRUCTION_FILE, "utf8").trim()) });
  assert.deepEqual(r.periodic, { stages: [2] });
});

// ---------------------------------------------------------------- suites

test("v08: the suites, the overlay need of U and Q, and the task prefix", () => {
  const configs = loadConfigs();
  const s = configs.suites;
  const common = { tasksDir: "tasks/v08", order: "block", overlay: true, runWallTimeMs: 1800000, runToolCalls: 120, periodicStages: [2, 4, 6, 8], periodicEvery: 3, periodicOffset: 0 };
  assert.deepEqual(s["v08-smoke"], { tasks: [], taskPrefix: "A11", pick: "all", count: 1, modes: ["U", "Q"], reps: 1, ...common, batchTokens: 4000000 });
  assert.deepEqual(s["v08-full"], { tasks: [], pick: "all", count: 6, modes: ["B", "N", "U", "Q"], reps: 2, ...common, comparisons: ["N-B", "U-B", "Q-B", "U-N", "Q-N"], batchTokens: 80000000 });
  const tasksDir = v07TaskDir(V08_TASK_IDS);
  try {
    const plan = (suite, more = []) => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock", ...more]), tasksDir }, configs);
    const p = plan("v08-full");
    assert.equal(p.runs.length, 48);
    assert.equal(p.limits.run.wallTimeMs, 1800000);
    assert.equal(p.limits.run.toolCalls, 120);
    assert.equal(p.limits.batch.totalTokens, 80000000);
    assert.equal(Object.keys(p.periodic.byTask).length, 6);
    assert.deepEqual(plan("v08-smoke").tasks.map((t) => t.taskId), ["A11-fixture"]);
    for (const m of ["U", "Q"]) assert.throws(() => plan("v08-smoke", ["--overlay", "off", "--modes", m]), new RegExp(`mode ${m} needs the overlay`));
    assert.doesNotThrow(() => parseArgs(["--batch", "x", "--suite", "v08-smoke", "--modes", "U,Q"]));
  } finally {
    cleanup(tasksDir);
  }
});

test("v08: both suites complete with --mock; U writes in the reminded stages; Q delivers its PreCompact text", async () => {
  const tasksDir = v07TaskDir(V08_TASK_IDS);
  try {
    for (const suite of ["v08-smoke", "v08-full"]) {
      const results = tmp("v08-res");
      const work = tmp("v08-work");
      try {
        const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", "--concurrency", "2"]), tasksDir, resultsDir: results, workRoot: work };
        const r = await runBatch(opts, { log: () => {} });
        assert.equal(r.exitCode, 0, suite);
        assert.ok(r.records.every((x) => x.status === "completed"), suite);
        const batch = JSON.parse(readFileSync(join(results, "b", "batch.json"), "utf8"));
        assert.equal(batch.periodicInstruction.file, "configs/periodic-instruction.txt");
        assert.equal(batch.precompactStrongInstruction.file, "configs/precompact-strong-instruction.txt");
        assert.equal(batch.compactInstruction, null, "mode P is not in the batch");
        assert.deepEqual(batch.periodic.byTask["A11-fixture"], { every: 3, offset: 0, turns: ["stage-2", "stage-4", "stage-6", "stage-8"] });
        for (const rec of r.records) {
          const tr = rec.telemetry.triggers;
          assert.equal(rec.telemetry.shim.errors, 0);
          assert.equal(rec.telemetry.costUsd, totalCostUsd(rec.turns), rec.runId);
          assert.equal(rec.telemetry.costUsd, 0.0145, "13 turns at 0.001 and 3 compactions at 0.0005");
          if (rec.mode === "U") {
            assert.deepEqual(tr.periodic, { fired: [{ n: 3, turn: "stage-2" }, { n: 6, turn: "stage-4" }, { n: 9, turn: "stage-6" }, { n: 12, turn: "stage-8" }], prompts: 13 });
            assert.deepEqual(rec.telemetry.stateFile.writeStages, [2, 4, 6, 8]);
            assert.deepEqual(rec.compactions.map((c) => c.stateFileCopied), [true, true, true]);
          } else assert.deepEqual(tr.periodic, { fired: [], prompts: 0 }, rec.runId);
          assert.equal(tr.precompact.deliveries, rec.mode === "Q" ? 3 : 0, rec.runId);
          if (rec.mode === "Q" || rec.mode === "B") assert.deepEqual(rec.telemetry.stateFile.writeStages, [], rec.runId);
        }
      } finally {
        cleanup(results, work);
      }
    }
  } finally {
    cleanup(tasksDir);
  }
});

test("v08: a host that counts /compact as a user message shows other reminded turns in telemetry", async () => {
  const tasksDir = v07TaskDir(V08_TASK_IDS);
  const results = tmp("v08-res");
  const work = tmp("v08-work");
  try {
    const { createMockHost } = await import("../../runner/hosts/mock.mjs");
    const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", "v08-smoke", "--mock", "--modes", "U"]), tasksDir, resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host: createMockHost({ mockDir: null, periodicCountsCompact: true }), log: () => {} });
    const p = r.records[0].telemetry.triggers.periodic;
    assert.equal(p.prompts, 16);
    assert.notDeepEqual(p.fired.map((f) => f.turn), ["stage-2", "stage-4", "stage-6", "stage-8"]);
  } finally {
    cleanup(tasksDir, results, work);
  }
});

test("v08: the fixture is the shape of tasks/v08 (8 stages, compactions after 3, 5 and 7)", () => {
  const t = eightStageTask(fixtureTask(), "A11-x", "A");
  assert.equal(t.stages.length, 8);
  assert.deepEqual(t.stages.filter((s) => s.compactAfter).map((s) => s.stage), [3, 5, 7]);
});
