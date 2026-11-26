// benchmarks/context-clock/tests/integration/fixtures.test.mjs
// Branch-local checks (they run before the merge): the contract validators, and the hand-written mock tasks, keys and
// run transcripts under fixtures/mock/. A small reference grader in this file recomputes each transcript's `expect`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateTask, validateKey, validateRun, validateGrade, validateSummary, answerFieldPaths, sameValue,
  MODES, MODE_ENV, TURN_KINDS, STATUSES, ERROR_CATEGORIES,
} from "../../fixtures/schema.mjs";
import { buildFixtures } from "../../fixtures/mock/build.mjs";
import { FIXTURES, MOCK_RUNS, jsonFiles, lastJsonAnswers, listFiles, readJson } from "./helpers.mjs";

const MOCK = join(FIXTURES, "mock");
const tasks = jsonFiles(join(MOCK, "generated"), ".task.json");
const keys = jsonFiles(join(MOCK, "keys"), ".key.json");
const runs = jsonFiles(MOCK_RUNS, ".json");
const taskOf = (id) => tasks.get(id + ".task.json");
const keyOf = (id) => keys.get(id + ".key.json");
const clone = (v) => structuredClone(v);

// ---------- a sample run record and grade in the contract shape ----------

function sampleRun(over = {}) {
  return {
    schema: 1, runId: "claude__A0-mock-long__C__r1", batch: "itest", host: "claude", taskId: "A0-mock-long", mode: "C", rep: 1,
    profile: "long", order: 3, status: "completed", failure: null, attempts: [{ attempt: 1, status: "completed", failure: null, durationMs: 70000 }], startedAt: "2026-11-22T16:00:00.000Z", durationMs: 70000,
    cli: { version: "2.1.330", model: "claude-haiku-5-5" }, env: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null }, sessionId: "s",
    turns: [
      { kind: "intro", exitCode: 0, timedOut: false, durationMs: 4000, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: 0 }, toolCalls: {}, clockSnapshots: { count: 0, bytes: 0 }, compactBoundary: false },
      { kind: "stage", stage: 1, exitCode: 0, timedOut: false, durationMs: 31000, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, toolCalls: { Read: 2, Bash: 3 }, clockSnapshots: { count: 1, bytes: 90 }, compactBoundary: false },
      { kind: "final", exitCode: 0, timedOut: false, durationMs: 9000, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, toolCalls: {}, clockSnapshots: { count: 0, bytes: 0 }, compactBoundary: false },
    ],
    compactions: [],
    answers: { final: { q1: "sqlite" }, checkpoint: null, finalParseError: null },
    telemetry: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 5, toolCallsByName: { Read: 2, Bash: 3 },
      clockFeedbackCount: 1, clockFeedbackBytes: 90, clock: { events: 4, maxTick: 3, stateRevision: 0, statusCalls: 0, commitCalls: 0 }, searchCalls: 0,
    },
    integrity: { violations: [] },
    ...over,
  };
}

function sampleGrade(over = {}) {
  return {
    schema: 1, runId: "claude__A0-mock-long__C__r1", valid: true, invalidReason: null, success: false, score: 0.5,
    questions: [
      { id: "q1", correct: false, given: "postgresql", aspect: "current_state", errorCategory: "obsolete_decision", preCompaction: false, establishedBy: ["e001", "e006"] },
      { id: "q2", correct: true, given: ["audit"], aspect: "completed_work", errorCategory: "lost_progress", preCompaction: false, establishedBy: ["e007"] },
    ],
    continuityErrors: { obsolete_decision: 1 }, preCompaction: { questions: 0, correct: 0 }, checkpoint: null,
    ...over,
  };
}

// ---------- validators ----------

describe("validators", () => {
  test("the mock tasks and keys are valid, alone and as pairs", () => {
    assert.equal(tasks.size, 2);
    for (const [name, t] of tasks) {
      assert.deepEqual(validateTask(t), [], name);
      assert.deepEqual(validateKey(keyOf(t.taskId)), [], name);
      assert.deepEqual(validateTask(t, keyOf(t.taskId)), [], name);
    }
  });

  test("validateTask finds each kind of task problem", () => {
    const t = taskOf("A0-mock-long");
    const cases = [
      ["bad category", (x) => { x.category = "F"; }, "category"],
      ["taskId without category", (x) => { x.taskId = "Z0-x"; }, "taskId"],
      ["bad profile", (x) => { x.profile = "short"; }, "profile"],
      ["bad question type", (x) => { x.final.questions[0].type = "text"; }, "type"],
      ["too few questions", (x) => { x.final.questions.length = 4; }, "5 to 8"],
      ["repeated question id", (x) => { x.final.questions[1].id = "q1"; }, "repeats question id"],
      ["choice without options", (x) => { delete x.final.questions[0].options; }, "options"],
      ["checkpoint on long", (x) => { x.checkpoint = { afterStage: 1, questions: [] }; }, "must be null"],
      ["stage numbers", (x) => { x.stages[1].stage = 5; }, "stage"],
      ["missing label", (x) => { x.stages[0].eventIds.push("e999"); }, "[e999]"],
      ["repeated event", (x) => { x.stages[1].eventIds.push("e001"); }, "repeats event"],
      ["no big feed", (x) => { x.stages[0].feeds[0].content = "[e004] x [e005] y"; }, "6000"],
      ["prompt misses a feed", (x) => { x.stages[0].prompt = "Stage 1. Read the file inbox/s1/notes-01.md."; }, "feed s1-log"],
      ["absolute file path", (x) => { x.stages[0].files[0].path = "/etc/notes.md"; }, "relative path"],
      ["answer leak", (x) => { x.final.answers = { q1: "sqlite" }; }, "answer-like"],
      ["compactAfter on long", (x) => { x.stages[0].compactAfter = true; }, "compactAfter"],
    ];
    for (const [label, edit, needle] of cases) {
      const x = clone(t);
      edit(x);
      const p = validateTask(x);
      assert.ok(p.some((m) => m.includes(needle)), label + ": " + JSON.stringify(p));
    }
    const c = clone(taskOf("D0-mock-compaction"));
    c.checkpoint = null;
    assert.ok(validateTask(c).some((m) => m.includes("checkpoint")));
    const c2 = clone(taskOf("D0-mock-compaction"));
    c2.stages.forEach((s) => { s.compactAfter = false; });
    assert.ok(validateTask(c2).some((m) => m.includes("one or two")));
    assert.deepEqual(validateTask(null), ["task: must be a JSON object"]);
  });

  test("validateKey finds each kind of key problem, also against its task", () => {
    const t = taskOf("A0-mock-long");
    const k = keyOf("A0-mock-long");
    const cases = [
      ["bad event kind", (x) => { x.events[0].kind = "fact"; }, "kind"],
      ["bad aspect", (x) => { x.answers.q1.aspect = "vibe"; }, "aspect"],
      ["bad error category", (x) => { x.answers.q1.errorCategory = "oops"; }, "errorCategory"],
      ["unknown event", (x) => { x.answers.q1.establishedBy = ["e777"]; }, "unknown event"],
      ["stale equals value", (x) => { x.answers.q1.staleValues = ["sqlite"]; }, "must not hold the answer"],
      ["value not an option", (x) => { x.answers.q1.value = "mysql"; }, "options"],
      ["int value not int", (x) => { x.answers.q3.value = "5"; }, "integer"],
      ["missing answer", (x) => { delete x.answers.q4; }, "no answer for q4"],
      ["extra answer", (x) => { x.answers.q9 = clone(x.answers.q1); }, "unknown question q9"],
      ["event stage mismatch", (x) => { x.events[0].stage = 2; }, "has stage"],
      ["event missing", (x) => { x.events.pop(); }, "missing from the key"],
      ["seed mismatch", (x) => { x.seed = 99; }, "seed"],
      ["stage after last", (x) => { x.answers.q1.lastChangedStage = 9; }, "after the last stage"],
      ["few aspects", (x) => { for (const a of Object.values(x.answers)) a.aspect = "current_state"; }, "aspects"],
    ];
    for (const [label, edit, needle] of cases) {
      const x = clone(k);
      edit(x);
      const p = validateKey(x, t);
      assert.ok(p.some((m) => m.includes(needle)), label + ": " + JSON.stringify(p));
    }
  });

  test("validateRun accepts the contract example shape and finds run problems", () => {
    assert.deepEqual(validateRun(sampleRun()), []);
    assert.deepEqual(validateRun(sampleRun({ attempts: [{ attempt: 1, status: "timeout", failure: { kind: "timeout", message: "turn timeout" }, durationMs: 1000 }, { attempt: 2, status: "completed", failure: null, durationMs: 1000 }] })), []);
    const cases = [
      ["bad mode", { mode: "X" }, "mode"],
      ["bad status", { status: "done" }, "status"],
      ["runId pattern", { runId: "claude__A0-mock-long__C__1" }, "runId"],
      ["mode C env", { env: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" } }, "CTX_CLOCK_FEEDBACK"],
      ["failure on completed", { failure: "x" }, "failure"],
      ["agent_failed retried", { status: "agent_failed", failure: "no answer", attempts: [{ attempt: 1, status: "agent_failed", failure: "no answer", durationMs: 1000 }, { attempt: 2, status: "agent_failed", failure: "no answer", durationMs: 1000 }], answers: { final: null, checkpoint: null, finalParseError: "no json" } }, "not retried"],
      ["completed without answers", { answers: { final: null, checkpoint: null, finalParseError: "x" } }, "answers.final"],
      ["too many attempts", { attempts: [1, 2, 3, 4].map((i) => ({ attempt: i, status: i < 4 ? "timeout" : "completed", failure: null, durationMs: 1 })) }, "attempts"],
      ["attempts as a count", { attempts: 1 }, "list of attempt records"],
      ["compaction on long", { compactions: [{ afterStage: 1, confirmed: true, mechanism: "m" }] }, "compaction"],
      ["violations not an array", { integrity: {} }, "violations"],
      ["bad turn kind", { turns: [{ ...sampleRun().turns[0], kind: "warmup" }, sampleRun().turns[2]] }, "kind"],
      ["negative usage", { turns: [{ ...sampleRun().turns[0], usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }, sampleRun().turns[2]] }, "inputTokens"],
    ];
    for (const [label, over, needle] of cases) {
      const p = validateRun(sampleRun(over));
      assert.ok(p.some((m) => m.includes(needle)), label + ": " + JSON.stringify(p));
    }
    const a = sampleRun({ runId: "claude__A0-mock-long__A__r1", mode: "A", env: { CTX_CLOCK: "1" } });
    assert.ok(validateRun(a).some((m) => m.includes("CTX_CLOCK must be null")));
    const aOk = sampleRun({ runId: "claude__A0-mock-long__A__r1", mode: "A", env: {}, telemetry: { ...sampleRun().telemetry, clockFeedbackCount: 0, clockFeedbackBytes: 0, clock: { events: 0, maxTick: 0, stateRevision: 0, statusCalls: 0, commitCalls: 0 } } });
    assert.deepEqual(validateRun(aOk), []);
    const bFeedback = sampleRun({ runId: "claude__A0-mock-long__B__r1", mode: "B", env: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" } });
    assert.ok(validateRun(bFeedback).some((m) => m.includes("mode B without clockFeedbackByChannel must have no snapshot")));
    // Mode B (feedback off) still gets the SessionStart state block (product behavior), never a tool reply or hook context.
    const ch = (tr, hc, ss) => ({ tool_reply: { count: tr, bytes: tr * 10 }, hook_context: { count: hc, bytes: hc * 10 }, session_start: { count: ss, bytes: ss * 10 }, other: { count: 0, bytes: 0 } });
    const bTel = (c) => ({ ...sampleRun().telemetry, clockFeedbackCount: c.tool_reply.count + c.hook_context.count + c.session_start.count, clockFeedbackBytes: (c.tool_reply.count + c.hook_context.count + c.session_start.count) * 10, clockFeedbackByChannel: c });
    const bRun = (c) => sampleRun({ runId: "claude__A0-mock-long__B__r1", mode: "B", env: { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }, telemetry: bTel(c) });
    assert.deepEqual(validateRun(bRun(ch(0, 0, 2))), []);
    assert.ok(validateRun(bRun(ch(1, 0, 2))).some((m) => m.includes("mode B (feedback off) gets no tool_reply snapshot")));
    assert.ok(validateRun(bRun(ch(0, 1, 0))).some((m) => m.includes("mode B (feedback off) gets no hook_context snapshot")));
    const aSnap = sampleRun({ runId: "claude__A0-mock-long__A__r1", mode: "A", env: {}, telemetry: { ...aOk.telemetry, clockFeedbackCount: 1, clockFeedbackBytes: 10 } });
    assert.ok(validateRun(aSnap).some((m) => m.includes("mode A gets no clock snapshot")));
    const sumBad = sampleRun({ telemetry: { ...sampleRun().telemetry, clockFeedbackCount: 5, clockFeedbackByChannel: ch(1, 0, 0) } });
    assert.ok(validateRun(sumBad).some((m) => m.includes("must add up to clockFeedbackCount")));
  });

  test("validateGrade accepts a correct grade and finds grade problems", () => {
    assert.deepEqual(validateGrade(sampleGrade(), sampleRun()), []);
    const cases = [
      ["score not a fraction", { score: 0.7 }, "fraction"],
      ["success with a wrong answer", { success: true }, "success"],
      ["bad error key", { continuityErrors: { oops: 1 } }, "continuityErrors"],
      ["invalid without reason", { valid: false, invalidReason: null }, "invalidReason"],
      ["pre count", { preCompaction: { questions: 2, correct: 1 } }, "preCompaction"],
      ["checkpoint correct > questions", { checkpoint: { questions: 1, correct: 2 } }, "checkpoint"],
      ["missing given", { questions: [{ id: "q1", correct: true, aspect: "current_state", errorCategory: "obsolete_decision", preCompaction: false, establishedBy: [] }], score: 1, success: true, continuityErrors: {} }, "given"],
    ];
    for (const [label, over, needle] of cases) {
      const p = validateGrade(sampleGrade(over), sampleRun());
      assert.ok(p.some((m) => m.includes(needle)), label + ": " + JSON.stringify(p));
    }
    assert.ok(validateGrade(sampleGrade(), sampleRun({ integrity: { violations: [{ tool: "Bash" }] } })).some((m) => m.includes("invalid")));
    assert.ok(validateGrade(sampleGrade(), sampleRun({ status: "timeout", failure: "t", answers: { final: null, checkpoint: null, finalParseError: null } })).some((m) => m.includes("score 0")));
    assert.ok(validateGrade(sampleGrade({ questions: sampleGrade().questions.map((q) => ({ ...q, preCompaction: true })), preCompaction: { questions: 2, correct: 1 } }), sampleRun()).some((m) => m.includes("profile long")));
    assert.ok(validateGrade(sampleGrade({ continuityErrors: { obsolete_decision: 2 } }), sampleRun()).some((m) => m.includes("must be 1")));
  });

  test("validateSummary checks the fields the contract fixes", () => {
    assert.deepEqual(validateSummary({ schema: 1, batch: "b", byMode: { A: { successRate: 0.5 }, B: {}, C: {} } }), []);
    assert.ok(validateSummary({ schema: 2 }).length > 0);
    assert.ok(validateSummary({ byMode: { X: {} } }).some((m) => m.includes("key")));
    assert.ok(validateSummary({ paired: { pValue: 0.01 } }).some((m) => m.includes("significance")));
    assert.ok(validateSummary([]).length > 0);
  });

  test("answerFieldPaths and sameValue", () => {
    assert.deepEqual(answerFieldPaths({ a: [{ Answers: 1 }], b: { staleValues: [] } }), ["$.a[0].Answers", "$.b.staleValues"]);
    assert.equal(sameValue(["a", "b"], ["b", "a"]), true);
    assert.equal(sameValue(["a", "b"], ["a"]), false);
    assert.equal(sameValue(["a", "a"], ["a", "b"]), false);
    assert.equal(sameValue(5, 5), true);
    assert.equal(sameValue(false, "false"), false);
  });

  test("the mode environment table matches the contract", () => {
    // Mode D: EXPERIMENT-V03.md "Modes". Modes E, F, G: EXPERIMENT-V04.md "Interfaces". Modes H, S: EXPERIMENT-V05.md "Arms".
    // Modes J, K, L: EXPERIMENT-V06.md "Interfaces". Modes N, T, P: EXPERIMENT-V07.md "Arms" (the trigger file comes from TRIGGER_ENV).
    assert.deepEqual(MODES, ["A", "B", "C", "D", "E", "F", "G", "H", "S", "J", "K", "L", "N", "T", "P", "U", "Q", "R", "V", "M", "O", "I", "Y", "Z", "W"]);
    assert.deepEqual(MODE_ENV.A, { CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null });
    assert.deepEqual(MODE_ENV.B, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
    assert.deepEqual(MODE_ENV.C, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null });
    assert.deepEqual(MODE_ENV.D, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null, CCB_FEEDBACK: "placebo" });
    assert.deepEqual(MODE_ENV.E, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
    assert.deepEqual(MODE_ENV.F, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "committed" });
    assert.deepEqual(MODE_ENV.G, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "reference" });
    assert.deepEqual(MODE_ENV.H, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" });
    assert.deepEqual(MODE_ENV.S, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
    assert.deepEqual(MODE_ENV.J, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
    assert.deepEqual(MODE_ENV.K, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" });
    assert.deepEqual(MODE_ENV.L, { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" });
    for (const m of ["N", "T", "P", "U", "Q", "R", "V", "M"]) assert.deepEqual(MODE_ENV[m], { CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }, m);
    for (const m of ["O", "I", "Z", "W"]) assert.deepEqual(MODE_ENV[m], { CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }, m);
  });
});

// ---------- the mock fixtures ----------

/** Reference grading of one transcript against its key (contract rules), for the fields that `expect` names. */
function referenceGrade(task, key, tr) {
  const final = tr.turns.find((t) => t.kind === "final");
  const timedOut = tr.turns.some((t) => t.result && t.result.timedOut === true);
  const violations = tr.turns.filter((t) => Array.isArray(t.stream) && t.stream.length > 0).length;
  if (timedOut) return { status: "timeout", success: false, score: 0 };
  const answers = final ? lastJsonAnswers(final.result.resultText) : null;
  if (answers === null) return { status: "agent_failed", success: false, score: 0 };
  const compactStage = tr.turns.find((t) => t.kind === "compact" && t.result.confirmed === true)?.afterStage ?? null;
  const errors = {};
  let correct = 0;
  let pre = 0;
  let preCorrect = 0;
  for (const q of task.final.questions) {
    const a = key.answers[q.id];
    const given = q.id in answers ? answers[q.id] : null;
    const ok = given !== null && sameValue(given, a.value);
    if (ok) correct++;
    else {
      const cat = a.staleValues.some((v) => sameValue(v, given)) ? "obsolete_decision" : a.errorCategory;
      errors[cat] = (errors[cat] ?? 0) + 1;
    }
    if (task.profile === "compaction" && compactStage !== null && a.firstEstablishedStage <= compactStage) {
      pre++;
      if (ok) preCorrect++;
    }
  }
  const n = task.final.questions.length;
  let checkpoint = null;
  if (task.checkpoint) {
    const cpTurn = tr.turns.find((t) => t.kind === "checkpoint");
    const cp = cpTurn ? lastJsonAnswers(cpTurn.result.resultText) ?? {} : {};
    const qs = task.checkpoint.questions;
    checkpoint = { questions: qs.length, correct: qs.filter((q) => q.id in cp && sameValue(cp[q.id], key.checkpointAnswers[q.id].value)).length };
  }
  const valid = violations === 0;
  return {
    status: "completed", valid, success: valid && correct === n, score: correct / n, continuityErrors: errors,
    preCompaction: { questions: pre, correct: preCorrect }, checkpoint, integrityViolations: violations,
  };
}

describe("mock fixtures", () => {
  test("the committed fixtures equal the builder output", () => {
    const built = buildFixtures();
    const committed = listFiles(MOCK).filter((p) => p !== "build.mjs");
    assert.deepEqual(committed, [...built.keys()].sort());
    for (const [rel, text] of built) assert.equal(readFileSync(join(MOCK, rel), "utf8"), text, rel);
  });

  test("every transcript has the documented layout", () => {
    assert.equal(runs.size, 9);
    for (const [name, tr] of runs) {
      assert.equal(tr.schema, 1, name);
      assert.equal(tr.fixture, "mock-run", name);
      assert.equal(name, tr.taskId + "__" + tr.mode + "__r" + tr.rep + ".json");
      assert.ok(taskOf(tr.taskId), name + ": unknown task");
      assert.ok(MODES.includes(tr.mode), name);
      assert.ok(STATUSES.includes(tr.expect.status), name);
      assert.ok(Array.isArray(tr.turns) && tr.turns.length > 0, name);
      assert.equal(tr.turns[0].kind, "intro", name);
      for (const t of tr.turns) {
        assert.ok(TURN_KINDS.includes(t.kind), name + ": kind " + t.kind);
        const r = t.result;
        if (t.kind === "compact") {
          assert.equal(typeof r.confirmed, "boolean", name);
          assert.equal(typeof r.mechanism, "string", name);
          assert.ok(Number.isInteger(t.afterStage), name);
          for (const k of ["exitCode", "durationMs", "streamPath"]) assert.ok(k in r, name + ": compact." + k);
          continue;
        }
        assert.ok(Number.isFinite(t.durationMs), name + ": durationMs");
        for (const k of ["exitCode", "timedOut", "sessionId", "resultText", "usage", "toolCalls", "streamPath", "compactBoundary", "clockSnapshots"]) assert.ok(k in r, name + ": result." + k);
        assert.ok(Array.isArray(r.toolCalls) && r.toolCalls.every((c) => typeof c.name === "string" && typeof c.isError === "boolean"), name);
        if (t.kind === "stage") assert.ok(Number.isInteger(t.stage), name);
        if (tr.mode !== "C") assert.equal(r.clockSnapshots.count, 0, name + ": only mode C gets snapshots");
      }
      for (const k of Object.keys(tr.expect.continuityErrors ?? {})) assert.ok(ERROR_CATEGORIES.includes(k), name);
    }
  });

  test("the transcripts cover every required case", () => {
    const variants = [...runs.values()].map((r) => r.variant).sort();
    assert.deepEqual(variants, ["agent-failed", "integrity-violation", "missing-answer", "perfect", "perfect-confirmed", "stale-answer", "stale-pre-compaction", "timeout", "unconfirmed-compaction"]);
    const all = [...runs.values()];
    for (const id of ["A0-mock-long", "D0-mock-compaction"]) {
      assert.deepEqual(all.filter((r) => r.taskId === id && r.rep === 1).map((r) => r.mode).sort(), ["A", "B", "C"], id + ": three modes");
    }
    const compacts = all.flatMap((r) => r.turns.filter((t) => t.kind === "compact").map((t) => t.result.confirmed));
    assert.ok(compacts.includes(true) && compacts.includes(false));
  });

  test("each transcript's expect block equals the reference grade", () => {
    for (const [name, tr] of runs) {
      const ref = referenceGrade(taskOf(tr.taskId), keyOf(tr.taskId), tr);
      for (const [k, v] of Object.entries(tr.expect)) assert.deepEqual(ref[k], v, name + ": expect." + k);
    }
  });

  test("clock text before the final JSON is not an answer", () => {
    const tr = runs.get("A0-mock-long__C__r1.json");
    const text = tr.turns.at(-1).result.resultText;
    assert.ok(text.includes("[context-clock]"));
    assert.equal(lastJsonAnswers(text).q1, "sqlite");
  });

  test("no mock task holds a key value under a question id", () => {
    for (const t of tasks.values()) {
      const k = keyOf(t.taskId);
      const ids = new Set(Object.keys(k.answers).concat(Object.keys(k.checkpointAnswers)));
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === "object") for (const [f, x] of Object.entries(v)) {
          if (ids.has(f)) assert.fail(t.taskId + ": field " + f + " in a task file");
          walk(x);
        }
      };
      walk(t);
    }
  });

  test("the transcript of the integrity case reads a key path; no other transcript leaves the workspace", () => {
    for (const [name, tr] of runs) {
      const streams = tr.turns.flatMap((t) => t.stream ?? []);
      if (tr.variant === "integrity-violation") assert.ok(streams.some((s) => JSON.stringify(s.input).includes("key.json")), name);
      else assert.equal(streams.length, 0, name);
    }
  });

  test("mock tasks validate through readJson as files on disk", () => {
    for (const id of ["A0-mock-long", "D0-mock-compaction"]) {
      assert.deepEqual(validateTask(readJson(join(MOCK, "generated", id + ".task.json")), readJson(join(MOCK, "keys", id + ".key.json"))), []);
    }
  });
});
