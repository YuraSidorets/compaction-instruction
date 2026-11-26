// Hand-made fixture batch for the analysis tests. Every number below is chosen by hand; the expected metrics in
// analysis.test.mjs are computed from this table by hand. The files follow the schemas in CONTRACT.md.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BATCH = "fixture-01";
export const HOST = "claude";

const QUESTIONS = ["q1", "q2", "q3", "q4"];
const ERROR_OF = { q1: "forgotten_requirement", q2: "obsolete_decision", q3: "wrong_relationship", q4: "lost_progress" };
const ASPECT_OF = { q1: "original_constraint", q2: "current_state", q3: "relationship", q4: "outstanding_work" };

export const TASKS = [
  { taskId: "A1-x", category: "A", profile: "long", approxBytes: 20000 },
  { taskId: "B1-y", category: "B", profile: "compaction", approxBytes: 60000 },
  { taskId: "C1-z", category: "C", profile: "long", approxBytes: 100000 },
];

/**
 * One row per run: [taskId, rep, mode, status, correct pattern or null, extra].
 * Scores: A1-x r1 A .5 B .75 C 1; A1-x r2 all 1; B1-y r1 A .25 B .5 C .75; B1-y r2 A agent_failed, B .5, C infra_failed;
 * C1-z r1 A .75 B timeout C 1; C1-z r2 all 1 but the C grade is invalid.
 */
export const RUNS = [
  ["A1-x", 1, "A", "completed", [1, 1, 0, 0]],
  ["A1-x", 1, "B", "completed", [1, 1, 1, 0]],
  ["A1-x", 1, "C", "completed", [1, 1, 1, 1]],
  ["A1-x", 2, "A", "completed", [1, 1, 1, 1]],
  ["A1-x", 2, "B", "completed", [1, 1, 1, 1]],
  ["A1-x", 2, "C", "completed", [1, 1, 1, 1]],
  ["B1-y", 1, "A", "completed", [1, 0, 0, 0]],
  ["B1-y", 1, "B", "completed", [1, 1, 0, 0]],
  ["B1-y", 1, "C", "completed", [1, 1, 1, 0]],
  ["B1-y", 2, "A", "agent_failed", null],
  ["B1-y", 2, "B", "completed", [1, 1, 0, 0]],
  ["B1-y", 2, "C", "infra_failed", null, { attempts: 3, failure: "rate limit" }],
  ["C1-z", 1, "A", "completed", [1, 1, 1, 0]],
  ["C1-z", 1, "B", "timeout", null],
  ["C1-z", 1, "C", "completed", [1, 1, 1, 1]],
  ["C1-z", 2, "A", "completed", [1, 1, 1, 1]],
  ["C1-z", 2, "B", "completed", [1, 1, 1, 1]],
  ["C1-z", 2, "C", "completed", [1, 1, 1, 1], { invalid: "integrity violation: path outside workspace" }],
];

const TELEMETRY = {
  A: { inputTokens: 1000, outputTokens: 100, durationMs: 1000, fbCount: 0, fbBytes: 0, commits: 0, status: 0 },
  B: { inputTokens: 1100, outputTokens: 100, durationMs: 1000, fbCount: 0, fbBytes: 0, commits: 0, status: 0 },
  C: { inputTokens: 1300, outputTokens: 100, durationMs: 1500, fbCount: 2, fbBytes: 400, commits: 1, status: 1 },
};

const answerOf = (taskId, q) => taskId + "-" + q + "-value";

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function taskJson(t) {
  return {
    schema: 1, taskId: t.taskId, category: t.category, seed: 1, profile: t.profile,
    params: { events: 40, entities: 3, updates: 4, dependencyDepth: 1, noiseRatio: 0.5, approxBytes: t.approxBytes },
    intro: "Intro.", stages: [],
    checkpoint: t.profile === "compaction" ? { afterStage: 1, questions: [] } : null,
    final: { questions: QUESTIONS.map((id) => ({ id, text: "Question " + id + "?", type: "choice", options: [answerOf(t.taskId, id), "wrong"] })) },
  };
}

function keyJson(t) {
  const answers = {};
  for (const q of QUESTIONS) {
    answers[q] = {
      value: answerOf(t.taskId, q), aspect: ASPECT_OF[q], establishedBy: ["e00" + q.slice(1)], staleValues: [],
      errorCategory: ERROR_OF[q], firstEstablishedStage: 1, lastChangedStage: 2,
    };
  }
  return {
    schema: 1, taskId: t.taskId, seed: 1,
    events: QUESTIONS.map((q, i) => ({ id: "e00" + q.slice(1), stage: i + 1, kind: "state", summary: "event for " + q + " | pipe" })),
    answers, checkpointAnswers: {},
  };
}

/** The attempt records of a run (run.json "attempts"): earlier attempts are infra failures, the last has the run status. */
function attemptList(status, n, failure) {
  return Array.from({ length: n }, (_, i) => ({ attempt: i + 1, status: i < n - 1 ? "infra_failed" : status, failure: i < n - 1 || status !== "completed" ? failure ?? status : null, durationMs: 1000 }));
}

function runJson([taskId, rep, mode, status, , extra = {}]) {
  const task = TASKS.find((t) => t.taskId === taskId);
  const tm = TELEMETRY[mode];
  return {
    schema: 1, runId: HOST + "__" + taskId + "__" + mode + "__r" + rep, batch: BATCH, host: HOST, taskId, mode, rep,
    profile: task.profile, order: 0, status, failure: extra.failure ?? null, attempts: attemptList(status, extra.attempts ?? 1, extra.failure),
    startedAt: "2026-11-22T16:00:00.000Z", durationMs: tm.durationMs,
    cli: { version: "2.1.330", model: "claude-haiku-5-5" },
    env: {}, sessionId: "s", turns: [],
    compactions: task.profile === "compaction" ? [{ afterStage: 1, confirmed: true, mechanism: "mock" }] : [],
    answers: { final: {}, checkpoint: null, finalParseError: null },
    telemetry: {
      inputTokens: tm.inputTokens, outputTokens: tm.outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolCalls: 10, toolCallsByName: {}, clockFeedbackCount: tm.fbCount, clockFeedbackBytes: tm.fbBytes,
      clock: { events: 5, maxTick: 3, stateRevision: tm.commits, statusCalls: tm.status, commitCalls: tm.commits }, searchCalls: 2,
    },
    integrity: { violations: extra.invalid ? [{ tool: "Read", reason: "outside" }] : [] },
  };
}

function gradeJson([taskId, rep, mode, status, pattern, extra = {}]) {
  const task = TASKS.find((t) => t.taskId === taskId);
  const done = status === "completed";
  const ok = QUESTIONS.map((_, i) => done && pattern[i] === 1);
  const compaction = task.profile === "compaction";
  const questions = QUESTIONS.map((id, i) => ({
    id, correct: ok[i], given: done ? (ok[i] ? answerOf(taskId, id) : "wrong") : null,
    aspect: ASPECT_OF[id], errorCategory: ERROR_OF[id], preCompaction: compaction && i < 2, establishedBy: ["e00" + id.slice(1)],
  }));
  const errors = {};
  if (done) questions.filter((q) => !q.correct).forEach((q) => { errors[q.errorCategory] = (errors[q.errorCategory] ?? 0) + 1; });
  const correct = ok.filter(Boolean).length;
  return {
    schema: 1, runId: HOST + "__" + taskId + "__" + mode + "__r" + rep,
    valid: extra.invalid === undefined, invalidReason: extra.invalid ?? null,
    success: done && correct === QUESTIONS.length, score: done ? correct / QUESTIONS.length : 0,
    questions, continuityErrors: errors,
    preCompaction: { questions: compaction ? 2 : 0, correct: compaction ? ok.slice(0, 2).filter(Boolean).length : 0 },
    checkpoint: compaction ? { questions: 2, correct: !done ? 0 : mode === "C" ? 2 : 1 } : null,
  };
}

/**
 * Writes the fixture into a new temp root. Options: `rows` replaces RUNS, `skipRuns` leaves run ids out,
 * `ungraded` writes no grade.json for these run ids, `batchJson` and `review` add those files.
 */
export function writeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-analysis-"));
  for (const t of TASKS) {
    writeJson(join(root, "tasks", "generated", t.taskId + ".task.json"), taskJson(t));
    writeJson(join(root, "tasks", "keys", t.taskId + ".key.json"), keyJson(t));
  }
  const batchDir = join(root, "results", BATCH);
  for (const row of opts.rows ?? RUNS) {
    const run = runJson(row);
    if ((opts.skipRuns ?? []).includes(run.runId)) continue;
    writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
    if (!(opts.ungraded ?? []).includes(run.runId)) writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(row));
  }
  if (opts.batchJson) writeJson(join(batchDir, "batch.json"), opts.batchJson);
  if (opts.review) writeJson(join(batchDir, "review.json"), opts.review);
  return root;
}
