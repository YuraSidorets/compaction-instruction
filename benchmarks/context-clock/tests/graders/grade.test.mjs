// Grader tests (CONTRACT.md "Grade record"). Hand-made task, key and run fixtures in ./fixtures.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeAnswer, gradeJson, gradeRun, holdsClockText } from "../../graders/grade.mjs";

const FIX = join(import.meta.dirname, "fixtures");
const GRADER = join(import.meta.dirname, "../../graders/grade.mjs");
const load = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const TASK = load("T1-compact.task.json");
const KEY = load("T1-compact.key.json");
const LONG_TASK = load("T2-long.task.json");
const LONG_KEY = load("T2-long.key.json");
const BASE = load("run-completed.json");

/** A run record from the base fixture with some fields replaced. `final` and `checkpoint` merge into the answers. */
function runWith({ final, checkpoint, ...over } = {}) {
  const r = structuredClone(BASE);
  Object.assign(r, over);
  if (final !== undefined) r.answers.final = final === null ? null : { ...r.answers.final, ...final };
  if (checkpoint !== undefined) r.answers.checkpoint = checkpoint;
  return r;
}
const q = (grade, id) => grade.questions.find((x) => x.id === id);
const Q = Object.fromEntries(TASK.final.questions.map((x) => [x.id, x]));

describe("answer types and normalization", () => {
  test("a fully correct run: success, score 1, no continuity errors", () => {
    const g = gradeRun(TASK, KEY, BASE);
    assert.equal(g.valid, true);
    assert.equal(g.invalidReason, null);
    assert.equal(g.status, "completed");
    assert.equal(g.success, true);
    assert.equal(g.score, 1);
    assert.deepEqual(g.continuityErrors, {});
    assert.deepEqual(g.questions.map((x) => x.correct), [true, true, true, true, true]);
    assert.deepEqual(q(g, "q1"), {
      id: "q1", type: "choice", correct: true, given: "sqlite", reason: null, aspect: "current_state",
      errorCategory: null, preCompaction: true, establishedBy: ["e001", "e004"],
    });
  });

  const cases = [
    // [question, given, correct, reason]
    ["q1", "  SQLite ", true, null],
    ["q1", "SQLITE\n", true, null],
    ["q1", "mysql", false, "not_an_option"],
    ["q1", "redis", false, "wrong_value"],
    ["q1", ["sqlite"], false, "malformed"],
    ["q1", 1, false, "malformed"],
    ["q2", [" Worker", "API "], true, null],
    ["q2", ["api", "worker", "api"], true, null],
    ["q2", ["api"], false, "wrong_value"],
    ["q2", ["api", "worker", "web"], false, "wrong_value"],
    ["q2", "api, worker", false, "malformed"],
    ["q2", ["api", 3], false, "malformed"],
    ["q2", ["api", "db"], false, "not_an_option"],
    ["q2", [], false, "wrong_value"],
    ["q3", 3, true, null],
    ["q3", "3", true, null],
    ["q3", " +3 ", true, null],
    ["q3", 3.0, true, null],
    ["q3", 3.5, false, "malformed"],
    ["q3", "3.0", false, "malformed"],
    ["q3", "three", false, "malformed"],
    ["q3", 4, false, "wrong_value"],
    ["q4", true, true, null],
    ["q4", " TRUE ", true, null],
    ["q4", "yes", false, "malformed"],
    ["q4", 1, false, "malformed"],
    ["q4", undefined, false, "missing"],
    ["q4", null, false, "missing"],
  ];
  for (const [id, given, correct, reason] of cases) {
    test(id + " (" + Q[id].type + ") given " + JSON.stringify(given) + " -> " + (correct ? "correct" : reason), () => {
      assert.deepEqual(gradeAnswer(Q[id], KEY.answers[id], given), { correct, reason });
    });
  }

  test("a wrong answer takes the errorCategory of the key and is counted", () => {
    const g = gradeRun(TASK, KEY, runWith({ final: { q5: "bob", q3: 4 } }));
    assert.equal(q(g, "q5").errorCategory, "wrong_relationship");
    assert.equal(q(g, "q3").errorCategory, "lost_progress");
    assert.deepEqual(g.continuityErrors, { lost_progress: 1, wrong_relationship: 1 });
    assert.equal(g.success, false);
    assert.equal(g.score, 0.6);
  });

  test("missing and malformed answers are wrong with the key category", () => {
    const g = gradeRun(TASK, KEY, runWith({ final: { q1: undefined, q2: "api", q4: "maybe" } }));
    assert.deepEqual([q(g, "q1").reason, q(g, "q2").reason, q(g, "q4").reason], ["missing", "malformed", "malformed"]);
    assert.equal(q(g, "q1").given, null);
    assert.deepEqual(g.continuityErrors, { forgotten_requirement: 1, invalid_transition: 1, obsolete_decision: 1 });
    const none = gradeRun(TASK, KEY, runWith({ final: null }));
    assert.equal(none.valid, true);
    assert.equal(none.score, 0);
    assert.ok(none.questions.every((x) => x.reason === "missing"));
  });
});

describe("stale values", () => {
  test("choice: a stale value is obsolete_decision, also for another key category", () => {
    assert.deepEqual(gradeAnswer(Q.q1, KEY.answers.q1, "PostgreSQL"), { correct: false, reason: "stale" });
    const key = structuredClone(KEY);
    key.answers.q1.errorCategory = "contradiction";
    const g = gradeRun(TASK, key, runWith({ final: { q1: " postgresql" } }));
    assert.equal(q(g, "q1").errorCategory, "obsolete_decision");
    assert.deepEqual(g.continuityErrors, { obsolete_decision: 1 });
  });

  test("set: a set with a stale member that is not in the value is obsolete_decision", () => {
    assert.deepEqual(gradeAnswer(Q.q2, KEY.answers.q2, ["api", "worker", "cron"]), { correct: false, reason: "stale" });
    assert.deepEqual(gradeAnswer(Q.q2, KEY.answers.q2, ["cron"]), { correct: false, reason: "stale" });
    // A wrong set without a stale member keeps the key category.
    const g = gradeRun(TASK, KEY, runWith({ final: { q2: ["api", "web"] } }));
    assert.equal(q(g, "q2").errorCategory, "forgotten_requirement");
  });

  test("set: a stale member that is also in the value is not stale; a whole stale set matches", () => {
    const k = { ...KEY.answers.q2, staleValues: ["api", ["api", "web"]] };
    assert.deepEqual(gradeAnswer(Q.q2, k, ["api"]), { correct: false, reason: "wrong_value" });
    assert.deepEqual(gradeAnswer(Q.q2, k, ["web", "API"]), { correct: false, reason: "stale" });
  });

  test("int and bool stale values", () => {
    assert.deepEqual(gradeAnswer(Q.q3, KEY.answers.q3, "2"), { correct: false, reason: "stale" });
    assert.deepEqual(gradeAnswer(Q.q4, KEY.answers.q4, "false"), { correct: false, reason: "stale" });
    const g = gradeRun(TASK, KEY, runWith({ final: { q3: 2, q4: false } }));
    assert.deepEqual(g.continuityErrors, { obsolete_decision: 2 });
  });
});

describe("clock text is never credited", () => {
  test("a [context-clock] block or a tick number in place of the value is wrong", () => {
    for (const [id, given] of [
      ["q1", "[context-clock] tick=12 events=30\nsqlite"],
      ["q1", "sqlite (tick=12)"],
      ["q3", "tick 3"],
      ["q3", "tick=3"],
      ["q4", "true [Context-Clock]"],
      ["q2", ["api", "worker", "[context-clock] state_rev=2"]],
    ]) {
      const r = gradeAnswer(Q[id], KEY.answers[id], given);
      assert.deepEqual(r, { correct: false, reason: "clock_text" }, JSON.stringify(given));
    }
    const g = gradeRun(TASK, KEY, runWith({ final: { q1: "[context-clock] sqlite" } }));
    assert.equal(q(g, "q1").correct, false);
    assert.equal(q(g, "q1").errorCategory, "obsolete_decision");
    assert.equal(g.success, false);
  });

  test("words like 'stick' or 'ticket' are not clock text", () => {
    assert.equal(holdsClockText("ticket 12"), false);
    assert.equal(holdsClockText("stick=3"), false);
    assert.equal(holdsClockText("Tick: 4"), true);
  });
});

describe("pre-compaction flags", () => {
  const flags = (g) => g.questions.map((x) => x.preCompaction);

  test("zero compactions: no question is pre-compaction", () => {
    const g = gradeRun(TASK, KEY, runWith({ compactions: [] }));
    assert.deepEqual(flags(g), [false, false, false, false, false]);
    assert.deepEqual(g.preCompaction, { questions: 0, correct: 0 });
  });

  test("one confirmed compaction after stage 2: questions established at stage 1 or 2", () => {
    const g = gradeRun(TASK, KEY, runWith({ final: { q2: ["api"] } }));
    assert.deepEqual(flags(g), [true, true, false, false, true]);
    assert.deepEqual(g.preCompaction, { questions: 3, correct: 2 });
  });

  test("two compactions: the first confirmed one decides", () => {
    const g = gradeRun(TASK, KEY, runWith({ compactions: [{ afterStage: 1, confirmed: true, mechanism: "m" }, { afterStage: 3, confirmed: true, mechanism: "m" }] }));
    assert.deepEqual(flags(g), [true, false, false, false, true]);
    assert.deepEqual(g.preCompaction, { questions: 2, correct: 2 });
  });

  test("an unconfirmed compaction never counts", () => {
    const only = gradeRun(TASK, KEY, runWith({ compactions: [{ afterStage: 3, confirmed: false, mechanism: "simulated hook" }] }));
    assert.deepEqual(flags(only), [false, false, false, false, false]);
    const then = gradeRun(TASK, KEY, runWith({ compactions: [{ afterStage: 1, confirmed: false, mechanism: "m" }, { afterStage: 3, confirmed: true, mechanism: "m" }] }));
    assert.deepEqual(flags(then), [true, true, true, false, true]);
  });

  test("profile long: always false, even with a confirmed compaction in the record", () => {
    const run = runWith({ taskId: "T2-long", profile: "long", checkpoint: null, compactions: [{ afterStage: 4, confirmed: true, mechanism: "m" }] });
    const g = gradeRun(LONG_TASK, LONG_KEY, run);
    assert.equal(g.valid, true, g.invalidReason);
    assert.deepEqual(flags(g), [false, false, false, false, false]);
    assert.deepEqual(g.preCompaction, { questions: 0, correct: 0 });
    assert.equal(g.checkpoint, null);
  });
});

describe("checkpoint", () => {
  test("checkpoint answers are graded against checkpointAnswers and do not change the score", () => {
    const g = gradeRun(TASK, KEY, runWith({ checkpoint: { c1: "sqlite", c2: "FALSE" } }));
    assert.deepEqual(g.checkpoint, { questions: 2, correct: 1 });
    assert.deepEqual(g.checkpointItems, [
      { id: "c1", type: "choice", correct: false, given: "sqlite", reason: "wrong_value" },
      { id: "c2", type: "bool", correct: true, given: "FALSE", reason: null },
    ]);
    assert.equal(g.score, 1);
    assert.deepEqual(g.continuityErrors, {});
  });

  test("a missing checkpoint answer block makes every checkpoint answer missing", () => {
    const g = gradeRun(TASK, KEY, runWith({ checkpoint: null }));
    assert.deepEqual(g.checkpointItems.map((i) => i.reason), ["missing", "missing"]);
    assert.equal(g.checkpoint.correct, 0);
  });
});

describe("validity and run status", () => {
  test("integrity violations make the run invalid with a reason, score 0 and no error counts", () => {
    const g = gradeRun(TASK, KEY, runWith({ integrity: { violations: [{ tool: "Bash", reason: "path outside workspace: /repo/benchmarks" }] }, final: { q1: "redis" } }));
    assert.equal(g.valid, false);
    assert.match(g.invalidReason, /^integrity: 1 violation\(s\), first: .*benchmarks/);
    assert.equal(g.success, false);
    assert.equal(g.score, 0);
    assert.deepEqual(g.continuityErrors, {});
    assert.equal(q(g, "q1").correct, false); // questions are still listed for the report
  });

  // limit_exceeded: EXPERIMENT-V03.md "Grading" (score 0, as timeout).
  for (const status of ["agent_failed", "timeout", "infra_failed", "limit_exceeded"]) {
    test("status " + status + ": success false, score 0, status kept", () => {
      const g = gradeRun(TASK, KEY, runWith({ status, final: status === "agent_failed" ? null : undefined }));
      assert.equal(g.status, status);
      assert.equal(g.valid, true);
      assert.equal(g.success, false);
      assert.equal(g.score, 0);
      assert.deepEqual(g.continuityErrors, {});
    });
  }

  const malformed = [
    ["null run", null, /run record is not an object/],
    ["string run", "oops", /run record is not an object/],
    ["schema 2", runWith({ schema: 2 }), /schema is not 1/],
    ["no runId", runWith({ runId: undefined }), /no runId/],
    ["unknown status", runWith({ status: "done" }), /run status/],
    ["other task", runWith({ taskId: "T9" }), /taskId does not match/],
    ["answers string", runWith({ answers: "x" }), /answers is not an object/],
    ["final list", runWith({ answers: { final: ["sqlite"], checkpoint: null } }), /final answers is not an object/],
    ["no integrity", runWith({ integrity: undefined }), /integrity\.violations is missing/],
    ["compactions object", runWith({ compactions: { afterStage: 2 } }), /compactions is not a list/],
  ];
  for (const [name, run, re] of malformed) {
    test("malformed run (" + name + ") gives an invalid grade, never a throw", () => {
      const g = gradeRun(TASK, KEY, run);
      assert.equal(g.valid, false);
      assert.match(g.invalidReason, re);
      assert.equal(g.success, false);
      assert.equal(g.score, 0);
      assert.deepEqual(g.questions, []);
    });
  }

  test("a key without an answer, or a task without questions, gives an invalid grade", () => {
    const key = structuredClone(KEY);
    delete key.answers.q3;
    assert.match(gradeRun(TASK, key, BASE).invalidReason, /key has no answer for q3/);
    assert.match(gradeRun({ ...TASK, final: {} }, KEY, BASE).invalidReason, /task final questions is not a list/);
    assert.match(gradeRun(TASK, { ...KEY, taskId: "X" }, BASE).invalidReason, /different taskId/);
    assert.match(gradeRun(undefined, undefined, BASE).invalidReason, /task is missing/);
  });

  test("a getter that throws inside the run record still gives an invalid grade", () => {
    const run = runWith();
    Object.defineProperty(run.answers, "final", { get() { throw new Error("boom"); } });
    const g = gradeRun(TASK, KEY, run);
    assert.equal(g.valid, false);
    assert.match(g.invalidReason, /grader could not read the input: boom/);
  });
});

describe("determinism", () => {
  test("the same input gives the same bytes, and the input is not changed", () => {
    const run = runWith({ final: { q1: "postgresql", q2: ["cron", "api"] }, checkpoint: { c1: "postgresql", c2: true } });
    const before = JSON.stringify([TASK, KEY, run]);
    const a = gradeJson(gradeRun(TASK, KEY, run));
    const b = gradeJson(gradeRun(structuredClone(TASK), structuredClone(KEY), structuredClone(run)));
    assert.equal(a, b);
    assert.equal(JSON.stringify([TASK, KEY, run]), before);
    assert.ok(a.endsWith("}\n"));
    assert.deepEqual(Object.keys(JSON.parse(a)), ["schema", "runId", "status", "valid", "invalidReason", "success", "score", "questions", "continuityErrors", "preCompaction", "checkpoint", "checkpointItems"]);
  });

  test("score is the exact fraction of correct final questions (CONTRACT.md)", () => {
    const task = structuredClone(TASK);
    const key = structuredClone(KEY);
    task.final.questions = [...task.final.questions, { id: "q6", type: "int" }];
    key.answers.q6 = { value: 1, aspect: "completed_work", establishedBy: [], staleValues: [], errorCategory: "repeated_work", firstEstablishedStage: 4 };
    const g = gradeRun(task, key, runWith({ final: { q6: 1, q5: "bob" } }));
    assert.equal(g.score, 5 / 6);
  });
});

describe("command: grade.mjs --batch", () => {
  function batchFolder() {
    const root = mkdtempSync(join(tmpdir(), "cc-grade-"));
    for (const d of ["tasks/generated", "tasks/keys"]) mkdirSync(join(root, d), { recursive: true });
    for (const id of ["T1-compact", "T2-long"]) {
      cpSync(join(FIX, id + ".task.json"), join(root, "tasks/generated", id + ".task.json"));
      cpSync(join(FIX, id + ".key.json"), join(root, "tasks/keys", id + ".key.json"));
    }
    const runs = {
      "mock__T1-compact__C__r1": runWith(),
      "mock__T1-compact__A__r1": runWith({ runId: "mock__T1-compact__A__r1", mode: "A", final: { q1: "postgresql" } }),
      "mock__T2-long__B__r1": runWith({ runId: "mock__T2-long__B__r1", taskId: "T2-long", profile: "long", checkpoint: null, compactions: [] }),
      "mock__T1-compact__B__r1": runWith({ runId: "mock__T1-compact__B__r1", status: "timeout", final: null }),
      "mock__T9-missing__C__r1": runWith({ runId: "mock__T9-missing__C__r1", taskId: "T9-missing" }),
    };
    for (const [id, run] of Object.entries(runs)) {
      mkdirSync(join(root, "results/b1/runs", id), { recursive: true });
      writeFileSync(join(root, "results/b1/runs", id, "run.json"), JSON.stringify(run, null, 2));
    }
    mkdirSync(join(root, "results/b1/runs/broken"), { recursive: true });
    writeFileSync(join(root, "results/b1/runs/broken/run.json"), "{ not json");
    mkdirSync(join(root, "results/b1/runs/unfinished"), { recursive: true }); // no run.json yet: skipped
    return root;
  }
  const grade = (root, ...args) => spawnSync(process.execPath, [GRADER, "--batch", "b1", "--root", root, ...args], { encoding: "utf8" });
  const read = (root, id) => JSON.parse(readFileSync(join(root, "results/b1/runs", id, "grade.json"), "utf8"));

  test("writes grade.json next to each run, prints one summary line, and is idempotent", () => {
    const root = batchFolder();
    try {
      const first = grade(root);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, "graded 6 runs in batch b1: valid 4, invalid 2, success 2, mean score 0.933 over 3 valid completed runs (written 6, unchanged 0)\n");
      assert.equal(read(root, "mock__T1-compact__C__r1").success, true);
      assert.equal(read(root, "mock__T1-compact__A__r1").continuityErrors.obsolete_decision, 1);
      assert.equal(read(root, "mock__T1-compact__B__r1").status, "timeout");
      assert.match(read(root, "mock__T9-missing__C__r1").invalidReason, /^task file is missing/);
      assert.equal(read(root, "broken").invalidReason, "run.json is not valid JSON");
      assert.equal(existsSync(join(root, "results/b1/runs/unfinished/grade.json")), false);

      const file = join(root, "results/b1/runs/mock__T1-compact__C__r1/grade.json");
      const bytes = readFileSync(file, "utf8");
      const mtime = statSync(file).mtimeMs;
      const second = grade(root);
      assert.equal(second.status, 0);
      assert.match(second.stdout, /\(written 0, unchanged 6\)\n$/);
      assert.equal(readFileSync(file, "utf8"), bytes);
      assert.equal(statSync(file).mtimeMs, mtime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors and a missing batch exit non-zero with one stderr line", () => {
    const root = batchFolder();
    try {
      const noBatch = spawnSync(process.execPath, [GRADER], { encoding: "utf8" });
      assert.equal(noBatch.status, 2);
      assert.match(noBatch.stderr, /^usage: /);
      const missing = spawnSync(process.execPath, [GRADER, "--batch", "nope", "--root", root], { encoding: "utf8" });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /no runs folder/);
      assert.equal(grade(root, "--bogus").status, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
