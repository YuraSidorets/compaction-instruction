// Category A: decision overrides. Requirements change over the stages; the final answers need the latest valid
// decision and the superseded ones. Rejected proposals are plausible distractors that change nothing.
import { stagePlan } from "./common.mjs";

const TOPICS = [
  { id: "db", label: "the primary database", options: ["postgresql", "mysql", "sqlite", "cockroachdb", "mariadb"] },
  { id: "queue", label: "the message broker", options: ["rabbitmq", "kafka", "nats", "sqs", "redis-streams"] },
  { id: "region", label: "the deploy region", options: ["eu-west-1", "us-east-1", "eu-central-1", "ap-south-1", "us-west-2"] },
  { id: "auth", label: "the login method", options: ["oauth2", "saml", "passkeys", "magic-link", "ldap"] },
  { id: "api", label: "the public API style", options: ["rest-json", "graphql", "grpc", "json-rpc"] },
  { id: "cdn", label: "the CDN vendor", options: ["cloudfront", "fastly", "akamai", "bunny", "cloudflare"] },
  { id: "logs", label: "the log shipper", options: ["vector", "fluent-bit", "logstash", "promtail"] },
  { id: "billing", label: "the payment provider", options: ["stripe", "adyen", "braintree", "mollie"] },
  { id: "ttl", label: "the cache TTL in seconds", type: "int", options: [30, 60, 120, 300, 600, 900] },
  { id: "upload", label: "the upload size limit in MB", type: "int", options: [10, 25, 50, 100, 200] },
  { id: "retries", label: "the webhook retry limit", type: "int", options: [3, 5, 7, 10, 12] },
  { id: "dark", label: "the dark mode launch flag", type: "bool", options: [true, false] },
  { id: "audit", label: "the audit export flag", type: "bool", options: [true, false] },
];

const LOCALES = ["en-US", "de-DE", "fr-FR", "es-ES", "ja-JP", "pt-BR", "it-IT", "nl-NL", "pl-PL", "sv-SE"];

export function buildDecisions(story, p) {
  const { rng, stages } = story;
  // v03 tasks pass their own value pools; the default pools keep the v0.2 tasks byte-identical.
  const TOPIC_POOL = p.pools?.topics ?? TOPICS;
  const LOCALE_POOL = p.pools?.locales ?? LOCALES;
  const scalars = TOPIC_POOL.filter((t) => !t.type);
  const ints = TOPIC_POOL.filter((t) => t.type === "int");
  const bools = TOPIC_POOL.filter((t) => t.type === "bool");
  const nScalar = Math.max(3, p.entities - 3);
  const focus = scalars.find((t) => t.id === p.focus) ?? scalars[0];
  const rest = rng.sample(scalars.filter((t) => t !== focus), Math.min(nScalar, scalars.length) - 1);
  const chosen = [focus, ...rest, rng.pick(ints), ...rng.sample(bools, 1)];
  const ids = [];
  for (const t of chosen) {
    ids.push(story.var(t.id, { label: t.label, type: t.type === "int" ? "int" : t.type === "bool" ? "bool" : "scalar", options: t.options }));
  }
  const loc = story.var("locales", { label: `the supported locales${p.pools?.labelSuffix ?? ""}`, type: "set", options: LOCALE_POOL });

  // Initial specification (stage 0).
  for (const t of chosen) story.set(0, t.id, rng.pick(t.options));
  for (const l of rng.sample(LOCALE_POOL.slice(0, 5), 3)) story.add(0, loc, l);

  // Decision changes. Topic weights: the first scalar topic changes most (several superseded values).
  const hot = chosen[0].id;
  const plan = stagePlan(rng, p.updates, stages);
  const changed = new Map();
  const lateFrom = p.compactAfter.length > 0 ? p.compactAfter[0] + 1 : null;
  const late = new Set();
  plan.forEach((stage, i) => {
    let t;
    if (i % 3 === 0) t = chosen.find((c) => c.id === hot);
    else t = rng.pick(chosen);
    if (rng.chance(0.18)) {
      // the locale set changes instead
      const cur = story.cur[loc];
      if (cur.length > 2 && rng.chance(0.5)) story.remove(stage, loc, rng.pick(cur));
      else story.add(stage, loc, rng.pick(LOCALE_POOL.filter((l) => !cur.includes(l))));
      return;
    }
    const prev = story.cur[t.id];
    const everSeen = changed.get(t.id) ?? [prev];
    // Sometimes revert to an earlier value (a supersede), else a new value.
    let next;
    if (everSeen.length > 1 && rng.chance(0.25)) next = rng.pickOther(everSeen, prev);
    else next = rng.pickOther(t.options, prev);
    story.set(stage, t.id, next, { kind: everSeen.length > 1 || rng.chance(0.4) ? "supersede" : "state" });
    changed.set(t.id, [...everSeen, next]);
    if (lateFrom !== null && stage >= lateFrom) late.add(t.id);
    // A rejected proposal now and then: it names a value that never becomes valid.
    if (rng.chance(0.3)) {
      const bogus = rng.pickOther(t.options, next);
      story.ev(stage, "conflict", { op: "mention", var: t.id, value: bogus });
    }
  });
  // Make sure the hot topic and one more topic change after the first compaction.
  if (lateFrom !== null) {
    for (const t of [chosen[0], chosen[1]]) {
      if (late.has(t.id)) continue;
      const stage = stages; // last stage: the steering copy is exact
      story.set(stage, t.id, rng.pickOther(t.options, story.cur[t.id]), { kind: "supersede" });
      changed.set(t.id, [...(changed.get(t.id) ?? []), story.cur[t.id]]);
    }
  }
  // Every scalar question needs at least one change.
  for (const t of chosen.slice(0, 3)) {
    if (!changed.has(t.id)) {
      const stage = stages;
      story.set(stage, t.id, rng.pickOther(t.options, story.cur[t.id]), { kind: "supersede" });
      changed.set(t.id, [story.cur[t.id]]);
    }
  }

  const intT = chosen.find((c) => c.type === "int");
  const boolT = chosen.find((c) => c.type === "bool");
  if (!changed.has(intT.id)) story.set(stages, intT.id, rng.pickOther(intT.options, story.cur[intT.id]));
  if (!changed.has(boolT.id)) story.set(stages, boolT.id, !story.cur[boolT.id], { kind: "supersede" });

  story.q({ text: `What is ${chosen[0].label} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: chosen[0].id } });
  story.q({ text: `Which values were decided for ${chosen[0].label} at some point and are no longer the decision? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: chosen[0].id } });
  story.q({ text: `What is ${chosen[1].label} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: chosen[1].id } });
  story.q({ text: `In the initial specification, what was ${chosen[2].label}?`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: chosen[2].id } });
  story.q({ text: `What is ${intT.label} now? Answer with a number.`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: intT.id } });
  story.q({ text: `Is ${boolT.label} ON now? Answer true for ON, false for OFF.`, type: "bool", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: boolT.id } });
  story.q({ text: "Which locales are supported now?", type: "set", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "members", var: loc } });

  if (p.compactAfter.length > 0) {
    story.cq({ text: `At this point, what is ${chosen[0].label}?`, type: "choice", query: { q: "value", var: chosen[0].id }, aspect: "current_state", errorCategory: "obsolete_decision" });
    story.cq({ text: `At this point, what is ${chosen[1].label}?`, type: "choice", query: { q: "value", var: chosen[1].id }, aspect: "current_state", errorCategory: "obsolete_decision" });
  }
  return { entities: chosen.length + 1, depth: 1 };
}
