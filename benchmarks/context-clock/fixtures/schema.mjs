// Context Clock benchmark: contract validators (benchmarks/context-clock/CONTRACT.md, frozen by the lead).
// Plain functions. Each returns a list of problems; an empty list means valid. Node built-ins only, no import from src/.
// Owner: verification worker. Other workers and the lead may import these functions.

export const CATEGORIES = Object.freeze(["A", "B", "C", "D", "E"]);
export const PROFILES = Object.freeze(["long", "compaction"]);
export const QUESTION_TYPES = Object.freeze(["choice", "set", "int", "bool"]);
export const EVENT_KINDS = Object.freeze(["state", "supersede", "noise", "rule", "conflict"]);
export const ASPECTS = Object.freeze([
  "current_state", "original_constraint", "superseded_decision", "relationship", "conditional_state",
  "conflict_resolution", "outstanding_work", "completed_work", "rejected_approach",
]);
export const ERROR_CATEGORIES = Object.freeze([
  "forgotten_requirement", "obsolete_decision", "wrong_relationship", "invalid_transition", "contradiction",
  "lost_progress", "repeated_work",
]);
// limit_exceeded and mode D: EXPERIMENT-V03.md (it adds to CONTRACT.md and wins where the two differ).
export const STATUSES = Object.freeze(["completed", "agent_failed", "timeout", "infra_failed", "limit_exceeded"]);
export const MODES = Object.freeze(["A", "B", "C", "D", "E", "F", "G", "H", "S", "J", "K", "L", "N", "T", "P", "U", "Q", "R", "V", "M", "O", "I", "Y", "Z", "W"]);
export const LIMIT_NAMES = Object.freeze(["wallTime", "toolCalls", "totalTokens"]);
export const TURN_KINDS = Object.freeze(["intro", "stage", "checkpoint", "compact", "final"]);
export const HOSTS = Object.freeze(["claude", "codex", "mock"]);
export const FEEDBACK_CHANNELS = Object.freeze(["tool_reply", "hook_context", "session_start", "other"]);
/** The agent environment of each mode. null means: the variable is unset. */
export const MODE_ENV = Object.freeze({
  A: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  B: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  C: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null }),
  D: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: null, CCB_FEEDBACK: "placebo" }),
  // EXPERIMENT-V04.md: E (commit paragraph), F (commit paragraph and committed state), G (reference state).
  E: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  F: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "committed" }),
  G: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "reference" }),
  // EXPERIMENT-V05.md: H (state file paragraph, the file returned), S (compaction instruction).
  H: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" }),
  S: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V06.md: J (paragraph, no return), K (H, paragraph only before a compaction), L (J, the same sparse rule).
  J: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  K: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", CCB_RETURN_STATE: "file" }),
  L: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V07.md: N, T and P add a trigger file variable (runner/workspace.mjs TRIGGER_ENV), no returned state.
  N: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  T: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  P: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V08.md: U (periodic reminder) and Q (stronger PreCompact text), from TRIGGER_ENV.
  U: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  Q: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V09.md: R (general PreCompact text), from TRIGGER_ENV.
  R: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V10.md: V (variant PreCompact text), from TRIGGER_ENV.
  V: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // Context Clock v0.3 design "Acceptance with the benchmark" (arm C3): the product hook prints the PreCompact text.
  M: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // EXPERIMENT-V11.md: the plain arms O and I have no Context Mode plugin and no clock.
  O: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  I: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  // v0.11 isolated batches: Y has the clock on and the product compaction instruction off (CTX_CLOCK_COMPACT=off).
  Y: Object.freeze({ CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off" }),
  // v12 plain arms: Z loads the standalone plugin, W gets the text in the CLAUDE.md of the workspace.
  Z: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
  W: Object.freeze({ CTX_CLOCK: null, CTX_CLOCK_FEEDBACK: null }),
});
export const BIG_FEED_BYTES = 6000;
const USAGE_KEYS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]);
const PARAM_KEYS = Object.freeze(["events", "entities", "updates", "dependencyDepth", "noiseRatio", "approxBytes"]);

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => typeof v === "string" && v.length > 0;
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isBool = (v) => typeof v === "boolean";
const bytes = (s) => Buffer.byteLength(s, "utf8");

function checker(prefix) {
  const problems = [];
  const add = (path, msg) => problems.push((prefix ? prefix + ": " : "") + path + " " + msg);
  return { problems, add };
}

function enumCheck(add, path, v, list) {
  if (!list.includes(v)) add(path, "must be one of " + list.join(", ") + " (got " + JSON.stringify(v) + ")");
}

// ---------- task ----------

/**
 * Validates a task file (tasks/generated/<taskId>.task.json). With `key`, it also runs validateKey(key, task).
 * Checks the contract rules that one task can show: shape, enumerations, stage order, checkpoint by profile, 5 to 8
 * final questions, unique ids, event labels in the stage material, one feed above 6000 bytes, and that each stage
 * prompt names its files and feeds. A task never holds an answer field.
 */
export function validateTask(task, key) {
  const { problems, add } = checker(isObj(task) && isStr(task.taskId) ? task.taskId : "task");
  if (!isObj(task)) return ["task: must be a JSON object"];
  if (task.schema !== 1) add("schema", "must be 1");
  if (!isNonEmptyStr(task.taskId)) add("taskId", "must be a non-empty string");
  enumCheck(add, "category", task.category, CATEGORIES);
  if (isNonEmptyStr(task.taskId) && CATEGORIES.includes(task.category) && !task.taskId.startsWith(task.category)) {
    add("taskId", "must start with its category " + task.category);
  }
  if (!isInt(task.seed)) add("seed", "must be an integer");
  enumCheck(add, "profile", task.profile, PROFILES);
  if (!isObj(task.params)) add("params", "must be an object");
  else for (const k of PARAM_KEYS) if (!isNum(task.params[k])) add("params." + k, "must be a number");
  if (!isNonEmptyStr(task.intro)) add("intro", "must be a non-empty string");

  const stages = Array.isArray(task.stages) ? task.stages : [];
  if (!Array.isArray(task.stages) || stages.length === 0) add("stages", "must be a non-empty array");
  const eventIds = new Set();
  let bigFeed = false;
  let compactStages = 0;
  stages.forEach((s, i) => {
    const p = "stages[" + i + "]";
    if (!isObj(s)) return add(p, "must be an object");
    if (s.stage !== i + 1) add(p + ".stage", "must be " + (i + 1));
    if (!isNonEmptyStr(s.prompt)) add(p + ".prompt", "must be a non-empty string");
    if (!isBool(s.compactAfter)) add(p + ".compactAfter", "must be a boolean");
    if (s.compactAfter === true) compactStages++;
    const files = Array.isArray(s.files) ? s.files : (add(p + ".files", "must be an array"), []);
    const feeds = Array.isArray(s.feeds) ? s.feeds : (add(p + ".feeds", "must be an array"), []);
    let material = "";
    files.forEach((f, j) => {
      if (!isObj(f) || !isNonEmptyStr(f.path) || !isStr(f.content)) return add(p + ".files[" + j + "]", "must be {path, content}");
      if (f.path.startsWith("/") || f.path.includes("..") || f.path.includes(":") || f.path.includes("\\")) add(p + ".files[" + j + "].path", "must be a relative path inside the workspace");
      if (isStr(s.prompt) && !s.prompt.includes(f.path)) add(p + ".prompt", "does not name the file " + f.path);
      material += f.content + "\n";
    });
    const names = new Set();
    feeds.forEach((f, j) => {
      if (!isObj(f) || !isNonEmptyStr(f.name) || !isStr(f.content)) return add(p + ".feeds[" + j + "]", "must be {name, content}");
      if (names.has(f.name)) add(p + ".feeds[" + j + "].name", "is not unique in the stage");
      names.add(f.name);
      for (const ch of f.name) if (!/[A-Za-z0-9._-]/.test(ch)) { add(p + ".feeds[" + j + "].name", "must use only letters, digits, '.', '_' and '-'"); break; }
      if (isStr(s.prompt) && !s.prompt.includes(f.name)) add(p + ".prompt", "does not name the feed " + f.name);
      if (bytes(f.content) > BIG_FEED_BYTES) bigFeed = true;
      material += f.content + "\n";
    });
    const ids = Array.isArray(s.eventIds) ? s.eventIds : (add(p + ".eventIds", "must be an array"), []);
    for (const id of ids) {
      if (!isNonEmptyStr(id)) { add(p + ".eventIds", "must hold strings"); continue; }
      if (eventIds.has(id)) add(p + ".eventIds", "repeats event " + id);
      eventIds.add(id);
      if (!material.includes("[" + id + "]")) add(p, "material has no visible label [" + id + "]");
    }
  });
  if (stages.length > 0 && !bigFeed) add("stages", "need at least one feed above " + BIG_FEED_BYTES + " bytes");

  if (task.profile === "long") {
    if (task.checkpoint !== null) add("checkpoint", "must be null for the profile long");
    if (compactStages !== 0) add("stages", "profile long has no stage with compactAfter true");
  } else if (task.profile === "compaction") {
    if (compactStages < 1 || compactStages > 2) add("stages", "profile compaction needs one or two stages with compactAfter true");
    if (!isObj(task.checkpoint)) add("checkpoint", "must be an object for the profile compaction");
    else {
      const first = stages.findIndex((s) => isObj(s) && s.compactAfter === true) + 1;
      if (!isInt(task.checkpoint.afterStage) || task.checkpoint.afterStage < 1 || task.checkpoint.afterStage > stages.length) add("checkpoint.afterStage", "must be a stage number");
      else if (first > 0 && task.checkpoint.afterStage !== first) add("checkpoint.afterStage", "must be the stage of the first compaction (" + first + ")");
    }
  }
  const qids = new Set();
  const checkQuestions = (list, path) => {
    if (!Array.isArray(list)) return add(path, "must be an array");
    list.forEach((q, i) => {
      const p = path + "[" + i + "]";
      if (!isObj(q)) return add(p, "must be an object");
      if (!isNonEmptyStr(q.id)) add(p + ".id", "must be a non-empty string");
      else if (qids.has(q.id)) add(p + ".id", "repeats question id " + q.id);
      else qids.add(q.id);
      if (!isNonEmptyStr(q.text)) add(p + ".text", "must be a non-empty string");
      enumCheck(add, p + ".type", q.type, QUESTION_TYPES);
      if (q.type === "choice" || q.type === "set") {
        if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.every(isNonEmptyStr)) add(p + ".options", "must be at least two strings");
        else if (new Set(q.options).size !== q.options.length) add(p + ".options", "must be unique");
      }
    });
  };
  if (isObj(task.checkpoint)) checkQuestions(task.checkpoint.questions, "checkpoint.questions");
  if (!isObj(task.final)) add("final", "must be an object");
  else {
    checkQuestions(task.final.questions, "final.questions");
    const n = Array.isArray(task.final.questions) ? task.final.questions.length : 0;
    if (n < 5 || n > 8) add("final.questions", "must hold 5 to 8 questions (got " + n + ")");
  }
  for (const leak of answerFieldPaths(task)) add(leak, "is an answer-like field; a task holds no answer");
  if (key !== undefined) problems.push(...validateKey(key, task));
  return problems;
}

const ANSWER_FIELDS = Object.freeze([
  "answer", "answers", "checkpointanswers", "solution", "solutions", "expected", "correct", "key",
  "stalevalues", "establishedby", "errorcategory", "firstestablishedstage", "lastchangedstage",
]);

/** JSON paths of fields whose name looks like an answer or key data (answer, answers, solution, expected, staleValues, ...). */
export function answerFieldPaths(value, path = "$") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...answerFieldPaths(v, path + "[" + i + "]")));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (ANSWER_FIELDS.includes(k.toLowerCase())) out.push(path + "." + k);
      out.push(...answerFieldPaths(v, path + "." + k));
    }
  }
  return out;
}

// ---------- answers ----------

/** Problems of one answer value against its question (type, options). */
export function answerProblems(question, value) {
  switch (question.type) {
    case "choice": return isStr(value) && question.options.includes(value) ? [] : ["must be one of the options"];
    case "set":
      if (!Array.isArray(value) || !value.every(isStr)) return ["must be a list of strings"];
      if (!value.every((v) => question.options.includes(v))) return ["must use only the options"];
      return new Set(value).size === value.length ? [] : ["must not repeat a value"];
    case "int": return isInt(value) ? [] : ["must be an integer"];
    case "bool": return isBool(value) ? [] : ["must be a boolean"];
    default: return ["has an unknown question type"];
  }
}

// ---------- key ----------

/**
 * Validates a key file (tasks/keys/<taskId>.key.json). With `task`, it also checks the key against the task: the same
 * taskId and seed, one answer per final question and per checkpoint question, values that fit the question type,
 * events that match the stage event ids, and at least three aspects in the final answers.
 */
export function validateKey(key, task) {
  const { problems, add } = checker("key " + (isObj(key) && isStr(key.taskId) ? key.taskId : "?"));
  if (!isObj(key)) return ["key: must be a JSON object"];
  if (key.schema !== 1) add("schema", "must be 1");
  if (!isNonEmptyStr(key.taskId)) add("taskId", "must be a non-empty string");
  if (!isInt(key.seed)) add("seed", "must be an integer");
  const events = Array.isArray(key.events) ? key.events : (add("events", "must be an array"), []);
  const eventStage = new Map();
  events.forEach((e, i) => {
    const p = "events[" + i + "]";
    if (!isObj(e)) return add(p, "must be an object");
    if (!isNonEmptyStr(e.id)) add(p + ".id", "must be a non-empty string");
    else if (eventStage.has(e.id)) add(p + ".id", "repeats " + e.id);
    else eventStage.set(e.id, e.stage);
    // Stage 0 is the intro (the initial specification, tasks/README.md); stages 1..N are the task stages.
    if (!isInt(e.stage) || e.stage < 0) add(p + ".stage", "must be a stage number (0 = the intro)");
    enumCheck(add, p + ".kind", e.kind, EVENT_KINDS);
    if (!isNonEmptyStr(e.summary)) add(p + ".summary", "must be a non-empty string");
  });
  const checkAnswer = (a, p) => {
    if (!isObj(a)) return add(p, "must be an object");
    if (!("value" in a)) add(p + ".value", "is missing");
    enumCheck(add, p + ".aspect", a.aspect, ASPECTS);
    enumCheck(add, p + ".errorCategory", a.errorCategory, ERROR_CATEGORIES);
    if (!Array.isArray(a.establishedBy) || a.establishedBy.length === 0) add(p + ".establishedBy", "must be a non-empty list of event ids");
    else for (const id of a.establishedBy) if (!eventStage.has(id)) add(p + ".establishedBy", "names unknown event " + JSON.stringify(id));
    if (!Array.isArray(a.staleValues)) add(p + ".staleValues", "must be an array");
    else if (a.staleValues.some((v) => sameValue(v, a.value))) add(p + ".staleValues", "must not hold the answer value");
    if (!isInt(a.firstEstablishedStage) || a.firstEstablishedStage < 0) add(p + ".firstEstablishedStage", "must be a stage number (0 = the intro)");
    if (!isInt(a.lastChangedStage) || a.lastChangedStage < 0) add(p + ".lastChangedStage", "must be a stage number (0 = the intro)");
    if (isInt(a.firstEstablishedStage) && isInt(a.lastChangedStage) && a.lastChangedStage < a.firstEstablishedStage) add(p + ".lastChangedStage", "must not be before firstEstablishedStage");
  };
  const answers = isObj(key.answers) ? key.answers : (add("answers", "must be an object"), {});
  for (const [id, a] of Object.entries(answers)) checkAnswer(a, "answers." + id);
  const cp = isObj(key.checkpointAnswers) ? key.checkpointAnswers : (add("checkpointAnswers", "must be an object"), {});
  for (const [id, a] of Object.entries(cp)) checkAnswer(a, "checkpointAnswers." + id);

  if (isObj(task)) {
    if (key.taskId !== task.taskId) add("taskId", "differs from the task " + JSON.stringify(task.taskId));
    if (key.seed !== task.seed) add("seed", "differs from the task seed");
    const stageCount = Array.isArray(task.stages) ? task.stages.length : 0;
    const taskEvents = new Map();
    for (const s of Array.isArray(task.stages) ? task.stages : []) for (const id of isObj(s) && Array.isArray(s.eventIds) ? s.eventIds : []) taskEvents.set(id, s.stage);
    for (const [id, st] of eventStage) {
      if (st === 0) {
        if (taskEvents.has(id)) add("events", "event " + id + " has stage 0 (the intro) but the task puts it in stage " + taskEvents.get(id));
        else if (!(typeof task.intro === "string" && task.intro.includes("[" + id + "]"))) add("events", "intro event " + id + " has no [" + id + "] label in the task intro");
      } else if (!taskEvents.has(id)) add("events", "event " + id + " is in no task stage");
      else if (taskEvents.get(id) !== st) add("events", "event " + id + " has stage " + st + " but the task puts it in stage " + taskEvents.get(id));
    }
    for (const id of taskEvents.keys()) if (!eventStage.has(id)) add("events", "task event " + id + " is missing from the key");
    const pair = (questions, map, path) => {
      const ids = new Set();
      for (const q of Array.isArray(questions) ? questions : []) {
        if (!isObj(q)) continue;
        ids.add(q.id);
        const a = map[q.id];
        if (!isObj(a)) { add(path, "has no answer for " + q.id); continue; }
        for (const m of answerProblems(q, a.value)) add(path + "." + q.id + ".value", m);
        for (const v of Array.isArray(a.staleValues) ? a.staleValues : []) for (const m of answerProblems(q, v)) add(path + "." + q.id + ".staleValues", m);
        for (const f of ["firstEstablishedStage", "lastChangedStage"]) if (isInt(a[f]) && a[f] > stageCount) add(path + "." + q.id + "." + f, "is after the last stage");
      }
      for (const id of Object.keys(map)) if (!ids.has(id)) add(path, "answers unknown question " + id);
    };
    pair(isObj(task.final) ? task.final.questions : [], answers, "answers");
    pair(isObj(task.checkpoint) ? task.checkpoint.questions : [], cp, "checkpointAnswers");
    const aspects = new Set(Object.values(answers).filter(isObj).map((a) => a.aspect));
    if (aspects.size < 3) add("answers", "cover " + aspects.size + " aspects; the contract needs at least three");
  }
  return problems;
}

/** Answer equality as the grader defines it: a set answer matches as an exact set, the rest by strict equality. */
export function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = new Set(a);
    return sa.size === new Set(b).size && b.every((x) => sa.has(x)) && a.length === b.length;
  }
  return a === b;
}

// ---------- run ----------

function checkUsage(add, p, u) {
  if (!isObj(u)) return add(p, "must be an object");
  for (const k of USAGE_KEYS) if (!(u[k] === null || (isInt(u[k]) && u[k] >= 0))) add(p + "." + k, "must be a non-negative integer or null");
}

function checkCounts(add, p, m) {
  if (!isObj(m)) return add(p, "must be an object of counts");
  for (const [k, v] of Object.entries(m)) if (!isInt(v) || v < 0) add(p + "." + k, "must be a non-negative integer");
}

/**
 * Validates a run record (results/<batch>/runs/<runId>/run.json): shape, enumerations, the runId pattern
 * <host>__<taskId>__<mode>__r<rep>, the mode environment, turn records, answers, telemetry and integrity.
 */
export function validateRun(run) {
  const { problems, add } = checker("run " + (isObj(run) && isStr(run.runId) ? run.runId : "?"));
  if (!isObj(run)) return ["run: must be a JSON object"];
  if (run.schema !== 1) add("schema", "must be 1");
  for (const f of ["runId", "batch", "host", "taskId", "startedAt"]) if (!isNonEmptyStr(run[f])) add(f, "must be a non-empty string");
  if (isNonEmptyStr(run.host)) enumCheck(add, "host", run.host, HOSTS);
  enumCheck(add, "mode", run.mode, MODES);
  enumCheck(add, "profile", run.profile, PROFILES);
  enumCheck(add, "status", run.status, STATUSES);
  if (!isInt(run.rep) || run.rep < 1) add("rep", "must be a positive integer");
  if (isStr(run.runId) && run.runId !== run.host + "__" + run.taskId + "__" + run.mode + "__r" + run.rep) add("runId", "must be <host>__<taskId>__<mode>__r<rep>");
  if (!isInt(run.order) || run.order < 0) add("order", "must be a non-negative integer");
  if (run.status === "completed" && run.failure !== null) add("failure", "must be null for a completed run");
  if (run.status !== "completed" && STATUSES.includes(run.status) && (run.failure === null || run.failure === undefined)) add("failure", "must describe why the run is " + run.status);
  // attempts: the list of attempt records [{ attempt, status, failure, durationMs }] ("Every attempt stays in attempts").
  // A run that the host cannot execute (failure.kind "profile_not_executable") has no attempt.
  const notExecutable = isObj(run.failure) && run.failure.kind === "profile_not_executable";
  if (!Array.isArray(run.attempts)) add("attempts", "must be a list of attempt records");
  else {
    const n = run.attempts.length;
    if (!(n >= 1 && n <= 3) && !(n === 0 && notExecutable)) add("attempts", "must hold 1 to 3 attempt records");
    run.attempts.forEach((a, i) => {
      const p = "attempts[" + i + "]";
      if (!isObj(a)) return add(p, "must be an object");
      if (a.attempt !== i + 1) add(p + ".attempt", "must be " + (i + 1));
      enumCheck(add, p + ".status", a.status, STATUSES);
      if (!isNum(a.durationMs) || a.durationMs < 0) add(p + ".durationMs", "must be a non-negative number");
      if (i < n - 1 && (a.status === "agent_failed" || a.status === "completed" || a.status === "limit_exceeded")) add(p, a.status === "completed" ? "a completed attempt is not retried" : "an " + a.status + " run is not retried");
    });
    if (n > 0 && isObj(run.attempts[n - 1]) && run.attempts[n - 1].status !== run.status) add("attempts", "the last attempt must have the run status");
  }
  // limitHit (EXPERIMENT-V03.md, optional for older records): null, or the limit that stopped a limit_exceeded run.
  if (run.limitHit !== undefined && run.limitHit !== null) enumCheck(add, "limitHit", run.limitHit, LIMIT_NAMES);
  if (run.status === "limit_exceeded" && !LIMIT_NAMES.includes(run.limitHit)) add("limitHit", "must name the limit of a limit_exceeded run");
  if (run.status !== "limit_exceeded" && run.limitHit !== undefined && run.limitHit !== null) add("limitHit", "must be null unless the status is limit_exceeded");
  if (isStr(run.startedAt) && Number.isNaN(Date.parse(run.startedAt))) add("startedAt", "must be an ISO 8601 time");
  if (!isNum(run.durationMs) || run.durationMs < 0) add("durationMs", "must be a non-negative number");
  if (!isObj(run.cli) || !isStr(run.cli.version) || !isStr(run.cli.model)) add("cli", "must be {version, model}");
  problems.push(...envProblems(run).map((m) => "run " + run.runId + ": " + m));
  if (!(run.sessionId === null || isStr(run.sessionId))) add("sessionId", "must be a string or null");

  const turns = Array.isArray(run.turns) ? run.turns : (add("turns", "must be an array"), []);
  turns.forEach((t, i) => {
    const p = "turns[" + i + "]";
    if (!isObj(t)) return add(p, "must be an object");
    enumCheck(add, p + ".kind", t.kind, TURN_KINDS);
    if (t.kind === "stage" && (!isInt(t.stage) || t.stage < 1)) add(p + ".stage", "must be a stage number");
    if (!(t.exitCode === null || isInt(t.exitCode))) add(p + ".exitCode", "must be an integer or null");
    if (!isBool(t.timedOut)) add(p + ".timedOut", "must be a boolean");
    if (!isNum(t.durationMs) || t.durationMs < 0) add(p + ".durationMs", "must be a non-negative number");
    if (t.kind === "compact" && t.compactInstruction !== undefined && !isBool(t.compactInstruction)) add(p + ".compactInstruction", "must be a boolean");
    // EXPERIMENT-V06.md: costUsd is the cost of this turn (the increment of the host session total), or null.
    if (t.costUsd !== undefined && !(t.costUsd === null || (isNum(t.costUsd) && t.costUsd >= 0))) add(p + ".costUsd", "must be a non-negative number or null");
    if (t.kind !== "compact") {
      checkUsage(add, p + ".usage", t.usage);
      checkCounts(add, p + ".toolCalls", t.toolCalls);
      if (!isObj(t.clockSnapshots) || !isInt(t.clockSnapshots.count) || !isInt(t.clockSnapshots.bytes)) add(p + ".clockSnapshots", "must be {count, bytes}");
      if (!isBool(t.compactBoundary)) add(p + ".compactBoundary", "must be a boolean");
      // EXPERIMENT-V09.md: the context size after the turn (absent in older batches).
      if (t.contextTokens !== undefined && !(t.contextTokens === null || (isInt(t.contextTokens) && t.contextTokens >= 0))) add(p + ".contextTokens", "must be a non-negative integer or null");
    }
  });
  if (run.status === "completed" && !turns.some((t) => isObj(t) && t.kind === "final")) add("turns", "a completed run needs a final turn");
  const comps = Array.isArray(run.compactions) ? run.compactions : (add("compactions", "must be an array"), []);
  comps.forEach((c, i) => {
    if (!isObj(c) || !isInt(c.afterStage) || !isBool(c.confirmed) || !isStr(c.mechanism)) return add("compactions[" + i + "]", "must be {afterStage, confirmed, mechanism}");
    // EXPERIMENT-V06.md: the state file copy and the context size before the compaction (absent in older batches).
    const p = "compactions[" + i + "]";
    if (c.stateFileCopied !== undefined && !isBool(c.stateFileCopied)) add(p + ".stateFileCopied", "must be a boolean");
    if (c.stateFileBytes !== undefined && !(c.stateFileBytes === null || (isInt(c.stateFileBytes) && c.stateFileBytes >= 0))) add(p + ".stateFileBytes", "must be a non-negative integer or null");
    if (c.stateFileCopied === false && isInt(c.stateFileBytes)) add(p + ".stateFileBytes", "must be null without a copy");
    if (c.preTokens !== undefined && !(c.preTokens === null || (isInt(c.preTokens) && c.preTokens >= 0))) add(p + ".preTokens", "must be a non-negative integer or null");
    // EXPERIMENT-V09.md: the trigger kind (absent in older batches), the turn of an automatic one, the host trigger.
    if (c.trigger !== undefined && !["manual", "auto"].includes(c.trigger)) add(p + ".trigger", "must be manual or auto");
    if (c.turn !== undefined && !isStr(c.turn)) add(p + ".turn", "must be a turn label");
    if (c.hostTrigger !== undefined && !(c.hostTrigger === null || isStr(c.hostTrigger))) add(p + ".hostTrigger", "must be a string or null");
  });
  // EXPERIMENT-V09.md part 2: a long task can have automatic compactions of the host, never a manual one.
  if (run.profile === "long" && comps.some((c) => !isObj(c) || c.trigger !== "auto")) add("compactions", "profile long has no compaction");

  if (!isObj(run.answers)) add("answers", "must be an object");
  else {
    if (!(run.answers.final === null || isObj(run.answers.final))) add("answers.final", "must be an object or null");
    if (!(run.answers.checkpoint === null || isObj(run.answers.checkpoint))) add("answers.checkpoint", "must be an object or null");
    if (!(run.answers.finalParseError === null || isStr(run.answers.finalParseError))) add("answers.finalParseError", "must be a string or null");
    if (run.status === "completed" && run.answers.final === null) add("answers.final", "a completed run has a parsed final answer");
    if (run.status === "agent_failed" && isObj(run.answers.final)) add("answers.final", "an agent_failed run has no parsed final answer");
  }
  const tm = run.telemetry;
  if (!isObj(tm)) add("telemetry", "must be an object");
  else {
    for (const k of [...USAGE_KEYS, "toolCalls", "clockFeedbackCount", "clockFeedbackBytes", "searchCalls"]) if (!(tm[k] === null || (isInt(tm[k]) && tm[k] >= 0))) add("telemetry." + k, "must be a non-negative integer or null");
    checkCounts(add, "telemetry.toolCallsByName", tm.toolCallsByName);
    if (!isObj(tm.clock)) add("telemetry.clock", "must be an object");
    else for (const k of ["events", "maxTick", "stateRevision", "statusCalls", "commitCalls"]) if (!isInt(tm.clock[k]) || tm.clock[k] < 0) add("telemetry.clock." + k, "must be a non-negative integer");
    if (run.mode === "A" && isObj(tm.clock) && (tm.clock.events > 0 || tm.clock.maxTick > 0)) add("telemetry.clock", "mode A records no clock event");
    // EXPERIMENT-V04.md: telemetry.commits (from the stream) and telemetry.stateBlock (from the shim log, null without the overlay).
    if (tm.commits !== undefined) {
      const c = tm.commits;
      if (!isObj(c)) add("telemetry.commits", "must be an object");
      else {
        for (const k of ["calls", "ok", "stagesWithCommit", "stages"]) if (!isInt(c[k]) || c[k] < 0) add("telemetry.commits." + k, "must be a non-negative integer");
        if (!isObj(c.rejected)) add("telemetry.commits.rejected", "must be an object of counts by error code");
        else {
          checkCounts(add, "telemetry.commits.rejected", c.rejected);
          const rej = Object.values(c.rejected).reduce((a, b) => a + (isInt(b) ? b : 0), 0);
          if (isInt(c.calls) && isInt(c.ok) && c.ok + rej !== c.calls) add("telemetry.commits", "ok plus rejected must equal calls");
        }
        if (isInt(c.stagesWithCommit) && isInt(c.stages) && c.stagesWithCommit > c.stages) add("telemetry.commits.stagesWithCommit", "must not be above stages");
      }
    }
    // EXPERIMENT-V05.md: telemetry.stateFile (Write or Edit calls on clock-state.md, from the stream).
    if (tm.stateFile !== undefined) {
      const f = tm.stateFile;
      if (!isObj(f)) add("telemetry.stateFile", "must be an object");
      else {
        for (const k of ["writes", "stagesWithWrite", "stages"]) if (!isInt(f[k]) || f[k] < 0) add("telemetry.stateFile." + k, "must be a non-negative integer");
        if (isInt(f.stagesWithWrite) && isInt(f.stages) && f.stagesWithWrite > f.stages) add("telemetry.stateFile.stagesWithWrite", "must not be above stages");
        if (isInt(f.stagesWithWrite) && isInt(f.writes) && f.stagesWithWrite > f.writes) add("telemetry.stateFile.stagesWithWrite", "must not be above writes");
        // EXPERIMENT-V06.md: reads { total, afterCompaction } (absent in older batches).
        if (f.reads !== undefined) {
          const r = f.reads;
          if (!isObj(r) || !isInt(r.total) || r.total < 0 || !isInt(r.afterCompaction) || r.afterCompaction < 0) add("telemetry.stateFile.reads", "must be { total, afterCompaction } with non-negative integers");
          else if (r.afterCompaction > r.total) add("telemetry.stateFile.reads.afterCompaction", "must not be above total");
        }
        // EXPERIMENT-V07.md: writeStages, one stage number for each write in a stage turn (absent in older batches).
        if (f.writeStages !== undefined) {
          if (!Array.isArray(f.writeStages) || f.writeStages.some((n) => !isInt(n) || n < 1)) add("telemetry.stateFile.writeStages", "must be a list of stage numbers");
          else if (isInt(f.writes) && f.writeStages.length > f.writes) add("telemetry.stateFile.writeStages", "must not hold more entries than writes");
        }
      }
    }
    // EXPERIMENT-V08.md: telemetry.costUsd, the sum of the turn costs (null without a host cost, absent in older batches).
    if (tm.costUsd !== undefined && tm.costUsd !== null && !(typeof tm.costUsd === "number" && Number.isFinite(tm.costUsd) && tm.costUsd >= 0)) add("telemetry.costUsd", "must be a non-negative number or null");
    // EXPERIMENT-V07.md: telemetry.triggers (from the shim log, null without the overlay, absent in older batches).
    if (tm.triggers !== undefined && tm.triggers !== null) {
      const g = tm.triggers;
      const okCount = (v) => isInt(v) && v >= 0;
      const okNum = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
      if (!isObj(g)) add("telemetry.triggers", "must be an object or null");
      else {
        if (!isObj(g.standing) || !okCount(g.standing.deliveries)) add("telemetry.triggers.standing", "must be { deliveries } with a non-negative integer");
        if (!isObj(g.precompact) || !okCount(g.precompact.deliveries)) add("telemetry.triggers.precompact", "must be { deliveries } with a non-negative integer");
        // EXPERIMENT-V09.md: precompactByTrigger { manual, auto, unknown } (absent in older batches).
        const bt = g.precompactByTrigger;
        // Context Clock v0.3 (mode M): precompactProduct { calls, deliveries, bytes, sha256s, byTrigger } (absent in older batches).
        // EXPERIMENT-V11.md (mode I): precompactPlain { deliveries, bytes, sha256s, byTrigger } (absent in older batches).
        const pl = g.precompactPlain;
        if (pl !== undefined && (!isObj(pl) || !okCount(pl.deliveries) || !okCount(pl.bytes) || !Array.isArray(pl.sha256s) || pl.sha256s.length !== pl.deliveries
          || !pl.sha256s.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) || !isObj(pl.byTrigger) || !["manual", "auto", "unknown"].every((k) => okCount(pl.byTrigger[k]))
          || pl.byTrigger.manual + pl.byTrigger.auto + pl.byTrigger.unknown !== pl.deliveries)) {
          add("telemetry.triggers.precompactPlain", "must be { deliveries, bytes, sha256s, byTrigger } with one sha256 for each delivery");
        }
        // v12 (mode Z): precompactStandalone { calls, deliveries, bytes, sha256s, byTrigger, unobserved } (absent in older batches).
        const ps = g.precompactStandalone;
        if (ps !== undefined && (!isObj(ps) || !okCount(ps.calls) || !okCount(ps.deliveries) || !okCount(ps.bytes) || !okCount(ps.unobserved) || !Array.isArray(ps.sha256s)
          || ps.sha256s.length !== ps.deliveries || !ps.sha256s.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) || ps.unobserved > ps.calls
          || !isObj(ps.byTrigger) || !["manual", "auto", "unknown"].every((k) => okCount(ps.byTrigger[k]))
          || ps.byTrigger.manual + ps.byTrigger.auto + ps.byTrigger.unknown !== ps.deliveries)) {
          add("telemetry.triggers.precompactStandalone", "must be { calls, deliveries, bytes, sha256s, byTrigger, unobserved } with one sha256 for each delivery");
        }
        // hookRuns: the PreCompact runs of the plugin command in the host debug log, or null (absent in older batches).
        const hr = ps?.hookRuns;
        if (hr !== undefined && hr !== null && (!isObj(hr) || !["manual", "auto", "unknown", "nonZeroExit", "notCompleted"].every((k) => okCount(hr[k])))) {
          add("telemetry.triggers.precompactStandalone.hookRuns", "must be null or { manual, auto, unknown, nonZeroExit, notCompleted } with non-negative integers");
        }
        const pp = g.precompactProduct;
        if (pp !== undefined && (!isObj(pp) || !okCount(pp.calls) || !okCount(pp.deliveries) || !okCount(pp.bytes) || !Array.isArray(pp.sha256s)
          || pp.sha256s.length !== pp.deliveries || !pp.sha256s.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))
          || pp.deliveries > pp.calls || !isObj(pp.byTrigger) || !["manual", "auto", "unknown"].every((k) => okCount(pp.byTrigger[k]))
          || pp.byTrigger.manual + pp.byTrigger.auto + pp.byTrigger.unknown !== pp.deliveries)) {
          add("telemetry.triggers.precompactProduct", "must be { calls, deliveries, bytes, sha256s, byTrigger } with one sha256 for each delivery");
        }
        if (bt !== undefined && (!isObj(bt) || !["manual", "auto", "unknown"].every((k) => okCount(bt[k])))) add("telemetry.triggers.precompactByTrigger", "must be { manual, auto, unknown } with non-negative integers");
        const r = g.reminder;
        if (!isObj(r) || !okCount(r.unreadable) || !Array.isArray(r.fired)) add("telemetry.triggers.reminder", "must be { fired: [], unreadable }");
        else r.fired.forEach((x, i) => {
          if (!isObj(x) || !(x.turn === null || isStr(x.turn)) || !okNum(x.estimate) || !okNum(x.threshold)) add(`telemetry.triggers.reminder.fired[${i}]`, "must be { turn, estimate, threshold }");
        });
        // EXPERIMENT-V08.md: periodic { fired: [{ n, turn }], prompts } (absent in v0.7 batches).
        const pr = g.periodic;
        if (pr !== undefined) {
          if (!isObj(pr) || !okCount(pr.prompts) || !Array.isArray(pr.fired)) add("telemetry.triggers.periodic", "must be { fired: [], prompts }");
          else {
            pr.fired.forEach((x, i) => {
              if (!isObj(x) || !(x.n === null || (isInt(x.n) && x.n >= 1)) || !(x.turn === null || isStr(x.turn))) add(`telemetry.triggers.periodic.fired[${i}]`, "must be { n, turn }");
            });
            if (pr.fired.length > pr.prompts) add("telemetry.triggers.periodic.fired", "must not hold more entries than prompts");
          }
        }
      }
    }
    if (tm.stateBlock !== undefined && tm.stateBlock !== null) {
      const b = tm.stateBlock;
      if (!isObj(b)) add("telemetry.stateBlock", "must be an object or null");
      else {
        for (const k of ["deliveries", "missing", "bytes", "findings", "cuts"]) if (!isInt(b[k]) || b[k] < 0) add("telemetry.stateBlock." + k, "must be a non-negative integer");
        if (isInt(b.cuts) && isInt(b.deliveries) && b.cuts > b.deliveries) add("telemetry.stateBlock.cuts", "must not be above deliveries");
      }
    }
    // Mode A: no clock, so no snapshot. Mode B (feedback off): only the SessionStart state block, which the product
    // sends in every clock mode; the tool reply and hook context channels stay silent. Mode C: every channel.
    if (run.mode === "A" && isInt(tm.clockFeedbackCount) && tm.clockFeedbackCount > 0) add("telemetry.clockFeedbackCount", "mode A gets no clock snapshot");
    const ch = tm.clockFeedbackByChannel;
    if (ch !== undefined) {
      if (!isObj(ch)) add("telemetry.clockFeedbackByChannel", "must be an object");
      else {
        let n = 0;
        let b = 0;
        for (const [k, v] of Object.entries(ch)) {
          enumCheck(add, "telemetry.clockFeedbackByChannel key", k, FEEDBACK_CHANNELS);
          if (!isObj(v) || !isInt(v.count) || v.count < 0 || !isInt(v.bytes) || v.bytes < 0) add("telemetry.clockFeedbackByChannel." + k, "must be { count, bytes } with non-negative integers");
          else {
            n += v.count;
            b += v.bytes;
          }
        }
        if (isInt(tm.clockFeedbackCount) && n !== tm.clockFeedbackCount) add("telemetry.clockFeedbackByChannel", "counts must add up to clockFeedbackCount");
        if (isInt(tm.clockFeedbackBytes) && b !== tm.clockFeedbackBytes) add("telemetry.clockFeedbackByChannel", "bytes must add up to clockFeedbackBytes");
        if (MODE_ENV[run.mode]?.CTX_CLOCK_FEEDBACK === "off") for (const k of ["tool_reply", "hook_context"]) if (isObj(ch[k]) && ch[k].count > 0) add("telemetry.clockFeedbackByChannel." + k, "mode " + run.mode + " (feedback off) gets no " + k + " snapshot");
        if (run.mode === "D") for (const k of ["tool_reply", "hook_context"]) if (isObj(ch[k]) && ch[k].count > 0) add("telemetry.clockFeedbackByChannel." + k, "mode D (placebo) gets no real " + k + " snapshot");
      }
    } else if (MODE_ENV[run.mode]?.CTX_CLOCK_FEEDBACK === "off" && isInt(tm.clockFeedbackCount) && tm.clockFeedbackCount > 0) {
      add("telemetry.clockFeedbackCount", "mode " + run.mode + " without clockFeedbackByChannel must have no snapshot");
    }
  }
  if (!isObj(run.integrity) || !Array.isArray(run.integrity.violations)) add("integrity.violations", "must be an array");
  return problems;
}

/** Problems of run.env against the mode table of the contract. A missing key and null both mean: unset. */
export function envProblems(run) {
  const want = MODE_ENV[run.mode];
  if (want === undefined) return [];
  if (!isObj(run.env)) return ["env must be an object"];
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    const got = run.env[k] === undefined ? null : run.env[k];
    if (got !== v) out.push("env." + k + " must be " + JSON.stringify(v) + " in mode " + run.mode + " (got " + JSON.stringify(got) + ")");
  }
  return out;
}

// ---------- grade ----------

/** Validates a grade record (results/<batch>/runs/<runId>/grade.json). With `run`, it also checks the run rules. */
export function validateGrade(grade, run) {
  const { problems, add } = checker("grade " + (isObj(grade) && isStr(grade.runId) ? grade.runId : "?"));
  if (!isObj(grade)) return ["grade: must be a JSON object"];
  if (grade.schema !== 1) add("schema", "must be 1");
  if (!isNonEmptyStr(grade.runId)) add("runId", "must be a non-empty string");
  if (!isBool(grade.valid)) add("valid", "must be a boolean");
  if (grade.valid === true && grade.invalidReason !== null) add("invalidReason", "must be null for a valid run");
  if (grade.valid === false && !isNonEmptyStr(grade.invalidReason)) add("invalidReason", "must explain an invalid run");
  if (!isBool(grade.success)) add("success", "must be a boolean");
  if (!isNum(grade.score) || grade.score < 0 || grade.score > 1) add("score", "must be a number from 0 to 1");
  const qs = Array.isArray(grade.questions) ? grade.questions : (add("questions", "must be an array"), []);
  const ids = new Set();
  let correct = 0;
  const errors = {};
  qs.forEach((q, i) => {
    const p = "questions[" + i + "]";
    if (!isObj(q)) return add(p, "must be an object");
    if (!isNonEmptyStr(q.id)) add(p + ".id", "must be a non-empty string");
    else if (ids.has(q.id)) add(p + ".id", "repeats " + q.id);
    ids.add(q.id);
    if (!isBool(q.correct)) add(p + ".correct", "must be a boolean");
    if (q.correct === true) correct++;
    if (!("given" in q)) add(p + ".given", "is missing (use null for a missing answer)");
    enumCheck(add, p + ".aspect", q.aspect, ASPECTS);
    // errorCategory is the continuity error that a wrong answer shows (CONTRACT.md). A correct question has none (null).
    if (!(q.correct === true && q.errorCategory === null)) enumCheck(add, p + ".errorCategory", q.errorCategory, ERROR_CATEGORIES);
    if (!isBool(q.preCompaction)) add(p + ".preCompaction", "must be a boolean");
    if (!Array.isArray(q.establishedBy)) add(p + ".establishedBy", "must be an array");
    if (q.correct === false && ERROR_CATEGORIES.includes(q.errorCategory)) errors[q.errorCategory] = (errors[q.errorCategory] ?? 0) + 1;
  });
  if (grade.success === true && (qs.length === 0 || correct !== qs.length)) add("success", "is true only when every final question is correct");
  if (grade.success === false && qs.length > 0 && correct === qs.length && grade.score === 1 && grade.valid === true) add("success", "must be true when every question is correct");
  if (isNum(grade.score) && qs.length > 0 && grade.score !== 0 && Math.abs(grade.score - correct / qs.length) > 1e-9) add("score", "must be the fraction of correct questions (" + correct + "/" + qs.length + ")");
  if (!isObj(grade.continuityErrors)) add("continuityErrors", "must be an object");
  else {
    for (const [k, v] of Object.entries(grade.continuityErrors)) {
      enumCheck(add, "continuityErrors." + k, k, ERROR_CATEGORIES);
      if (!isInt(v) || v < 1) add("continuityErrors." + k, "must be a positive integer");
    }
  }
  const pair = (v, p, nullable) => {
    if (v === null && nullable) return;
    if (!isObj(v) || !isInt(v.questions) || !isInt(v.correct) || v.correct < 0 || v.correct > v.questions) add(p, "must be {questions, correct} with correct <= questions");
  };
  pair(grade.preCompaction, "preCompaction", false);
  pair(grade.checkpoint, "checkpoint", true);
  if (isObj(grade.preCompaction)) {
    const pre = qs.filter((q) => isObj(q) && q.preCompaction === true);
    if (grade.preCompaction.questions !== pre.length) add("preCompaction.questions", "must count the questions with preCompaction true");
  }
  if (isObj(run)) {
    if (grade.runId !== run.runId) add("runId", "differs from the run");
    if (run.status !== "completed" && (grade.success !== false || grade.score !== 0)) add("score", "a run that is not completed gets success false and score 0");
    if (Array.isArray(run.integrity?.violations) && run.integrity.violations.length > 0 && grade.valid !== false) add("valid", "a run with an integrity violation is invalid");
    if (run.profile === "long" && qs.some((q) => isObj(q) && q.preCompaction === true)) add("questions", "preCompaction is always false for the profile long");
    if (run.status === "completed" && grade.valid === true) {
      for (const [k, v] of Object.entries(errors)) if (isObj(grade.continuityErrors) && grade.continuityErrors[k] !== v) add("continuityErrors." + k, "must be " + v + " (the wrong questions)");
    }
  }
  return problems;
}

// ---------- summary ----------

/**
 * Validates results/<batch>/summary.json. The contract fixes its content, not its field names, so this checks only:
 * a JSON object, schema 1 when present, a batch name when present, mode keys from A, B, C wherever an object is keyed
 * by mode, finite numbers, and no significance claim (no field named like p-value or significant).
 */
export function validateSummary(summary) {
  const { problems, add } = checker("summary");
  if (!isObj(summary)) return ["summary: must be a JSON object"];
  if ("schema" in summary && summary.schema !== 1) add("schema", "must be 1");
  if ("batch" in summary && !isNonEmptyStr(summary.batch)) add("batch", "must be a non-empty string");
  const walk = (v, path) => {
    if (typeof v === "number" && !Number.isFinite(v)) add(path, "must be a finite number");
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + "[" + i + "]"));
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const lk = k.toLowerCase();
        if (lk === "pvalue" || lk === "p_value" || lk === "significant" || lk === "significance") add(path + "." + k, "is a significance claim; the analysis makes none");
        if ((lk === "mode" || lk === "modes") && isStr(x)) enumCheck(add, path + "." + k, x, MODES);
        if ((lk === "bymode" || lk === "permode" || lk === "modes") && isObj(x)) for (const m of Object.keys(x)) enumCheck(add, path + "." + k + " key", m, MODES);
        walk(x, path + "." + k);
      }
    }
  };
  walk(summary, "$");
  return problems;
}
