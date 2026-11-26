#!/usr/bin/env node
// Context Clock v0.6 experiment: 4 held-out compaction tasks with explicit semantics (EXPERIMENT-V06.md, sections
// "Tasks" and "Interfaces"). Same families, builders, size range, probe rules and question types as the 8-series of
// tasks/v04/. New recorded seeds, new slugs and new value pools. Writes tasks/v06/generated/<taskId>.task.json,
// tasks/v06/keys/<taskId>.key.json and tasks/v06/reference/<taskId>.state.json (reference schema 2).
//
//   node benchmarks/context-clock/tasks/generator/v06.mjs            rewrite the 12 files
//   node benchmarks/context-clock/tasks/generator/v06.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v06.mjs --freeze   write tasks/v06/FROZEN.json (HEAD is the generator commit)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR, generateTask } from "./generate.mjs";
import { createMachine } from "./reference.mjs";
import { STATE_TEXT_MAX_BYTES, factName, stateFacts, stateText } from "./refstate.mjs";

export const V06_DIR = join(TASKS_DIR, "v06");
export const V06_RANGE = [55000, 95000];
/** The size group of the v03 and v04 tasks: two large feeds, small deliveries as in the medium group. */
export const V06_GROUP = { target: 72000, minStage: 6800, bigFeeds: 2, bigBytes: [8000, 10000], distractors: 0.9 };

/** Side variables: the large feeds carry their records. No question asks them, and the reference state omits them. */
const SIDE = [
  { id: "side.cluster", label: "the staging cluster name", options: ["stg-lynx", "stg-otter", "stg-puma", "stg-bison", "stg-moose"] },
  { id: "side.image", label: "the build runner image", options: ["imager-c81", "imager-c82", "imager-c83", "imager-c84", "imager-c85"] },
  { id: "side.board", label: "the status board id", options: ["wall-w91", "wall-w92", "wall-w93", "wall-w94", "wall-w95"] },
];
export const SIDE_IDS = new Set(SIDE.map((s) => s.id));

const POOL_A = {
  topics: [
    { id: "gateway", label: "the API gateway", options: ["kong-gw", "tyk-gw", "apisix", "envoy-gw", "krakend"] },
    { id: "queue", label: "the message queue", options: ["lavinmq", "activemq", "sqs-queue", "nsq-queue", "beanstalkd"] },
    { id: "docdb", label: "the document store", options: ["mongodb", "couchdb", "ravendb", "firestore-db"] },
    { id: "policy", label: "the policy engine", options: ["opa-engine", "cedar-policy", "casbin", "oso-policy"] },
    { id: "workflow", label: "the workflow engine", options: ["temporal-io", "airflow", "argo-wf", "prefect-flow"] },
    { id: "tsdb", label: "the time series database", options: ["influxdb", "timescaledb", "questdb", "clickhouse-ts"] },
    { id: "edgert", label: "the edge runtime", options: ["workers-rt", "deno-deploy", "fastly-compute", "lambda-edge"] },
    { id: "dns", label: "the DNS provider", options: ["route53", "ns1-dns", "dnsimple", "gandi-dns"] },
    { id: "bodykb", label: "the request body limit in KB", type: "int", options: [64, 128, 256, 512, 1024] },
    { id: "gwtimeout", label: "the gateway timeout in seconds", type: "int", options: [5, 15, 30, 60, 120] },
    { id: "auditdays", label: "the audit log retention in days", type: "int", options: [45, 90, 180, 365, 730] },
    { id: "mtls", label: "the mutual TLS flag", type: "bool", options: [true, false] },
    { id: "reqsign", label: "the request signing flag", type: "bool", options: [true, false] },
  ],
  locales: ["fr-CA", "en-AU", "en-IN", "ar-EG", "fa-IR", "bn-BD", "ta-IN", "sw-KE", "lt-LT", "lv-LV"],
};

const POOL_B = {
  services: [
    "route-planner", "fleet-api", "depot-svc", "parcel-track", "label-print", "customs-svc", "eta-model", "driver-gw",
    "slot-booking", "returns-svc", "carrier-hub", "geo-fence", "manifest-gen", "yard-svc",
  ],
  teamPairs: [
    ["team-routing", "team-navigation"], ["team-fleet", "team-vehicles"], ["team-depot", "team-sites"], ["team-parcels", "team-shipments"],
    ["team-customs", "team-borders"], ["team-handhelds", "team-field"], ["team-carriers", "team-partners"],
  ],
  oncall: ["quinn", "rosa", "sami", "tomas", "ulla", "viktor", "wren", "yara"],
};

const POOL_C = {
  flags: ["usage-metering", "tax-engine", "proration", "dunning-v2", "credit-notes", "multi-currency", "invoice-pdf"],
  configs: [
    { id: "workers", label: "the invoice worker count", options: [3, 5, 7, 11, 13] },
    { id: "chunk", label: "the export page size", options: [150, 300, 600, 1200, 2400] },
    { id: "deadline", label: "the job deadline in minutes", options: [5, 12, 20, 35, 50] },
    { id: "replicas", label: "the ledger replica count", options: [2, 3, 5, 7, 9] },
  ],
  pricing: ["plan-sheet-a", "plan-sheet-b", "plan-sheet-c", "plan-sheet-d"],
  schema: ["ledger-s20", "ledger-s21", "ledger-s22", "ledger-s23"],
  checkpoint: "snap-c9",
};

const POOL_E = {
  theme: {
    feature: "the data export service",
    criteria: ["ac-export-resumable", "ac-gzip-output", "ac-signed-links", "ac-export-under-5m", "ac-column-filter", "ac-tenant-isolation", "ac-timeout-retry-3x"],
    steps: ["step-export-api", "step-job-queue", "step-file-writer", "step-link-signer", "step-quota-check", "step-chaos-test", "step-billing-hook", "step-user-guide"],
    rejected: ["sync-http-export", "shared-tmp-dir", "email-attachments", "unbounded-queries", "cron-dump-all"],
    details: [
      { id: "format", label: "the default export format", options: ["parquet-v2", "csv-utf8", "ndjson-lines", "avro-file"] },
      { id: "linkttl", label: "the link lifetime in hours", type: "int", options: [1, 6, 24, 72, 168] },
    ],
  },
};

/** The rules of each task, in the intro after the initial specification. Each rule names how a tracked value changes. */
const COMMON_RULES = [
  "Rules for this task:",
  "- A value changes only by an event that decides, corrects, adds, removes, renames, runs or restores it. A proposal, a question, a link or a quote of an old page changes nothing.",
  "- A correction or a new decision replaces the earlier value. The earlier value is then superseded.",
  "- The initial specification gives the first value of each item.",
];
export const V06_RULES = {
  A: [
    ...COMMON_RULES,
    "- Each tool and each setting has one current decision. A new decision for it replaces the earlier one.",
    "- A superseded value of an item is a value that was its decision at some time, the initial specification included, and is not its current decision.",
    "- A locale is supported from the event that adds it until an event removes it.",
  ],
  B: [
    ...COMMON_RULES,
    "- A service has one owning team at a time. A new owner replaces the earlier owner.",
    "- A rename gives a team a new name. The team keeps its services. Every reference to the old name means the new name.",
    "- The dependencies of a service are the services in its own dependency list. These are its direct dependencies. A dependency of a dependency is not counted.",
    "- A service has one on-call engineer at a time. A new assignment replaces the earlier one.",
  ],
  C: [
    ...COMMON_RULES,
    "- The status of a migration is `pending`, `applied` or `failed`. Only a run event of that migration changes its status.",
    "- A run event sets the status of its migration to the result of the runbook rule in the event. The rule uses the values of its conditions at the moment of the run.",
    "- A later run of the same migration can change the status again. A later change of a flag or of another migration does not change a status by itself.",
    "- A change with a condition takes effect only if the condition holds at the moment of the change. If not, the value stays as it was, and a later change of the condition does not revive the change.",
    "- A checkpoint records the current settings. A rollback event sets each setting that it names back to its value at that checkpoint. Every other value keeps its current value. A rollback never changes a migration status.",
  ],
  E: [
    ...COMMON_RULES,
    "- The acceptance criteria, the planned steps, the completed steps and the rejected approaches are lists. An event adds an item to a list or removes an item from it.",
    "- A step is outstanding when it is in the planned steps and not in the completed steps.",
    "- An approach is rejected while it is in the list of rejected approaches. A suggestion to use it again does not change the list.",
    "- A decision on a detail replaces the earlier decision for that detail.",
  ],
};

/** Question texts with a second fair reading, and their v06 form. The probe texts derive from these. */
const REWRITES = [
  // C: "final status" can read as "the last run result" against "the stored value". The rules make both the same.
  [/^What is the final status of (migration m\d+)\?$/, "What is the status of $1 now?"],
  // B: "depend on" can read as direct or as transitive. The question now names direct dependencies.
  [/^Does (\S+) depend on (`[^`]+`) now\?$/, "Is $2 a direct dependency of $1 now?"],
  [/^Which services does (\S+) depend on now\?$/, "Which services are direct dependencies of $1 now?"],
];

/** v06 hook, called after the builder: question texts with one reading, and a history question in category E. */
function prepare(story) {
  for (const q of story.questions) for (const [re, to] of REWRITES) q.text = q.text.replace(re, to);
  if (story.category === "E") {
    const [id, v] = Object.entries(story.vars).find(([, x]) => x.type === "scalar");
    story.q({ text: `In the initial specification, what was ${v.label}?`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: id } });
  }
}

const BASE = { profile: "compaction", size: "v06", group: V06_GROUP, range: V06_RANGE, v03: { side: SIDE }, stages: 7, compactAfter: [4, 6] };
const v06 = (category) => ({ rules: V06_RULES[category], prepare });

/** The 4 tasks with their recorded seeds. 7 stages each, a compaction after stages 4 and 6. */
export const V06_TASKS = [
  { ...BASE, taskId: "A9-api-gateway", category: "A", seed: 1400002, entities: 8, updates: 16, depth: 1, focus: "gateway", bigFeedName: "activity", pools: POOL_A, v06: v06("A"),
    lead: "You help a platform team choose the parts of a new API gateway setup and keep its requirements. Decisions and requirements change as the trials report back." },
  { ...BASE, taskId: "B9-logistics-teams", category: "B", seed: 1425000, entities: 8, updates: 16, depth: 3, bigFeedName: "audit", pools: POOL_B, v06: v06("B"),
    lead: "You follow the reorganization of a logistics platform: teams get new names, services change owners and dependencies change." },
  { ...BASE, taskId: "C9-billing-migration", category: "C", seed: 1450000, entities: 8, updates: 18, depth: 3, bigFeedName: "ops-log", pools: POOL_C, v06: v06("C"),
    lead: "You follow a billing platform move with three chained migrations behind feature flags, a settings checkpoint and a selective rollback." },
  { ...BASE, taskId: "E9-export-service", category: "E", seed: 1475000, entities: 8, updates: 20, depth: 2, bigFeedName: "audit", pools: POOL_E, v06: v06("E"),
    lead: "You work with a team that builds a data export service over several days. Keep the constraints, the rejected ideas and the unfinished work straight." },
];

/** The fact that decides an answer: { name, part } or null. names: the fact names of the reference file. */
export function factOf(vars, query, names) {
  const one = { value: "current", members: "current", count: "current", contains: "current", initial: "history", superseded: "history" }[query.q];
  if (!one) return null;
  const name = factName(vars[query.var]);
  return names.has(name) ? { name, part: one } : null;
}

/**
 * v06 rules on top of the v03 rules. Fails with an error. ref: { vars, events, questions, checkpointQuestions }.
 * - New state events in stages 5, 6 and 7, and at least one corrected or replaced value.
 * - The final set has a current-state question and a history question. An initial question asks a value of stage 0.
 * - A question about a team by name asks a name that is the current name at the time of the question.
 * - No run leaves its result open, and no event text says that a run output was not kept.
 */
export function validateV06(task, key, ref) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (Math.max(...task.stages.map((s) => s.stage)) !== 7 || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== "4,6") fail("7 stages with compactions after 4 and 6");
  const ids = Object.keys(ref.vars).filter((id) => !SIDE_IDS.has(id));
  const m = createMachine(ref.vars);
  const snap = () => JSON.stringify(ids.map((id) => m.valueOf(id)));
  const changedIn = new Set();
  let corrected = 0;
  for (const e of ref.events) {
    const before = snap();
    m.apply(e.op);
    if (snap() === before) continue;
    changedIn.add(e.stage);
    const kind = key.events.find((x) => x.id === e.id).kind;
    if (e.stage > 0 && kind === "supersede") corrected += 1;
  }
  for (const s of [5, 6, 7]) if (!changedIn.has(s)) fail(`no state change in stage ${s}`);
  if (corrected === 0) fail("no corrected or replaced value");
  const kinds = new Set(ref.questions.map((q) => q.query.q));
  if (!["value", "members"].some((k) => kinds.has(k))) fail("no current-state question");
  if (!["initial", "superseded"].some((k) => kinds.has(k))) fail("no history question");
  for (const q of ref.questions) if (q.query.q === "initial" && key.answers[q.id].firstEstablishedStage !== 0) fail(`${q.id}: initial value not in the specification`);
  const renames = ref.events.filter((e) => e.op.op === "rename");
  const stageOfQ = new Map([...ref.questions.map((q) => [q, 7]), ...task.checkpoint.probes.flatMap((p) => p.questionIds.map((id) => [ref.checkpointQuestions.find((q) => q.id === id), p.afterStage]))]);
  for (const [q, at] of stageOfQ) {
    if (q.query.q !== "whereEq") continue;
    const name = q.query.value;
    if (renames.some((e) => (e.op.from === name && e.stage <= at) || (e.op.to === name && e.stage > at))) fail(`${q.id}: team name ${name} is not current at stage ${at}`);
  }
  const all = JSON.stringify(task);
  if (all.includes("was not kept")) fail("an event leaves a run result open");
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The three files of one task as { relativePath: content }, relative to tasks/v06/. */
export function generateOneV06(spec) {
  const { task, key, reference } = generateTask(spec, { withReference: true });
  validateV06(task, key, reference);
  const states = spec.compactAfter.map((afterStage) => {
    const text = stateText(reference.vars, reference.events, afterStage, SIDE_IDS);
    const n = Buffer.byteLength(text, "utf8");
    if (n > STATE_TEXT_MAX_BYTES) throw new Error(`${spec.taskId}: reference state after stage ${afterStage} has ${n} bytes`);
    const facts = stateFacts(reference.vars, reference.events, afterStage, SIDE_IDS);
    if (new Set(facts.map((f) => f.name)).size !== facts.length) throw new Error(`${spec.taskId}: duplicate fact name`);
    return { afterStage, text, facts };
  });
  const names = new Set(states.flatMap((s) => s.facts.map((f) => f.name)));
  const link = (answers, questions) => Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { ...a, fact: factOf(reference.vars, questions.find((q) => q.id === id).query, names) }]));
  const keyOut = { ...key, answers: link(key.answers, reference.questions), checkpointAnswers: link(key.checkpointAnswers, reference.checkpointQuestions) };
  return {
    [`generated/${spec.taskId}.task.json`]: serialize(task),
    [`keys/${spec.taskId}.key.json`]: serialize(keyOut),
    [`reference/${spec.taskId}.state.json`]: serialize({ schema: 2, taskId: spec.taskId, states }),
  };
}

/** All 12 files as { relativePath: content }, relative to tasks/v06/. */
export function generateAllV06(tasks = V06_TASKS) {
  return Object.assign({}, ...tasks.map(generateOneV06));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** FROZEN.json content: the generator commit, the seeds and the SHA-256 of every task, key and reference file. */
export function frozenRecord(commit, files) {
  const entry = (path) => ({ path, sha256: sha256(files[path]) });
  return {
    schema: 1,
    experiment: "v06-memory-delivery",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v06.mjs",
    tasks: V06_TASKS.map((s) => ({
      taskId: s.taskId,
      category: s.category,
      seed: s.seed,
      compactAfter: s.compactAfter,
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      reference: entry(`reference/${s.taskId}.state.json`),
    })),
  };
}

function main(argv) {
  const files = generateAllV06();
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V06_DIR, rel);
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
    // The hashes are of the files on disk; they must equal what the generator at HEAD writes.
    for (const [rel, content] of Object.entries(files)) {
      if (readFileSync(join(V06_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v06.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V06_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V06_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V06_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V06_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V06_DIR}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
