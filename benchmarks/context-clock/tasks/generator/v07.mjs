#!/usr/bin/env node
// Context Clock v0.7 experiment: 6 harder held-out compaction tasks (EXPERIMENT-V07.md, section "Tasks").
// - About twice the tracked items of the v06 tasks, and more changes for each item.
// - 8 stages, a compaction after stages 3, 5 and 7, a probe turn after each compaction.
// - A10-observability-stack tracks the reason of each tracked decision. C10 tracks conditions that tie a permit item to a flag.
// Same families and builders as before, with new recorded seeds, new slugs and new value pools. Writes
// tasks/v07/generated/<taskId>.task.json, tasks/v07/keys/<taskId>.key.json and tasks/v07/reference/<taskId>.state.json
// (reference schema 2).
//
// Difficulty: generateOneV07(spec, { difficulty }) scales the item count, the change count and the question mix. The
// recorded seed is a base seed: the generator tries base, base + 1, ... and takes the first seed that passes every
// rule. Thus a revision with another difficulty is a seed-stable regeneration.
//
//   node benchmarks/context-clock/tasks/generator/v07.mjs                  rewrite the 18 files
//   node benchmarks/context-clock/tasks/generator/v07.mjs --check          exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v07.mjs --freeze         write tasks/v07/FROZEN.json (status candidate)
//   node benchmarks/context-clock/tasks/generator/v07.mjs --difficulty 2   another difficulty (also with --check)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR, generateTask, validateV03 } from "./generate.mjs";
import { createMachine } from "./reference.mjs";
import { createRng } from "./rng.mjs";
import { factName, stateFacts, stateText } from "./refstate.mjs";

export const V07_DIR = join(TASKS_DIR, "v07");
/** 1.3 to 1.5 times the bytes of a v06 task (69 700 to 71 900 bytes). */
export const V07_RANGE = [92000, 107000];
export const V07_GROUP = { target: 104000, minStage: 8000, bigFeeds: 2, bigBytes: [8000, 10000], distractors: 0.9 };
export const V07_STATE_TEXT_MAX_BYTES = 4000;
export const V07_COMPACT_AFTER = [3, 5, 7];
export const DEFAULT_DIFFICULTY = 1;
/** Seed attempts from the base seed before the generator gives up. */
const SEED_TRIES = 400;

/** Side variables: the large feeds carry their records. No question asks them, and the reference state omits them. */
const SIDE = [
  { id: "side.cluster", label: "the perf cluster name", options: ["perf-heron", "perf-ibex", "perf-jackal", "perf-kudu", "perf-lemur"] },
  { id: "side.image", label: "the base container image", options: ["baseimg-d41", "baseimg-d42", "baseimg-d43", "baseimg-d44", "baseimg-d45"] },
  { id: "side.board", label: "the wall screen id", options: ["screen-s61", "screen-s62", "screen-s63", "screen-s64", "screen-s65"] },
];
export const SIDE_IDS = new Set(SIDE.map((s) => s.id));

// ---------------------------------------------------------------------------------------------------------------
// Value pools. No value of an earlier task set is reused (the tests check it).

const POOL_A = {
  topics: [
    { id: "warehouse", label: "the data warehouse", options: ["snowflake-dw", "bigquery-dw", "redshift-dw", "databricks-sql", "duckdb-dw"] },
    { id: "tablefmt", label: "the table format", options: ["iceberg-tbl", "delta-tbl", "hudi-tbl", "paimon-tbl"] },
    { id: "orch", label: "the job orchestrator", options: ["dagster-io", "mage-ai", "luigi-jobs", "kestra-io"] },
    { id: "stream", label: "the stream processor", options: ["flink-sp", "spark-ss", "kstreams-sp", "materialize-sp"] },
    { id: "catalog", label: "the data catalog", options: ["datahub-cat", "amundsen-cat", "openmeta-cat", "unity-cat"] },
    { id: "transform", label: "the transform tool", options: ["dbt-core", "sqlmesh-tool", "dataform-tool", "coalesce-tool"] },
    { id: "bi", label: "the dashboard tool", options: ["superset-bi", "metabase-bi", "looker-bi", "lightdash-bi"] },
    { id: "ingest", label: "the ingestion tool", options: ["airbyte-io", "fivetran-io", "meltano-io", "singer-io"] },
    { id: "quality", label: "the data quality checker", options: ["great-expect", "soda-core", "deequ-check", "elementary-dq"] },
    { id: "lineage", label: "the lineage tracker", options: ["openlineage-tr", "marquez-tr", "spline-tr", "egeria-tr"] },
    { id: "secrets", label: "the secrets store", options: ["vault-hc", "doppler-sec", "infisical-sec", "sops-age"] },
    { id: "objstore", label: "the object store", options: ["minio-s3", "ceph-rgw", "gcs-bucket", "r2-bucket"] },
    { id: "notebook", label: "the notebook server", options: ["jupyterhub-nb", "zeppelin-nb", "hex-nb", "marimo-nb"] },
    { id: "partmb", label: "the partition size in MB", type: "int", options: [48, 96, 192, 384, 768] },
    { id: "colmask", label: "the column masking flag", type: "bool", options: [true, false] },
  ],
  locales: ["mt-MT", "ga-IE", "cy-GB", "eu-ES", "gl-ES", "ca-AD", "lb-LU", "mk-MK", "sq-AL", "bs-BA"],
  extra: [
    { id: "querymin", label: "the query timeout in minutes", type: "int", options: [3, 9, 27, 45, 90] },
    { id: "rawdays", label: "the raw data retention in days", type: "int", options: [14, 28, 56, 112, 400] },
    { id: "costalert", label: "the cost alert flag", type: "bool", options: [true, false] },
  ],
};

const POOL_F = {
  topics: [
    { id: "metrics", label: "the metrics backend", options: ["victoria-mx", "thanos-store", "mimir-tsdb", "cortex-store"] },
    { id: "tracing", label: "the tracing backend", options: ["jaeger-tr", "tempo-tr", "zipkin-tr", "signoz-tr"] },
    { id: "logstore", label: "the log store", options: ["loki-store", "quickwit-store", "openobserve", "graylog-store"] },
    { id: "alertrt", label: "the alert router", options: ["alertmanager", "opsgenie-rt", "pagerduty-rt", "grafana-oncall"] },
    { id: "collector", label: "the telemetry collector", options: ["otelcol-contrib", "telegraf-agent", "vector-agent", "beyla-agent"] },
    { id: "profiler", label: "the continuous profiler", options: ["pyroscope-prof", "parca-prof", "polar-signals", "dd-profiler"] },
    { id: "uptime", label: "the uptime checker", options: ["uptime-kuma", "gatus-check", "blackbox-exp", "checkly-check"] },
    { id: "statushost", label: "the status page host", options: ["cachet-host", "instatus-host", "statuspal-host", "atlassian-sp"] },
    { id: "incident", label: "the incident tracker", options: ["incident-io", "rootly-ir", "firehydrant-ir", "dispatch-ir"] },
    { id: "scrape", label: "the scrape interval in seconds", type: "int", options: [7, 14, 21, 42, 84] },
    { id: "exemplar", label: "the exemplar storage flag", type: "bool", options: [true, false] },
  ],
  locales: ["hy-AM", "ka-GE", "az-AZ", "kk-KZ", "uz-UZ", "mn-MN", "ne-NP", "si-LK", "km-KH", "lo-LA"],
  extra: [
    { id: "samplepm", label: "the trace sample rate per mille", type: "int", options: [2, 8, 32, 128, 512] },
    { id: "logsample", label: "the log sampling flag", type: "bool", options: [true, false] },
  ],
  reasons: ["rsn-cost", "rsn-latency", "rsn-security", "rsn-compliance", "rsn-ops-load", "rsn-vendor-lock", "rsn-team-skill"],
};

const POOL_B = {
  services: [
    "patient-api", "booking-svc", "triage-bot", "lab-results", "rx-orders", "claims-svc", "consent-svc", "imaging-store",
    "ehr-sync", "nurse-roster", "bed-tracker", "referral-hub", "telehealth-gw", "pharmacy-svc", "insurer-gw", "vitals-ingest",
    "discharge-svc", "audit-log-svc",
  ],
  teamPairs: [
    ["team-intake", "team-admissions"], ["team-labs", "team-diagnostics"], ["team-claims", "team-revenue"], ["team-records", "team-charts"],
    ["team-pharmacy", "team-meds"], ["team-telecare", "team-virtual"],
  ],
  oncall: ["abebe", "bruna", "ciaran", "dilnoza", "esko", "farah", "goran", "hiro"],
};

const POOL_C = {
  flags: ["fx-rates-v3", "card-tokens", "payout-batching", "risk-scoring", "sepa-instant", "refund-queue", "ledger-split", "chargeback-ui", "wallet-topup", "kyc-recheck"],
  configs: [
    { id: "settleq", label: "the settlement queue depth", options: [40, 80, 160, 320, 640] },
    { id: "retryms", label: "the gateway retry delay in ms", options: [250, 750, 1500, 3000, 6000] },
    { id: "fraudthr", label: "the fraud score threshold", options: [55, 65, 72, 81, 93] },
    { id: "batchwin", label: "the payout window in minutes", options: [10, 25, 40, 75, 150] },
  ],
  pricing: ["fee-grid-p1", "fee-grid-p2", "fee-grid-p3", "fee-grid-p4"],
  schema: ["pay-s40", "pay-s41", "pay-s42", "pay-s43"],
  checkpoint: "snap-c10",
  extra: [
    { id: "dispdays", label: "the dispute window in days", type: "int", options: [7, 21, 45, 60, 120] },
    { id: "minpayout", label: "the minimum payout in cents", type: "int", options: [500, 1500, 2500, 5000, 9900] },
    { id: "cardretry", label: "the card retry count", type: "int", options: [1, 2, 4, 6, 9] },
    { id: "holdhours", label: "the risk hold in hours", type: "int", options: [6, 18, 36, 72, 168] },
  ],
  permits: [
    { id: "refundtool", label: "the bulk refund tool" },
    { id: "payoutexport", label: "the partner payout export" },
    { id: "weekendrun", label: "the weekend settlement run" },
  ],
};

const PARAMS_D = [
  { id: "fwaction", label: "the firewall default action", options: ["fw-deny", "fw-reject", "fw-allow-log", "fw-drop"] },
  { id: "vpn", label: "the VPN protocol", options: ["wireguard-vpn", "ipsec-ikev2", "openvpn-udp", "tailnet-vpn"] },
  { id: "resolver", label: "the DNS resolver", options: ["unbound-res", "coredns-res", "knot-res", "dnsmasq-res"] },
  { id: "lbmode", label: "the load balancer mode", options: ["lb-round-robin", "lb-least-conn", "lb-ip-hash", "lb-maglev"] },
  { id: "ca", label: "the certificate authority", options: ["step-ca", "acme-ca", "vault-pki", "ejbca-pki"] },
  { id: "proxyproto", label: "the proxy protocol version", options: ["proxy-v1", "proxy-v2", "proxy-off", "proxy-h2"] },
  { id: "egress", label: "the egress gateway", options: ["egress-nat-a", "egress-nat-b", "egress-squid", "egress-envoy"] },
  { id: "bgptag", label: "the BGP community tag", options: ["bgp-65001", "bgp-65010", "bgp-65100", "bgp-65500"] },
  { id: "idle", label: "the connection idle timeout in seconds", type: "int", options: [45, 90, 180, 360, 900] },
  { id: "mtu", label: "the MTU size in bytes", type: "int", options: [1280, 1420, 1460, 1500, 9001] },
  { id: "ratelimit", label: "the rate limit per client per second", type: "int", options: [20, 75, 150, 400, 1000] },
  { id: "portstart", label: "the port range start", type: "int", options: [20000, 30000, 40000, 49152, 55000] },
  { id: "hcint", label: "the health check interval in seconds", type: "int", options: [3, 6, 12, 24, 48] },
  { id: "dualstack", label: "the IPv6 dual stack mode", type: "bool", options: [true, false] },
  { id: "pcap", label: "the packet capture mode", type: "bool", options: [true, false] },
  { id: "strictsni", label: "the strict SNI mode", type: "bool", options: [true, false] },
];
const POOL_D = {
  params: PARAMS_D,
  theme: {
    order: ["netsec-policy", "arch-review", "ops-runbook", "team-chat-log", "ticket-comment"],
    docs: { "netsec-policy": "NSP", "arch-review": "ARV", "ops-runbook": "RUN", "team-chat-log": "CHAT", "ticket-comment": "TKT" },
  },
};

const POOL_E = {
  theme: {
    feature: "the notification hub",
    criteria: [
      "ac-push-under-2s", "ac-quiet-window", "ac-digest-mode", "ac-per-user-optout", "ac-sms-fallback", "ac-preview-render",
      "ac-locale-aware", "ac-dedupe-sends", "ac-audit-every-send", "ac-rate-cap-tenant",
    ],
    steps: [
      "step-event-intake", "step-router-core", "step-tpl-registry", "step-apns-bridge", "step-sms-bridge", "step-email-adapter",
      "step-optout-store", "step-digest-job", "step-soak-run", "step-ops-dashboard", "step-runbook-doc", "step-pilot-tenant",
    ],
    rejected: ["poll-every-second", "shared-api-keys", "inline-html-mail", "global-send-lock", "manual-retry-only", "per-tenant-forks", "sms-only-delivery"],
    details: [
      { id: "channel", label: "the default channel", options: ["chan-push", "chan-email", "chan-sms", "chan-inapp"] },
      { id: "digesth", label: "the digest interval in hours", type: "int", options: [2, 4, 8, 12, 24] },
    ],
  },
  extra: [
    { id: "tplengine", label: "the template engine", options: ["mjml-tpl", "handlebars-tpl", "liquid-tpl", "jinja-tpl"] },
    { id: "pushprov", label: "the push provider", options: ["fcm-push", "apns-direct", "onesignal-push", "pusher-beams"] },
    { id: "senddom", label: "the sender domain", options: ["mx-notify-a", "mx-notify-b", "mx-alerts-c", "mx-ping-d"] },
    { id: "retrybudget", label: "the retry budget per message", type: "int", options: [2, 3, 5, 8, 13] },
    { id: "filterwin", label: "the duplicate filter window in minutes", type: "int", options: [1, 5, 15, 30, 60] },
    { id: "payloadkb", label: "the payload size limit in KB", type: "int", options: [4, 16, 32, 64, 128] },
    { id: "quietstart", label: "the quiet hours start hour", type: "int", options: [19, 20, 21, 22, 23] },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Rules. The intro of each task states every rule by which a tracked value, a reason or a condition changes.

const AT_SOME_POINT = "- A question about the values of an item \"at some point\" counts every value from the initial specification on, up to the time of the question.";
const COMMON_RULES = [
  "Rules for this task:",
  "- A value changes only by an event that decides, corrects, adds, removes, renames, runs or restores it. A proposal, a question, a link or a quote of an old page changes nothing.",
  "- A correction or a new decision replaces the earlier value. The earlier value is then superseded.",
  "- The initial specification gives the first value of each item.",
  AT_SOME_POINT,
];
const RULES_A = [
  "- Each tool and each setting has one current decision. A new decision for it replaces the earlier one.",
  "- A superseded value of an item is a value that was its decision at some time, the initial specification included, and is not its current decision.",
  "- A locale is supported from the event that adds it until an event removes it.",
];
const reasonRules = (reasons) => [
  `- Some decisions have a recorded reason. A reason is one id of this closed list: ${reasons.map((r) => `\`${r}\``).join(", ")}.`,
  "- Each decision with a recorded reason has one reason at a time. An entry that records a reason for it replaces the earlier reason.",
  "- A new decision for such an item comes with an entry that records its reason. A later entry can replace the reason and keep the decision.",
  "- A reason changes only by an entry that records it. A new decision with no such entry keeps the earlier reason. A proposed reason changes nothing.",
];
const conditionRules = () => [
  "- Each permit item has one condition at a time. The condition `while-<flag>-on` means that the item is allowed only while that flag is ON. The condition `while-<flag>-off` means that it is allowed only while that flag is OFF. The condition `always-allowed` means that it is allowed at all times.",
  "- Only an event that changes the condition of an item replaces its condition. A change of a flag never changes a condition. It changes only whether an item is allowed.",
  "- An item is allowed at a moment when its condition at that moment holds for the value of its flag at that moment.",
];

/** The rules of a kind with the reason list of a pool (v08 tasks pass their own reason ids). */
export function rulesFor(kind, reasons) {
  return kind === "F" ? [...COMMON_RULES, ...RULES_A, ...reasonRules(reasons)] : V07_RULES[kind];
}

export const V07_RULES = {
  A: [...COMMON_RULES, ...RULES_A],
  F: [...COMMON_RULES, ...RULES_A, ...reasonRules(POOL_F.reasons)],
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
    "- A checkpoint records the current settings. A rollback event sets each setting that it names back to its value at that checkpoint. Every other value keeps its current value. A rollback never changes a migration status or a condition.",
    ...conditionRules(),
  ],
  D: [
    "Rules for this task:",
    "- A value changes only by a document that states it or by the withdrawal of a document. A proposal, a question, a link or a quote of an old page changes nothing.",
    "- The value of a parameter comes from the valid documents that state it. The highest source decides. Inside that source, the document with the higher version decides.",
    "- A new document of a lower source does not replace the value of a higher source.",
    "- A withdrawn document is not valid. The value then comes from the other valid documents by the same rule.",
    "- The initial specification gives the first value of each item.",
    AT_SOME_POINT,
  ],
  E: [
    ...COMMON_RULES,
    "- The acceptance criteria, the planned steps, the completed steps and the rejected approaches are lists. An event adds an item to a list or removes an item from it.",
    "- A step is outstanding when it is in the planned steps and not in the completed steps.",
    "- An approach is rejected while it is in the list of rejected approaches. A suggestion to use it again does not change the list.",
    "- A decision on a detail replaces the earlier decision for that detail.",
  ],
};

/** Question texts with a second fair reading, and their v07 form (as in v06). The probe texts derive from these. */
const REWRITES = [
  [/^What is the final status of ((?:\S+ )?migration m\d+)\?$/, "What is the status of $1 now?"],
  [/^Does (\S+) depend on (`[^`]+`) now\?$/, "Is $2 a direct dependency of $1 now?"],
  [/^Which services does (\S+) depend on now\?$/, "Which services are direct dependencies of $1 now?"],
];

// ---------------------------------------------------------------------------------------------------------------
// The v07 hook: runs after the builder, before distractors, large feeds and routine records.

const NUM = " Answer with a number.";
const BOOL = " Answer true for ON, false for OFF.";
const REASON_TEMPLATES = {
  set: ["{P} recorded {L}: {V}.", "For the record, {P} wrote down {L}: {V}."],
  supersede: ["{P} replaced {L}. It is now {V}. The decision itself stays as it is.", "New reason from {P} for the same decision: {L} is now {V}."],
};
const CONDITION_TEMPLATES = {
  set: ["Policy update from {P}: {L} is now {V}.", "{P} changed {L}. It is now {V}."],
  supersede: ["Correction from {P}: {L} is {V}. The earlier condition no longer applies.", "{P} replaced {L} with {V}."],
};

function varType(t) {
  return t.type === "int" ? "int" : t.type === "bool" ? "bool" : "scalar";
}

/** Extra tracked items with an initial value and `changes` later changes each, at seeded stages 1..stages. */
function addItems(story, rng, defs, changes) {
  const ids = [];
  for (const d of defs) {
    const id = story.var(d.id, { label: d.label, type: varType(d), options: d.options });
    story.set(0, id, rng.pick(d.options));
    const stages = Array.from({ length: changes }, () => rng.int(1, story.stages)).sort((a, b) => a - b);
    const seen = [story.cur[id]];
    for (const s of stages) {
      const prev = story.cur[id];
      const next = d.type === "bool" ? !prev : seen.length > 1 && rng.chance(0.3) ? rng.pickOther(seen, prev) : rng.pickOther(d.options, prev);
      story.set(s, id, next, { kind: seen.length > 1 || rng.chance(0.5) ? "supersede" : "state" });
      seen.push(next);
    }
    ids.push(id);
  }
  return ids;
}

/** Moves the last `n` events of the story directly after event `after`. */
function moveAfter(story, after, n) {
  const moved = story.events.splice(story.events.length - n, n);
  story.events.splice(story.events.indexOf(after) + 1, 0, ...moved);
}

function q(story, def) {
  story.q(def);
}

/** A10-observability-stack: a reason for each of the first `k` scalar decisions. */
function addReasons(story, rng, reasons, k, extraChanges) {
  const topics = Object.entries(story.vars).filter(([, v]) => v.type === "scalar" && !v.mode).slice(0, k);
  const out = [];
  for (const [tid, tv] of topics) {
    const id = story.var(`reason.${tid}`, { label: `the reason for the ${tv.label.replace(/^the /, "")} decision`, options: reasons, templates: REASON_TEMPLATES });
    story.set(0, id, rng.pick(reasons));
    // Each later decision of the topic comes with a reason entry directly after it.
    for (const e of story.events.filter((x) => x.stage > 0 && x.op.op === "set" && x.op.var === tid)) {
      story.set(e.stage, id, rng.pickOther(reasons, story.cur[id]), { kind: "state" });
      moveAfter(story, e, 1);
    }
    // Reason-only replacements: the decision stays.
    for (let i = 0; i < extraChanges; i += 1) {
      const s = rng.int(1, story.stages);
      story.set(s, id, rng.pickOther(reasons, story.cur[id]), { kind: "supersede" });
    }
    out.push(id);
  }
  // The entries were made in insertion order, not in time order. Walk the final order (stage, then insertion) and
  // make each reason entry a real change of the reason. Then the steering copy holds the true values.
  const order = story.events.map((e, i) => [e, i]).sort((x, y) => x[0].stage - y[0].stage || x[1] - y[1]).map(([e]) => e);
  const now = {};
  for (const e of order) {
    if (e.op.op !== "set" || !out.includes(e.op.var)) continue;
    if (now[e.op.var] === e.op.value) e.op.value = rng.pickOther(reasons, e.op.value);
    now[e.op.var] = e.op.value;
  }
  for (const id of out) story.cur[id] = now[id];
  return out;
}

/**
 * D10: claims of the top source for `n` parameters that have no top-source claim yet, `changes` for each. The top
 * source decides, so each claim changes the value. Versions rise in time order above every earlier top-source version.
 */
function addTopClaims(story, rng, theme, n, changes) {
  const TOP = theme.order[0];
  const claims = story.events.filter((e) => e.op.op === "claim");
  const topped = new Set(claims.filter((e) => e.op.source === TOP).map((e) => e.op.var));
  let version = Math.max(0, ...claims.filter((e) => e.op.source === TOP).map((e) => e.op.version));
  const cand = Object.keys(story.vars).filter((id) => story.vars[id].mode === "claims" && !topped.has(id));
  const chosen = rng.sample(cand, Math.min(n, cand.length));
  const plan = chosen.flatMap((id) => Array.from({ length: changes }, () => ({ id, stage: rng.int(1, story.stages) })));
  plan.sort((a, b) => a.stage - b.stage);
  const last = {};
  let docNo = 800;
  for (const c of plan) {
    const v = story.vars[c.id];
    // The value at this moment: replay the events up to this stage in time order.
    const m = createMachine(story.vars);
    for (const e of story.events.map((x, i) => [x, i]).sort((a, b) => a[0].stage - b[0].stage || a[1] - b[1]).map(([x]) => x)) {
      if (e.stage > c.stage) break;
      m.apply(e.op);
    }
    const now = m.valueOf(c.id);
    const value = v.type === "bool" ? !now : rng.pickOther(v.options, now);
    version += rng.int(1, 2);
    docNo += rng.int(3, 40);
    story.ev(c.stage, last[c.id] === undefined ? "state" : "supersede", { op: "claim", var: c.id, value, source: TOP, version, doc: `${theme.docs[TOP]}-${docNo}` });
    last[c.id] = value;
  }
  return chosen;
}

/** C10: a condition for each permit item. Options: every flag of the task, ON or OFF, and always-allowed. */
function addConditions(story, rng, permits, changes) {
  const flags = Object.keys(story.vars).filter((id) => id.startsWith("flag."));
  const rules = { "always-allowed": null };
  for (const f of flags) {
    const name = f.slice(5);
    rules[`while-${name}-on`] = { var: f, eq: true };
    rules[`while-${name}-off`] = { var: f, eq: false };
  }
  const options = Object.keys(rules);
  const out = [];
  for (const pm of permits) {
    const id = story.var(`cond.${pm.id}`, { label: `the condition of ${pm.label}`, options, templates: CONDITION_TEMPLATES, permit: pm.label });
    const pick = (prev) => {
      const f = rng.pick(flags).slice(5);
      const c = rng.chance(0.12) ? "always-allowed" : `while-${f}-${rng.chance(0.6) ? "on" : "off"}`;
      return c === prev ? pick(prev) : c;
    };
    story.set(0, id, pick(null));
    const stages = Array.from({ length: changes }, () => rng.int(1, story.stages)).sort((a, b) => a - b);
    let seen = 1;
    for (const s of stages) {
      story.set(s, id, pick(story.cur[id]), { kind: seen > 1 ? "supersede" : "state" });
      seen += 1;
    }
    out.push({ id, label: pm.label, rules });
  }
  return out;
}

/**
 * The v07 hook of one task. d: the difficulty (1 is the base). It adds items, reasons or conditions, rewrites
 * question texts with a second fair reading and builds a final set of 8 to 10 questions.
 */
function makePrepare(kind, d) {
  return function prepare(story, p) {
    const rng = createRng(p.seed * 7 + 104729);
    for (const qq of story.questions) for (const [re, to] of REWRITES) qq.text = qq.text.replace(re, to);
    const changes = 2 + d;
    const scalars = () => Object.entries(story.vars).filter(([id, v]) => !SIDE_IDS.has(id) && v.type !== "set");
    if (kind === "A") {
      const extra = addItems(story, rng, p.pools.extra.slice(0, 2 + d), changes);
      const asked = new Set(story.questions.map((x) => x.query.var));
      const [, second] = story.questions.filter((x) => x.query.q === "value" && story.vars[x.query.var].type === "scalar").map((x) => x.query.var);
      q(story, { text: `Which values were decided for ${story.vars[second].label} at some point and are no longer the decision? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: second } });
      const intId = extra.find((id) => story.vars[id].type === "int" && !asked.has(id));
      q(story, { text: `What is ${story.vars[intId].label} now?${NUM}`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: intId } });
      if (d >= 2) {
        const b = extra.find((id) => story.vars[id].type === "bool");
        q(story, { text: `Is ${story.vars[b].label} ON now?${BOOL}`, type: "bool", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: b } });
      }
    }
    if (kind === "F") {
      addItems(story, rng, p.pools.extra.slice(0, 1 + d), changes);
      const reasons = addReasons(story, rng, p.pools.reasons, 4 + d, d);
      const label = (id) => story.vars[id].label;
      // The current reason of the hot decision, the replaced reasons of a second one, a count over all reasons.
      q(story, { text: `What is ${label(reasons[0])} now? Answer with the reason id.`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: reasons[0] } });
      q(story, { text: `Which reasons were recorded for the ${label(reasons[1]).replace(/^the reason for the /, "")} at some point and are no longer its reason? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: reasons[1] } });
      const target = story.cur[reasons[2]];
      q(story, { text: `Of the ${reasons.length} decisions with a recorded reason, how many have the reason \`${target}\` now?${NUM}`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "countEq", vars: reasons, value: target } });
      // Keep 10: drop the locale question, which v06 already asked in this family.
      const loc = story.questions.findIndex((x) => x.query.var === "locales");
      if (story.questions.length > 10 && loc >= 0) story.questions.splice(loc, 1);
    }
    if (kind === "B") {
      const asked = new Set(story.questions.map((x) => x.query.var));
      const oncall = scalars().filter(([id]) => id.startsWith("oncall.")).map(([id]) => id);
      const on = oncall.find((id) => asked.has(id)) ?? oncall[0];
      q(story, { text: `Which engineers were on call for ${on.slice(7)} at some point and are not on call for it now? List every one.`, type: "set", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "superseded", var: on } });
      const owner = scalars().find(([id]) => id.startsWith("owner.") && !asked.has(id))[0];
      q(story, { text: `Which team owns ${owner.slice(6)} now? Use the team's current name.`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: owner } });
    }
    if (kind === "C") {
      addItems(story, rng, p.pools.extra.slice(0, 2 + d), changes);
      const conds = addConditions(story, rng, p.pools.permits.slice(0, 2 + d), changes);
      // Make room: drop the second config question of the builder.
      const drop = story.questions.findIndex((x) => x.aspect === "current_state" && x.type === "int");
      if (drop >= 0) story.questions.splice(drop, 1);
      const [c0, c1] = conds;
      q(story, { text: `What is ${story.vars[c0.id].label} now? Answer with the condition id.`, type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: c0.id } });
      q(story, { text: `Is ${c1.label} allowed now? Answer true or false.`, type: "bool", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "allowed", cond: c1.id, rules: c1.rules } });
      q(story, { text: `Which conditions applied to ${c0.label} at some point and do not apply now? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "invalid_transition", query: { q: "superseded", var: c0.id } });
    }
    if (kind === "D") {
      const asked = new Set(story.questions.map((x) => x.query.var));
      const topped = addTopClaims(story, rng, p.pools.theme, 4 + 2 * d, changes);
      // Prefer the parameters with new top-source claims, then the ones with the most claims: their answers change.
      const claimsOf = (id) => (topped.includes(id) ? 100 : 0) + story.events.filter((e) => e.stage > 0 && e.op.op === "claim" && e.op.var === id).length;
      const free = scalars().filter(([id, v]) => v.mode === "claims" && !asked.has(id)).sort((x, y) => claimsOf(y[0]) - claimsOf(x[0]));
      const [sid, sv] = free.find(([, v]) => v.type === "scalar") ?? free[0];
      const [iid, iv] = free.find(([, v]) => v.type === "int" && v !== sv) ?? free[1];
      q(story, { text: `Under the precedence rule, what is ${sv.label} now?`, type: "choice", aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "value", var: sid } });
      q(story, { text: `Under the precedence rule, what is ${iv.label} now?${NUM}`, type: "int", aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "value", var: iid } });
    }
    if (kind === "E") {
      const extra = addItems(story, rng, p.pools.extra.slice(0, 5 + d), changes);
      const [id0, v0] = Object.entries(story.vars).find(([, x]) => x.type === "scalar");
      q(story, { text: `In the initial specification, what was ${v0.label}?`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: id0 } });
      const e0 = extra.find((id) => story.vars[id].type === "scalar");
      q(story, { text: `What is ${story.vars[e0].label} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: e0 } });
    }
    // A dropped question leaves a gap: number the final questions again.
    story.questions.forEach((x, i) => (x.id = `q${i + 1}`));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The tasks. Base counts at difficulty 1. The v06 counts in the comments are the counts of the matching v06 task.

const BASE = {
  profile: "compaction",
  size: "v07",
  group: V07_GROUP,
  range: V07_RANGE,
  v03: { side: SIDE },
  stages: 8,
  compactAfter: V07_COMPACT_AFTER,
  limits: { final: [8, 10], stages: [8, 8] },
};

/** Spec fields that scale with the difficulty: entities, updates and the hook. */
export function v07Spec(spec, d) {
  const k = d - 1;
  return {
    ...spec,
    entities: spec.entities + k * spec.grow.entities,
    updates: Math.round(spec.updates * (1 + 0.3 * k)),
    v07: { kind: spec.kind, rules: spec.rules ?? V07_RULES[spec.kind], prepare: makePrepare(spec.kind, d) },
  };
}

/** The 6 tasks with their recorded base seeds. */
export const V07_TASKS = [
  { ...BASE, taskId: "A10-data-platform", category: "A", kind: "A", seed: 1500000, found: { 1: 1500000, 2: 1500007 }, entities: 13, updates: 40, depth: 1, focus: "warehouse", bigFeedName: "activity", pools: POOL_A, grow: { entities: 2 }, minFacts: 16,
    lead: "You help a data team choose the parts of a new data platform and keep its requirements. Decisions and requirements change often as the trials report back." },
  { ...BASE, taskId: "A10-observability-stack", category: "A", kind: "F", seed: 1525000, found: { 1: 1525021, 2: 1525150 }, entities: 10, updates: 34, depth: 1, focus: "metrics", bigFeedName: "audit", pools: POOL_F, grow: { entities: 1 }, minFacts: 16,
    lead: "You help an SRE team choose an observability stack. Each main decision has a recorded reason, and both the decisions and their reasons change as the evaluations go on." },
  { ...BASE, taskId: "B10-clinic-platform", category: "B", kind: "B", seed: 1550000, found: { 1: 1550002, 2: 1550000 }, entities: 17, updates: 72, depth: 3, bigFeedName: "audit", pools: POOL_B, grow: { entities: 2 }, minFacts: 34,
    lead: "You follow the reorganization of a clinic software platform: teams get new names, services change owners and dependencies change." },
  { ...BASE, taskId: "C10-payments-cutover", category: "C", kind: "C", seed: 1575000, found: { 1: 1575002, 2: 1575000 }, entities: 13, updates: 40, depth: 4, bigFeedName: "ops-log", pools: POOL_C, grow: { entities: 0 }, minFacts: 24,
    lead: "You follow a payments platform cutover with four chained migrations behind feature flags, a settings checkpoint, a selective rollback and permit items that are allowed only under a condition." },
  { ...BASE, taskId: "D10-network-policy", category: "D", kind: "D", seed: 1600000, found: { 1: 1600000, 2: 1600005 }, entities: 16, updates: 72, depth: 3, bigFeedName: "activity", pools: POOL_D, grow: { entities: 0 }, minFacts: 16,
    lead: "You settle a network policy from security policies, architecture reviews, runbooks, chat threads and ticket comments." },
  { ...BASE, taskId: "E10-notification-hub", category: "E", kind: "E", seed: 1625000, found: { 1: 1625000, 2: 1625000 }, entities: 12, updates: 44, depth: 2, bigFeedName: "audit", pools: POOL_E, grow: { entities: 0 }, minFacts: 12,
    lead: "You work with a team that builds a notification hub over several days. Keep the constraints, the rejected ideas, the decided details and the unfinished work straight." },
];

// ---------------------------------------------------------------------------------------------------------------
// Fact links and v07 rules.

/** The fact that decides an answer: { name, part } or null. names: the fact names of the reference file. */
export function factOf(vars, query, names) {
  const one = { value: "current", members: "current", count: "current", contains: "current", eq: "current", initial: "history", superseded: "history" }[query.q];
  if (!one) return null;
  const name = factName(vars[query.var]);
  return names.has(name) ? { name, part: one } : null;
}

/** A question about a reason: its variable or its variable list is a reason variable. */
export function isReasonQuestion(x) {
  return [x.query.var, ...(x.query.vars ?? [])].some((id) => typeof id === "string" && id.startsWith("reason."));
}

/** A question about a condition: its variable is a condition variable, or it asks whether an item is allowed. */
export function isConditionQuestion(x) {
  return x.query.q === "allowed" || (typeof x.query.var === "string" && x.query.var.startsWith("cond."));
}

/**
 * v07 rules on top of the shared and v03 rules. Fails with an error. ref: { vars, events, questions, checkpointQuestions }.
 * - 8 stages, compactions after stages 3, 5 and 7, a probe after each compaction.
 * - A tracked value changes in every stage 1 to 8, and at least one value is corrected or replaced.
 * - The final set has 8 to 10 questions, with a current-state and a history question. The reason task asks reasons, C10 asks conditions.
 * - A question about a team by name asks a name that is the current name at the time of the question.
 */
export function validateV07(task, key, ref, spec) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (task.stages.length !== 8 || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== "3,5,7") fail("8 stages with compactions after 3, 5 and 7");
  if ((task.checkpoint.probes ?? []).map((p) => p.afterStage).join() !== "3,5,7") fail("one probe after each compaction");
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
  for (let s = 1; s <= 8; s += 1) if (!changedIn.has(s)) fail(`no state change in stage ${s}`);
  if (corrected === 0) fail("no corrected or replaced value");
  const qs = ref.questions;
  if (qs.length < 8 || qs.length > 10) fail(`final question count ${qs.length}`);
  const kinds = new Set(qs.map((x) => x.query.q));
  if (!["value", "members"].some((k) => kinds.has(k))) fail("no current-state question");
  if (!["initial", "superseded"].some((k) => kinds.has(k))) fail("no history question");
  if (spec.kind === "F" && qs.filter(isReasonQuestion).length < 3) fail("fewer than 3 reason questions");
  if (spec.kind === "C" && qs.filter(isConditionQuestion).length < 3) fail("fewer than 3 condition questions");
  for (const x of qs) if (x.query.q === "initial" && key.answers[x.id].firstEstablishedStage !== 0) fail(`${x.id}: initial value not in the specification`);
  // A question must not ask a history that is empty.
  for (const x of qs) if (x.query.q === "superseded" && key.answers[x.id].value.length === 0) fail(`${x.id}: no superseded value`);
  const renames = ref.events.filter((e) => e.op.op === "rename");
  const stageOfQ = new Map([...qs.map((x) => [x, 8]), ...task.checkpoint.probes.flatMap((p) => p.questionIds.map((id) => [ref.checkpointQuestions.find((x) => x.id === id), p.afterStage]))]);
  for (const [x, at] of stageOfQ) {
    if (x.query.q !== "whereEq") continue;
    const name = x.query.value;
    if (renames.some((e) => (e.op.from === name && e.stage <= at) || (e.op.to === name && e.stage > at))) fail(`${x.id}: team name ${name} is not current at stage ${at}`);
  }
  if (JSON.stringify(task).includes("was not kept")) fail("an event leaves a run result open");
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** One attempt with one seed. Returns the three files and a summary, or throws. */
function attempt(spec) {
  const g = generateTask(spec, { withReference: true });
  const { task, reference } = g;
  let key = g.key;
  // v08: fixed key metadata (keyfix.mjs). The v03 rules read the stage fields, so they run again on the fixed key.
  if (spec.fixKey) {
    key = spec.fixKey(key, reference, task.checkpoint.probes);
    validateV03(task, key, reference);
  }
  validateV07(task, key, reference, spec);
  const states = spec.compactAfter.map((afterStage) => {
    const text = stateText(reference.vars, reference.events, afterStage, SIDE_IDS);
    const n = Buffer.byteLength(text, "utf8");
    if (n > V07_STATE_TEXT_MAX_BYTES) throw new Error(`${spec.taskId}: reference state after stage ${afterStage} has ${n} bytes`);
    const facts = stateFacts(reference.vars, reference.events, afterStage, SIDE_IDS);
    if (new Set(facts.map((f) => f.name)).size !== facts.length) throw new Error(`${spec.taskId}: duplicate fact name`);
    return { afterStage, text, facts };
  });
  const nFacts = states.at(-1).facts.length;
  if (nFacts < spec.minFacts) throw new Error(`${spec.taskId}: ${nFacts} facts, fewer than ${spec.minFacts}`);
  const names = new Set(states.flatMap((s) => s.facts.map((f) => f.name)));
  const link = (answers, questions) => Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { ...a, fact: factOf(reference.vars, questions.find((x) => x.id === id).query, names) }]));
  const keyOut = { ...key, answers: link(key.answers, reference.questions), checkpointAnswers: link(key.checkpointAnswers, reference.checkpointQuestions) };
  return {
    files: {
      [`generated/${spec.taskId}.task.json`]: serialize(task),
      [`keys/${spec.taskId}.key.json`]: serialize(keyOut),
      [`reference/${spec.taskId}.state.json`]: serialize({ schema: 2, taskId: spec.taskId, states }),
    },
    seed: spec.seed,
  };
}

/**
 * The three files of one task as { files: { relativePath: content }, seed }, relative to tasks/v07/. The seed is the
 * first seed from spec.seed on that passes every rule at this difficulty.
 */
export function generateOneV07(base, { difficulty = DEFAULT_DIFFICULTY, tries = SEED_TRIES, fromBase = false } = {}) {
  const spec = v07Spec(base, difficulty);
  // found: the seed that an earlier search from the base seed found at this difficulty. It only saves time.
  const start = fromBase ? base.seed : (base.found?.[difficulty] ?? base.seed);
  let last = null;
  for (let k = 0; k < tries; k += 1) {
    try {
      return attempt({ ...spec, seed: start + k });
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${base.taskId}: no seed in ${tries} tries at difficulty ${difficulty}: ${last?.message}`);
}

/** All 18 files and the used seeds. */
export function generateAllV07({ difficulty = DEFAULT_DIFFICULTY, tasks = V07_TASKS } = {}) {
  const files = {};
  const seeds = {};
  for (const spec of tasks) {
    const r = generateOneV07(spec, { difficulty });
    Object.assign(files, r.files);
    seeds[spec.taskId] = r.seed;
  }
  return { files, seeds };
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** FROZEN.json content: status candidate, the generator commit, the difficulty, the seeds and the SHA-256 of every file. */
export function frozenRecord(commit, files, seeds, difficulty = DEFAULT_DIFFICULTY) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: "v07-product-trigger",
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v07.mjs",
    difficulty,
    tasks: V07_TASKS.map((s) => ({
      taskId: s.taskId,
      category: s.category,
      baseSeed: s.seed,
      seed: seeds[s.taskId],
      compactAfter: s.compactAfter,
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      reference: entry(`reference/${s.taskId}.state.json`),
    })),
  };
}

function main(argv) {
  const di = argv.indexOf("--difficulty");
  const difficulty = di >= 0 ? Number(argv[di + 1]) : DEFAULT_DIFFICULTY;
  if (!Number.isInteger(difficulty) || difficulty < 1) throw new Error("--difficulty takes an integer of 1 or more");
  const { files, seeds } = generateAllV07({ difficulty });
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V07_DIR, rel);
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
      if (readFileSync(join(V07_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v07.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V07_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V07_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V07_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files, seeds, difficulty)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V07_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V07_DIR} (seeds ${JSON.stringify(seeds)})\n`);
}

if (import.meta.main) main(process.argv.slice(2));
