#!/usr/bin/env node
// Context Clock v0.9 tasks (EXPERIMENT-V09.md, sections "Tasks" and "Part 2: automatic compaction").
// - Six tasks with 8 stages and compactions after stages 3, 5 and 7: two of the old shape from the v0.8 generators of
//   kind A and D with new seeds, two of the shape "worklog" (kind W) and two of the shape "decision" (kind X).
// - One long task of the old shape (kind A) for part 2: no compaction in its plan, 24 stages, about twice the material
//   of a v0.8 stage in each stage, and a probe prepared for every stage boundary. The stage count and the stage size
//   are parameters.
// Each task.json has the field `shape`. Keys and reference files have the v0.8 layout (schema 2, `fact` links).
//
//   node benchmarks/context-clock/tasks/generator/v09.mjs                       rewrite the 21 files
//   node benchmarks/context-clock/tasks/generator/v09.mjs --check               exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v09.mjs --freeze              write tasks/v09/FROZEN.json (candidate)
//   node benchmarks/context-clock/tasks/generator/v09.mjs --from-base           search each seed from its base seed
//   node benchmarks/context-clock/tasks/generator/v09.mjs --long-stages 24 --long-stage-bytes 24000
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR, generateTask, validateV03 } from "./generate.mjs";
import { fixKey } from "./keyfix.mjs";
import { createMachine } from "./reference.mjs";
import { factName, stateFacts, stateText } from "./refstate.mjs";
import { SIDE_IDS, V07_GROUP, V07_RANGE, V07_STATE_TEXT_MAX_BYTES, sha256, v07Spec, validateV07 } from "./v07.mjs";
import { V08_TASKS } from "./v08.mjs";

export const V09_DIR = join(TASKS_DIR, "v09");
export const V09_DIFFICULTY = 1;
export const V09_COMPACT_AFTER = [3, 5, 7];
/** Defaults of the long task. A v0.8 stage holds about 12 000 bytes of material (97 KB over 8 stages). */
export const LONG_DEFAULTS = { stages: 24, stageBytes: 24000 };
const SEED_TRIES = 400;

/** Side variables of the large feeds: the v07 ids (no question asks them), new labels and values. */
const SIDE = [
  { id: "side.cluster", label: "the soak test cluster", options: ["soak-hydra", "soak-ibis", "soak-jackal", "soak-koala", "soak-lemur"] },
  { id: "side.image", label: "the build agent pool", options: ["agentpool-q41", "agentpool-q42", "agentpool-q43", "agentpool-q44", "agentpool-q45"] },
  { id: "side.board", label: "the wall screen id", options: ["wallscreen-w11", "wallscreen-w12", "wallscreen-w13", "wallscreen-w14", "wallscreen-w15"] },
];

// ---------------------------------------------------------------------------------------------------------------
// Pools of the new shapes.

const POOL_W1 = {
  items: ["LDG-214", "LDG-227", "LDG-231", "LDG-246", "LDG-258", "LDG-263", "LDG-275", "LDG-289", "LDG-292"],
  owners: ["okafor", "lindqvist", "haddad", "moreau", "takeda", "varga", "nakamura", "ferreira"],
  files: ["src/ledger/posting.ts", "src/ledger/accounts.ts", "src/ledger/fx-rates.ts", "migrations/0042_split_journal.sql", "migrations/0043_backfill_entries.sql", "docs/ledger/cutover-plan.md", "src/ledger/reconcile.ts", "config/ledger-flags.yaml"],
};

const POOL_W2 = {
  items: ["SRCH-412", "SRCH-418", "SRCH-425", "SRCH-433", "SRCH-447", "SRCH-451", "SRCH-466", "SRCH-470", "SRCH-484"],
  owners: ["achebe", "bergstrom", "castellanos", "dimitrov", "esposito", "fujimoto", "gallagher", "horvath"],
  files: ["services/search/ranker.py", "services/search/synonyms.yaml", "services/search/indexer.py", "infra/search/cluster.tf", "services/search/query_parser.py", "docs/search/relevance-notes.md", "services/search/autocomplete.py", "infra/search/snapshots.tf"],
};

const POOL_X1 = {
  topics: [
    { id: "store", label: "the archive store", options: ["glacier-deep", "azure-archive", "gcs-coldline", "wasabi-vault"] },
    { id: "format", label: "the export format", options: ["parquet-v2", "avro-files", "orc-files", "jsonl-gz"] },
    { id: "scheduler", label: "the purge scheduler", options: ["airflow-dag", "argo-cron", "temporal-flow", "k8s-cronjob"] },
    { id: "hashing", label: "the pseudonym hash", options: ["sha3-256", "blake2b-512", "hmac-sha256", "argon2id"] },
    { id: "catalog", label: "the data catalog", options: ["datahub-oss", "amundsen-oss", "openmetadata", "apache-atlas"] },
    { id: "masking", label: "the masking library", options: ["presidio-lib", "faker-mask", "tonic-sdk", "privy-mask"] },
    { id: "days", label: "the retention period in days", type: "int", options: [30, 45, 90, 180, 365] },
  ],
  reasons: ["why-gdpr", "why-storage-cost", "why-restore-speed", "why-audit-trail", "why-vendor-risk", "why-ops-load"],
  constraints: ["cn-no-new-vendors", "cn-eu-data-only", "cn-budget-cap", "cn-freeze-schema", "cn-keep-backups", "cn-no-weekend-jobs"],
  questions: [
    { id: "oq-legal-hold", options: ["hold-90d", "hold-1y", "hold-forever"] },
    { id: "oq-delete-owner", options: ["team-privacy", "team-platform", "team-legal"] },
    { id: "oq-backfill", options: ["backfill-q1", "backfill-q2", "skip-backfill"] },
    { id: "oq-audit-sink", options: ["audit-siem", "audit-s3", "audit-bigquery"] },
    { id: "oq-restore-sla", options: ["sla-4h", "sla-24h", "sla-72h"] },
    { id: "oq-test-data", options: ["synthetic-only", "masked-copy", "sampled-prod"] },
  ],
};

const POOL_X2 = {
  topics: [
    { id: "edge", label: "the edge vendor", options: ["fastly-edge", "akamai-edge", "bunny-edge", "gcore-edge"] },
    { id: "issuer", label: "the certificate issuer", options: ["letsencrypt-acme", "digicert-ov", "sectigo-dv", "zerossl-acme"] },
    { id: "waf", label: "the edge firewall", options: ["coraza-waf", "modsec-crs", "sigsci-waf", "wallarm-node"] },
    { id: "purge", label: "the cache purge method", options: ["surrogate-keys", "path-purge", "ban-lurker", "tag-purge"] },
    { id: "shield", label: "the origin shield region", options: ["fra-shield", "iad-shield", "sin-shield", "gru-shield"] },
    { id: "imaging", label: "the image optimizer", options: ["imgproxy-node", "thumbor-svc", "sharp-edge", "imageflow-svc"] },
    { id: "ttl", label: "the default edge TTL in seconds", type: "int", options: [60, 120, 300, 900, 3600] },
  ],
  reasons: ["why-latency", "why-price", "why-compliance", "why-vendor-support", "why-feature-set", "why-lock-in"],
  constraints: ["cn-no-downtime", "cn-keep-old-cdn", "cn-us-eu-pops", "cn-max-two-vendors", "cn-change-window", "cn-no-js-at-edge"],
  questions: [
    { id: "oq-ipv6", options: ["ipv6-day-one", "ipv6-later", "ipv6-never"] },
    { id: "oq-log-sink", options: ["sink-splunk", "sink-elastic", "sink-loki"] },
    { id: "oq-cutover-day", options: ["cutover-tue", "cutover-wed", "cutover-sat"] },
    { id: "oq-bot-policy", options: ["bots-block", "bots-challenge", "bots-allow"] },
    { id: "oq-rollback-owner", options: ["owner-sre", "owner-netops", "owner-webteam"] },
    { id: "oq-http3", options: ["http3-on", "http3-pilot", "http3-off"] },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// The tasks.

const NEW_BASE = {
  profile: "compaction",
  size: "v09",
  group: V07_GROUP,
  range: V07_RANGE,
  v03: { side: SIDE },
  stages: 8,
  compactAfter: V09_COMPACT_AFTER,
  limits: { final: [8, 10], stages: [8, 8] },
  wording: "v09",
  bigFeedName: "activity",
  fixKey,
};

/** An old-shape spec from the v0.8 spec of a kind, with a new id, seed and lead. */
function old(kind, over) {
  const base = V08_TASKS.find((t) => t.kind === kind);
  return { ...base, shape: "old", v03: { side: SIDE }, found: {}, fixKey, ...over };
}

export const V09_TASKS = [
  old("A", { taskId: "A12-mobile-gateway", seed: 1900000, found: { 1: 1900034 },
    lead: "You help a mobile team pick the parts of an app gateway and keep its requirements. Decisions and requirements change often as the trials report back." }),
  old("D", { taskId: "D12-backup-policy", seed: 1925000, found: { 1: 1925001 },
    lead: "You settle a backup policy from storage standards, design documents, a platform handbook, Slack threads and Jira comments." }),
  { ...NEW_BASE, shape: "worklog", taskId: "W12-ledger-migration", category: "W", kind: "W", seed: 1950000, found: { 1: 1950000 }, entities: 7, files: 6, updates: 44, depth: 2, pools: POOL_W1, minFacts: 24,
    lead: "You follow the work log of a team that moves a ledger service to a new journal schema. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." },
  { ...NEW_BASE, shape: "worklog", taskId: "W12-shop-search", category: "W", kind: "W", seed: 1985000, found: { 1: 1985000 }, entities: 7, files: 6, updates: 44, depth: 2, pools: POOL_W2, minFacts: 24, bigFeedName: "audit",
    lead: "You follow the work log of a team that rebuilds the search of an online shop. Work items open, close and reopen, change owners and block each other, and the files of the change move through review." },
  { ...NEW_BASE, shape: "decision", taskId: "X12-data-retention", category: "X", kind: "X", seed: 2000000, found: { 1: 2000000 }, entities: 6, reasons: 4, constraints: 5, questions: 5, updates: 40, depth: 2, pools: POOL_X1, minFacts: 18,
    lead: "You keep the decision record of a data retention project. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." },
  { ...NEW_BASE, shape: "decision", taskId: "X12-cdn-migration", category: "X", kind: "X", seed: 2035000, found: { 1: 2035000 }, entities: 6, reasons: 4, constraints: 5, questions: 5, updates: 40, depth: 2, pools: POOL_X2, minFacts: 18, bigFeedName: "ops-log",
    lead: "You keep the decision record of a move to a new edge network. Decisions and their reasons change, the user sets and lifts constraints, and open questions get answers or stay open." },
];

/**
 * The long task of part 2. stages: the stage count. stageBytes: the target material of one stage in bytes. The
 * update count grows with the stage count, so that each stage has about as many changes as a v0.8 stage.
 */
export function longSpec({ stages = LONG_DEFAULTS.stages, stageBytes = LONG_DEFAULTS.stageBytes } = {}) {
  const base = V08_TASKS.find((t) => t.kind === "A");
  const target = stages * stageBytes;
  const isDefault = stages === LONG_DEFAULTS.stages && stageBytes === LONG_DEFAULTS.stageBytes;
  return {
    ...base,
    shape: "old",
    taskId: "A13-long-mobile-platform",
    seed: 2050000,
    found: isDefault ? { 1: 2050000 } : {},
    profile: "long",
    stages,
    compactAfter: [],
    probeAfter: Array.from({ length: stages - 1 }, (_, i) => i + 1),
    probeTiming: "after_auto_compaction",
    updates: Math.round((base.updates * stages) / 8),
    group: { target, minStage: Math.round(stageBytes * 0.8), bigFeeds: 3, bigBytes: [8000, 10000], distractors: 0.9 },
    range: [Math.round(target * 0.85), Math.round(target * 1.08)],
    limits: { final: [8, 10], stages: [stages, stages], deliveries: [4, 12], bigFeeds: 3 },
    v03: { side: SIDE },
    fixKey,
    long: { stages, stageBytes },
    lead: "You help a mobile team choose the parts of a new app platform over a long project and keep its requirements. Decisions and requirements change often as the trials report back.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Checks.

/** The fact that decides an answer: { name, part } or null. names: the fact names of the reference file. */
export function factOfV09(vars, query, names) {
  const part = { value: "current", members: "current", count: "current", contains: "current", eq: "current", initial: "history", superseded: "history", previous: "history" }[query.q];
  if (!part) return null;
  const name = factName(vars[query.var]);
  return names.has(name) ? { name, part } : null;
}

/** A source line of the form "name: value": a tracked label or fact name, a colon, then a value. */
export function nameValueLines(task, vars) {
  const names = Object.values(vars).flatMap((v) => [v.label, factName(v)]);
  const text = [task.intro, ...task.stages.flatMap((s) => [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)])].join("\n");
  const out = [];
  for (const line of text.split("\n")) {
    if (/:\s*`[^`]+`/.test(line)) out.push(line);
    else if (names.some((n) => line.includes(`${n}:`))) out.push(line);
  }
  return out;
}

/** A question about what blocks what (worklog) or about a reason (decision). */
export function isBlockQuestion(x) {
  return [x.query.var, ...(x.query.vars ?? [])].some((id) => typeof id === "string" && id.endsWith(".blocker"));
}
export function isReasonQuestionV09(x) {
  return [x.query.var, ...(x.query.vars ?? [])].some((id) => typeof id === "string" && id.startsWith("reason."));
}

/**
 * v0.9 rules on top of the shared rules. Fails with an error.
 * - The 8-stage tasks: the v07 rules (stages, compactions, probes, changes in every stage, a correction, 8 to 10 final
 *   questions with a current-state and a history question).
 * - worklog: at least 3 questions about what blocks what, and no "name: value" source line.
 * - decision: at least 2 reason questions, and no "name: value" source line.
 * - long: a probe with 4 to 6 questions after every stage boundary, a change in at least 90% of the stages, and final
 *   answers that change in the last third.
 */
export function validateV09(task, key, ref, spec) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (spec.long) {
    const n = spec.long.stages;
    if (task.stages.length !== n || task.stages.some((s) => s.compactAfter)) fail(`${n} stages with no compaction`);
    const probes = task.checkpoint?.probes ?? [];
    if (probes.map((p) => p.afterStage).join() !== spec.probeAfter.join()) fail("one probe after every stage boundary");
    for (const p of probes) if (p.questionIds.length < 4 || p.questionIds.length > 6) fail(`probe after stage ${p.afterStage}: ${p.questionIds.length} questions`);
    const ids = Object.keys(ref.vars).filter((id) => !SIDE_IDS.has(id));
    const m = createMachine(ref.vars);
    const changedIn = new Set();
    for (const e of ref.events) {
      const before = JSON.stringify(ids.map((id) => m.valueOf(id)));
      m.apply(e.op);
      if (JSON.stringify(ids.map((id) => m.valueOf(id))) !== before) changedIn.add(e.stage);
    }
    const covered = [...changedIn].filter((s) => s >= 1).length;
    if (covered < Math.ceil(0.9 * n)) fail(`state changes in only ${covered} of ${n} stages`);
    const late = Object.values(key.answers).filter((a) => a.lastChangedStage > Math.floor((2 * n) / 3)).length;
    if (late < 2) fail(`only ${late} final answers change in the last third`);
    return;
  }
  validateV07(task, key, ref, spec);
  if (spec.shape === "worklog" && ref.questions.filter(isBlockQuestion).length < 2) fail("fewer than 2 questions about what blocks what");
  if (spec.shape === "decision" && ref.questions.filter(isReasonQuestionV09).length < 2) fail("fewer than 2 reason questions");
  if (spec.shape !== "old") {
    const bad = nameValueLines(task, ref.vars);
    if (bad.length > 0) fail(`"name: value" source line: ${bad[0]}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Generation.

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The task with the field `shape` after `category`. */
function withShape(task, shape) {
  const { schema, taskId, category, ...rest } = task;
  return { schema, taskId, category, shape, ...rest };
}

/** One attempt with one seed. Returns the three files, or throws. */
function attempt(spec) {
  const g = generateTask(spec, { withReference: true });
  const { reference } = g;
  const task = withShape(g.task, spec.shape);
  const key = spec.fixKey(g.key, reference, task.checkpoint?.probes ?? []);
  if (!spec.long && spec.coverage !== false) validateV03(task, key, reference);
  (spec.validate ?? validateV09)(task, key, reference, spec);
  const stateStages = spec.long ? spec.probeAfter : spec.compactAfter;
  const maxBytes = spec.stateMaxBytes ?? (spec.long ? 2 * V07_STATE_TEXT_MAX_BYTES : V07_STATE_TEXT_MAX_BYTES);
  const states = stateStages.map((afterStage) => {
    const text = stateText(reference.vars, reference.events, afterStage, SIDE_IDS);
    const n = Buffer.byteLength(text, "utf8");
    if (n > maxBytes) throw new Error(`${spec.taskId}: reference state after stage ${afterStage} has ${n} bytes`);
    const facts = stateFacts(reference.vars, reference.events, afterStage, SIDE_IDS);
    if (new Set(facts.map((f) => f.name)).size !== facts.length) throw new Error(`${spec.taskId}: duplicate fact name`);
    return { afterStage, text, facts };
  });
  const nFacts = states.at(-1).facts.length;
  if (nFacts < spec.minFacts) throw new Error(`${spec.taskId}: ${nFacts} facts, fewer than ${spec.minFacts}`);
  const names = new Set(states.flatMap((s) => s.facts.map((f) => f.name)));
  const link = (answers, questions) => Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { ...a, fact: factOfV09(reference.vars, questions.find((x) => x.id === id).query, names) }]));
  const keyOut = { ...key, answers: link(key.answers, reference.questions), checkpointAnswers: link(key.checkpointAnswers, reference.checkpointQuestions) };
  return {
    files: {
      [`generated/${spec.taskId}.task.json`]: serialize(task),
      [`keys/${spec.taskId}.key.json`]: serialize(keyOut),
      [`reference/${spec.taskId}.state.json`]: serialize({ schema: 2, taskId: spec.taskId, states }),
    },
    seed: spec.seed,
    reference,
  };
}

/** The full spec of a task at the v0.9 difficulty: the old shape goes through the v07 hook. */
export function fullSpec(base) {
  return base.shape === "old" ? { ...v07Spec(base, base.difficulty ?? V09_DIFFICULTY), wording: undefined } : base;
}

/** The files of one task, from the first seed on that passes every rule. */
export function generateOneV09(base, { fromBase = false, tries = SEED_TRIES } = {}) {
  const spec = fullSpec(base);
  const start = fromBase ? base.seed : (base.found?.[V09_DIFFICULTY] ?? base.seed);
  let last = null;
  for (let k = 0; k < tries; k += 1) {
    try {
      return attempt({ ...spec, seed: start + k });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${base.taskId}: no seed in ${tries} tries: ${last?.message}`);
}

/** All 21 files and the used seeds. long: the parameters of the long task. */
export function generateAllV09({ fromBase = false, long = {} } = {}) {
  const files = {};
  const seeds = {};
  for (const spec of [...V09_TASKS, longSpec(long)]) {
    const r = generateOneV09(spec, { fromBase });
    Object.assign(files, r.files);
    seeds[spec.taskId] = r.seed;
  }
  return { files, seeds };
}

/** FROZEN.json content: status candidate, the generator commit, the seeds and the SHA-256 and bytes of every file. */
export function frozenRecord(commit, files, seeds, long = {}) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: "v09-general-instruction",
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v09.mjs",
    difficulty: V09_DIFFICULTY,
    tasks: [...V09_TASKS, longSpec(long)].map((s) => ({
      taskId: s.taskId,
      category: s.category,
      kind: s.kind,
      shape: s.shape,
      baseSeed: s.seed,
      seed: seeds[s.taskId],
      stages: s.stages,
      compactAfter: s.compactAfter,
      ...(s.long ? { probeAfter: s.probeAfter, stageBytes: s.long.stageBytes } : {}),
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      reference: entry(`reference/${s.taskId}.state.json`),
    })),
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
}

function main(argv) {
  const long = {};
  if (argValue(argv, "--long-stages") !== undefined) long.stages = argValue(argv, "--long-stages");
  if (argValue(argv, "--long-stage-bytes") !== undefined) long.stageBytes = argValue(argv, "--long-stage-bytes");
  const { files, seeds } = generateAllV09({ fromBase: argv.includes("--from-base"), long });
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V09_DIR, rel);
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
      if (readFileSync(join(V09_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v09.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V09_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V09_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V09_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files, seeds, long)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V09_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V09_DIR} (seeds ${JSON.stringify(seeds)})\n`);
}

if (import.meta.main) main(process.argv.slice(2));
