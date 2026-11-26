// Category C: conditional state machines with dependent updates. Feature flags, migrations that succeed only when
// their prerequisites hold, steps that are void after a failure, and a rollback that restores selected values.
// The text states each rule; it never states the outcome of a migration run.

const FLAG_POOL = ["new-checkout", "async-export", "beta-search", "fast-sync", "smart-retry", "v2-pricing", "bulk-import"];
const CONFIG_POOL = [
  { id: "pool", label: "the worker pool size", options: [4, 8, 16, 24, 32] },
  { id: "batch", label: "the batch size", options: [100, 250, 500, 750, 1000] },
  { id: "timeout", label: "the job timeout in seconds", options: [10, 20, 30, 45, 60] },
  { id: "shards", label: "the shard count", options: [2, 4, 6, 8, 12] },
];
const PRICING_POOL = ["table-2023", "table-2024", "table-2025", "table-legacy"];
const SCHEMA_POOL = ["schema-v1", "schema-v2", "schema-v3", "schema-v4"];
const STATUS = ["pending", "applied", "failed"];

export function buildConditional(story, p) {
  const { rng, stages } = story;
  // v03 tasks pass their own value pools; the default pools keep the v0.2 tasks byte-identical.
  const FLAGS = p.pools?.flags ?? FLAG_POOL;
  const CONFIGS = p.pools?.configs ?? CONFIG_POOL;
  const PRICING = p.pools?.pricing ?? PRICING_POOL;
  const SCHEMA = p.pools?.schema ?? SCHEMA_POOL;
  const CP = p.pools?.checkpoint ?? "cp-1";
  const nFlags = Math.min(FLAGS.length, Math.max(3, p.entities - 3));
  const depth = Math.max(1, Math.min(4, p.depth));
  const flags = rng.sample(FLAGS, nFlags).map((f) => story.var(`flag.${f}`, { label: `the flag ${f}`, type: "bool", options: [true, false] }));
  const migs = [];
  // v08 pools name their own items: a prefix for the migrations and a suffix for the pricing table and the schema.
  const MP = p.pools?.migPrefix ?? "";
  const LS = p.pools?.labelSuffix ?? "";
  for (let j = 1; j <= depth; j += 1) migs.push(story.var(`mig.m${j}`, { label: `${MP}migration m${j}`, options: STATUS }));
  const cfgs = rng.sample(CONFIGS, 2).map((c) => ({ ...c, v: story.var(`cfg.${c.id}`, { label: c.label, type: "int", options: c.options }) }));
  const pricing = story.var("pricing", { label: `the active pricing table${LS}`, options: PRICING });
  const schema = story.var("schema", { label: `the live schema version${LS}`, options: SCHEMA });
  const cur = story.cur;
  let snap = null;

  // Prerequisites: m1 needs flags[0]; mj needs m(j-1) applied and flags[j-1].
  const req = migs.map((m, j) => {
    const r = [{ var: flags[j % flags.length], eq: true }];
    if (j > 0) r.unshift({ var: migs[j - 1], eq: "applied" });
    return r;
  });
  const holds = (conds) => conds.every((c) => cur[c.var] === c.eq);
  const attempt = (stage, j) => {
    const op = { op: "attempt", var: migs[j], success: "applied", fail: "failed", requires: req[j] };
    story.ev(stage, "rule", op);
    cur[migs[j]] = holds(req[j]) ? "applied" : "failed";
  };
  const guarded = (stage, v, value, conds) => {
    story.ev(stage, "state", { op: "set", var: v, value, guard: conds });
    if (holds(conds)) cur[v] = value;
  };

  // Initial specification.
  flags.forEach((f, i) => story.set(0, f, i === 0 ? false : rng.chance(0.5)));
  migs.forEach((m) => story.set(0, m, "pending"));
  cfgs.forEach((c) => story.set(0, c.v, rng.pick(c.options)));
  story.set(0, pricing, rng.pick(PRICING));
  story.set(0, schema, SCHEMA[0]);

  // Ordered milestones; each runs at a stage that rises with its index.
  const ms = [];
  ms.push((s) => attempt(s, 0)); // flags[0] is OFF: m1 fails
  ms.push((s) => guarded(s, schema, SCHEMA[2], [{ var: migs[depth - 1], eq: "applied" }])); // void: not applied
  ms.push((s) => {
    story.set(s, cfgs[0].v, rng.pickOther(cfgs[0].options, cur[cfgs[0].v]));
    story.ev(s, "rule", { op: "snapshot", label: CP });
    snap = { [cfgs[0].v]: cur[cfgs[0].v], [pricing]: cur[pricing] };
  });
  ms.push((s) => {
    story.set(s, flags[0], true);
    attempt(s, 0); // now applied
  });
  for (let j = 1; j < depth; j += 1) {
    ms.push((s) => {
      const f = req[j][req[j].length - 1].var;
      if (rng.chance(0.65) && cur[f] !== true) story.set(s, f, true);
      attempt(s, j);
      if (cur[migs[j]] === "failed") {
        story.set(s, f, true);
        attempt(s, j);
      }
    });
  }
  ms.push((s) => {
    story.set(s, cfgs[0].v, rng.pickOther(cfgs[0].options, cur[cfgs[0].v]));
    story.set(s, pricing, rng.pickOther(PRICING, cur[pricing]), { kind: "supersede" });
    story.set(s, cfgs[1].v, rng.pickOther(cfgs[1].options, cur[cfgs[1].v]));
  });
  ms.push((s) => {
    story.ev(s, "supersede", { op: "rollback", label: CP, vars: [cfgs[0].v, pricing] });
    cur[cfgs[0].v] = snap[cfgs[0].v];
    cur[pricing] = snap[pricing];
  });
  ms.push((s) => guarded(s, schema, rng.pick([SCHEMA[1], SCHEMA[3]]), [{ var: migs[depth - 1], eq: "applied" }]));
  // A late failure: the last flag is turned OFF and a dependent step becomes void.
  ms.push((s) => {
    const f = flags[flags.length - 1];
    story.set(s, f, false, { kind: "supersede" });
    guarded(s, cfgs[1].v, rng.pickOther(cfgs[1].options, cur[cfgs[1].v]), [{ var: f, eq: true }]);
  });

  const at = ms.map((_, i) => Math.min(stages, 1 + Math.floor((i * stages) / ms.length)));
  // Filler updates: flag toggles on flags that no later milestone needs, and config changes.
  const filler = [];
  const freeFlags = flags.slice(depth);
  for (let i = 0; i < Math.max(0, p.updates - ms.length * 2); i += 1) filler.push(rng.int(1, stages));
  filler.sort((a, b) => a - b);
  let fi = 0;
  for (let s = 1; s <= stages; s += 1) {
    ms.forEach((m, i) => {
      if (at[i] === s) m(s);
    });
    while (fi < filler.length && filler[fi] === s) {
      if (freeFlags.length > 1 && rng.chance(0.5)) {
        const f = rng.pick(freeFlags.slice(0, -1));
        story.set(s, f, !cur[f], { kind: "supersede" });
      } else {
        story.set(s, cfgs[1].v, rng.pickOther(cfgs[1].options, cur[cfgs[1].v]));
      }
      fi += 1;
    }
  }

  const flagQ = flags[flags.length - 1];
  story.q({ text: `What is the final status of ${MP}migration m${depth}?`, type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: migs[depth - 1] } });
  if (depth > 1) {
    story.q({ text: `What is the status of ${MP}migration m1 now?`, type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: migs[0] } });
  }
  story.q({ text: "Which schema version is live now?", type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: schema } });
  story.q({ text: `What is ${cfgs[0].label} now? Answer with a number.`, type: "int", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: cfgs[0].v } });
  story.q({ text: `What is ${cfgs[1].label} now? Answer with a number.`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: cfgs[1].v } });
  story.q({ text: "Which pricing table is active now?", type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: pricing } });
  if (depth === 1 && flags.length >= 4) {
    story.q({ text: "How many of the feature flags are ON now?", type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "countEq", vars: flags, value: true } });
  }
  story.q({ text: `In the initial specification, what was ${cfgs[1].label}? Answer with a number.`, type: "int", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: cfgs[1].v } });
  story.q({ text: `Is the flag ${flagQ.slice(5)} ON now? Answer true for ON, false for OFF.`, type: "bool", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: flagQ } });

  if (p.compactAfter.length > 0) {
    story.cq({ text: `At this point, what is the status of ${MP}migration m1?`, type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: migs[0] } });
    story.cq({ text: `At this point, what is ${cfgs[0].label}? Answer with a number.`, type: "int", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: cfgs[0].v } });
    story.cq({ text: "At this point, which pricing table is active?", type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query: { q: "value", var: pricing } });
  }
  return { entities: flags.length + migs.length + 4, depth };
}
