// Small helpers shared by the category builders.

/** n stage numbers in 1..stages, ascending, every stage used once before any repeats when n >= stages. */
export function stagePlan(rng, n, stages) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(i < stages ? i + 1 : rng.int(1, stages));
  return out.sort((a, b) => a - b);
}

/** The question options for a scalar universe: sorted copy as strings. */
export function sortedStrings(list) {
  return [...new Set(list.map(String))].sort();
}

/** Picks the stage whose state events go into the large feed: a middle stage. */
export function bigStage(rng, stages, compactAfter) {
  const choices = [];
  for (let s = 2; s <= stages - 1; s += 1) if (!compactAfter.includes(s)) choices.push(s);
  return choices.length > 0 ? rng.pick(choices) : 2;
}

/** Adds small noise over stages 1..stages (and a little in the intro is never added: the intro is a spec). */
export function sprinkleNoise(story, total) {
  const { rng, stages } = story;
  for (let i = 0; i < total; i += 1) story.noise(rng.int(1, stages), 1);
}

/** The first stage after the first compaction, or null for profile long. */
export function afterCompaction(compactAfter) {
  return compactAfter.length === 0 ? null : compactAfter[0] + 1;
}

/**
 * Adds distractors to stages 1..stages: near misses (the subject appears, nothing changes), rejected proposals, and
 * dated copies of old values. A copy only quotes a value that a later event changes, and never the initial value of
 * a variable that an "initial" question asks about. All distractors have kind "conflict" and change no state.
 */
export function addDistractors(story, factor) {
  const { rng, stages, vars, events } = story;
  const qs = [...story.questions, ...story.checkpointQuestions];
  const initialVars = new Set(qs.filter((q) => q.query.q === "initial").map((q) => q.query.var));
  const setters = events.filter((e) => (e.op.op === "set" && !e.op.guard) || e.op.op === "claim");
  const outdated = setters.filter((e) => setters.some((x) => x !== e && x.op.var === e.op.var && events.indexOf(x) > events.indexOf(e)));
  const setVars = new Set(setters.map((e) => e.op.var));
  const mentionVars = Object.keys(vars).filter((id) => vars[id].type !== "set" && setVars.has(id) && Array.isArray(vars[id].options) && vars[id].options.length > 1);
  const allVars = Object.keys(vars);
  const made = { restate: 0, mention: 0, touch: 0 };
  const add = (s, type, refs) => {
    if (type === "restate" && refs.length > 0) {
      const ref = rng.pick(refs);
      const op = { op: "restate", var: ref.op.var, value: ref.op.value };
      if (ref.op.op === "claim") Object.assign(op, { source: ref.op.source, doc: ref.op.doc, version: ref.op.version });
      story.ev(s, "conflict", op, { refEvent: ref });
    } else if (type === "mention" && mentionVars.length > 0) {
      const v = rng.pick(mentionVars);
      story.ev(s, "conflict", { op: "mention", var: v, value: rng.pickOther(vars[v].options, story.cur[v]) });
    } else {
      type = "touch";
      story.ev(s, "conflict", { op: "touch", var: rng.pick(allVars) });
    }
    made[type] += 1;
  };
  for (let s = 1; s <= stages; s += 1) {
    const nState = events.filter((e) => e.stage === s && e.kind !== "noise").length;
    const k = Math.max(1, Math.round(nState * factor));
    const refs = outdated.filter((e) => e.stage < s && !(e.stage === 0 && initialVars.has(e.op.var)));
    for (let i = 0; i < k; i += 1) {
      const r = rng.float();
      add(s, r < 0.45 ? "restate" : r < 0.7 ? "mention" : "touch", refs);
    }
    // The last stage adds each kind that is still missing.
    if (s === stages) for (const type of Object.keys(made)) if (made[type] === 0) add(s, type, refs);
  }
}
