#!/usr/bin/env node
// Context Clock v0.8 experiment: 6 new held-out tasks (EXPERIMENT-V08.md, section "Tasks"). They come from the six
// v0.7 generators (v07.mjs) at base difficulty 1, with new base seeds, new slugs and new names and values. Same
// structure as tasks/v07: 8 stages, a compaction after stages 3, 5 and 7, reference schema 2, keys with `fact`.
// The keys use the fixed metadata of keyfix.mjs.
//
//   node benchmarks/context-clock/tasks/generator/v08.mjs            rewrite the 18 files
//   node benchmarks/context-clock/tasks/generator/v08.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v08.mjs --freeze   write tasks/v08/FROZEN.json (status candidate)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR } from "./generate.mjs";
import { fixKey } from "./keyfix.mjs";
import { V07_TASKS, generateOneV07, rulesFor, sha256 } from "./v07.mjs";

export const V08_DIR = join(TASKS_DIR, "v08");
export const V08_DIFFICULTY = 1;

/** Side variables of the large feeds. Same ids as in v07 (no question asks them), new labels and values. */
const SIDE = [
  { id: "side.cluster", label: "the load test cluster", options: ["lt-cobra", "lt-dingo", "lt-egret", "lt-ferret", "lt-gecko"] },
  { id: "side.image", label: "the CI runner pool", options: ["runpool-p31", "runpool-p32", "runpool-p33", "runpool-p34", "runpool-p35"] },
  { id: "side.board", label: "the TV dashboard id", options: ["tvdash-t81", "tvdash-t82", "tvdash-t83", "tvdash-t84", "tvdash-t85"] },
];

const POOL_A = {
  topics: [
    { id: "pushgw", label: "the push gateway", options: ["fcm-relay", "apns-relay", "expo-push", "airship-push"] },
    { id: "crash", label: "the crash reporter", options: ["sentry-io", "bugsnag-io", "crashlytics-sdk", "instabug-sdk"] },
    { id: "flags", label: "the feature flag service", options: ["launchdarkly-ff", "unleash-ff", "flagsmith-ff", "growthbook-ff"] },
    { id: "analytics", label: "the analytics SDK", options: ["amplitude-sdk", "mixpanel-sdk", "posthog-sdk", "segment-sdk"] },
    { id: "idp", label: "the auth provider", options: ["auth0-idp", "cognito-idp", "keycloak-idp", "supertokens-idp"] },
    { id: "framework", label: "the backend framework", options: ["nestjs-api", "fastify-api", "ktor-api", "gin-api"] },
    { id: "imgcdn", label: "the image CDN", options: ["imgix-cdn", "cloudinary-cdn", "imagekit-cdn", "thumbor-cdn"] },
    { id: "paysdk", label: "the payment SDK", options: ["stripe-sdk", "braintree-sdk", "adyen-sdk", "checkout-sdk"] },
    { id: "buildsvc", label: "the build service", options: ["bitrise-ci", "codemagic-ci", "appcenter-ci", "fastlane-ci"] },
    { id: "chat", label: "the chat backend", options: ["stream-chat", "sendbird-chat", "matrix-chat", "pubnub-chat"] },
    { id: "search", label: "the search service", options: ["algolia-idx", "typesense-idx", "meili-idx", "elastic-idx"] },
    { id: "deeplink", label: "the deep link service", options: ["branch-links", "adjust-links", "appsflyer-links", "firebase-links"] },
    { id: "offline", label: "the offline sync engine", options: ["realm-sync", "couchbase-lite", "watermelon-db", "powersync-db"] },
    { id: "pagesize", label: "the API page size", type: "int", options: [25, 50, 100, 200, 400] },
    { id: "biometric", label: "the biometric login flag", type: "bool", options: [true, false] },
  ],
  labelSuffix: " of the app",
  locales: ["af-ZA", "zu-ZA", "xh-ZA", "yo-NG", "ig-NG", "ha-NG", "am-ET", "so-SO", "rw-RW", "mg-MG"],
  extra: [
    { id: "reqtimeout", label: "the request timeout in seconds", type: "int", options: [4, 8, 16, 32, 64] },
    { id: "cachemb", label: "the client cache size in MB", type: "int", options: [16, 64, 128, 512, 1024] },
    { id: "betachan", label: "the beta channel flag", type: "bool", options: [true, false] },
  ],
};

const POOL_F = {
  topics: [
    { id: "encoder", label: "the video encoder", options: ["x264-enc", "svt-av1", "nvenc-h265", "vp9-libvpx"] },
    { id: "packager", label: "the packager", options: ["shaka-pkg", "bento4-pkg", "gpac-pkg", "unified-pkg"] },
    { id: "drm", label: "the DRM vendor", options: ["widevine-drm", "playready-drm", "fairplay-drm", "axinom-drm"] },
    { id: "player", label: "the video player", options: ["videojs-player", "hlsjs-player", "dashjs-player", "exo-player"] },
    { id: "tier", label: "the storage tier", options: ["hot-tier-ssd", "warm-tier-hdd", "cold-tier-glacier", "archive-tier-tape"] },
    { id: "farm", label: "the transcode farm", options: ["mediaconvert-farm", "elemental-farm", "ffmpeg-farm", "bitmovin-farm"] },
    { id: "subs", label: "the subtitle format", options: ["webvtt-subs", "ttml-subs", "srt-subs", "scc-subs"] },
    { id: "adserver", label: "the ad server", options: ["freewheel-ads", "gam-ads", "springserve-ads", "spotx-ads"] },
    { id: "qoe", label: "the QoE monitor", options: ["mux-data", "conviva-qoe", "npaw-qoe", "bitmovin-qoe"] },
    { id: "seglen", label: "the segment length in seconds", type: "int", options: [2, 4, 6, 8, 10] },
    { id: "lowlat", label: "the low latency flag", type: "bool", options: [true, false] },
  ],
  labelSuffix: " of the player",
  locales: ["fo-FO", "kl-GL", "se-NO", "fy-NL", "rm-CH", "gd-GB", "kw-GB", "br-FR", "oc-FR", "co-FR"],
  extra: [
    { id: "rungs", label: "the bitrate ladder rung count", type: "int", options: [3, 5, 7, 9, 12] },
    { id: "sprites", label: "the thumbnail sprite flag", type: "bool", options: [true, false] },
    { id: "gop", label: "the keyframe interval in frames", type: "int", options: [24, 48, 60, 96, 120] },
  ],
  reasons: ["why-cost", "why-latency", "why-quality", "why-licensing", "why-scale", "why-support", "why-security"],
};

const POOL_B = {
  services: [
    "rider-api", "driver-app-gw", "dispatch-core", "surge-pricer", "trip-ledger", "eta-engine", "map-tiles", "fraud-screen",
    "payout-svc", "rating-svc", "promo-engine", "support-desk", "incident-bot", "vehicle-registry", "document-check", "heatmap-svc",
    "geo-index", "receipt-mailer",
  ],
  teamPairs: [
    ["team-dispatch", "team-matching"], ["team-pricing", "team-fares"], ["team-riders", "team-passengers"], ["team-drivers", "team-fleet-ops"],
    ["team-safety", "team-integrity"], ["team-maps", "team-geo"],
  ],
  oncall: ["anouk", "bayo", "chidi", "dagny", "emre", "fumiko", "gunnar", "hamid"],
};

const POOL_C = {
  flags: ["claim-autopay", "ocr-intake", "fraud-model-v2", "photo-estimate", "subrogation-ui", "reserve-calc", "policy-sync", "adjuster-app", "catastrophe-mode", "reinsurance-feed"],
  configs: [
    { id: "triagecap", label: "the triage queue cap", options: [30, 60, 120, 240, 480] },
    { id: "slahours", label: "the claim SLA in hours", options: [12, 24, 48, 72, 96] },
    { id: "autolimit", label: "the auto-approve limit in dollars", options: [250, 500, 1000, 2500, 5000] },
    { id: "photocount", label: "the required photo count", options: [2, 4, 6, 8, 10] },
  ],
  pricing: ["rate-book-r1", "rate-book-r2", "rate-book-r3", "rate-book-r4"],
  schema: ["claims-s70", "claims-s71", "claims-s72", "claims-s73"],
  checkpoint: "snap-c11",
  migPrefix: "claims ",
  labelSuffix: " for claims",
  extra: [
    { id: "reopendays", label: "the reopen window in days", type: "int", options: [10, 20, 30, 60, 90] },
    { id: "adjload", label: "the adjuster load per day", type: "int", options: [5, 8, 12, 16, 20] },
    { id: "evidmonths", label: "the evidence retention in months", type: "int", options: [6, 12, 24, 36, 84] },
    { id: "paybatch", label: "the payout batch size", type: "int", options: [25, 50, 100, 200, 400] },
  ],
  permits: [
    { id: "expresslane", label: "the express payout lane" },
    { id: "droneinsp", label: "the drone inspection service" },
    { id: "bulkcloser", label: "the bulk claim closer" },
    { id: "repairnet", label: "the partner repair network" },
  ],
};

const POOL_D = {
  params: [
    { id: "replmode", label: "the replication mode", options: ["repl-sync", "repl-async", "repl-quorum", "repl-chain"] },
    { id: "erasure", label: "the erasure code", options: ["ec-4-2", "ec-8-3", "ec-10-4", "ec-6-3"] },
    { id: "encmode", label: "the encryption mode", options: ["enc-aes-gcm", "enc-xts", "enc-chacha", "enc-none-dev"] },
    { id: "snaptool", label: "the snapshot tool", options: ["restic-snap", "borg-snap", "velero-snap", "kopia-snap"] },
    { id: "objlock", label: "the object lock mode", options: ["lock-governance", "lock-compliance", "lock-legal-hold", "lock-off"] },
    { id: "tiering", label: "the tiering engine", options: ["tier-lifecycle", "tier-intelligent", "tier-manual", "tier-scheduled"] },
    { id: "checksum", label: "the checksum type", options: ["crc32c-sum", "md5-sum", "sha1-sum", "xxh3-sum"] },
    { id: "bkttarget", label: "the backup target", options: ["bkt-tokyo", "bkt-frankfurt", "bkt-oregon", "bkt-sydney"] },
    { id: "scrubdays", label: "the scrub interval in days", type: "int", options: [7, 14, 28, 56, 91] },
    { id: "bucketgb", label: "the quota per bucket in GB", type: "int", options: [50, 200, 500, 2000, 10000] },
    { id: "maxobjgb", label: "the max object size in GB", type: "int", options: [1, 5, 50, 500, 5000] },
    { id: "rebuildmb", label: "the rebuild throttle in MB per second", type: "int", options: [25, 100, 250, 500, 1000] },
    { id: "verdepth", label: "the versioning depth", type: "int", options: [2, 5, 10, 25, 50] },
    { id: "dedupe", label: "the dedupe mode", type: "bool", options: [true, false] },
    { id: "compress", label: "the compression mode", type: "bool", options: [true, false] },
    { id: "worm", label: "the WORM mode", type: "bool", options: [true, false] },
  ],
  theme: {
    order: ["storage-standard", "design-memo", "platform-handbook", "slack-thread", "jira-comment"],
    docs: { "storage-standard": "STD", "design-memo": "DMEMO", "platform-handbook": "HBK", "slack-thread": "SLK", "jira-comment": "JIRA" },
  },
};

const POOL_E = {
  labelSuffix: " of the loyalty program",
  theme: {
    feature: "the loyalty program",
    criteria: [
      "ac-points-realtime", "ac-tier-upgrade-mail", "ac-expiry-warning", "ac-partner-earn", "ac-fraud-hold", "ac-gdpr-export",
      "ac-family-pooling", "ac-receipt-scan", "ac-offline-earn", "ac-points-transfer",
    ],
    steps: [
      "step-points-ledger", "step-tier-engine", "step-earn-rules", "step-burn-catalog", "step-partner-api", "step-receipt-ocr",
      "step-expiry-job", "step-member-portal", "step-fraud-rules", "step-migration-dry", "step-ops-alerts", "step-launch-pilot",
    ],
    rejected: ["points-in-crm", "nightly-recalc-only", "shared-member-ids", "manual-tier-review", "csv-partner-feed", "client-side-balance", "single-region-db"],
    details: [
      { id: "currency", label: "the points currency name", options: ["pts-stars", "pts-miles", "pts-coins", "pts-gems"] },
      { id: "expirym", label: "the points expiry in months", type: "int", options: [6, 12, 18, 24, 36] },
    ],
  },
  extra: [
    { id: "earnengine", label: "the earn rule engine", options: ["rules-drools", "rules-json", "rules-dmn", "rules-easy"] },
    { id: "cardfmt", label: "the member card format", options: ["card-qr", "card-nfc", "card-barcode", "card-wallet"] },
    { id: "mailvendor", label: "the email vendor", options: ["mailgun-mx", "postmark-mx", "sendgrid-mx", "sparkpost-mx"] },
    { id: "welcomepts", label: "the welcome bonus points", type: "int", options: [100, 250, 500, 1000, 2000] },
    { id: "tierreview", label: "the tier review interval in days", type: "int", options: [30, 60, 90, 180, 365] },
    { id: "maxtransfers", label: "the max transfers per month", type: "int", options: [1, 2, 4, 6, 10] },
    { id: "receiptage", label: "the receipt age limit in days", type: "int", options: [7, 14, 30, 45, 60] },
  ],
};

/** The v07 spec of a kind, with the v08 id, seed, pools and lead. */
function from(kind, over) {
  const base = V07_TASKS.find((t) => t.kind === kind);
  return { ...base, size: "v08", v03: { side: SIDE }, found: {}, fixKey, ...over };
}

/**
 * The 6 tasks with their base seeds. Two tasks have the category A, so two ids start with A11. The smoke suite takes
 * the first id in order with the prefix A11, which is A11-mobile-backend.
 */
export const V08_TASKS = [
  from("A", { taskId: "A11-mobile-backend", seed: 1700000, found: { 1: 1700003 }, focus: "pushgw", pools: POOL_A,
    lead: "You help a mobile team choose the parts of a new app backend and keep its requirements. Decisions and requirements change often as the trials report back." }),
  from("F", { taskId: "A11-video-pipeline", seed: 1725000, found: { 1: 1725005 }, focus: "encoder", pools: POOL_F, rules: rulesFor("F", POOL_F.reasons),
    lead: "You help a media team choose a video pipeline. Each main decision has a recorded reason, and both the decisions and their reasons change as the evaluations go on." }),
  from("B", { taskId: "B11-ride-hailing", seed: 1750000, found: { 1: 1750003 }, pools: POOL_B,
    lead: "You follow the reorganization of a ride-hailing platform: teams get new names, services change owners and dependencies change." }),
  from("C", { taskId: "C11-insurance-claims", seed: 1775000, found: { 1: 1775001 }, pools: POOL_C,
    lead: "You follow an insurance claims platform cutover with four chained migrations behind feature flags, a settings checkpoint, a selective rollback and permit items that are allowed only under a condition." }),
  from("D", { taskId: "D11-storage-policy", seed: 1800000, found: { 1: 1800000 }, pools: POOL_D,
    lead: "You settle a storage policy from storage standards, design documents, a platform handbook, Slack threads and Jira comments." }),
  from("E", { taskId: "E11-loyalty-program", seed: 1825000, found: { 1: 1825000 }, pools: POOL_E,
    lead: "You work with a team that builds a loyalty program over several days. Keep the constraints, the rejected ideas, the decided details and the unfinished work straight." }),
];

/** All 18 files and the used seeds, at base difficulty. */
export function generateAllV08({ fromBase = false } = {}) {
  const files = {};
  const seeds = {};
  for (const spec of V08_TASKS) {
    const r = generateOneV07(spec, { difficulty: V08_DIFFICULTY, fromBase });
    Object.assign(files, r.files);
    seeds[spec.taskId] = r.seed;
  }
  return { files, seeds };
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** FROZEN.json content: status candidate, the generator commit, the seeds and the SHA-256 and bytes of every file. */
export function frozenRecord(commit, files, seeds) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: "v08-lower-cost",
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v08.mjs",
    difficulty: V08_DIFFICULTY,
    tasks: V08_TASKS.map((s) => ({
      taskId: s.taskId,
      category: s.category,
      kind: s.kind,
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
  const { files, seeds } = generateAllV08({ fromBase: argv.includes("--from-base") });
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(V08_DIR, rel);
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
      if (readFileSync(join(V08_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v08.mjs first`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "../generator"], { cwd: V08_DIR, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: V08_DIR, encoding: "utf8" }).trim();
    writeFileSync(join(V08_DIR, "FROZEN.json"), serialize(frozenRecord(commit, files, seeds)));
    process.stdout.write(`wrote FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(V08_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${V08_DIR} (seeds ${JSON.stringify(seeds)})\n`);
}

if (import.meta.main) main(process.argv.slice(2));
