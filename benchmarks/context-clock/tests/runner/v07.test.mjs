// v0.7 runner arms (EXPERIMENT-V07.md): modes N, T and P, the fixed texts, the 8-stage tasks with 3 compactions,
// telemetry.stateFile.writeStages, telemetry.triggers, the v07 suites and their run limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readShimLog } from "../../runner/overlay-run.mjs";
import { buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { STATE_FILE_INSTRUCTION_FILE, COMPACT_INSTRUCTION_FILE, stageToolsOf, stateFileTelemetry } from "../../runner/v05.mjs";
import { stageMessage } from "../../runner/v04.mjs";
import {
  DEFAULT_REMIND_THRESHOLD, REMINDER_INSTRUCTION_FILE, STANDING_INSTRUCTION_FILE, TRIGGER_MODES, reminderInstruction, standingInstruction,
  triggerRecords, triggerTelemetry,
} from "../../runner/v07.mjs";
import { CONFIGS_DIR, MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { capture } from "./v06-capture.mjs";
import { V07_COMPACT_STAGES, V07_TASK_IDS, v07TaskDir } from "./v07-fixture.mjs";
import { cleanup, tmp } from "./helpers.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const raw = (file) => readFileSync(file, "utf8");
const NAMED = { N: ["CCB_STANDING_FILE"], T: ["CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD"], P: ["CCB_PRECOMPACT_FILE"] };

// ---------------------------------------------------------------- fixed texts

test("v07: the text of mode L stays unchanged (v0.6 hash)", () => {
  // sha256 of the file bytes at the v0.6 commit 1a335ef7.
  assert.equal(createHash("sha256").update(readFileSync(STATE_FILE_INSTRUCTION_FILE)).digest("hex"), "b7b578b87a9ccc9d01c68ce9a58345f1be3ec4e78acc72678ce3e5d6af04c29a");
});

test("v07: the description of the state file is the same sentences in the texts of L, N and T", () => {
  const l = raw(STATE_FILE_INSTRUCTION_FILE).trim();
  const start = l.indexOf("Use one Write call");
  const end = l.indexOf("No other tool call");
  assert.ok(start > 0 && end > start, "the L text holds the description sentences");
  const description = l.slice(start, end).trim();
  assert.ok(description.includes('"<identifier>: <value>"') && description.includes('"<identifier> history: <first value>, then <next value>"'));
  for (const text of [standingInstruction(), reminderInstruction()]) {
    assert.ok(text.includes(description), text);
    assert.ok(text.includes("the file clock-state.md in the working folder"), text);
    assert.ok(!/[\r\n]/.test(text), "one line");
  }
  assert.ok(l.includes("the file clock-state.md in the working folder"));
  // Mode N: a standing instruction for the whole session, with a write after each change and no other reminder.
  assert.match(standingInstruction(), /^For this whole session, keep/);
  assert.match(standingInstruction(), /After each change of a tracked value, save .* before you write your reply\./);
  assert.match(standingInstruction(), /No other reminder of this file comes\.$/);
  // Mode T: the context is nearly full, a compaction comes soon, write now before the next step.
  assert.match(reminderInstruction(), /^The context is nearly full, and a compaction of the context comes soon\./);
  assert.match(reminderInstruction(), /now, before your next step\./);
});

test("v07: no fixed text names a task value", () => {
  const values = new Set();
  const dir = v07TaskDir();
  try {
    for (const id of V07_TASK_IDS) {
      const t = JSON.parse(raw(join(dir, `${id}.task.json`)));
      for (const q of [...t.final.questions, ...t.checkpoint.questions]) for (const o of q.options ?? []) if (String(o).length >= 4) values.add(String(o));
    }
  } finally {
    cleanup(dir);
  }
  assert.ok(values.size > 20);
  for (const text of [standingInstruction(), reminderInstruction(), raw(COMPACT_INSTRUCTION_FILE)]) {
    for (const v of values) assert.ok(!text.includes(v), `${v} in ${text.slice(0, 40)}`);
  }
});

// ---------------------------------------------------------------- modes

test("v07: modes N, T and P set the clock as mode B, no returned state, and an absolute path to their text", () => {
  for (const m of TRIGGER_MODES) assert.deepEqual(MODE_ENV[m], MODE_ENV.B, m);
  const parent = { PATH: "x", CCB_STANDING_FILE: "leak", CCB_REMIND_FILE: "leak", CCB_REMIND_THRESHOLD: "1", CCB_PRECOMPACT_FILE: "leak" };
  const b = modeEnv("B", "C:/data", parent, "C:/ws");
  for (const k of Object.values(NAMED).flat()) assert.equal(b[k], undefined, `B must not inherit ${k}`);
  for (const m of TRIGGER_MODES) {
    const e = modeEnv(m, "C:/data", parent, "C:/ws");
    assert.equal(e.CCB_RETURN_STATE, undefined, m);
    assert.equal(e.CCB_STATE_FILE, undefined, m);
    assert.equal(e.CCB_DATA_DIR, "C:/data");
    const diff = Object.keys({ ...e, ...b }).filter((k) => e[k] !== b[k]).sort();
    assert.deepEqual(diff, [...NAMED[m]].sort(), m);
  }
  const n = modeEnv("N", "d", {}, "w");
  const t = modeEnv("T", "d", {}, "w");
  const p = modeEnv("P", "d", {}, "w");
  assert.equal(n.CCB_STANDING_FILE, STANDING_INSTRUCTION_FILE);
  assert.equal(t.CCB_REMIND_FILE, REMINDER_INSTRUCTION_FILE);
  assert.equal(p.CCB_PRECOMPACT_FILE, COMPACT_INSTRUCTION_FILE);
  for (const f of [n.CCB_STANDING_FILE, t.CCB_REMIND_FILE, p.CCB_PRECOMPACT_FILE]) assert.ok(isAbsolute(f) && existsSync(f) && f.startsWith(CONFIGS_DIR), f);
  assert.equal(t.CCB_REMIND_THRESHOLD, "40000");
  assert.equal(DEFAULT_REMIND_THRESHOLD, 40000);
  assert.equal(modeEnv("T", "d", {}, "w", { remindThreshold: 30000 }).CCB_REMIND_THRESHOLD, "30000");
  assert.throws(() => modeEnv("T", "d", {}, "w", { remindThreshold: 0 }), /remindThreshold/);
});

test("v07: modes N and T allow Write in stage turns; mode P keeps the tools of mode B; no stage message names the state file", () => {
  assert.ok(stageToolsOf(["Read"], "N").includes("Write"));
  assert.ok(stageToolsOf(["Read"], "T").includes("Write"));
  assert.deepEqual(stageToolsOf(["Read"], "P"), stageToolsOf(["Read"], "B"));
  for (const m of TRIGGER_MODES) for (const compactAfter of [true, false]) assert.equal(stageMessage("prompt", m, { stage: 3, compactAfter }), "prompt", m);
});

test("v07: the prompts of N, T and P are byte-equal to mode B on an 8-stage task, and the environments differ only in the named variables", async () => {
  const tasksDir = v07TaskDir();
  try {
    const out = await capture({ tasksDir, taskId: V07_TASK_IDS[0], modes: ["B", "N", "T", "P"] });
    const b = out.B;
    assert.equal(b.status, "completed");
    for (const m of TRIGGER_MODES) {
      const x = out[m];
      assert.equal(x.status, "completed", m);
      assert.deepEqual(x.turns, b.turns, `${m} prompts`);
      assert.deepEqual(x.compacts, b.compacts, `${m} compactions`);
      for (const turn of x.turns) assert.ok(!turn.prompt.includes("clock-state.md"), `${m} ${turn.label}`);
      const diff = Object.keys({ ...x.env, ...b.env }).filter((k) => x.env[k] !== b.env[k]).sort();
      assert.deepEqual(diff, [...NAMED[m]].sort(), `${m} env`);
    }
    // Mode P sends the plain /compact, unlike mode S.
    assert.deepEqual(out.P.compacts, ["/compact", "/compact", "/compact"]);
    assert.deepEqual(out.P.tools, b.tools);
    assert.deepEqual(out.N.tools, [...b.tools, "Write"]);
    assert.deepEqual(out.T.tools, [...b.tools, "Write"]);
  } finally {
    cleanup(tasksDir);
  }
});

// ---------------------------------------------------------------- 8 stages, 3 compactions

test("v07: a task with 8 stages and 3 compactions runs with probes after each compaction and state file copies in every mode", async () => {
  const tasksDir = v07TaskDir();
  try {
    const out = await capture({ tasksDir, taskId: V07_TASK_IDS[0], modes: ["B", "L", "N", "T", "P"] });
    const labels = out.B.turns.map((t) => t.label);
    const want = ["intro"];
    for (let s = 1; s <= 8; s++) {
      want.push(`stage-${s}`);
      if (V07_COMPACT_STAGES.includes(s)) want.push(`checkpoint-${s}`);
    }
    want.push("final");
    assert.deepEqual(labels, want);
    for (const [m, copied] of Object.entries({ B: false, L: true, N: true, T: true, P: false })) {
      const rec = out[m].record;
      assert.deepEqual(rec.compactions.map((c) => c.afterStage), [3, 5, 7], m);
      assert.ok(rec.compactions.every((c) => c.confirmed === true && c.stateFileCopied === copied), m);
      assert.equal(rec.turns.filter((t) => t.kind === "compact").length, 3, m);
    }
  } finally {
    cleanup(tasksDir);
  }
});

// ---------------------------------------------------------------- telemetry

test("v07: stateFile.writeStages lists the stage of each write, with repeats", () => {
  const w = (n) => {
    const content = Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: i % 2 ? "Edit" : "Write", input: { file_path: "C:/ws/clock-state.md" } }));
    return JSON.stringify({ type: "assistant", message: { content } }) + "\n";
  };
  const t = stateFileTelemetry([{ turn: "intro", text: "" }, { turn: "stage-1", text: w(1) }, { turn: "stage-2", text: "" }, { turn: "stage-3", text: w(2) }, { turn: "checkpoint-3", text: w(1) }, { turn: "compact-3", text: "" }, { turn: "stage-4", text: w(1) }], 4);
  assert.deepEqual(t.writeStages, [1, 3, 3, 4]);
  assert.equal(t.writes, 5);
  assert.equal(t.stagesWithWrite, 3);
});

test("v07: triggerTelemetry reads the standing, reminder and precompact lines and names the turn of each reminder", () => {
  const dir = tmp("v07-shim");
  try {
    const file = join(dir, "shim.jsonl");
    const lines = [
      { channel: "standing", event: "SessionStart", delivered: true },
      { channel: "session_start", event: "SessionStart", mode: "real", originalBytes: 1, deliveredBytes: 1, replaced: 0 },
      { channel: "reminder", fired: false, estimate: 1000, threshold: 40000 },
      { channel: "reminder", event: "PostToolUse", fired: true, estimate: 41234, threshold: 40000 },
      { channel: "reminder", unreadable: true },
      { channel: "precompact", event: "PreCompact", delivered: true },
      { channel: "standing", event: "SessionStart", delivered: false },
      { channel: "standing", event: "SessionStart" },
      { channel: "reminder", estimate: "x" },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n\n");
    const marks = [{ turn: "intro", lines: 2 }, { turn: "stage-1", lines: 3 }, { turn: "stage-2", lines: 5 }, { turn: "compact-2", lines: 8 }];
    assert.deepEqual(triggerTelemetry(file, marks), {
      standing: { deliveries: 2 },
      reminder: { fired: [{ turn: "stage-2", estimate: 41234, threshold: 40000 }, { turn: null, estimate: null, threshold: null }], unreadable: 1 },
      precompact: { deliveries: 1 },
      periodic: { fired: [], prompts: 0 },
      precompactByTrigger: { manual: 0, auto: 0, unknown: 1 },
      precompactProduct: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } },
      precompactPlain: { deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } },
      precompactStandalone: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: null },
    });
    // The trigger lines are not shim errors; the other channels count as before.
    const shim = readShimLog(file);
    assert.equal(shim.errors, 0);
    assert.equal(shim.byChannel.session_start.real, 1);
    writeFileSync(file, JSON.stringify({ channel: "reminder", error: "transcript read failed" }) + "\n", { flag: "a" });
    assert.equal(readShimLog(file).errors, 1);
    assert.deepEqual(triggerTelemetry(null, []), { standing: { deliveries: 0 }, reminder: { fired: [], unreadable: 0 }, precompact: { deliveries: 0 }, periodic: { fired: [], prompts: 0 }, precompactByTrigger: { manual: 0, auto: 0, unknown: 0 }, precompactProduct: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } }, precompactPlain: { deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 } }, precompactStandalone: { calls: 0, deliveries: 0, bytes: 0, sha256s: [], byTrigger: { manual: 0, auto: 0, unknown: 0 }, unobserved: 0, hookRuns: null } });
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- suites

test("v07: the suites, their run limits, and the overlay need of N, T and P", () => {
  const configs = loadConfigs();
  const s = configs.suites;
  const common = { tasksDir: "tasks/v07", order: "block", overlay: true, runWallTimeMs: 1800000, runToolCalls: 120 };
  assert.deepEqual(s["v07-calib"], { tasks: [], pick: "all", count: 6, modes: ["B", "L"], reps: 1, ...common, batchTokens: 20000000 });
  assert.deepEqual(s["v07-smoke"], { tasks: [], taskPrefix: "A10", pick: "all", count: 1, modes: ["N", "T", "P"], reps: 1, ...common, remindThreshold: 52000, batchTokens: 6000000 });
  assert.deepEqual(s["v07-full"], { tasks: [], pick: "all", count: 6, modes: ["B", "L", "N", "T", "P"], reps: 2, ...common, comparisons: ["N-B", "T-B", "P-B", "L-B", "N-L", "T-L", "P-L"], remindThreshold: 52000, batchTokens: 90000000 });
  const tasksDir = v07TaskDir();
  try {
    const plan = (suite, extra = {}, more = []) => buildPlan({ ...parseArgs(["--host", "claude", "--batch", "x", "--suite", suite, "--mock", ...more]), tasksDir }, { ...configs, suites: { ...s, [suite]: { ...s[suite], ...extra } } });
    const p = plan("v07-full");
    assert.equal(p.limits.run.wallTimeMs, 1800000);
    assert.equal(p.limits.run.toolCalls, 120);
    assert.equal(p.limits.run.turnTimeoutMs, configs.limits.run.turnTimeoutMs);
    assert.equal(p.limits.batch.totalTokens, 90000000);
    assert.equal(p.remindThreshold, 52000);
    assert.equal(p.runs.length, 60);
    assert.deepEqual(plan("v07-smoke").tasks.map((t) => t.taskId), ["A10-fixture"]);
    assert.equal(plan("v07-smoke", { remindThreshold: 25000 }).remindThreshold, 25000);
    assert.throws(() => plan("v07-smoke", { remindThreshold: -1 }), /remindThreshold/);
    assert.throws(() => plan("v07-smoke", { runWallTimeMs: "long" }), /runWallTimeMs/);
    assert.throws(() => plan("v07-smoke", { runToolCalls: 0 }), /runToolCalls/);
    for (const m of TRIGGER_MODES) assert.throws(() => plan("v07-smoke", {}, ["--overlay", "off", "--modes", m]), new RegExp(`mode ${m} needs the overlay`));
  } finally {
    cleanup(tasksDir);
  }
});

test("v07: triggerRecords names the texts that the batch modes use", () => {
  assert.deepEqual(triggerRecords(["B", "L"]), { standingInstruction: null, reminderInstruction: null, remindThreshold: null });
  const r = triggerRecords(["N", "T", "P"], 30000);
  assert.deepEqual(r.standingInstruction, { file: "configs/standing-instruction.txt", sha256: sha(standingInstruction()) });
  assert.deepEqual(r.reminderInstruction, { file: "configs/reminder-instruction.txt", sha256: sha(reminderInstruction()) });
  assert.equal(r.remindThreshold, 30000);
});

test("v07: all three suites complete with --mock, with batch records and trigger telemetry", async () => {
  const tasksDir = v07TaskDir();
  try {
    for (const suite of ["v07-calib", "v07-smoke", "v07-full"]) {
      const results = tmp("v07-res");
      const work = tmp("v07-work");
      try {
        const opts = { ...parseArgs(["--host", "claude", "--batch", "b", "--suite", suite, "--mock", "--concurrency", "2"]), tasksDir, resultsDir: results, workRoot: work };
        const r = await runBatch(opts, { log: () => {} });
        assert.equal(r.exitCode, 0, suite);
        assert.ok(r.records.length > 0 && r.records.every((x) => x.status === "completed"), suite);
        const batch = JSON.parse(raw(join(results, "b", "batch.json")));
        const modes = batch.modes;
        assert.equal(batch.limits.run.wallTimeMs, 1800000);
        assert.equal(batch.limits.run.toolCalls, 120);
        assert.equal(batch.stateFileInstruction?.file ?? null, modes.includes("L") ? "configs/state-file-instruction.txt" : null, suite);
        assert.equal(batch.compactInstruction?.file ?? null, modes.includes("P") ? "configs/compact-instruction.txt" : null, suite);
        assert.equal(batch.compactInstruction?.sha256 ?? null, modes.includes("P") ? sha(raw(COMPACT_INSTRUCTION_FILE).trim()) : null, suite);
        assert.equal(batch.standingInstruction?.file ?? null, modes.includes("N") ? "configs/standing-instruction.txt" : null, suite);
        assert.equal(batch.reminderInstruction?.file ?? null, modes.includes("T") ? "configs/reminder-instruction.txt" : null, suite);
        assert.equal(batch.remindThreshold, modes.includes("T") ? 52000 : null, suite);
        for (const rec of r.records) {
          const tr = rec.telemetry.triggers;
          const ws = rec.telemetry.stateFile.writeStages;
          assert.equal(rec.compactions.length, 3, rec.runId);
          if (rec.mode === "N") {
            assert.equal(tr.standing.deliveries, 4, "start plus 3 compactions");
            assert.deepEqual(ws, [1, 3, 5, 7]);
          } else assert.equal(tr.standing.deliveries, 0, rec.runId);
          if (rec.mode === "T") {
            assert.deepEqual(tr.reminder.fired.map((f) => f.turn), ["stage-2", "stage-5", "stage-7"]);
            assert.ok(tr.reminder.fired.every((f) => f.threshold === 52000 && f.estimate >= 52000));
            assert.deepEqual(ws, [2, 5, 7]);
          } else assert.deepEqual(tr.reminder.fired, [], rec.runId);
          assert.equal(tr.precompact.deliveries, rec.mode === "P" ? 3 : 0, rec.runId);
          if (rec.mode === "P" || rec.mode === "B") assert.deepEqual(ws, [], rec.runId);
          if (rec.mode === "L") assert.deepEqual(ws, [3, 5, 7]);
          assert.equal(rec.telemetry.shim.errors, 0);
        }
      } finally {
        cleanup(results, work);
      }
    }
  } finally {
    cleanup(tasksDir);
  }
});
