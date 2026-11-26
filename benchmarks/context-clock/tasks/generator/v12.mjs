#!/usr/bin/env node
// Context Clock v12 task sets for the standalone plan (docs/context-clock/PLAN-standalone.md, phase 1b and steps 2.1,
// 2.5 and 2.6). Package 1: tasks/v12 holds 10 tasks from new seeds of the three v0.9 shapes (4 old shape, 3 worklog,
// 3 decision), with the generator settings of tasks/v09 part 1. Keys and reference files have the v0.9 layout.
//
//   node benchmarks/context-clock/tasks/generator/v12.mjs [--set v12]             rewrite the files of a set
//   node benchmarks/context-clock/tasks/generator/v12.mjs [--set v12] --check     exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v12.mjs [--set v12] --freeze    write FROZEN.json (status candidate)
//   node benchmarks/context-clock/tasks/generator/v12.mjs [--set v12] --from-base search each seed from its base seed
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR } from "./generate.mjs";
import { fixKey } from "./keyfix.mjs";
import { computeAnswers, createMachine } from "./reference.mjs";
import { SIDE_IDS, V07_TASKS, rulesFor, sha256 } from "./v07.mjs";
import { V08_TASKS } from "./v08.mjs";
import { V09_DIFFICULTY, V09_TASKS, generateOneV09, isBlockQuestion, isReasonQuestionV09, nameValueLines } from "./v09.mjs";

// ---------------------------------------------------------------------------------------------------------------
// Pools of the third worklog task and the third decision task. The other new-shape tasks reuse the v0.9 pools.

const POOL_W3 = {
  items: ["AUTH-511", "AUTH-517", "AUTH-523", "AUTH-534", "AUTH-542", "AUTH-556", "AUTH-561", "AUTH-578", "AUTH-589"],
  owners: ["iwasaki", "jovanovic", "kowalczyk", "laurent", "mbeki", "novak", "oyelaran", "petrov"],
  files: ["services/auth/session.go", "services/auth/oidc_client.go", "services/auth/password_hash.go", "migrations/0107_user_identities.sql", "migrations/0108_drop_legacy_tokens.sql", "docs/auth/rollout-plan.md", "services/auth/mfa.go", "config/auth-providers.yaml"],
};

const POOL_X3 = {
  topics: [
    { id: "beta", label: "the beta channel", options: ["testflight-beta", "firebase-dist", "appcenter-beta", "play-internal"] },
    { id: "flags", label: "the feature flag service", options: ["launchdarkly-sdk", "unleash-oss", "flagsmith-oss", "growthbook-oss"] },
    { id: "mobileci", label: "the mobile CI service", options: ["bitrise-ci", "codemagic-ci", "circleci-mac", "buildkite-mac"] },
    { id: "analytics", label: "the product analytics tool", options: ["amplitude-sdk", "mixpanel-sdk", "posthog-oss", "heap-sdk"] },
    { id: "signing", label: "the code signing method", options: ["fastlane-match", "xcode-cloud", "manual-p12", "sigstore-mobile"] },
    { id: "staged", label: "the staged rollout tool", options: ["play-staged", "asc-phased", "custom-gate", "flag-gated"] },
    { id: "pct", label: "the first rollout share in percent", type: "int", options: [1, 2, 5, 10, 20] },
  ],
  reasons: ["why-crash-rate", "why-review-time", "why-team-skill", "why-sdk-size", "why-pricing", "why-privacy"],
  constraints: ["cn-no-new-sdks", "cn-ios-first", "cn-weekly-train", "cn-no-tracking", "cn-keep-min-os", "cn-freeze-strings"],
  questions: [
    { id: "oq-min-ios", options: ["ios-16-min", "ios-17-min", "ios-18-min"] },
    { id: "oq-tablet", options: ["tablet-launch", "tablet-later", "tablet-skip"] },
    { id: "oq-hotfix-owner", options: ["owner-mobile", "owner-release", "owner-qa"] },
    { id: "oq-dark-icons", options: ["icons-now", "icons-v2", "icons-skip"] },
    { id: "oq-beta-size", options: ["beta-500", "beta-2k", "beta-10k"] },
    { id: "oq-store-copy", options: ["copy-marketing", "copy-product", "copy-agency"] },
  ],
};

// Pools of the incident shape (package 2). Times sort as text in time order.
const TIMES_A = ["13:12", "13:19", "13:26", "13:34", "13:41", "13:48", "13:55", "14:03", "14:11", "14:18", "14:26", "14:33"];
const TIMES_B = ["02:07", "02:15", "02:22", "02:31", "02:38", "02:46", "02:53", "03:02", "03:09", "03:17", "03:24", "03:32"];

const POOL_T1 = {
  people: ["abara", "brandt", "cortes", "delacroix", "eriksen", "farouk", "gonzaga", "holm"],
  services: ["payments-api", "card-vault", "fraud-scorer", "payout-worker", "ledger-writer", "checkout-web", "refund-queue", "webhook-relay", "invoice-render", "fx-quoter"],
  times: TIMES_A,
  actions: ["act-failover-db", "act-drain-az2", "act-pause-payouts", "act-raise-pool", "act-revert-deploy", "act-block-retries"],
  causes: ["cause-db-lock-storm", "cause-bad-deploy", "cause-cert-expiry", "cause-dns-flap", "cause-pool-exhaustion", "cause-noisy-tenant"],
};

const POOL_T2 = {
  people: ["ikeda", "jansen", "kariuki", "lemaire", "mancini", "nordin", "osei", "pavlova"],
  services: ["login-web", "token-issuer", "session-store", "mfa-sender", "sso-bridge", "profile-api", "password-reset", "risk-engine", "audit-writer", "device-registry"],
  times: TIMES_B,
  actions: ["act-rotate-keys", "act-scale-sessions", "act-disable-sso", "act-flush-cache", "act-rollback-config", "act-throttle-mfa"],
  causes: ["cause-key-rotation", "cause-cache-stampede", "cause-idp-outage", "cause-config-typo", "cause-sms-gateway", "cause-clock-skew"],
};

// ---------------------------------------------------------------------------------------------------------------
// Specs. The new-shape specs copy a v0.9 spec and change the id, seed, pools and lead. The old-shape specs take the
// v0.7 or v0.8 spec of kind A or D with the v0.9 settings (side records, key fix, shape field).

const v09 = (id) => V09_TASKS.find((t) => t.taskId === id);
const SIDE = v09("A12-mobile-gateway").v03.side;
const W = v09("W12-ledger-migration");
const X = v09("X12-data-retention");

function old(from, kind, over) {
  const base = from.find((t) => t.kind === kind);
  return { ...base, size: "v12", shape: "old", v03: { side: SIDE }, fixKey, found: {}, ...over };
}

const like = (base, over) => ({ ...base, size: "v12", found: {}, bigFeedName: "activity", ...over });

export const V12_TASKS = [
  old(V07_TASKS, "A", { taskId: "A13-data-lakehouse", seed: 2100000, found: { 1: 2100060 },
    lead: "You help a data team choose the parts of a lakehouse and keep its requirements. Decisions and requirements change often as the trials report back." }),
  old(V08_TASKS, "A", { taskId: "A13-mobile-checkout", seed: 2125000, found: { 1: 2125017 },
    lead: "You help a mobile team choose the parts of a checkout backend and keep its requirements. Decisions and requirements change often as the trials report back." }),
  old(V07_TASKS, "D", { taskId: "D13-network-segments", seed: 2150000, found: { 1: 2150008 },
    lead: "You settle the network segment rules from security policies, architecture reviews, runbooks, chat threads and ticket comments." }),
  old(V08_TASKS, "D", { taskId: "D13-archive-policy", seed: 2175000, found: { 1: 2175005 },
    lead: "You settle an archive policy from storage standards, design documents, a platform handbook, Slack threads and Jira comments." }),
  like(W, { taskId: "W13-billing-cutover", seed: 2200000, found: { 1: 2200000 }, pools: v09("W12-ledger-migration").pools,
    lead: "You follow the work log of a team that moves billing to a new ledger. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." }),
  like(W, { taskId: "W13-catalog-search", seed: 2225000, found: { 1: 2225000 }, pools: v09("W12-shop-search").pools, bigFeedName: "audit",
    lead: "You follow the work log of a team that rebuilds the catalog search of a web shop. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." }),
  like(W, { taskId: "W13-auth-migration", seed: 2250000, found: { 1: 2250000 }, pools: POOL_W3, bigFeedName: "ops-log",
    lead: "You follow the work log of a team that moves user login to a new identity service. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." }),
  like(X, { taskId: "X13-log-retention", seed: 2275000, found: { 1: 2275000 }, pools: v09("X12-data-retention").pools,
    lead: "You keep the decision record of a log retention project. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." }),
  like(X, { taskId: "X13-cdn-cutover", seed: 2300000, found: { 1: 2300000 }, pools: v09("X12-cdn-migration").pools, bigFeedName: "audit",
    lead: "You keep the decision record of a cutover to a new content delivery network. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." }),
  like(X, { taskId: "X13-mobile-release", seed: 2325000, found: { 1: 2325000 }, pools: POOL_X3, bigFeedName: "ops-log",
    lead: "You keep the decision record of a new mobile release process. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." }),
];

/** Package 2: the independent shape, an incident timeline (kind T). The set tasks/v12-indep. */
export const V12_INCIDENT_TASKS = [
  like(W, { taskId: "T13-payments-outage", category: "T", kind: "T", shape: "incident", seed: 2350000, found: {}, pools: POOL_T1, actions: 6, updates: 46, minFacts: 15, entities: 4,
    lead: "You keep the timeline of a payments outage. People hand over the incident roles, the severity and the affected services change, mitigation actions run, and the root cause hypothesis changes as evidence comes in." }),
  like(W, { taskId: "T13-login-incident", category: "T", kind: "T", shape: "incident", seed: 2375000, found: {}, pools: POOL_T2, actions: 6, updates: 46, minFacts: 15, entities: 4, bigFeedName: "audit",
    lead: "You keep the timeline of a night incident in a login service. People hand over the incident roles, the severity and the affected services change, mitigation actions run, and the root cause hypothesis changes as evidence comes in." }),
];

// ---------------------------------------------------------------------------------------------------------------
// The harder set (tasks/v12-hard): 12 stages, compactions after stages 2, 4, 6, 8 and 10, about twice the tracked
// items and twice the changes for each stage, more distractors that name tracked items, and history questions of
// depth 3 or more. The old shape uses kind A and the reason kind F at difficulty 2, with the v0.7 and v0.8 pools of
// the kind merged. The new shapes merge two pools of the shape.

export const HARD_STAGES = 12;
export const HARD_COMPACT_AFTER = [2, 4, 6, 8, 10];
export const HARD_FINAL_MAX = 12;
/** Material target of one stage in bytes (a v0.9 stage holds about 12 000 bytes). */
export const HARD_STAGE_BYTES = 14000;

/** Changes for each stage: twice the rate of the v0.9 spec. */
const doubleRate = (updates) => Math.round((updates / 8) * 2 * HARD_STAGES);

/** The values of each single-value item in time order, repeats after a change included. */
function trails(story) {
  const order = story.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.stage - b.e.stage || a.i - b.i).map((x) => x.e);
  const m = createMachine(story.vars);
  const out = Object.fromEntries(Object.keys(story.vars).map((id) => [id, []]));
  for (const e of order) {
    m.apply(e.op);
    for (const id of Object.keys(story.vars)) {
      if (story.vars[id].type === "set") continue;
      const v = m.valueOf(id);
      if (v !== null && out[id].at(-1) !== v) out[id].push(v);
    }
  }
  return out;
}

/**
 * The hook of the harder set: adds history questions of depth 3 or more until the task has HARD_FINAL_MAX final
 * questions. One kind asks the value two values before the current value. The other asks every replaced value of an
 * item with at least 3 replaced values. Items with the longest history come first. It uses no random numbers.
 */
export function hardHook(story, p) {
  // Old shape: the builders of kind A and F change almost every item after an early first compaction. Three items
  // that a current-state question asks keep their value after the first compaction, as in the worklog and decision
  // builders: their changes after it are dropped, and an item with no change up to it gets its first later change
  // at the compaction stage. Items of history questions and the item of the first question are not used.
  if (p.shape === "old") {
    const early = p.compactAfter[0];
    const isState = (e) => ["set", "add", "remove"].includes(e.op.op) && e.stage > 0;
    const history = new Set(story.questions.filter((q) => !["value", "members"].includes(q.query.q)).map((q) => q.query.var));
    const frozen = story.questions
      .slice(1)
      .filter((q) => ["value", "members"].includes(q.query.q) && !history.has(q.query.var) && q.query.var !== story.questions[0].query.var)
      .map((q) => q.query.var)
      .slice(0, 3);
    for (const v of frozen) {
      const mine = story.events.filter((e) => e.op.var === v && isState(e));
      const late = mine.filter((e) => e.stage > early);
      if (mine.length === late.length && late.length > 0) late.shift().stage = early;
      for (const e of late) story.events.splice(story.events.indexOf(e), 1);
    }
  }
  const tr = trails(story);
  const key = (q, id, steps = "") => `${q}:${id}:${steps}`;
  const asked = new Set(story.questions.map((q) => key(q.query.q, q.query.var, q.query.steps ?? "")));
  const items = Object.entries(story.vars)
    .filter(([id, v]) => v.type !== "set" && v.type !== "bool" && !SIDE_IDS.has(id))
    .sort((a, b) => tr[b[0]].length - tr[a[0]].length || (a[0] < b[0] ? -1 : 1));
  const suffix = (id, v) => (v.type === "int" ? " Answer with a number." : id.startsWith("reason.") ? " Answer with the reason id." : "");
  for (let turn = 0; turn < 40 && story.questions.length < HARD_FINAL_MAX; turn += 1) {
    const back = turn % 2 === 0;
    // A value two values back must differ from the current value (a, b, a would read as a trick question).
    const pick = items.find(([id]) => (back ? tr[id].length >= 3 && String(tr[id].at(-3)) !== String(tr[id].at(-1)) && !asked.has(key("previous", id, 2)) : new Set(tr[id].map(String)).size >= 4 && !asked.has(key("superseded", id))));
    if (!pick) continue;
    const [id, v] = pick;
    if (back) {
      story.q({ text: `What was ${v.label} two values before its current value?${suffix(id, v)}`, type: v.type === "int" ? "int" : "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: id, steps: 2 } });
      asked.add(key("previous", id, 2));
    } else {
      story.q({ text: `Which values did ${v.label} have at some point that it does not have now? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: id } });
      asked.add(key("superseded", id));
    }
  }
}

/** A final question whose answer needs at least 3 values of one history. */
export function isDeepQuestion(q, answer) {
  if (q.query.q === "previous") return (q.query.steps ?? 1) >= 2;
  if (q.query.q === "superseded") return Array.isArray(answer.value) && answer.value.length >= 3;
  return false;
}

/**
 * Rules of the harder set. Fails with an error.
 * - 12 stages, compactions after stages 2, 4, 6, 8 and 10, one probe after each compaction.
 * - A tracked value changes in every stage, and at least one value is corrected or replaced.
 * - 10 to 12 final questions with a current-state and a history question, and at least 3 questions of depth 3 or more.
 * - The reason task and the decision tasks ask at least 3 reason questions, the worklog tasks ask what blocks what.
 * - The worklog and decision tasks have no "name: value" source line.
 */
export function validateHard(task, key, ref, spec) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (task.stages.length !== HARD_STAGES || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== HARD_COMPACT_AFTER.join()) fail("12 stages with compactions after 2, 4, 6, 8 and 10");
  if ((task.checkpoint.probes ?? []).map((p) => p.afterStage).join() !== HARD_COMPACT_AFTER.join()) fail("one probe after each compaction");
  const ids = Object.keys(ref.vars).filter((id) => !SIDE_IDS.has(id));
  const m = createMachine(ref.vars);
  const changedIn = new Set();
  let corrected = 0;
  for (const e of ref.events) {
    const before = JSON.stringify(ids.map((id) => m.valueOf(id)));
    m.apply(e.op);
    if (JSON.stringify(ids.map((id) => m.valueOf(id))) === before) continue;
    changedIn.add(e.stage);
    if (e.stage > 0 && key.events.find((x) => x.id === e.id).kind === "supersede") corrected += 1;
  }
  for (let s = 1; s <= HARD_STAGES; s += 1) if (!changedIn.has(s)) fail(`no state change in stage ${s}`);
  if (corrected === 0) fail("no corrected or replaced value");
  const qs = ref.questions;
  if (qs.length < 10 || qs.length > HARD_FINAL_MAX) fail(`final question count ${qs.length}`);
  const kinds = new Set(qs.map((x) => x.query.q));
  if (!["value", "members"].some((k) => kinds.has(k))) fail("no current-state question");
  if (!["initial", "superseded", "previous"].some((k) => kinds.has(k))) fail("no history question");
  const deep = qs.filter((x) => isDeepQuestion(x, key.answers[x.id])).length;
  if (deep < 3) fail(`only ${deep} questions of depth 3 or more`);
  for (const x of qs) if (x.query.q === "initial" && key.answers[x.id].firstEstablishedStage !== 0) fail(`${x.id}: initial value not in the specification`);
  for (const x of qs) if (x.query.q === "superseded" && key.answers[x.id].value.length === 0) fail(`${x.id}: no superseded value`);
  if ((spec.kind === "F" || spec.shape === "decision") && qs.filter(isReasonQuestionV09).length < 3) fail("fewer than 3 reason questions");
  if (spec.shape === "worklog" && qs.filter(isBlockQuestion).length < 2) fail("fewer than 2 questions about what blocks what");
  if (spec.shape !== "old") {
    const bad = nameValueLines(task, ref.vars);
    if (bad.length > 0) fail(`"name: value" source line: ${bad[0]}`);
  }
  if (JSON.stringify(task).includes("was not kept")) fail("an event leaves a run result open");
}

const HARD_COMMON = {
  size: "v12-hard",
  stages: HARD_STAGES,
  compactAfter: HARD_COMPACT_AFTER,
  group: { target: HARD_STAGES * HARD_STAGE_BYTES, minStage: 9000, bigFeeds: 3, bigBytes: [8000, 10000], distractors: 1.6 },
  range: [Math.round(HARD_STAGES * HARD_STAGE_BYTES * 0.86), Math.round(HARD_STAGES * HARD_STAGE_BYTES * 1.06)],
  limits: { final: [10, HARD_FINAL_MAX], stages: [HARD_STAGES, HARD_STAGES], bigFeeds: 3 },
  v03: { side: SIDE },
  fixKey,
  extraHook: hardHook,
  validate: validateHard,
  stateMaxBytes: 9000,
  found: {},
};

/** The v0.7 and v0.8 pools of one old kind, merged. */
function mergedOld(kind) {
  const a = V07_TASKS.find((t) => t.kind === kind).pools;
  const b = V08_TASKS.find((t) => t.kind === kind).pools;
  return { ...b, topics: [...a.topics, ...b.topics], extra: [...a.extra, ...b.extra] };
}

const mergeW = (a, b) => ({ items: [...a.items, ...b.items], owners: [...a.owners, ...b.owners], files: [...a.files, ...b.files] });
const mergeX = (a, b) => ({ topics: [...a.topics, ...b.topics], reasons: [...a.reasons, ...b.reasons], constraints: [...a.constraints, ...b.constraints], questions: [...a.questions, ...b.questions] });

const POOL_HA = mergedOld("A");
const POOL_HF = mergedOld("F");
const v08 = (kind) => V08_TASKS.find((t) => t.kind === kind);

export const V12_HARD_TASKS = [
  { ...v08("A"), shape: "old", ...HARD_COMMON, difficulty: 2, taskId: "A14-platform-program", seed: 2400000, pools: POOL_HA, entities: 2 * v08("A").entities, updates: doubleRate(v08("A").updates), minFacts: 28, focus: "warehouse",
    lead: "You help a platform team choose the parts of a data platform and a mobile backend in one program, and keep their requirements. Decisions and requirements change often as the trials report back." },
  { ...v08("F"), shape: "old", ...HARD_COMMON, difficulty: 2, taskId: "A14-media-observability", seed: 2425000, pools: POOL_HF, rules: rulesFor("F", POOL_HF.reasons), entities: 2 * v08("F").entities, updates: doubleRate(v08("F").updates), minFacts: 26, focus: "metrics",
    lead: "You help an SRE and media team choose an observability stack and a video pipeline in one program. Each main decision has a recorded reason, and both the decisions and their reasons change as the evaluations go on." },
  { ...W, ...HARD_COMMON, taskId: "W14-ledger-and-login", seed: 2450000, pools: mergeW(v09("W12-ledger-migration").pools, POOL_W3), entities: 12, files: 12, updates: doubleRate(W.updates), minFacts: 44,
    lead: "You follow the work log of a platform program that moves a ledger service to a new journal schema and user login to a new identity service. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." },
  { ...W, ...HARD_COMMON, taskId: "W14-search-and-ledger", seed: 2475000, pools: mergeW(v09("W12-shop-search").pools, v09("W12-ledger-migration").pools), entities: 12, files: 12, updates: doubleRate(W.updates), minFacts: 44, bigFeedName: "audit",
    lead: "You follow the work log of a program that rebuilds the search of a web shop and moves its ledger to a new journal schema. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." },
  { ...X, ...HARD_COMMON, taskId: "X14-retention-and-release", seed: 2500000, pools: mergeX(v09("X12-data-retention").pools, POOL_X3), entities: 12, reasons: 8, constraints: 10, questions: 10, updates: doubleRate(X.updates), minFacts: 36,
    lead: "You keep the decision record of a program with two workstreams, data retention and a new mobile release process. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." },
  { ...X, ...HARD_COMMON, taskId: "X14-edge-and-retention", seed: 2525000, pools: mergeX(v09("X12-cdn-migration").pools, v09("X12-data-retention").pools), entities: 12, reasons: 8, constraints: 10, questions: 10, updates: doubleRate(X.updates), minFacts: 36, bigFeedName: "ops-log",
    lead: "You keep the decision record of a program with two workstreams, a move to a new edge network and data retention. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." },
];

// ---------------------------------------------------------------------------------------------------------------
// The no-harm set (tasks/v12-noharm): the protocol and size of tasks/v12 (8 stages, compactions after stages 3, 5
// and 7), but no answer needs state from before a compaction. Every state event of an item that a final question
// asks moves to stage 8, after the last compaction, in its order. The other items change in stages 1 to 7 as usual,
// so each compaction has state to summarize that no question needs. The tasks have no probe: a probe follows a
// compaction directly, so its answer would need state from before that compaction.

export const NOHARM_LAST = 8;

/** The variables that a question reads. */
const varsOf = (q) => [q.query.var, ...(q.query.vars ?? [])].filter((x) => typeof x === "string");

/**
 * The hook of the no-harm set. Questions over many items (for example "which items are done") are dropped, because
 * they would move most of the task to stage 8. A question about the first value gets a text without "specification"
 * or "first page". Every event of an asked item moves to stage 8 in its order. Then history questions about the asked
 * items fill the task up to 8 final questions. It uses no random numbers.
 */
export function noharmHook(story) {
  for (let i = story.questions.length - 1; i >= 0; i -= 1) if (story.questions[i].query.vars) story.questions.splice(i, 1);
  for (const q of story.questions) {
    const v = story.vars[q.query.var];
    if (q.query.q === "initial") q.text = `What was the first value of ${v.label} in the material?${v.type === "int" ? " Answer with a number." : ""}`;
  }
  const asked = new Set(story.questions.flatMap(varsOf));
  for (const e of story.events) {
    if (e.stage >= NOHARM_LAST || e.kind === "noise") continue;
    if ([e.op.var, ...(e.op.vars ?? [])].some((v) => asked.has(v))) e.stage = NOHARM_LAST;
  }
  const tr = trails(story);
  const has = (q, id) => story.questions.some((x) => x.query.q === q && x.query.var === id);
  const suffix = (id, v) => (v.type === "int" ? " Answer with a number." : id.startsWith("reason.") ? " Answer with the reason id." : "");
  for (const id of [...asked].sort()) {
    if (story.questions.length >= 8) break;
    const v = story.vars[id];
    if (v.type === "set" || v.type === "bool" || tr[id].length < 2) continue;
    if (!has("previous", id)) story.q({ text: `What was ${v.label} directly before its current value?${suffix(id, v)}`, type: v.type === "int" ? "int" : "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: id } });
    else if (!has("superseded", id)) story.q({ text: `Which values did ${v.label} have at some point that it does not have now? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: id } });
  }
  story.questions.forEach((q, i) => (q.id = `q${i + 1}`));
}

/**
 * Rules of the no-harm set. Fails with an error.
 * - 8 stages, compactions after stages 3, 5 and 7, no checkpoint.
 * - 8 to 10 final questions with a current-state question. No state event of an asked item comes before stage 8, and
 *   each answer from the events of stage 8 alone equals the answer from all events.
 * - A tracked value changes in each of stages 1 to 7, so each compaction has state to summarize.
 * - The worklog and decision tasks have no "name: value" source line.
 */
export function validateNoHarm(task, key, ref, spec) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (task.stages.length !== 8 || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== "3,5,7") fail("8 stages with compactions after 3, 5 and 7");
  if (task.checkpoint !== null) fail("a checkpoint");
  const qs = ref.questions;
  if (qs.length < 8 || qs.length > 10) fail(`final question count ${qs.length}`);
  if (!qs.some((x) => ["value", "members"].includes(x.query.q))) fail("no current-state question");
  const asked = new Set(qs.flatMap(varsOf));
  const kinds = new Map(key.events.map((e) => [e.id, e.kind]));
  for (const e of ref.events) {
    if (e.stage < NOHARM_LAST && kinds.get(e.id) !== "noise" && kinds.get(e.id) !== "conflict" && [e.op.var, ...(e.op.vars ?? [])].some((v) => asked.has(v))) fail(`${e.id} in stage ${e.stage} changes an asked item`);
  }
  const all = computeAnswers(ref.vars, ref.events, qs);
  const late = computeAnswers(ref.vars, ref.events.filter((e) => e.stage >= NOHARM_LAST), qs);
  for (const x of qs) if (JSON.stringify(all[x.id].value) !== JSON.stringify(late[x.id].value)) fail(`${x.id} needs state from before stage ${NOHARM_LAST}`);
  const ids = Object.keys(ref.vars).filter((id) => !SIDE_IDS.has(id));
  const m = createMachine(ref.vars);
  const changedIn = new Set();
  for (const e of ref.events) {
    const before = JSON.stringify(ids.map((id) => m.valueOf(id)));
    m.apply(e.op);
    if (JSON.stringify(ids.map((id) => m.valueOf(id))) !== before) changedIn.add(e.stage);
  }
  for (let s = 1; s < NOHARM_LAST; s += 1) if (!changedIn.has(s)) fail(`no state change in stage ${s}`);
  if (spec.shape !== "old") {
    const bad = nameValueLines(task, ref.vars);
    if (bad.length > 0) fail(`"name: value" source line: ${bad[0]}`);
  }
}

const NOHARM_COMMON = { size: "v12-noharm", probeAfter: [], group: { target: 96000, minStage: 8000, bigFeeds: 2, bigBytes: [8000, 10000], distractors: 0.9 }, range: [92000, 107000], minFacts: 8, limits: { final: [8, 10], stages: [8, 8], deliveries: [4, 12] }, coverage: false, extraHook: noharmHook, validate: validateNoHarm, found: {} };

export const V12_NOHARM_TASKS = [
  old(V07_TASKS, "A", { ...NOHARM_COMMON, taskId: "A13-late-data-platform", seed: 2600000,
    lead: "You help a data team choose the parts of a data platform and keep its requirements. Decisions and requirements change often as the trials report back." }),
  like(W, { ...NOHARM_COMMON, taskId: "W13-late-ledger-cleanup", seed: 2625000, pools: v09("W12-ledger-migration").pools,
    lead: "You follow the work log of a team that cleans up a ledger service. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." }),
  like(X, { ...NOHARM_COMMON, taskId: "X13-late-backup-policy", seed: 2650000, pools: v09("X12-data-retention").pools, bigFeedName: "audit",
    lead: "You keep the decision record of a backup policy project. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." }),
];

/** The task sets of this generator: folder, specs and experiment name of FROZEN.json. */
export const V12_SETS = {
  v12: { dir: join(TASKS_DIR, "v12"), tasks: () => V12_TASKS, experiment: "v12-standalone" },
  "v12-hard": { dir: join(TASKS_DIR, "v12-hard"), tasks: () => V12_HARD_TASKS, experiment: "v12-standalone-hard" },
  "v12-indep": { dir: join(TASKS_DIR, "v12-indep"), tasks: () => V12_INCIDENT_TASKS, experiment: "v12-standalone-indep" },
  "v12-noharm": { dir: join(TASKS_DIR, "v12-noharm"), tasks: () => V12_NOHARM_TASKS, experiment: "v12-standalone-noharm" },
};

// ---------------------------------------------------------------------------------------------------------------
// Generation.

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The files of a set and the used seeds. */
export function generateSet(name, { fromBase = false } = {}) {
  const files = {};
  const seeds = {};
  for (const spec of V12_SETS[name].tasks()) {
    const r = generateOneV09(spec, { fromBase });
    Object.assign(files, r.files);
    seeds[spec.taskId] = r.seed;
  }
  return { files, seeds };
}

/** FROZEN.json content: status candidate, the generator commit, the seeds and the SHA-256 and bytes of every file. */
export function frozenRecord(name, commit, files, seeds) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: V12_SETS[name].experiment,
    set: name,
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v12.mjs",
    difficulty: V09_DIFFICULTY,
    tasks: V12_SETS[name].tasks().map((s) => ({
      taskId: s.taskId,
      category: s.category,
      kind: s.kind,
      shape: s.shape,
      baseSeed: s.seed,
      seed: seeds[s.taskId],
      stages: s.stages,
      compactAfter: s.compactAfter,
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      reference: entry(`reference/${s.taskId}.state.json`),
    })),
  };
}

function main(argv) {
  const i = argv.indexOf("--set");
  const name = i >= 0 ? argv[i + 1] : "v12";
  if (!V12_SETS[name]) throw new Error(`unknown set ${name}: use one of ${Object.keys(V12_SETS).join(", ")}`);
  const dir = V12_SETS[name].dir;
  const { files, seeds } = generateSet(name, { fromBase: argv.includes("--from-base") });
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(dir, rel);
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        diff += 1;
        process.stderr.write(`differs: ${rel}\n`);
      }
    }
    process.stdout.write(diff === 0 ? `ok: ${Object.keys(files).length} files match\n` : `${diff} files differ\n`);
    process.exitCode = diff === 0 ? 0 : 1;
    return;
  }
  if (argv.includes("--freeze")) {
    for (const [rel, content] of Object.entries(files)) {
      if (readFileSync(join(dir, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v12.mjs first`);
    }
    const gen = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: gen, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gen, encoding: "utf8" }).trim();
    writeFileSync(join(dir, "FROZEN.json"), serialize(frozenRecord(name, commit, files, seeds)));
    process.stdout.write(`wrote ${name}/FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${dir} (seeds ${JSON.stringify(seeds)})\n`);
}

if (import.meta.main) main(process.argv.slice(2));
