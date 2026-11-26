// Probe questions of the v03 tasks: one probe turn directly after each compaction. A probe asks for the state at the
// end of the compaction stage. The candidates are the final questions in a "at this point" form plus one value
// question for each scalar variable that no final question asks. The reference computes every answer.
import { computeAnswers } from "./reference.mjs";

function canon(v) {
  return Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : JSON.stringify(v);
}

/** The aspects that the probes of one task must cover, as far as the category has them. */
export const PROBE_ASPECTS = {
  A: ["current_state", "superseded_decision"],
  B: ["relationship", "current_state"],
  C: ["conditional_state", "current_state"],
  D: ["conflict_resolution"],
  E: ["completed_work", "outstanding_work", "original_constraint", "rejected_approach"],
  W: ["current_state", "relationship"],
  X: ["current_state", "superseded_decision"],
  T: ["current_state", "relationship"],
};

/** Final question text to probe text: "What is X now?" becomes "At this point, what is X?". */
export function probeText(text) {
  const t = text.replace(" now?", "?").replace(" now ", " ").replace("the final status of", "the status of");
  return `At this point, ${t[0].toLowerCase()}${t.slice(1)}`;
}

const NUM = " Answer with a number.";
const BOOL = " Answer true for ON, false for OFF.";

/** One value question for a variable that no final question asks. */
function extraQuestion(id, v, category) {
  const query = { q: "value", var: id };
  if (category === "B" && id.startsWith("owner.")) {
    return { text: `At this point, which team owns ${id.slice(6)}? Use the team's current name.`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query };
  }
  if (category === "C" && id.startsWith("mig.")) {
    return { text: `At this point, what is the status of ${v.label}?`, type: "choice", aspect: "conditional_state", errorCategory: "invalid_transition", query };
  }
  const rule = category === "D" ? "under the precedence rule, " : "";
  const aspect = category === "D" ? "conflict_resolution" : "current_state";
  const errorCategory = category === "D" ? "contradiction" : "obsolete_decision";
  if (v.type === "bool") return { text: `At this point, ${rule}is ${v.label} ON?${BOOL}`, type: "bool", aspect, errorCategory, query };
  if (v.type === "int") return { text: `At this point, ${rule}what is ${v.label}?${NUM}`, type: "int", aspect, errorCategory, query };
  const who = v.label.startsWith("the on-call engineer") ? "who" : "what";
  return { text: `At this point, ${rule}${who} is ${v.label}?`, type: "choice", aspect, errorCategory, query };
}

/** All probe candidates of a story. side: variable ids that no question may ask (the large feed side records). */
export function probeCandidates(story, side) {
  const out = [];
  const asked = new Set();
  for (const q of story.questions) {
    if (q.query.q === "initial") continue;
    if (q.query.q === "value") asked.add(q.query.var);
    out.push({ ...q, text: probeText(q.text), from: q.id });
  }
  for (const [id, v] of Object.entries(story.vars)) {
    if (side.has(id) || asked.has(id) || v.type === "set") continue;
    out.push(extraQuestion(id, v, story.category));
  }
  if (story.category === "A") {
    for (const [id, v] of Object.entries(story.vars)) {
      if (side.has(id) || v.type !== "scalar") continue;
      if (story.questions.some((q) => q.query.q === "superseded" && q.query.var === id)) continue;
      out.push({ text: `At this point, which values were decided for ${v.label} at some point and are no longer the decision? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: id } });
    }
  }
  return out.map((q, i) => ({ ...q, id: `k${i + 1}` }));
}

/**
 * Picks the probe questions. compactAfter: the compaction stages. optionsOf(q): the option list of a choice or set
 * question. Returns [{ afterStage, questions }] with ids c1, c2, ... over all probes.
 */
export function buildProbes(rng, story, refEvents, compactAfter, side, optionsOf) {
  const cands = probeCandidates(story, side);
  const finalAns = computeAnswers(story.vars, refEvents, cands);
  const need = new Set(PROBE_ASPECTS[story.category]);
  const usedQueries = new Set();
  const askedAnswers = new Set(); // query + answer of earlier probes: a later probe never repeats both
  const probes = [];
  let n = 0;
  for (const stage of compactAfter) {
    const ans = computeAnswers(story.vars, refEvents, cands, stage);
    const ok = cands.filter((q) => {
      const v = ans[q.id].value;
      if (v === null || v === undefined) return false;
      if (q.type === "int") return Number.isInteger(v);
      if (q.type === "bool") return typeof v === "boolean";
      const opts = optionsOf(q);
      if (q.type === "choice") return opts.includes(String(v));
      return Array.isArray(v) && v.length > 0 && v.every((x) => opts.includes(String(x)));
    });
    const count = Math.min(ok.length, rng.int(4, 6));
    if (count < 4) throw new Error(`probe after stage ${stage}: only ${ok.length} candidates`);
    const picked = [];
    const aspects = new Set();
    const noise = new Map(ok.map((q) => [q.id, rng.float()]));
    while (picked.length < count) {
      let best = null;
      let bestScore = -Infinity;
      for (const q of ok) {
        if (picked.includes(q)) continue;
        const qk = JSON.stringify(q.query);
        const changed = canon(ans[q.id].value) !== canon(finalAns[q.id].value);
        let s = noise.get(q.id) * 0.5;
        if (need.has(q.aspect)) s += 3;
        if (!aspects.has(q.aspect)) s += 1.5;
        if (changed) s += 2;
        if (!usedQueries.has(qk)) s += 1;
        if (q.from) s += 0.5;
        if (askedAnswers.has(qk + canon(ans[q.id].value))) s -= 6;
        if (s > bestScore) {
          bestScore = s;
          best = q;
        }
      }
      picked.push(best);
      aspects.add(best.aspect);
      need.delete(best.aspect);
      usedQueries.add(JSON.stringify(best.query));
    }
    for (const q of picked) askedAnswers.add(JSON.stringify(q.query) + canon(ans[q.id].value));
    probes.push({
      afterStage: stage,
      questions: picked.map((q) => {
        const { from, ...rest } = q;
        return { ...rest, id: `c${(n += 1)}` };
      }),
    });
  }
  return probes;
}
