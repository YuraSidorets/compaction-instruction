// v0.6 runner (EXPERIMENT-V06.md "Experiment A", "Experiment B", "Records for each compaction", "Interfaces"): modes J,
// K and L, the state file copy before each /compact, telemetry.stateFile.reads, preTokens, costUsd, the v06 suites and
// taskPrefix. tasks/v06 is the task worker's; these tests use a v06-like folder made from tasks/v04 (7 stages, two
// compactions) and the runner fixture tasks. The overlay module is a stub; the host is the mock.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODE_ENV as SCHEMA_MODE_ENV, MODES as SCHEMA_MODES, validateRun } from "../../fixtures/schema.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { MODES, selectTasks } from "../../runner/plan.mjs";
import { USAGE, buildPlan, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { STATE_BLOCK_MODES, stageMessage } from "../../runner/v04.mjs";
import {
  SPARSE_STATE_FILE_MODES, STATE_FILE_MODES, instructionRecords, isStateFileRead, stageToolsOf, stateFileInstruction, stateFileParagraphApplies,
  stateFileReadsOf, stateFileTelemetry,
} from "../../runner/v05.mjs";
import { copyStateFile, createCostTracker, hostCostOf, preTokensOf, stateFileCopyName } from "../../runner/v06.mjs";
import { MODE_ENV, modeEnv } from "../../runner/workspace.mjs";
import { capture, sha256 } from "./v06-capture.mjs";
import { BENCH, TASKS, cleanup, readJson, tmp } from "./helpers.mjs";

const quiet = () => {};
const V04 = join(BENCH, "tasks", "v04", "generated");

/** A v06-like task folder: copies of v04 tasks under the v06 ids A9, B9, C9 and E9 (no slug needed by taskPrefix). */
function v06Tasks() {
  const dir = tmp("v06tasks");
  const from = { "A9-mock-decisions": "A8-registry-move", "B9-mock-owners": "B8-payments-reorg", "C9-mock-transitions": "C8-storage-upgrade", "E9-mock-constraints": "E8-index-rebuild" };
  for (const [id, src] of Object.entries(from)) {
    const t = readJson(join(V04, `${src}.task.json`));
    writeFileSync(join(dir, `${id}.task.json`), JSON.stringify({ ...t, taskId: id }));
  }
  return dir;
}

function stubOverlay() {
  return {
    findInstalledPlugin: () => "C:/fake/installed/context-mode",
    buildOverlay: ({ destDir }) => {
      mkdirSync(destDir, { recursive: true });
      return { pluginDir: destDir, sourceSha: "sha-stub-1" };
    },
  };
}

function suiteOpts(x, suite, extra = []) {
  return { ...parseArgs(["--host", "claude", "--batch", "v", "--suite", suite, "--mock", ...extra]), tasksDir: x.tasks, resultsDir: x.results, workRoot: x.work };
}

const dirs = () => ({ tasks: v06Tasks(), results: tmp("v06res"), work: tmp("v06work") });
const stageOf = (task, label) => task.stages.find((s) => `stage-${s.stage}` === label);

// ---------------------------------------------------------------- mode table

test("modes J, K, L: the mode table of EXPERIMENT-V06.md, in the runner and in the shared schema", () => {
  for (const m of ["J", "K", "L"]) {
    assert.ok(MODES.includes(m) && SCHEMA_MODES.includes(m), m);
    assert.deepEqual(MODE_ENV[m], SCHEMA_MODE_ENV[m], m);
  }
  assert.deepEqual(MODE_ENV.J, MODE_ENV.B);
  assert.deepEqual(MODE_ENV.L, MODE_ENV.J);
  assert.deepEqual(MODE_ENV.K, MODE_ENV.H);
  assert.deepEqual(STATE_FILE_MODES, ["H", "J", "K", "L"]);
  assert.deepEqual(SPARSE_STATE_FILE_MODES, ["K", "L"]);
  assert.ok(STATE_BLOCK_MODES.includes("K") && !STATE_BLOCK_MODES.includes("J") && !STATE_BLOCK_MODES.includes("L"));
  for (const m of ["J", "K", "L"]) assert.ok(stageToolsOf(["Read"], m).includes("Write"), m);
  for (const s of ["v06-smoke", "v06-a", "v06-b-restore", "v06-b-prep"]) assert.ok(USAGE.includes(s), s);
  const env = (m) => modeEnv(m, "/data", { PATH: "/bin" }, "/ws");
  assert.equal(env("K").CCB_STATE_FILE, join("/ws", "clock-state.md"));
  for (const m of ["J", "L"]) assert.equal("CCB_STATE_FILE" in env(m) || "CCB_RETURN_STATE" in env(m), false, m);
});

test("stateFileParagraphApplies and stageMessage: every stage in H and J, only a compactAfter stage in K and L", () => {
  const p = "Stage 1.\n";
  const before = { stage: 4, compactAfter: true };
  const plain = { stage: 3, compactAfter: false };
  for (const m of MODES) {
    for (const s of [before, plain, null]) {
      const want = ["H", "J"].includes(m) || (["K", "L"].includes(m) && s?.compactAfter === true);
      assert.equal(stateFileParagraphApplies(m, s), want, `${m} ${JSON.stringify(s)}`);
      if (["H", "J", "K", "L"].includes(m)) assert.equal(stageMessage(p, m, s).includes(stateFileInstruction()), want, `${m}`);
    }
  }
  assert.equal(stageMessage(p, "H", before), stageMessage(p, "J", plain), "the same paragraph bytes");
  assert.deepEqual(instructionRecords(["J"]).stateFileInstruction, instructionRecords(["H"]).stateFileInstruction);
});

// ---------------------------------------------------------------- prompts and environment

// sha256 of the prompt list and of the environment of modes B and H for the fixture task T2-runner-compaction, captured
// with the v0.5 runner (commit 24549334) through tests/runner/v06-capture.mjs. v0.6 must not change them.
const V05_PINS = {
  B: { turns: "9c724247b5ac8456c7caa1825f8c09eaa76214c4a1cb74ce961045bbb11d33dd", env: "707bbeeb7b7c825445672dd1543ddab0e61782e4fb5d8a281f517a455696b981" },
  H: { turns: "f6251bf76eb3c4873e6d8f5c44d11b1e91997c30f7383aa092cccc34225d70e1", env: "b9ea7c883629bc08193e6db19e67bcaa433946f44f6d2ee3b974876d64697a9d" },
};

test("modes B and H stay byte-equal to v0.5: the prompt list, the compaction prompts and the environment", async () => {
  const c = await capture({ tasksDir: TASKS, taskId: "T2-runner-compaction", modes: ["B", "H"] });
  for (const m of ["B", "H"]) {
    assert.equal(c[m].status, "completed", m);
    assert.equal(sha256(c[m].turns), V05_PINS[m].turns, `${m} prompts`);
    // Context Clock v0.3: every mode except M adds CTX_CLOCK_COMPACT=off; the rest of the environment stays byte-equal.
    const { CTX_CLOCK_COMPACT, ...env05 } = c[m].env;
    assert.equal(CTX_CLOCK_COMPACT, "off", m);
    assert.equal(sha256(env05), V05_PINS[m].env, `${m} env`);
    assert.deepEqual(c[m].compacts, ["/compact"], m);
  }
});

test("J against H: byte-equal prompts, compactions and tools; the environment differs only in CCB_RETURN_STATE and CCB_STATE_FILE", async () => {
  const x = dirs();
  try {
    const c = await capture({ tasksDir: x.tasks, taskId: "C9-mock-transitions", modes: ["B", "J", "H", "K", "L"] });
    for (const m of ["B", "J", "H", "K", "L"]) assert.equal(c[m].status, "completed", m);
    const { J, H, K, L, B } = c;
    assert.deepEqual(J.turns, H.turns);
    assert.deepEqual(J.compacts, H.compacts);
    assert.deepEqual(J.tools, H.tools);
    assert.ok(J.tools.includes("Write"));
    const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
    assert.deepEqual(diff(J.env, H.env), ["CCB_RETURN_STATE", "CCB_STATE_FILE"]);
    assert.equal(H.env.CCB_RETURN_STATE, "file");
    assert.equal(H.env.CCB_STATE_FILE, "<ws>/clock-state.md");
    assert.equal("CCB_RETURN_STATE" in J.env || "CCB_STATE_FILE" in J.env, false);
    // The paragraph is in every stage message of J and H, and in no other message.
    const para = stateFileInstruction();
    for (const t of H.turns) assert.equal(t.prompt.includes(para), t.label.startsWith("stage-"), t.label);
    // K against H, L against J: equal environment, tools and compactions; only the stage messages of stages without
    // compactAfter differ, and there they are the B message (no paragraph).
    const task = readJson(join(x.tasks, "C9-mock-transitions.task.json"));
    for (const [sparse, dense] of [[K, H], [L, J]]) {
      assert.deepEqual(sparse.env, dense.env);
      assert.deepEqual(sparse.tools, dense.tools);
      assert.deepEqual(sparse.compacts, dense.compacts);
      assert.deepEqual(sparse.turns.map((t) => t.label), dense.turns.map((t) => t.label));
      let differ = 0;
      sparse.turns.forEach((t, i) => {
        const st = stageOf(task, t.label);
        if (st && st.compactAfter !== true) {
          assert.notEqual(t.prompt, dense.turns[i].prompt, t.label);
          assert.equal(t.prompt, B.turns[i].prompt, t.label);
          differ++;
        } else assert.equal(t.prompt, dense.turns[i].prompt, t.label);
      });
      assert.equal(differ, task.stages.filter((s) => s.compactAfter !== true).length);
    }
  } finally {
    cleanup(x.tasks);
  }
});

// ---------------------------------------------------------------- records for each compaction

test("state file copies, preTokens and costUsd: one copy before each /compact where the file exists, in every mode", async () => {
  const x = dirs();
  try {
    const r = await runBatch(suiteOpts(x, "v06-a", ["--tasks", "C9-mock-transitions", "--reps", "1", "--modes", "B,J,H,K,L"]), { host: createMockHost({ mockDir: null }), overlay: stubOverlay(), log: quiet });
    assert.equal(r.records.length, 5);
    const task = readJson(join(x.tasks, "C9-mock-transitions.task.json"));
    const compactStages = task.stages.filter((s) => s.compactAfter === true).map((s) => s.stage);
    for (const rec of r.records) {
      assert.equal(rec.status, "completed", rec.runId);
      assert.deepEqual(validateRun(rec), [], rec.runId);
      const raw = join(x.results, "v", "raw", rec.runId, "a1");
      assert.deepEqual(rec.compactions.map((c) => c.afterStage), compactStages);
      for (const c of rec.compactions) {
        const file = join(raw, stateFileCopyName(c.afterStage));
        if (rec.mode === "B") {
          assert.deepEqual({ copied: c.stateFileCopied, bytes: c.stateFileBytes }, { copied: false, bytes: null });
          assert.equal(existsSync(file), false);
        } else {
          assert.equal(c.stateFileCopied, true, `${rec.runId} ${c.afterStage}`);
          // The mock writes "mock-item-k: value-k" for k up to the stage: the copy is the state of that stage.
          const text = readFileSync(file, "utf8");
          assert.equal(Buffer.byteLength(text), c.stateFileBytes);
          assert.ok(text.includes(`mock-item-${c.afterStage}: value-${c.afterStage}`));
          assert.equal(text.includes(`mock-item-${c.afterStage + 1}:`), false);
        }
        assert.ok(Number.isInteger(c.preTokens) && c.preTokens > 0, "preTokens from compact_metadata.pre_tokens");
      }
      // costUsd: the increment of the mock session total (0.001 for a turn, 0.0005 for a compaction), never the total.
      for (const t of rec.turns) assert.equal(t.costUsd, t.kind === "compact" ? 0.0005 : 0.001, `${rec.runId} ${t.kind}`);
      const sum = rec.turns.reduce((a, t) => a + t.costUsd, 0);
      const last = readFileSync(join(raw, "final.jsonl"), "utf8");
      assert.ok(Math.abs(sum - hostCostOf(last)) < 1e-9, "the increments add up to the last session total");
      // State block: K and H get one after each compaction; B, J and L get none.
      const sb = rec.telemetry.stateBlock;
      assert.equal(sb.deliveries, ["H", "K"].includes(rec.mode) ? compactStages.length : 0, rec.runId);
      const writes = rec.mode === "B" ? 0 : ["K", "L"].includes(rec.mode) ? compactStages.length : task.stages.length;
      const writeStages = rec.mode === "B" ? [] : ["K", "L"].includes(rec.mode) ? [...compactStages] : task.stages.map((s) => s.stage);
      assert.deepEqual(rec.telemetry.stateFile, { writes, stagesWithWrite: writes, stages: task.stages.length, reads: { total: 0, afterCompaction: 0 }, writeStages }, rec.runId);
    }
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("without total_cost_usd or pre_tokens in the stream: costUsd and preTokens are null", async () => {
  const x = dirs();
  try {
    const host = createMockHost({ mockDir: null, noCost: true, noPreTokens: true });
    const r = await runBatch(suiteOpts(x, "v06-smoke", ["--modes", "J"]), { host, overlay: stubOverlay(), log: quiet });
    const rec = r.records[0];
    assert.equal(rec.status, "completed");
    assert.deepEqual(validateRun(rec), []);
    for (const t of rec.turns) assert.equal(t.costUsd, null, t.kind);
    for (const c of rec.compactions) assert.equal(c.preTokens, null);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("copyStateFile: copies the file to state-file-<N>.md, and no file gives no copy and no error", () => {
  const ws = tmp("v06ws");
  const raw = tmp("v06raw");
  try {
    assert.deepEqual(copyStateFile(ws, raw, 4), { stateFileCopied: false, stateFileBytes: null });
    assert.equal(existsSync(join(raw, "state-file-4.md")), false);
    writeFileSync(join(ws, "clock-state.md"), "a: 1\nb: 2\n");
    assert.deepEqual(copyStateFile(ws, raw, 4), { stateFileCopied: true, stateFileBytes: 10 });
    assert.equal(readFileSync(join(raw, "state-file-4.md"), "utf8"), "a: 1\nb: 2\n");
    mkdirSync(join(ws, "sub"));
    assert.deepEqual(copyStateFile(join(ws, "sub"), raw, 6), { stateFileCopied: false, stateFileBytes: null });
  } finally {
    cleanup(ws, raw);
  }
});

test("preTokensOf, hostCostOf and the cost tracker: increments of a running total, null on a missing or lower total", () => {
  const line = (o) => JSON.stringify(o);
  assert.equal(preTokensOf(line({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 33448, post_tokens: 7416 } })), 33448);
  assert.equal(preTokensOf(line({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 120 } })), 120);
  assert.equal(preTokensOf(line({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } })), null);
  assert.equal(preTokensOf(line({ type: "result" })), null);
  assert.equal(preTokensOf(null), null);
  assert.equal(preTokensOf(readFileSync(join(BENCH, "tests", "runner", "fixtures", "streams", "claude-compact.jsonl"), "utf8")), 33448);
  assert.equal(hostCostOf([line({ type: "result", total_cost_usd: 0.01 }), line({ type: "result", total_cost_usd: 0.03 })].join("\n")), 0.03);
  assert.equal(hostCostOf(line({ type: "result" })), null);
  const c = createCostTracker();
  assert.equal(c.next(0.01), 0.01);
  assert.equal(c.next(0.035), 0.025);
  assert.equal(c.next(null), null, "no total: no cost, the last total stays");
  assert.equal(c.next(0.035), 0);
  assert.equal(c.next(0.002), null, "a lower total (zeroed after a crash) gives null");
  assert.equal(c.next(0.005), 0.003, "the next increment starts from the lower total");
});

test("telemetry.stateFile.reads: Read, Grep or Bash that name clock-state.md; afterCompaction counts turns after the first compact turn", () => {
  const use = (name, input, id) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  assert.ok(isStateFileRead("Read", { file_path: "C:\\ws\\clock-state.md" }));
  assert.ok(isStateFileRead("Grep", { pattern: "owner", path: "clock-state.md" }));
  assert.ok(isStateFileRead("Bash", { command: "cat clock-state.md" }));
  assert.equal(isStateFileRead("Write", { file_path: "/ws/clock-state.md" }), false);
  assert.equal(isStateFileRead("Read", { file_path: "/ws/notes.md" }), false);
  const one = use("Read", { file_path: "/ws/clock-state.md" }, "a");
  const two = [use("Bash", { command: "cat clock-state.md" }, "b"), use("Grep", { pattern: "x", path: "clock-state.md" }, "c")].join("\n");
  assert.equal(stateFileReadsOf(two), 2);
  const t = stateFileTelemetry([{ turn: "stage-1", text: one }, { turn: "stage-2", text: two }, { turn: "compact-2", text: "" }, { turn: "checkpoint-2", text: one }, { turn: "stage-3", text: two }, { turn: "compact-3", text: "" }, { turn: "final", text: one }], 3);
  assert.deepEqual(t.reads, { total: 7, afterCompaction: 4 });
});

// ---------------------------------------------------------------- suites

test("v06 suites: tasks/v06, block order, overlay, modes, repetitions, comparisons, batch token limits, taskPrefix", () => {
  const { suites } = loadConfigs();
  const want = {
    "v06-smoke": { modes: ["B", "J", "H"], reps: 1, batchTokens: 6000000, comparisons: undefined, taskPrefix: "C9" },
    "v06-a": { modes: ["B", "J", "H"], reps: 2, batchTokens: 40000000, comparisons: ["J-B", "H-J", "H-B"], taskPrefix: undefined },
    "v06-b-restore": { modes: ["H", "K"], reps: 2, batchTokens: 25000000, comparisons: ["K-H"], taskPrefix: undefined },
    "v06-b-prep": { modes: ["J", "L"], reps: 2, batchTokens: 25000000, comparisons: ["L-J"], taskPrefix: undefined },
  };
  for (const [name, w] of Object.entries(want)) {
    const s = suites[name];
    assert.equal(s.tasksDir, "tasks/v06", name);
    assert.equal(s.order, "block", name);
    assert.equal(s.overlay, true, name);
    assert.deepEqual(s.tasks, [], name);
    for (const k of Object.keys(w)) assert.deepEqual(s[k], w[k], `${name} ${k}`);
  }
});

test("taskPrefix selects the tasks whose id starts with it; no match stops the plan", () => {
  const all = ["A9-x", "C9-y", "C8-z"].map((taskId) => ({ taskId, stages: [] }));
  assert.deepEqual(selectTasks(all, { tasks: [], taskPrefix: "C9", pick: "all", count: 1 }).map((t) => t.taskId), ["C9-y"]);
  assert.deepEqual(selectTasks(all, { tasks: [], taskPrefix: "C9", pick: "all", count: 1 }, ["A9-x"]).map((t) => t.taskId), ["A9-x"], "--tasks wins");
  assert.throws(() => selectTasks(all, { tasks: [], taskPrefix: "D9", pick: "all", count: 1 }), /no task id starts with D9/);
});

test("v06 plans: 3, 24, 16 and 16 runs in blocks, with the batch token limit of each suite", () => {
  const x = dirs();
  try {
    const configs = loadConfigs();
    const runs = { "v06-smoke": 3, "v06-a": 24, "v06-b-restore": 16, "v06-b-prep": 16 };
    const tokens = { "v06-smoke": 6000000, "v06-a": 40000000, "v06-b-restore": 25000000, "v06-b-prep": 25000000 };
    for (const [suite, n] of Object.entries(runs)) {
      const plan = buildPlan(suiteOpts(x, suite), configs);
      assert.equal(plan.runs.length, n, suite);
      assert.equal(plan.limits.batch.totalTokens, tokens[suite], suite);
      assert.equal(plan.order, "block");
      assert.equal(plan.overlay, true);
    }
    assert.deepEqual(buildPlan(suiteOpts(x, "v06-smoke"), configs).tasks.map((t) => t.taskId), ["C9-mock-transitions"]);
    assert.deepEqual(buildPlan(suiteOpts(x, "v06-a"), configs).tasks.map((t) => t.taskId), ["A9-mock-decisions", "B9-mock-owners", "C9-mock-transitions", "E9-mock-constraints"]);
    assert.throws(() => buildPlan(suiteOpts(x, "v06-b-restore", ["--overlay", "off"]), configs), /mode H needs the overlay/);
    assert.throws(() => buildPlan(suiteOpts(x, "v06-b-restore", ["--modes", "K", "--overlay", "off"]), configs), /mode K needs the overlay/);
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});

test("each v06 suite gives completed runs with --mock (smoke in full, the others on one task and one repetition)", async () => {
  const x = dirs();
  try {
    for (const [suite, extra, n] of [["v06-smoke", [], 3], ["v06-a", ["--tasks", "A9-mock-decisions", "--reps", "1"], 3], ["v06-b-restore", ["--tasks", "B9-mock-owners", "--reps", "1"], 2], ["v06-b-prep", ["--tasks", "E9-mock-constraints", "--reps", "1"], 2]]) {
      const r = await runBatch({ ...suiteOpts(x, suite, extra), batch: suite }, { host: createMockHost({ mockDir: null }), overlay: stubOverlay(), log: quiet });
      assert.equal(r.records.length, n, suite);
      for (const rec of r.records) {
        assert.equal(rec.status, "completed", rec.runId);
        assert.deepEqual(validateRun(rec), [], rec.runId);
        assert.equal(rec.telemetry.shim.errors, 0);
        for (const c of rec.compactions) assert.equal(c.stateFileCopied, rec.mode !== "B", `${rec.runId} ${c.afterStage}`);
      }
      const b = readJson(join(x.results, suite, "batch.json"));
      assert.deepEqual(b.comparisons, loadConfigs().suites[suite].comparisons ?? null);
      assert.ok(b.stateFileInstruction, suite);
    }
  } finally {
    cleanup(x.tasks, x.results, x.work);
  }
});
