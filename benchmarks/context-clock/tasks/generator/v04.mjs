#!/usr/bin/env node
// Context Clock v0.4 experiment: 10 compaction tasks with a reference state (EXPERIMENT-V04.md, sections "Tasks" and
// "Interfaces"). Same families, builders, size range and probe rules as tasks/v03/, new recorded seeds, new slugs and
// new value pools. Writes tasks/v04/generated/<taskId>.task.json, tasks/v04/keys/<taskId>.key.json and
// tasks/v04/reference/<taskId>.state.json.
//
//   node benchmarks/context-clock/tasks/generator/v04.mjs            rewrite the 30 files
//   node benchmarks/context-clock/tasks/generator/v04.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v04.mjs --freeze   write tasks/v04/FROZEN.json (HEAD is the generator commit)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR, generateTask } from "./generate.mjs";
import { referenceState } from "./refstate.mjs";

export const V04_DIR = join(TASKS_DIR, "v04");
export const V04_RANGE = [55000, 95000];
/** The size group of the v03 tasks: two large feeds, small deliveries as in the medium group. */
export const V04_GROUP = { target: 72000, minStage: 6800, bigFeeds: 2, bigBytes: [8000, 10000], distractors: 0.9 };

/** Side variables: the large feeds carry their records. No question asks them, and the reference state omits them. */
const SIDE = [
  { id: "side.cluster", label: "the staging cluster name", options: ["stg-falcon", "stg-heron", "stg-kestrel", "stg-osprey", "stg-raven"] },
  { id: "side.image", label: "the build runner image", options: ["builder-b71", "builder-b72", "builder-b73", "builder-b74", "builder-b75"] },
  { id: "side.board", label: "the status board id", options: ["panel-p61", "panel-p62", "panel-p63", "panel-p64", "panel-p65"] },
];
export const SIDE_IDS = new Set(SIDE.map((s) => s.id));

const POOL_A = {
  topics: [
    { id: "cdn", label: "the CDN provider", options: ["fastly", "cloudflare-cdn", "akamai", "bunny-cdn", "cloudfront"] },
    { id: "registry", label: "the container registry", options: ["harbor", "quay-io", "ecr-registry", "ghcr", "artifactory"] },
    { id: "logship", label: "the log shipper", options: ["otel-collector", "vector-dev", "cribl-stream", "filebeat", "nxlog-agent"] },
    { id: "dbproxy", label: "the database proxy", options: ["pgbouncer", "proxysql", "odyssey-pg", "pgcat"] },
    { id: "cachestore", label: "the cache store", options: ["redis-stack", "hazelcast", "dragonfly-db", "keydb", "valkey"] },
    { id: "iac", label: "the provisioning tool", options: ["terraform", "pulumi", "opentofu", "crossplane"] },
    { id: "metrics", label: "the metrics store", options: ["prometheus", "victoriametrics", "thanos", "mimir-store"] },
    { id: "idp", label: "the identity provider", options: ["okta", "auth0", "keycloak", "zitadel"] },
    { id: "threads", label: "the worker thread limit", type: "int", options: [8, 12, 24, 40, 56] },
    { id: "upload", label: "the upload size limit in MB", type: "int", options: [5, 10, 25, 50, 100] },
    { id: "logdays", label: "the log retention in days", type: "int", options: [3, 10, 30, 60, 90] },
    { id: "bluegreen", label: "the blue-green deploy flag", type: "bool", options: [true, false] },
    { id: "darklaunch", label: "the dark launch flag", type: "bool", options: [true, false] },
  ],
  locales: ["ms-MY", "es-MX", "hi-IN", "bg-BG", "sk-SK", "he-IL", "th-TH", "vi-VN", "id-ID", "uk-UA"],
};

const POOL_B = {
  services: [
    "ledger-core", "payout-api", "kyc-check", "statement-gen", "card-issuer", "dispute-svc", "fx-rates", "limits-api",
    "notify-gw", "audit-trail", "report-svc", "settle-svc", "risk-score", "merchant-api",
  ],
  teamPairs: [
    ["team-payins", "team-treasury"], ["team-ledger", "team-books"], ["team-cards", "team-issuing"], ["team-compliance", "team-kyc"],
    ["team-runtime", "team-kernel"], ["team-warehouse", "team-bi"], ["team-onboard", "team-acquire"],
  ],
  oncall: ["ines", "jonas", "kira", "lev", "mara", "nils", "olga", "pavel"],
};

const POOL_C = {
  flags: ["smart-retry", "edge-cache", "dual-write", "fast-search", "async-export", "soft-delete", "read-replica"],
  configs: [
    { id: "workers", label: "the worker count", options: [2, 4, 8, 16, 24] },
    { id: "chunk", label: "the chunk size", options: [250, 500, 1000, 2000, 4000] },
    { id: "deadline", label: "the step deadline in seconds", options: [10, 30, 45, 75, 150] },
    { id: "replicas", label: "the replica count", options: [2, 4, 6, 8, 10] },
  ],
  pricing: ["tariff-alpha", "tariff-beta", "tariff-gamma", "tariff-delta"],
  schema: ["schema-q7", "schema-q8", "schema-q9", "schema-q11"],
  checkpoint: "snap-b",
};

const PARAMS_D = [
  { id: "maxfiles", label: "the maximum open files", type: "int", options: [1024, 2048, 4096, 8192, 16384] },
  { id: "tls", label: "the minimum TLS version", options: ["tls-v12", "tls-v13", "tls-v11", "ssl-v3"] },
  { id: "loglevel", label: "the default log level", options: ["level-debug", "level-info", "level-warn", "level-error"] },
  { id: "session", label: "the session lifetime in minutes", type: "int", options: [15, 30, 60, 240, 720] },
  { id: "snapint", label: "the snapshot interval in hours", type: "int", options: [1, 3, 8, 16, 48] },
  { id: "hash", label: "the hash function", options: ["sha-256", "sha3-512", "blake3", "xxhash64"] },
  { id: "tracemode", label: "the request tracing mode", type: "bool", options: [true, false] },
  { id: "region", label: "the backup region", options: ["eu-west-2", "eu-north-1", "us-east-2", "sa-east-1", "ca-central-1"] },
  { id: "quota", label: "the upload quota per hour", type: "int", options: [100, 250, 600, 1200, 3000] },
  { id: "keywrap", label: "the key wrap algorithm", options: ["kw-aes256", "rsa-oaep", "kw-aes128", "ecdh-es"] },
];

const POOL_D7 = {
  params: PARAMS_D,
  theme: {
    order: ["court-order", "vendor-contract", "ops-manual", "mailing-list", "chat-thread"],
    docs: { "court-order": "CO", "vendor-contract": "VC", "ops-manual": "OM", "mailing-list": "ML", "chat-thread": "CHAT" },
  },
};
const POOL_D8 = {
  params: PARAMS_D,
  theme: {
    order: ["infosec-policy", "design-review", "team-wiki", "standup", "email-thread"],
    docs: { "infosec-policy": "SEC", "design-review": "DR", "team-wiki": "WIKI", standup: "STAND", "email-thread": "MAIL" },
  },
};

const POOL_E7 = {
  theme: {
    feature: "the bulk import tool",
    criteria: ["ac-resume-after-crash", "ac-csv-and-xlsx", "ac-dry-run-report", "ac-row-level-errors", "ac-import-under-10m", "ac-undo-last-import", "ac-import-audit-row"],
    steps: ["step-file-parser", "step-validator", "step-staging-table", "step-error-report", "step-undo-log", "step-import-soak", "step-admin-ui", "step-docs-page"],
    rejected: ["client-side-parse", "single-transaction-load", "email-error-dump", "nightly-batch-only", "schema-free-import"],
    details: [
      { id: "rowcap", label: "the row cap per file", type: "int", options: [10000, 25000, 50000, 100000, 250000] },
      { id: "parser", label: "the parser library", options: ["papaparse", "fast-csv", "csv-stream", "sheetjs"] },
    ],
  },
};
const POOL_E8 = {
  theme: {
    feature: "the search index rebuild",
    criteria: ["ac-zero-downtime-swap", "ac-fuzzy-match", "ac-facet-counts", "ac-p95-under-300ms", "ac-synonym-support", "ac-reindex-under-1h", "ac-stale-alert"],
    steps: ["step-mapping-design", "step-dual-index", "step-backfill-job", "step-alias-swap", "step-relevance-tests", "step-shadow-queries", "step-cleanup-old", "step-oncall-guide"],
    rejected: ["in-place-reindex", "single-shard-index", "client-side-ranking", "nightly-full-rebuild", "db-like-queries"],
    details: [
      { id: "analyzer", label: "the text analyzer", options: ["icu-analyzer", "snowball-en", "ngram-tri", "kuromoji"] },
      { id: "shards", label: "the shard count", type: "int", options: [3, 6, 12, 24, 48] },
    ],
  },
};

const BASE = { profile: "compaction", size: "v04", group: V04_GROUP, range: V04_RANGE, v03: { side: SIDE } };

/** The 10 tasks with their recorded seeds. Ids: <category>7-<slug> with one compaction, <category>8-<slug> with two. */
export const V04_TASKS = [
  { ...BASE, taskId: "A7-edge-delivery", category: "A", seed: 1100004, stages: 6, compactAfter: [4], entities: 7, updates: 14, depth: 1, focus: "cdn", bigFeedName: "audit", pools: POOL_A,
    lead: "You help a web team choose the parts of a new edge delivery setup. Decisions change as the trials report back." },
  { ...BASE, taskId: "A8-registry-move", category: "A", seed: 1125004, stages: 7, compactAfter: [4, 6], entities: 8, updates: 16, depth: 1, focus: "registry", bigFeedName: "activity", pools: POOL_A,
    lead: "You follow the move of a company's build artifacts to a new container registry. The platform group revises its choices more than once." },
  { ...BASE, taskId: "B7-ledger-teams", category: "B", seed: 1150003, stages: 6, compactAfter: [4], entities: 6, updates: 12, depth: 2, bigFeedName: "ops-log", pools: POOL_B,
    lead: "You keep track of which finance team owns which service and how the services call each other." },
  { ...BASE, taskId: "B8-payments-reorg", category: "B", seed: 1175000, stages: 7, compactAfter: [4, 6], entities: 8, updates: 16, depth: 3, bigFeedName: "audit", pools: POOL_B,
    lead: "You follow the reorganization of a payments platform: teams get new names, services move and dependencies change." },
  { ...BASE, taskId: "C7-search-cutover", category: "C", seed: 1200000, stages: 6, compactAfter: [4], entities: 6, updates: 14, depth: 1, bigFeedName: "activity", pools: POOL_C,
    lead: "You follow the cutover of a search flow behind feature flags, with one data migration. The runbook rules decide which steps take effect." },
  { ...BASE, taskId: "C8-storage-upgrade", category: "C", seed: 1225000, stages: 7, compactAfter: [4, 6], entities: 8, updates: 18, depth: 3, bigFeedName: "ops-log", pools: POOL_C,
    lead: "You follow a storage upgrade with chained migrations, a settings checkpoint and a selective rollback." },
  { ...BASE, taskId: "D7-vendor-limits", category: "D", seed: 1250000, stages: 6, compactAfter: [4], entities: 7, updates: 18, depth: 3, bigFeedName: "audit", pools: POOL_D7,
    lead: "You settle the technical limits of a vendor service from court orders, contracts, an operations manual, a mailing list and chat threads. They often disagree." },
  { ...BASE, taskId: "D8-security-baseline", category: "D", seed: 1275000, stages: 7, compactAfter: [4, 6], entities: 8, updates: 20, depth: 3, bigFeedName: "activity", pools: POOL_D8,
    lead: "You settle a security baseline from security policies, design reviews, a team wiki, standup notes and email threads." },
  { ...BASE, taskId: "E7-bulk-import", category: "E", seed: 1300000, stages: 6, compactAfter: [4], entities: 7, updates: 18, depth: 2, bigFeedName: "ops-log", pools: POOL_E7,
    lead: "You work with a team on a bulk import tool over several days. Keep the requirements, the decisions and the progress straight." },
  { ...BASE, taskId: "E8-index-rebuild", category: "E", seed: 1325005, stages: 7, compactAfter: [4, 6], entities: 8, updates: 20, depth: 2, bigFeedName: "audit", pools: POOL_E8,
    lead: "You work with a team that rebuilds a search index. Keep the acceptance criteria, the rejected ideas and the progress straight." },
];

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** The three files of one task as { relativePath: content }, relative to tasks/v04/. */
export function generateOneV04(spec) {
  const { task, key, reference } = generateTask(spec, { withReference: true });
  const state = referenceState(spec.taskId, spec.compactAfter, reference.vars, reference.events, SIDE_IDS);
  return {
    [`generated/${spec.taskId}.task.json`]: serialize(task),
    [`keys/${spec.taskId}.key.json`]: serialize(key),
    [`reference/${spec.taskId}.state.json`]: serialize(state),
  };
}

/** All 30 files as { relativePath: content }, relative to tasks/v04/. */
export function generateAllV04(tasks = V04_TASKS) {
  return Object.assign({}, ...tasks.map(generateOneV04));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** FROZEN.json content: the generator commit, the seeds and the SHA-256 of every task, key and reference file. */
export function frozenRecord(commit, files) {
  const entry = (path) => ({ path, sha256: sha256(files[path]) });
  return {
    schema: 1,
    experiment: "v04-returned-state",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v04.mjs",
    tasks: V04_TASKS.map((s) => ({
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
  const files = generateAllV04();
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V04_DIR, rel);
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
      if (readFileSync(join(V04_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v04.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V04_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V04_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V04_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V04_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V04_DIR}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
