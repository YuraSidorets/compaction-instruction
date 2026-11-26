#!/usr/bin/env node
// Context Clock v0.3 placebo experiment: 10 held-out compaction tasks (EXPERIMENT-V03.md, section "Tasks").
// Same families and builders as the v0.2 tasks, new recorded seeds, new slugs and new value pools. Writes
// tasks/v03/generated/<taskId>.task.json and tasks/v03/keys/<taskId>.key.json.
//
//   node benchmarks/context-clock/tasks/generator/v03.mjs            rewrite the 20 files
//   node benchmarks/context-clock/tasks/generator/v03.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v03.mjs --freeze   write tasks/v03/FROZEN.json (HEAD is the generator commit)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR, generateTask } from "./generate.mjs";

export const V03_DIR = join(TASKS_DIR, "v03");
export const V03_RANGE = [55000, 95000];
/** One size group for all 10 tasks: two large feeds, small deliveries as in the medium group. */
export const V03_GROUP = { target: 72000, minStage: 6800, bigFeeds: 2, bigBytes: [8000, 10000], distractors: 0.9 };

/** Side variables: the large feeds carry their records. No question asks them. */
const SIDE = [
  { id: "side.cluster", label: "the staging cluster name", options: ["stg-amber", "stg-cobalt", "stg-indigo", "stg-jade", "stg-onyx"] },
  { id: "side.image", label: "the build runner image", options: ["runner-r41", "runner-r42", "runner-r43", "runner-r44", "runner-r45"] },
  { id: "side.board", label: "the status board id", options: ["board-k1", "board-k2", "board-k3", "board-k4", "board-k5"] },
];

const POOL_A = {
  topics: [
    { id: "ci", label: "the CI system", options: ["buildkite", "circleci", "drone-ci", "woodpecker", "teamcity"] },
    { id: "mesh", label: "the service mesh", options: ["istio", "linkerd", "consul-mesh", "kuma", "cilium-mesh"] },
    { id: "objstore", label: "the object store", options: ["minio", "ceph-rgw", "gcs-bucket", "azure-blob", "wasabi-s3"] },
    { id: "flagsvc", label: "the feature flag service", options: ["launchdarkly", "unleash", "flagsmith", "growthbook"] },
    { id: "tracing", label: "the tracing backend", options: ["jaeger", "grafana-tempo", "zipkin", "honeycomb", "lightstep"] },
    { id: "sitesearch", label: "the site search engine", options: ["algolia", "elasticsearch", "solr", "sphinx-se"] },
    { id: "mailer", label: "the email provider", options: ["sendgrid", "postmark", "mailgun", "ses-mail"] },
    { id: "secrets", label: "the secrets manager", options: ["hashicorp-vault", "doppler", "infisical", "aws-secrets"] },
    { id: "poolmax", label: "the connection pool limit", type: "int", options: [16, 32, 48, 64, 96] },
    { id: "rps", label: "the rate limit in requests per second", type: "int", options: [40, 80, 150, 250, 400] },
    { id: "keepdays", label: "the backup retention in days", type: "int", options: [7, 14, 21, 35, 49] },
    { id: "canary", label: "the canary deploy flag", type: "bool", options: [true, false] },
    { id: "freeze", label: "the release freeze flag", type: "bool", options: [true, false] },
  ],
  locales: ["ko-KR", "zh-TW", "tr-TR", "cs-CZ", "fi-FI", "da-DK", "nb-NO", "hu-HU", "ro-RO", "el-GR"],
};

const POOL_B = {
  services: [
    "order-svc", "pricing-api", "inventory-svc", "shipping-api", "review-svc", "coupon-svc", "tax-calc", "fraud-check",
    "session-svc", "catalog-api", "invoice-gen", "webhook-hub", "export-svc", "alert-svc",
  ],
  teamPairs: [
    ["team-orders", "team-fulfilment"], ["team-catalog", "team-merch"], ["team-risk", "team-trust"], ["team-checkout", "team-commerce"],
    ["team-sre", "team-reliability"], ["team-api", "team-interfaces"], ["team-ml", "team-models"],
  ],
  oncall: ["arlo", "bea", "cyrus", "dov", "esme", "finn", "greta", "hugo"],
};

const POOL_C = {
  flags: ["quick-pay", "geo-routing", "lazy-images", "inline-edit", "split-ledger", "bulk-tagging", "live-preview"],
  configs: [
    { id: "workers", label: "the worker count", options: [3, 6, 9, 12, 18] },
    { id: "chunk", label: "the chunk size", options: [200, 400, 800, 1600, 3200] },
    { id: "deadline", label: "the step deadline in seconds", options: [15, 25, 40, 90, 120] },
    { id: "replicas", label: "the replica count", options: [1, 3, 5, 7, 9] },
  ],
  pricing: ["rates-north", "rates-south", "rates-east", "rates-west"],
  schema: ["schema-r1", "schema-r2", "schema-r3", "schema-r4"],
  checkpoint: "snap-a",
};

const PARAMS_D = [
  { id: "maxconn", label: "the maximum concurrent connections", type: "int", options: [50, 100, 200, 400, 800] },
  { id: "encoding", label: "the text encoding", options: ["utf-8", "utf-16le", "latin-1", "ascii-7"] },
  { id: "cipher", label: "the disk encryption cipher", options: ["aes-256-gcm", "chacha20", "aes-128-cbc", "xts-aes"] },
  { id: "idle", label: "the idle timeout in seconds", type: "int", options: [20, 40, 90, 180, 300] },
  { id: "backup", label: "the backup interval in hours", type: "int", options: [2, 4, 6, 12, 24] },
  { id: "codec", label: "the compression codec", options: ["zstd", "gzip", "brotli", "lz4", "snappy"] },
  { id: "audit", label: "the audit trail mode", type: "bool", options: [true, false] },
  { id: "dc", label: "the primary data center", options: ["dc-fra1", "dc-ams2", "dc-lon3", "dc-par4", "dc-mad5"] },
  { id: "burst", label: "the burst quota per minute", type: "int", options: [60, 150, 350, 700, 1500] },
  { id: "signing", label: "the token signing algorithm", options: ["rs256", "es256", "eddsa", "hs512"] },
];

const POOL_D5 = {
  params: PARAMS_D,
  theme: {
    order: ["regulator-notice", "master-agreement", "partner-sheet", "forum", "ticket"],
    docs: { "regulator-notice": "REG", "master-agreement": "MSA", "partner-sheet": "PS", forum: "FORUM", ticket: "TKT" },
  },
};
const POOL_D6 = {
  params: PARAMS_D,
  theme: {
    order: ["board-resolution", "architecture-record", "handbook", "slack", "memo"],
    docs: { "board-resolution": "BRD", "architecture-record": "ADR", handbook: "HB", slack: "SLK", memo: "MEMO" },
  },
};

const POOL_E5 = {
  theme: {
    feature: "the mobile offline mode",
    criteria: ["ac-sync-on-reconnect", "ac-conflict-banner", "ac-queue-limit-500", "ac-battery-budget", "ac-encrypted-cache", "ac-airplane-test", "ac-manual-retry"],
    steps: ["step-local-db", "step-sync-engine", "step-conflict-ui", "step-queue-store", "step-cache-crypto", "step-device-tests", "step-release-notes", "step-telemetry"],
    rejected: ["full-db-download", "polling-every-5s", "plain-text-cache", "server-merge-only", "websocket-only-sync"],
    details: [
      { id: "syncint", label: "the sync interval in seconds", type: "int", options: [15, 30, 60, 120, 300] },
      { id: "cachedb", label: "the local cache engine", options: ["sqlite-wal", "realm-db", "leveldb", "watermelondb"] },
    ],
  },
};
const POOL_E6 = {
  theme: {
    feature: "the notification service split",
    criteria: ["ac-no-duplicate-push", "ac-quiet-hours", "ac-per-user-opt-out", "ac-delivery-receipts", "ac-p99-under-2s", "ac-template-preview", "ac-rate-cap"],
    steps: ["step-topic-model", "step-fanout-worker", "step-template-store", "step-push-adapter", "step-sms-adapter", "step-soak-test", "step-dashboards", "step-decommission"],
    rejected: ["shared-monolith-queue", "cron-batch-sends", "per-device-threads", "inline-html-templates", "global-send-lock"],
    details: [
      { id: "broker", label: "the fan-out broker", options: ["kafka-topics", "pulsar", "nats-jetstream", "redpanda"] },
      { id: "batchmax", label: "the maximum batch per send", type: "int", options: [50, 100, 250, 500, 1000] },
    ],
  },
};

const BASE = { profile: "compaction", size: "v03", group: V03_GROUP, range: V03_RANGE, v03: { side: SIDE } };

/** The 10 tasks with their recorded seeds. Ids: <category>5-<slug> with one compaction, <category>6-<slug> with two. */
export const V03_TASKS = [
  { ...BASE, taskId: "A5-ci-platform", category: "A", seed: 700098, stages: 6, compactAfter: [4], entities: 7, updates: 14, depth: 1, focus: "ci", bigFeedName: "audit", pools: POOL_A,
    lead: "You help a platform team choose the tools of a new build and deploy pipeline. Decisions change as the pilots report back." },
  { ...BASE, taskId: "A6-mesh-rollout", category: "A", seed: 725014, stages: 7, compactAfter: [4, 6], entities: 8, updates: 16, depth: 1, focus: "mesh", bigFeedName: "activity", pools: POOL_A,
    lead: "You follow the rollout of a service mesh across a cluster fleet. The infrastructure group revises its choices more than once." },
  { ...BASE, taskId: "B5-commerce-teams", category: "B", seed: 750124, stages: 6, compactAfter: [4], entities: 6, updates: 12, depth: 2, bigFeedName: "ops-log", pools: POOL_B,
    lead: "You keep track of which commerce team owns which service and how the services call each other." },
  { ...BASE, taskId: "B6-catalog-split", category: "B", seed: 775137, stages: 7, compactAfter: [4, 6], entities: 8, updates: 16, depth: 3, bigFeedName: "audit", pools: POOL_B,
    lead: "You follow the split of a large catalog platform: teams get new names, services move and dependencies change." },
  { ...BASE, taskId: "C5-pay-switch", category: "C", seed: 800053, stages: 6, compactAfter: [4], entities: 6, updates: 14, depth: 1, bigFeedName: "activity", pools: POOL_C,
    lead: "You follow the switch of a payment flow behind feature flags, with one data migration. The runbook rules decide which steps take effect." },
  { ...BASE, taskId: "C6-data-replatform", category: "C", seed: 825066, stages: 7, compactAfter: [4, 6], entities: 8, updates: 18, depth: 3, bigFeedName: "ops-log", pools: POOL_C,
    lead: "You follow a data platform move with chained migrations, a settings checkpoint and a selective rollback." },
  { ...BASE, taskId: "D5-partner-terms", category: "D", seed: 850079, stages: 6, compactAfter: [4], entities: 7, updates: 18, depth: 3, bigFeedName: "audit", pools: POOL_D5,
    lead: "You settle the technical terms of a partner integration from notices, agreements, partner sheets, a forum and tickets. They often disagree." },
  { ...BASE, taskId: "D6-platform-limits", category: "D", seed: 875092, stages: 7, compactAfter: [4, 6], entities: 8, updates: 20, depth: 3, bigFeedName: "activity", pools: POOL_D6,
    lead: "You settle the limits of a shared platform from board resolutions, architecture records, a handbook, chat and memos." },
  { ...BASE, taskId: "E5-offline-mode", category: "E", seed: 900105, stages: 6, compactAfter: [4], entities: 7, updates: 18, depth: 2, bigFeedName: "ops-log", pools: POOL_E5,
    lead: "You work with a mobile team on an offline mode over several days. Keep the requirements, the decisions and the progress straight." },
  { ...BASE, taskId: "E6-notify-split", category: "E", seed: 926961, stages: 7, compactAfter: [4, 6], entities: 8, updates: 20, depth: 2, bigFeedName: "audit", pools: POOL_E6,
    lead: "You work with a team that splits notifications out of a monolith. Keep the acceptance criteria, the rejected ideas and the progress straight." },
];

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** All 20 files as { relativePath: content }, relative to tasks/v03/. */
export function generateAllV03(tasks = V03_TASKS) {
  const out = {};
  for (const spec of tasks) {
    const { task, key } = generateTask(spec);
    out[`generated/${spec.taskId}.task.json`] = serialize(task);
    out[`keys/${spec.taskId}.key.json`] = serialize(key);
  }
  return out;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** FROZEN.json content: the generator commit, the seeds and the SHA-256 of every task and key file. */
export function frozenRecord(commit, files) {
  return {
    schema: 1,
    experiment: "v03-placebo",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v03.mjs",
    tasks: V03_TASKS.map((s) => ({
      taskId: s.taskId,
      category: s.category,
      seed: s.seed,
      compactAfter: s.compactAfter,
      task: { path: `generated/${s.taskId}.task.json`, sha256: sha256(files[`generated/${s.taskId}.task.json`]) },
      key: { path: `keys/${s.taskId}.key.json`, sha256: sha256(files[`keys/${s.taskId}.key.json`]) },
    })),
  };
}

function main(argv) {
  const files = generateAllV03();
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V03_DIR, rel);
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
      if (readFileSync(join(V03_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v03.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V03_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V03_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V03_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V03_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V03_DIR}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
