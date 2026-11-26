// Hand-made v0.3 fixture: one compaction task with a chunk list, modes B, C, D, and per-turn raw streams.
// The streams are written by hand so that each errorClass rule of EXPERIMENT-V03.md has one known case.
//
// Events: e001 (stage 0, intro), e010 (stage 1 file), e020 (stage 1 big feed, cut, never visible), e030 (stage 2 file,
// repeated in the compaction summary), e040 (stage 3 feed). Turns: intro, stage-1, stage-2, compact-2, checkpoint-2,
// stage-3, final. The last confirmed compaction is compact-2.
//
// Final questions and their needed events: q1 [e010], q2 [e020], q3 [e040], q4 [e030], q5 [e040]. Probe c1 [e010].
// Run C r1 answers: q1 wrong (compaction_recovery), q2 wrong (retrieval), q3 stale (state_tracking), q4 wrong
// (reasoning), q5 missing (indeterminate). Run D r1: only q2 wrong. Run B r1: all correct. Run B r2: limit_exceeded.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BATCH = "v03-fixture";
export const HOST = "claude";
export const TASK_ID = "A5-fixture";
export const TASK2_ID = "B5-fixture";

const Q = ["q1", "q2", "q3", "q4", "q5"];
const NEEDED = { q1: ["e010"], q2: ["e020"], q3: ["e040"], q4: ["e030"], q5: ["e040"] };
const VALUE = { q1: "alpha", q2: "beta", q3: "gamma", q4: "delta", q5: "epsilon" };

export function task(taskId = TASK_ID, category = "A") {
  return {
    schema: 1, taskId, category, seed: 7, profile: "compaction",
    params: { events: 5, entities: 2, updates: 1, dependencyDepth: 1, noiseRatio: 0.5, approxBytes: 60000 },
    intro: "Spec. [e001] The original rule.",
    stages: [
      { stage: 1, prompt: "Read inbox/s1/a.md and run node feed.mjs s1-big.", files: [], feeds: [], eventIds: ["e010", "e020"], compactAfter: false,
        chunks: [
          { chunkId: "s1-file-a", kind: "file", name: "inbox/s1/a.md", bytes: 120, events: ["e010"] },
          { chunkId: "s1-feed-big", kind: "feed", name: "s1-big", bytes: 9000, events: ["e020", "e021"] },
        ] },
      { stage: 2, prompt: "Read inbox/s2/b.md.", files: [], feeds: [], eventIds: ["e030"], compactAfter: true,
        chunks: [{ chunkId: "s2-file-b", kind: "file", name: "inbox/s2/b.md", bytes: 100, events: ["e030"] }] },
      { stage: 3, prompt: "Run node feed.mjs s3-log.", files: [], feeds: [], eventIds: ["e040"], compactAfter: false,
        chunks: [{ chunkId: "s3-feed-log", kind: "feed", name: "s3-log", bytes: 800, events: ["e040"] }] },
    ],
    checkpoint: { afterStage: 2, questions: [{ id: "c1", text: "c1?", type: "choice", options: ["alpha", "other"] }] },
    final: { questions: Q.map((id) => ({ id, text: id + "?", type: "choice", options: [VALUE[id], "old-" + id, "other"] })) },
  };
}

export function key(taskId = TASK_ID) {
  const answers = {};
  for (const id of Q) {
    answers[id] = { value: VALUE[id], aspect: "current_state", establishedBy: NEEDED[id], staleValues: ["old-" + id], errorCategory: "obsolete_decision", firstEstablishedStage: 1, lastChangedStage: 3 };
  }
  return {
    schema: 1, taskId, seed: 7,
    events: [
      { id: "e001", stage: 0, kind: "rule", summary: "original rule" },
      { id: "e010", stage: 1, kind: "state", summary: "q1 fact" },
      { id: "e020", stage: 1, kind: "state", summary: "q2 fact in the big feed" },
      { id: "e021", stage: 1, kind: "noise", summary: "noise" },
      { id: "e030", stage: 2, kind: "state", summary: "q4 fact" },
      { id: "e040", stage: 3, kind: "supersede", summary: "q3 and q5 fact" },
    ],
    answers,
    checkpointAnswers: { c1: { value: "alpha", aspect: "current_state", establishedBy: ["e010"], staleValues: [], errorCategory: "obsolete_decision", firstEstablishedStage: 1, lastChangedStage: 1 } },
  };
}

// ---- stream lines ----
const init = () => ({ type: "system", subtype: "init" });
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const say = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const done = () => ({ type: "result", subtype: "success" });

/** Per-turn streams. `mention` adds an assistant text that names the clock (C) or the placebo tag (D). */
export function streams(mode) {
  const mention = mode === "C" ? [say("The [context-clock] block says tick 4.")] : mode === "D" ? [say("There is a [context-note] line.")] : [];
  return {
    intro: [init(), say("Ready."), done()],
    "stage-1": [
      init(),
      use("t1", "Read", { file_path: "/ws/inbox/s1/a.md" }),
      result("t1", "1\t- [e010] q1 fact is alpha"),
      use("t2", "Bash", { command: "node feed.mjs s1-big" }),
      result("t2", "== big ==\n[e021] noise\nmcp__plugin_context-mode_context-mode__ctx_search({queries:[\"x\"], source:\"s1\"}) searches the whole output (9000 B)."),
      say("The feed output was truncated, I will search it."),
      use("t3", "mcp__plugin_context-mode_context-mode__ctx_search", { queries: ["beta"] }),
      result("t3", "No hits."),
      ...mention,
      done(),
    ],
    "stage-2": [init(), use("t4", "Read", { file_path: "/ws/inbox/s2/b.md" }), result("t4", "- [e030] q4 fact is delta"), done()],
    "compact-2": [
      init(), { type: "system", subtype: "compact_boundary" },
      { type: "user", message: { content: "This session is being continued. Summary: [e030] delta." } }, done(),
    ],
    "checkpoint-2": [init(), say("```json\n{\"answers\":{\"c1\":\"alpha\"}}\n```"), done()],
    "stage-3": [init(), use("t5", "Bash", { command: "node feed.mjs s3-log | head -5" }), result("t5", "[e040] q3 and q5 fact"), done()],
    final: [init(), say("answers"), done()],
  };
}

const TURNS = [
  { kind: "intro" }, { kind: "stage", stage: 1 }, { kind: "stage", stage: 2 }, { kind: "compact", stage: 2 },
  { kind: "checkpoint", stage: 2 }, { kind: "stage", stage: 3 }, { kind: "final" },
];

/** Answers per run: [taskId, mode, rep, status, answers or null, extra]. */
export const RUNS = [
  [TASK_ID, "B", 1, "completed", { q1: "alpha", q2: "beta", q3: "gamma", q4: "delta", q5: "epsilon" }, { guard: 1 }],
  [TASK_ID, "C", 1, "completed", { q1: "other", q2: "other", q3: "old-q3", q4: "other" }, {}],
  [TASK_ID, "D", 1, "completed", { q1: "alpha", q2: "other", q3: "gamma", q4: "delta", q5: "epsilon" }, { secondAttempt: true }],
  [TASK_ID, "B", 2, "limit_exceeded", null, { limitHit: "wallTime", unconfirmed: true }],
  [TASK_ID, "C", 2, "completed", { q1: "alpha", q2: "beta", q3: "gamma", q4: "delta", q5: "epsilon" }, {}],
  [TASK_ID, "D", 2, "completed", { q1: "alpha", q2: "beta", q3: "gamma", q4: "delta", q5: "epsilon" }, {}],
  [TASK2_ID, "B", 1, "completed", { q1: "alpha", q2: "other", q3: "gamma", q4: "delta", q5: "epsilon" }, {}],
  [TASK2_ID, "C", 1, "completed", { q1: "alpha", q2: "beta", q3: "gamma", q4: "delta", q5: "epsilon" }, {}],
  [TASK2_ID, "D", 1, "completed", { q1: "alpha", q2: "other", q3: "gamma", q4: "delta", q5: "epsilon" }, {}],
];

const SHIM = {
  B: { mcp_reply: { real: 0, placebo: 0, none: 4, bytes: 0 } },
  C: { mcp_reply: { real: 3, placebo: 0, none: 1, bytes: 900 }, hook_context: { real: 1, placebo: 0, none: 0, bytes: 600 } },
  D: { mcp_reply: { real: 0, placebo: 3, none: 1, bytes: 900 }, hook_context: { real: 0, placebo: 1, none: 0, bytes: 600 } },
};

function runJson([taskId, mode, rep, status, , extra]) {
  return {
    schema: 1, runId: HOST + "__" + taskId + "__" + mode + "__r" + rep, batch: BATCH, host: HOST, taskId, mode, rep,
    profile: "compaction", order: 0, status, failure: status === "completed" ? null : status,
    attempts: extra.secondAttempt ? [{ attempt: 1, status: "infra_failed" }, { attempt: 2, status }] : [{ attempt: 1, status }],
    durationMs: mode === "B" ? 1000 : 1200, cli: { version: "x", model: "m" }, env: {}, sessionId: "s",
    turns: TURNS.map((t) => ({ ...t })),
    compactions: [{ afterStage: 2, confirmed: extra.unconfirmed ? false : true, mechanism: "mock" }],
    limitHit: extra.limitHit ?? null,
    answers: { final: {}, checkpoint: null, finalParseError: null },
    telemetry: {
      inputTokens: mode === "B" ? 1000 : 1100, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: mode === "B" ? 5 : 6,
      toolCallsByName: {}, clockFeedbackCount: mode === "C" ? 4 : 0, clockFeedbackBytes: mode === "C" ? 1500 : 0,
      clock: { events: 3, maxTick: 2, stateRevision: 0, statusCalls: 0, commitCalls: 0 }, searchCalls: 1,
      shim: { byChannel: SHIM[mode], errors: 0 }, guard: { denied: extra.guard ?? 0, byTool: extra.guard ? { Read: extra.guard } : {} },
    },
    integrity: { violations: [] },
  };
}

function gradeJson([taskId, mode, rep, status, answers]) {
  const ok = status === "completed";
  const questions = Q.map((id) => {
    const given = ok && answers[id] !== undefined ? answers[id] : null;
    const correct = given === VALUE[id];
    const reason = correct ? null : given === null ? "missing" : given === "old-" + id ? "stale" : "wrong_value";
    return { id, type: "choice", correct, given, reason, aspect: "current_state", errorCategory: correct ? null : "obsolete_decision", preCompaction: id === "q1" || id === "q2", establishedBy: NEEDED[id] };
  });
  const correct = questions.filter((q) => q.correct).length;
  const pre = questions.filter((q) => q.preCompaction);
  return {
    schema: 1, runId: HOST + "__" + taskId + "__" + mode + "__r" + rep, status, valid: true, invalidReason: null,
    success: ok && correct === Q.length, score: ok ? correct / Q.length : 0, questions,
    continuityErrors: ok && correct < Q.length ? { obsolete_decision: Q.length - correct } : {},
    preCompaction: { questions: pre.length, correct: ok ? pre.filter((q) => q.correct).length : 0 },
    checkpoint: { questions: 1, correct: ok ? 1 : 0 },
    checkpointItems: [{ id: "c1", type: "choice", correct: ok, given: ok ? "alpha" : null, reason: ok ? null : "missing" }],
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeStreams(dir, mode) {
  for (const [label, lines] of Object.entries(streams(mode))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, label + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
}

/**
 * Writes the v0.3 fixture into a new temp root: tasks under tasks/v03, batch.json with modes and tasksDir, runs,
 * grades and raw streams. `rawElsewhere` puts the raw folder outside the batch (for --raw-dir).
 */
export function writeV03Fixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxclock-v03-"));
  for (const [id, cat] of [[TASK_ID, "A"], [TASK2_ID, "B"]]) {
    writeJson(join(root, "tasks", "v03", "generated", id + ".task.json"), task(id, cat));
    writeJson(join(root, "tasks", "v03", "keys", id + ".key.json"), key(id));
  }
  const batchDir = join(root, "results", BATCH);
  writeJson(join(batchDir, "batch.json"), { schema: 1, batch: BATCH, suite: "v03-full", modes: ["B", "C", "D"], tasksDir: "tasks/v03", ...(opts.batchExtra ?? {}) });
  const rawRoot = opts.rawElsewhere ? join(root, "elsewhere-raw") : join(batchDir, "raw");
  for (const row of RUNS) {
    const run = runJson(row);
    writeJson(join(batchDir, "runs", run.runId, "run.json"), run);
    writeJson(join(batchDir, "runs", run.runId, "grade.json"), gradeJson(row));
    const rawRun = join(rawRoot, run.runId);
    if (row[5].secondAttempt) {
      // Attempt 1 shows e020 in a tool result; only attempt 2 (the last) counts.
      mkdirSync(join(rawRun, "a1"), { recursive: true });
      writeFileSync(join(rawRun, "a1", "stage-1.jsonl"), JSON.stringify(result("x", "[e020] seen in the failed attempt")) + "\n", "utf8");
      writeStreams(join(rawRun, "a2"), row[1]);
    } else {
      writeStreams(join(rawRun, "a1"), row[1]);
    }
  }
  if (opts.review) writeJson(join(batchDir, "review.json"), opts.review);
  return { root, rawRoot };
}
