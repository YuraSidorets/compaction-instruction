// Tests for the validity rule of graders/work-tests.mjs: the same v0.8 denied-attempt rule as graders/grade.mjs
// (deniedViolations, violationsOf, usesDeniedRule). A work run whose outside attempts the guard denied stays valid and
// gets the hidden-test score; an attempt that was not denied makes the run invalid with score 0. Both graders agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deniedViolations, gradeRun, GUARD_DENY_TEXT } from "../../graders/grade.mjs";
import { gradeWorkBatch, gradeWorkRun } from "../../graders/work-tests.mjs";
import { WORK_DIR } from "../../tasks/generator/v12work.mjs";

const FIX = join(import.meta.dirname, "fixtures");
const load = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const QTASK = load("T1-compact.task.json");
const QKEY = load("T1-compact.key.json");
const QBASE = load("run-completed.json");

const ID = "K13-shipping-quote";
const TASK = JSON.parse(readFileSync(join(WORK_DIR, "generated", `${ID}.task.json`), "utf8"));
const TESTS = JSON.parse(readFileSync(join(WORK_DIR, "keys", `${ID}.tests.json`), "utf8"));
const SOLUTION = readFileSync(join(WORK_DIR, "reference", `${ID}.solution.mjs`), "utf8");

const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, text, isError) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });
const denyText = (tool) => "PreToolUse:" + tool + " hook error: " + GUARD_DENY_TEXT;

// The live shapes of v12-work-01: a Read of the session transcript and a Write to the memory folder, both denied.
const V_READ = { turn: "stage-4", tool: "Read", reason: "path outside the workspace", excerpt: "<home>/.claude/projects/<workspace>/s1.jsonl" };
const V_WRITE = { turn: "final", tool: "Write", reason: "path outside the workspace", excerpt: "<home>/.claude/projects/<workspace>/memory/notes.md" };
const READ_IN = { file_path: "C:\\Users\\me\\.claude\\projects\\C--work-ws-x\\s1.jsonl" };
const WRITE_IN = { file_path: "C:/Users/me/.claude/projects/C--work-ws-x/memory/notes.md", content: "x" };
const streams = (writeDenied = true) => ({
  "stage-4": [use("r1", "Read", READ_IN), result("r1", denyText("Read"), true)],
  final: [use("w1", "Write", WRITE_IN), writeDenied ? result("w1", denyText("Write"), true) : result("w1", "File created", false)],
});

function workRun(vs, guardDenied) {
  return { schema: 1, runId: "r1", taskId: ID, status: "completed", integrity: { violations: vs }, telemetry: { guard: { denied: guardDenied } } };
}

function workspaceDir() {
  const dir = mkdtempSync(join(tmpdir(), "ccb-work-ws-"));
  for (const f of TASK.workspace.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  writeFileSync(join(dir, TESTS.module), SOLUTION);
  return dir;
}

test("gradeWorkRun: all outside attempts denied keeps the run valid with the hidden-test score, as gradeRun does", () => {
  const dir = workspaceDir();
  try {
    const run = workRun([V_READ, V_WRITE], 2);
    const denial = deniedViolations(run.integrity.violations, streams());
    const g = gradeWorkRun(TASK, TESTS, run, dir, { rule: "v08", denial });
    assert.deepEqual([g.valid, g.invalidReason, g.score, g.success, g.validityRule], [true, null, 1, true, "v08"]);
    assert.deepEqual(g.deniedAttempts, { violations: 2, notPaths: 0, denied: 2, calls: 2, allDenied: true });
    // The question grader decides the same for a run with the same violations and guard log.
    const q = { ...structuredClone(QBASE), integrity: { violations: [V_READ, V_WRITE] }, telemetry: { guard: { denied: 2 } } };
    assert.equal(gradeRun(QTASK, QKEY, q, { rule: "v08", denial }).valid, g.valid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gradeWorkRun: an attempt that was not denied, or a guard log with too few denials, makes the run invalid with score 0", () => {
  const dir = workspaceDir();
  try {
    const run = workRun([V_READ, V_WRITE], 2);
    const ran = deniedViolations(run.integrity.violations, streams(false));
    const g = gradeWorkRun(TASK, TESTS, run, dir, { rule: "v08", denial: ran });
    assert.deepEqual([g.valid, g.score, g.success, g.deniedAttempts.allDenied, g.deniedAttempts.denied], [false, 0, false, false, 1]);
    assert.match(g.invalidReason, /1 not denied by the guard/);
    const q = { ...structuredClone(QBASE), integrity: { violations: [V_READ, V_WRITE] }, telemetry: { guard: { denied: 2 } } };
    assert.equal(gradeRun(QTASK, QKEY, q, { rule: "v08", denial: ran }).valid, false);
    const few = gradeWorkRun(TASK, TESTS, workRun([V_READ, V_WRITE], 1), dir, { rule: "v08", denial: deniedViolations([V_READ, V_WRITE], streams()) });
    assert.deepEqual([few.valid, few.score], [false, 0]);
    assert.match(few.invalidReason, /guard log has 1 denial/);
    // Without the v08 rule, any violation makes the run invalid, and the grade has no deniedAttempts.
    const old = gradeWorkRun(TASK, TESTS, run, dir);
    assert.deepEqual([old.valid, old.score, "deniedAttempts" in old], [false, 0, false]);
    // A record of a path inside the workspace (Git Bash form) is not a violation.
    const inside = gradeWorkRun(TASK, TESTS, workRun([{ turn: "final", tool: "Bash", reason: "path outside the workspace", excerpt: "<workspace>/src/shipping" }], 0), dir);
    assert.deepEqual([inside.valid, inside.score], [true, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function batchRoot(suite, { writeDenied = true, raw = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ccb-work-batch-"));
  mkdirSync(join(root, "tasks", "generated"), { recursive: true });
  mkdirSync(join(root, "tasks", "keys"), { recursive: true });
  cpSync(join(WORK_DIR, "generated", `${ID}.task.json`), join(root, "tasks", "generated", `${ID}.task.json`));
  cpSync(join(WORK_DIR, "keys", `${ID}.tests.json`), join(root, "tasks", "keys", `${ID}.tests.json`));
  const batch = join(root, "results", "bw");
  const runDir = join(batch, "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(batch, "batch.json"), JSON.stringify({ schema: 1, batch: "bw", suite }));
  writeFileSync(join(runDir, "run.json"), JSON.stringify(workRun([V_READ, V_WRITE], 2)));
  const ws = workspaceDir();
  cpSync(ws, join(runDir, "workspace"), { recursive: true });
  rmSync(ws, { recursive: true, force: true });
  if (raw) {
    const dir = join(batch, "raw", "r1", "a1");
    mkdirSync(dir, { recursive: true });
    for (const [label, lines] of Object.entries(streams(writeDenied))) writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return root;
}

test("gradeWorkBatch: a v08 or later suite reads the raw streams and records deniedAttempts; an older suite keeps the old rule", () => {
  const cases = [
    ["v12-work", {}, true, 1],
    ["v12-work", { writeDenied: false }, false, 0],
    ["v12-work", { raw: false }, false, 0],
    ["v07-full", {}, false, 0],
  ];
  for (const [suite, opts, valid, score] of cases) {
    const root = batchRoot(suite, opts);
    try {
      gradeWorkBatch(root, "bw");
      const g = JSON.parse(readFileSync(join(root, "results", "bw", "runs", "r1", "grade.json"), "utf8"));
      const at = `${suite} ${JSON.stringify(opts)}`;
      assert.deepEqual([g.valid, g.score], [valid, score], at);
      if (suite === "v12-work") assert.equal(g.deniedAttempts.allDenied, valid, at);
      else assert.equal("deniedAttempts" in g, false, at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
