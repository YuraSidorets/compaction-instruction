// Category E: long-running software task continuity. Acceptance criteria must survive, details change later,
// rejected approaches must not come back, completed steps stay completed, and some work stays outstanding.
import { stagePlan } from "./common.mjs";

const THEMES = [
  {
    feature: "the CSV export feature",
    criteria: ["ac-utf8-output", "ac-header-row", "ac-10k-rows-under-5s", "ac-timezone-utc", "ac-empty-state-message", "ac-audit-entry", "ac-retry-on-timeout"],
    steps: ["step-schema", "step-endpoint", "step-streaming", "step-ui-button", "step-permissions", "step-tests", "step-docs", "step-metrics"],
    rejected: ["client-side-generation", "nightly-batch-only", "email-attachment", "iframe-embed", "shared-temp-table"],
    details: [
      { id: "path", label: "the export endpoint path", options: ["/v1/export", "/v2/export", "/api/exports", "/export/csv"] },
      { id: "page", label: "the page size of the export query", type: "int", options: [100, 250, 500, 1000, 2000] },
    ],
  },
  {
    feature: "the auth refactor",
    criteria: ["ac-no-session-loss", "ac-mfa-optional", "ac-token-rotation", "ac-audit-login", "ac-lockout-after-5", "ac-sso-fallback", "ac-logout-everywhere"],
    steps: ["step-token-store", "step-middleware", "step-refresh-flow", "step-mfa-hook", "step-migration-script", "step-load-test", "step-runbook", "step-cleanup"],
    rejected: ["jwt-in-localstorage", "custom-crypto", "session-sharing-db", "cookie-per-subdomain", "long-lived-tokens"],
    details: [
      { id: "ttl", label: "the access token lifetime in minutes", type: "int", options: [5, 10, 15, 30, 60] },
      { id: "store", label: "the token store", options: ["redis", "postgres", "memcached", "dynamodb"] },
    ],
  },
  {
    feature: "the search rewrite",
    criteria: ["ac-typo-tolerance", "ac-p95-under-200ms", "ac-filters-kept", "ac-zero-result-hint", "ac-reindex-online", "ac-stemming-de", "ac-synonyms"],
    steps: ["step-index-schema", "step-ingest-worker", "step-query-api", "step-ranking", "step-ui-facets", "step-backfill", "step-shadow-traffic", "step-cutover"],
    rejected: ["sql-like-queries", "single-node-index", "client-side-filtering", "nightly-full-reindex", "regex-matching"],
    details: [
      { id: "engine", label: "the search engine", options: ["opensearch", "meilisearch", "typesense", "vespa"] },
      { id: "shards", label: "the shard count of the index", type: "int", options: [1, 3, 5, 8, 12] },
    ],
  },
  {
    feature: "the billing port",
    criteria: ["ac-no-double-charge", "ac-invoice-pdf", "ac-proration", "ac-tax-per-country", "ac-dunning-emails", "ac-refund-api", "ac-ledger-balanced"],
    steps: ["step-data-model", "step-provider-client", "step-webhooks", "step-invoices", "step-proration", "step-reconciliation", "step-backfill", "step-switchover"],
    rejected: ["dual-write-forever", "cron-polling", "floating-point-money", "manual-reconciliation", "provider-side-invoices"],
    details: [
      { id: "currency", label: "the settlement currency", options: ["EUR", "USD", "GBP", "CHF"] },
      { id: "grace", label: "the payment grace period in days", type: "int", options: [3, 7, 14, 21, 30] },
    ],
  },
];

export function buildContinuity(story, p) {
  const { rng, stages } = story;
  // v03 tasks pass their own theme; the default themes keep the v0.2 tasks byte-identical.
  const th = p.pools?.theme ?? THEMES[p.theme % THEMES.length];
  // v08 pools give a suffix, so that the list names differ from earlier task sets.
  const LS = p.pools?.labelSuffix ?? "";
  const crit = story.var("criteria", { label: `the acceptance criteria${LS}`, type: "set", options: th.criteria });
  const planned = story.var("planned", { label: `the planned steps${LS}`, type: "set", options: th.steps });
  const done = story.var("done", { label: `the completed steps${LS}`, type: "set", options: th.steps });
  const rej = story.var("rejected", { label: `the rejected approaches${LS}`, type: "set", options: th.rejected });
  const [dS, dI] = th.details[0].type ? [th.details[1], th.details[0]] : [th.details[0], th.details[1]];
  const detS = story.var(dS.id, { label: dS.label, options: dS.options });
  const detI = story.var(dI.id, { label: dI.label, type: "int", options: dI.options });
  const cur = story.cur;

  const nCrit = Math.min(th.criteria.length, Math.max(4, p.entities - 2));
  const startCrit = th.criteria.slice(0, nCrit - 1);
  const nSteps = Math.min(th.steps.length, Math.max(5, p.entities));
  for (const c of startCrit) story.add(0, crit, c);
  for (const s of th.steps.slice(0, nSteps - 1)) story.add(0, planned, s);
  story.set(0, detS, rng.pick(dS.options));
  story.set(0, detI, rng.pick(dI.options));

  // Ordered milestones.
  const ms = [];
  const keepOpen = th.steps[nSteps - 2]; // never completed: outstanding at the end
  const markDone = (s) => {
    const open = cur[planned].filter((x) => !cur[done].includes(x) && x !== keepOpen);
    if (open.length > 0) story.add(s, done, open[0]);
  };
  ms.push((s) => {
    story.add(s, rej, th.rejected[0]);
    markDone(s);
  });
  ms.push((s) => {
    story.set(s, detS, rng.pickOther(dS.options, cur[detS]), { kind: "supersede" });
    markDone(s);
  });
  ms.push((s) => {
    story.add(s, crit, th.criteria[nCrit - 1]);
    story.add(s, rej, th.rejected[1]);
  });
  ms.push((s) => {
    story.ev(s, "conflict", { op: "mention", var: rej, value: th.rejected[0] }); // a rejected approach is suggested again
    markDone(s);
  });
  ms.push((s) => {
    story.add(s, planned, th.steps[nSteps - 1]); // new work appears
    story.set(s, detI, rng.pickOther(dI.options, cur[detI]), { kind: "supersede" });
  });
  ms.push((s) => {
    story.remove(s, crit, startCrit[1]); // product drops one criterion
    markDone(s);
  });
  ms.push((s) => {
    story.add(s, rej, th.rejected[2]);
    story.set(s, detS, rng.pickOther(dS.options, cur[detS]), { kind: "supersede" });
    markDone(s);
  });
  ms.push((s) => {
    story.ev(s, "conflict", { op: "mention", var: rej, value: th.rejected[1] });
    story.set(s, detI, rng.pickOther(dI.options, cur[detI]), { kind: "supersede" });
    markDone(s);
  });

  const at = ms.map((_, i) => Math.min(stages, 1 + Math.floor((i * stages) / ms.length)));
  const filler = stagePlan(rng, Math.max(0, p.updates - 16), stages);
  let fi = 0;
  for (let s = 1; s <= stages; s += 1) {
    ms.forEach((m, i) => {
      if (at[i] === s) m(s);
    });
    while (fi < filler.length && filler[fi] === s) {
      if (rng.chance(0.5)) markDone(s);
      else story.set(s, detI, rng.pickOther(dI.options, cur[detI]), { kind: "supersede" });
      fi += 1;
    }
  }

  const probeRejected = th.rejected[1];
  const probeAllowed = th.rejected[3];
  story.q({ text: `Which planned steps of ${th.feature} are still outstanding (planned and not completed)?`, type: "set", aspect: "outstanding_work", errorCategory: "lost_progress", query: { q: "diff", a: planned, b: done } });
  story.q({ text: "Which steps are completed?", type: "set", aspect: "completed_work", errorCategory: "repeated_work", query: { q: "members", var: done } });
  story.q({ text: `Is the approach \`${probeRejected}\` rejected?`, type: "bool", aspect: "rejected_approach", errorCategory: "repeated_work", query: { q: "contains", var: rej, item: probeRejected } });
  story.q({ text: `Is the approach \`${probeAllowed}\` rejected?`, type: "bool", aspect: "rejected_approach", errorCategory: "repeated_work", query: { q: "contains", var: rej, item: probeAllowed } });
  story.q({ text: `What is ${dS.label} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: detS } });
  story.q({ text: `What is ${dI.label} now? Answer with a number.`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: detI } });
  story.q({ text: "Which acceptance criteria apply now?", type: "set", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "members", var: crit } });

  if (p.compactAfter.length > 0) {
    story.cq({ text: "At this point, which steps are completed?", type: "set", aspect: "completed_work", errorCategory: "repeated_work", query: { q: "members", var: done } });
    story.cq({ text: `At this point, what is ${dS.label}?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: detS } });
  }
  return { entities: nCrit + nSteps + 2, depth: 2 };
}
