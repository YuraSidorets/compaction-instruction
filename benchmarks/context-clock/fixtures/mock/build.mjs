// Builds the hand-written mock fixtures: two tasks, their keys, and recorded run transcripts.
// Run: node benchmarks/context-clock/fixtures/mock/build.mjs   (writes generated/, keys/, runs/ next to this file)
// The output is deterministic. tests/integration/fixtures.test.mjs checks that the committed files equal this output.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEARCH = "mcp__plugin_context-mode_context-mode__ctx_search";

// ---------- shared text helpers ----------

/** Deterministic filler log lines with no event label, so a feed passes 6000 bytes. */
function filler(prefix, lines) {
  const out = [];
  for (let i = 1; i <= lines; i++) {
    const s = String(i).padStart(3, "0");
    out.push(`10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} ${prefix} worker-${i % 4} heartbeat ok seq=${s} queue=${(i * 7) % 13}`);
  }
  return out.join("\n");
}

const stagePrompt = (n, files, feeds) => {
  const parts = [`Stage ${n}.`];
  for (const f of files) parts.push(`Read the file ${f.path}.`);
  for (const f of feeds) parts.push(`Run \`node feed.mjs ${f.name}\` and read its output.`);
  parts.push("Keep track of what changes. Reply with a short note when you are done.");
  return parts.join(" ");
};

function stage(n, files, feeds, eventIds, compactAfter) {
  return { stage: n, prompt: stagePrompt(n, files, feeds), files, feeds, eventIds, compactAfter };
}

const answer = (value, aspect, establishedBy, staleValues, errorCategory, firstEstablishedStage, lastChangedStage) =>
  ({ value, aspect, establishedBy, staleValues, errorCategory, firstEstablishedStage, lastChangedStage });

// ---------- task A0-mock-long (category A, profile long) ----------

const longFiles1 = [{ path: "inbox/s1/notes-01.md", content: [
  "# Orbit deployment notes, week 1",
  "[e001] Decision: the primary database is postgresql.",
  "[e002] Constraint from legal: the service must stay in the region eu-west.",
  "[e003] The coffee machine on floor 2 is broken again.",
].join("\n") }];
const longFeeds1 = [{ name: "s1-log", content: [
  filler("orbit", 110),
  "[e004] Config: the client uses a maximum retry count of 3.",
  filler("orbit-late", 40),
  "[e005] Note: the dashboard colors were changed to dark mode.",
].join("\n") }];
const longFiles2 = [{ path: "inbox/s2/notes-02.md", content: [
  "# Orbit deployment notes, week 2",
  "[e006] Decision: the primary database changes from postgresql to sqlite.",
  "[e007] The feature audit is now enabled.",
  "[e008] Team lunch moves to Thursday.",
].join("\n") }];
const longFeeds2 = [{ name: "s2-status", content: "[e009] Status: the feature export is now enabled.\nAll checks green." }];
const longFiles3 = [{ path: "inbox/s3/notes-03.md", content: [
  "# Orbit deployment notes, week 3",
  "[e010] Decision: the maximum retry count changes from 3 to 5.",
  "[e011] Rule: response caching is not allowed while the feature audit is enabled.",
  "[e012] The office plants were watered.",
].join("\n") }];

const longTask = {
  schema: 1,
  taskId: "A0-mock-long",
  category: "A",
  seed: 1,
  profile: "long",
  params: { events: 12, entities: 4, updates: 2, dependencyDepth: 1, noiseRatio: 0.33, approxBytes: 9000 },
  intro: "You help maintain the deployment plan of the Orbit service. Track decisions, constraints and their changes.",
  stages: [
    stage(1, longFiles1, longFeeds1, ["e001", "e002", "e003", "e004", "e005"], false),
    stage(2, longFiles2, longFeeds2, ["e006", "e007", "e008", "e009"], false),
    stage(3, longFiles3, [], ["e010", "e011", "e012"], false),
  ],
  checkpoint: null,
  final: { questions: [
    { id: "q1", text: "Which database is the primary store now?", type: "choice", options: ["postgresql", "sqlite", "redis", "none"] },
    { id: "q2", text: "Which features are enabled now?", type: "set", options: ["audit", "export", "search", "billing"] },
    { id: "q3", text: "What is the maximum retry count now?", type: "int" },
    { id: "q4", text: "Is response caching allowed now?", type: "bool" },
    { id: "q5", text: "Which region must the service stay in?", type: "choice", options: ["eu-west", "us-east", "ap-south"] },
  ] },
};

const longKey = {
  schema: 1,
  taskId: "A0-mock-long",
  seed: 1,
  events: [
    { id: "e001", stage: 1, kind: "state", summary: "primary database is postgresql" },
    { id: "e002", stage: 1, kind: "rule", summary: "service must stay in eu-west" },
    { id: "e003", stage: 1, kind: "noise", summary: "coffee machine broken" },
    { id: "e004", stage: 1, kind: "state", summary: "maximum retry count is 3" },
    { id: "e005", stage: 1, kind: "noise", summary: "dashboard dark mode" },
    { id: "e006", stage: 2, kind: "supersede", summary: "primary database changes to sqlite" },
    { id: "e007", stage: 2, kind: "state", summary: "feature audit enabled" },
    { id: "e008", stage: 2, kind: "noise", summary: "team lunch moves" },
    { id: "e009", stage: 2, kind: "state", summary: "feature export enabled" },
    { id: "e010", stage: 3, kind: "supersede", summary: "maximum retry count changes to 5" },
    { id: "e011", stage: 3, kind: "rule", summary: "no caching while audit is enabled" },
    { id: "e012", stage: 3, kind: "noise", summary: "plants watered" },
  ],
  answers: {
    q1: answer("sqlite", "current_state", ["e001", "e006"], ["postgresql"], "obsolete_decision", 1, 2),
    q2: answer(["audit", "export"], "completed_work", ["e007", "e009"], [], "lost_progress", 2, 2),
    q3: answer(5, "superseded_decision", ["e004", "e010"], [3], "obsolete_decision", 1, 3),
    q4: answer(false, "conditional_state", ["e007", "e011"], [], "invalid_transition", 3, 3),
    q5: answer("eu-west", "original_constraint", ["e002"], [], "forgotten_requirement", 1, 1),
  },
  checkpointAnswers: {},
};

// ---------- task D0-mock-compaction (category D, profile compaction) ----------

const cmpFiles1 = [{ path: "inbox/s1/brief.md", content: [
  "# Billing module brief",
  "[e001] The billing module is owned by team-red.",
  "[e002] Rule: deployments happen only in the friday window.",
  "[e003] The parking garage closes early on holidays.",
].join("\n") }];
const cmpFeeds1 = [{ name: "s1-audit", content: [
  filler("billing", 100),
  "[e004] Wiki page (last edited two years ago): the billing module is owned by team-blue.",
  filler("billing-late", 50),
  "[e005] Audit tool upgraded to version 9.",
].join("\n") }];
const cmpFeeds2 = [{ name: "s2-thread", content: [
  "[e006] Lead: the wiki is outdated. The billing module stays with team-red.",
  "[e007] Migration step-1 is done.",
].join("\n") }];
const cmpFiles3 = [{ path: "inbox/s3/update.md", content: [
  "# Update",
  "[e008] Decision: the deployment window changes from friday to tuesday.",
  "[e009] Migration step-2 is done.",
  "[e010] New chairs arrive next month.",
].join("\n") }];
const cmpFeeds4 = [{ name: "s4-tail", content: [
  "[e011] Review: the blue-green approach is rejected for billing.",
  "[e012] The build cache was cleared.",
].join("\n") }];

const cmpTask = {
  schema: 1,
  taskId: "D0-mock-compaction",
  category: "D",
  seed: 2,
  profile: "compaction",
  params: { events: 12, entities: 3, updates: 2, dependencyDepth: 1, noiseRatio: 0.33, approxBytes: 9500 },
  intro: "You help track the billing module migration. Sources can disagree. Keep the confirmed facts.",
  stages: [
    stage(1, cmpFiles1, cmpFeeds1, ["e001", "e002", "e003", "e004", "e005"], false),
    stage(2, [], cmpFeeds2, ["e006", "e007"], true),
    stage(3, cmpFiles3, [], ["e008", "e009", "e010"], false),
    stage(4, [], cmpFeeds4, ["e011", "e012"], false),
  ],
  checkpoint: { afterStage: 2, questions: [
    { id: "cq1", text: "Which team owns the billing module?", type: "choice", options: ["team-red", "team-blue", "team-green"] },
    { id: "cq2", text: "Is migration step-1 done?", type: "bool" },
  ] },
  final: { questions: [
    { id: "q1", text: "Which team owns the billing module?", type: "choice", options: ["team-red", "team-blue", "team-green"] },
    { id: "q2", text: "Which deployment window applies now?", type: "choice", options: ["friday", "tuesday", "monday"] },
    { id: "q3", text: "Which migration steps are done?", type: "set", options: ["step-1", "step-2", "step-3"] },
    { id: "q4", text: "Which approach was rejected?", type: "choice", options: ["blue-green", "canary", "rolling"] },
    { id: "q5", text: "How many of the three migration steps remain?", type: "int" },
  ] },
};

const cmpKey = {
  schema: 1,
  taskId: "D0-mock-compaction",
  seed: 2,
  events: [
    { id: "e001", stage: 1, kind: "state", summary: "billing owned by team-red" },
    { id: "e002", stage: 1, kind: "rule", summary: "deploy window friday" },
    { id: "e003", stage: 1, kind: "noise", summary: "garage closes early" },
    { id: "e004", stage: 1, kind: "conflict", summary: "outdated wiki says team-blue" },
    { id: "e005", stage: 1, kind: "noise", summary: "audit tool upgraded" },
    { id: "e006", stage: 2, kind: "state", summary: "lead confirms team-red" },
    { id: "e007", stage: 2, kind: "state", summary: "migration step-1 done" },
    { id: "e008", stage: 3, kind: "supersede", summary: "deploy window changes to tuesday" },
    { id: "e009", stage: 3, kind: "state", summary: "migration step-2 done" },
    { id: "e010", stage: 3, kind: "noise", summary: "new chairs" },
    { id: "e011", stage: 4, kind: "state", summary: "blue-green rejected" },
    { id: "e012", stage: 4, kind: "noise", summary: "build cache cleared" },
  ],
  answers: {
    q1: answer("team-red", "conflict_resolution", ["e001", "e004", "e006"], [], "contradiction", 1, 2),
    q2: answer("tuesday", "superseded_decision", ["e002", "e008"], ["friday"], "obsolete_decision", 1, 3),
    q3: answer(["step-1", "step-2"], "completed_work", ["e007", "e009"], [["step-1"]], "lost_progress", 2, 3),
    q4: answer("blue-green", "rejected_approach", ["e011"], [], "repeated_work", 4, 4),
    q5: answer(1, "outstanding_work", ["e007", "e009"], [2], "lost_progress", 2, 3),
  },
  checkpointAnswers: {
    cq1: answer("team-red", "conflict_resolution", ["e001", "e004", "e006"], [], "contradiction", 1, 2),
    cq2: answer(true, "completed_work", ["e007"], [], "lost_progress", 2, 2),
  },
};

// ---------- recorded turns ----------

const usage = (i, o) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: i * 3, cacheCreationTokens: 200 });
const fence = (obj) => "```json\n" + JSON.stringify(obj) + "\n```";
const SNAP = "[context-clock] tick 4, seq 9, state rev 0. Coverage: inbox files of this stage.";

function turnResult(sid, { text = "Done. Noted the changes.", tools = [], snapshots = null, timedOut = false, exitCode = 0, boundary = false, u = usage(1500, 120) } = {}) {
  return {
    exitCode: timedOut ? null : exitCode,
    timedOut,
    sessionId: sid,
    resultText: timedOut ? "" : text,
    usage: u,
    toolCalls: tools.map((name) => ({ name, isError: false })),
    streamPath: null,
    compactBoundary: boundary,
    clockSnapshots: snapshots ?? { count: 0, bytes: 0 },
  };
}

function stageTools(task, n) {
  const s = task.stages[n - 1];
  const tools = s.files.map(() => "Read");
  for (const f of s.feeds) {
    tools.push("Bash");
    if (Buffer.byteLength(f.content, "utf8") > 6000) tools.push(SEARCH);
  }
  return tools;
}

/**
 * One run transcript. opts: final (answers object, or a string for raw final text), checkpoint (answers), timeoutAt
 * (stage number whose turn times out), confirmed (compaction marker seen), violation (a tool input that leaves the
 * workspace), clockText (a [context-clock] line before the final JSON).
 */
function transcript(task, mode, rep, variant, opts, expect) {
  const sid = `mock-${task.taskId}-${mode}-r${rep}`;
  const snap = mode === "C" ? { count: 1, bytes: Buffer.byteLength(SNAP, "utf8") } : null;
  const turns = [{ kind: "intro", durationMs: 4000, result: turnResult(sid, { text: "Understood. Ready for stage 1.", u: usage(900, 40) }) }];
  for (const s of task.stages) {
    const n = s.stage;
    if (opts.timeoutAt === n) {
      turns.push({ kind: "stage", stage: n, durationMs: 600000, result: turnResult(sid, { timedOut: true, tools: stageTools(task, n).slice(0, 1) }) });
      return finish();
    }
    const entry = { kind: "stage", stage: n, durationMs: 20000 + n * 1000, result: turnResult(sid, { tools: stageTools(task, n), snapshots: snap }) };
    if (opts.violation && n === 1) {
      entry.result.toolCalls.push({ name: "Bash", isError: false });
      entry.stream = [{ type: "tool_use", name: "Bash", input: { command: opts.violation } }];
    }
    turns.push(entry);
    if (task.checkpoint && task.checkpoint.afterStage === n) {
      turns.push({ kind: "checkpoint", durationMs: 6000, result: turnResult(sid, { text: fence({ answers: opts.checkpoint }) }) });
    }
    if (s.compactAfter) {
      turns.push({ kind: "compact", afterStage: n, result: {
        confirmed: opts.confirmed !== false,
        mechanism: "/compact through claude -p --resume",
        exitCode: 0,
        durationMs: 15000,
        streamPath: null,
      } });
    }
  }
  const finalText = typeof opts.final === "string" ? opts.final : (opts.clockText ? SNAP + "\n\n" : "") + "Final answers:\n" + fence({ answers: opts.final });
  turns.push({ kind: "final", durationMs: 9000, result: turnResult(sid, { text: finalText, snapshots: snap, u: usage(2500, 200) }) });
  return finish();

  function finish() {
    return { schema: 1, fixture: "mock-run", taskId: task.taskId, mode, rep, variant, turns, expect };
  }
}

const longPerfect = { q1: "sqlite", q2: ["export", "audit"], q3: 5, q4: false, q5: "eu-west" };
const cmpPerfect = { q1: "team-red", q2: "tuesday", q3: ["step-1", "step-2"], q4: "blue-green", q5: 1 };
const cmpCheckpoint = { cq1: "team-red", cq2: true };
const KEY_PATH = "/home/user/repo/benchmarks/context-clock/tasks/keys/A0-mock-long.key.json";

const runs = [
  transcript(longTask, "A", 1, "perfect", { final: longPerfect },
    { status: "completed", valid: true, success: true, score: 1, continuityErrors: {}, preCompaction: { questions: 0, correct: 0 }, checkpoint: null }),
  transcript(longTask, "B", 1, "stale-answer", { final: { ...longPerfect, q1: "postgresql", q3: 3 } },
    { status: "completed", valid: true, success: false, score: 0.6, continuityErrors: { obsolete_decision: 2 }, preCompaction: { questions: 0, correct: 0 }, checkpoint: null }),
  transcript(longTask, "C", 1, "missing-answer", { final: { q1: "sqlite", q2: ["audit", "export"], q3: 5, q5: "eu-west" }, clockText: true },
    { status: "completed", valid: true, success: false, score: 0.8, continuityErrors: { invalid_transition: 1 }, preCompaction: { questions: 0, correct: 0 }, checkpoint: null }),
  transcript(longTask, "A", 2, "agent-failed", { final: "I could not keep track of the stages, sorry. No answers." },
    { status: "agent_failed", success: false, score: 0 }),
  transcript(longTask, "B", 2, "timeout", { timeoutAt: 2, final: longPerfect },
    { status: "timeout", success: false, score: 0 }),
  transcript(longTask, "C", 2, "integrity-violation", { final: longPerfect, violation: "cat " + KEY_PATH },
    { status: "completed", valid: false, success: false, integrityViolations: 1 }),
  transcript(cmpTask, "A", 1, "perfect-confirmed", { final: cmpPerfect, checkpoint: cmpCheckpoint, confirmed: true },
    { status: "completed", valid: true, success: true, score: 1, continuityErrors: {}, preCompaction: { questions: 4, correct: 4 }, checkpoint: { questions: 2, correct: 2 } }),
  transcript(cmpTask, "B", 1, "stale-pre-compaction", { final: { ...cmpPerfect, q2: "friday" }, checkpoint: cmpCheckpoint, confirmed: true },
    { status: "completed", valid: true, success: false, score: 0.8, continuityErrors: { obsolete_decision: 1 }, preCompaction: { questions: 4, correct: 3 }, checkpoint: { questions: 2, correct: 2 } }),
  transcript(cmpTask, "C", 1, "unconfirmed-compaction", { final: cmpPerfect, checkpoint: { cq1: "team-blue", cq2: true }, confirmed: false, clockText: true },
    { status: "completed", valid: true, success: true, score: 1, continuityErrors: {}, preCompaction: { questions: 0, correct: 0 }, checkpoint: { questions: 2, correct: 1 } }),
];

/** Every file the builder writes, as relative path -> text. */
export function buildFixtures() {
  const out = new Map();
  const json = (v) => JSON.stringify(v, null, 2) + "\n";
  for (const t of [longTask, cmpTask]) out.set("generated/" + t.taskId + ".task.json", json(t));
  for (const k of [longKey, cmpKey]) out.set("keys/" + k.taskId + ".key.json", json(k));
  for (const r of runs) out.set("runs/" + r.taskId + "__" + r.mode + "__r" + r.rep + ".json", json(r));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [rel, text] of buildFixtures()) {
    const p = join(HERE, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  console.log("wrote " + buildFixtures().size + " fixture files under " + HERE);
}
