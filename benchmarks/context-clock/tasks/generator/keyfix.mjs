// Key metadata fixes of the v08 tasks (two faults of the v0.7 keys). The v07 keys keep the old metadata.
// 1. An "allowed now" answer: establishedBy names the events that the current answer rests on, which are the last
//    event that set the current condition and the last event that set the current value of its flag.
// 2. Every answer: establishedBy cites only events that touch a variable of the question. The old rule cited the
//    first event of the task when a question held a value before any event (for example "is X in the list?" with
//    false for an option that occurs in no event). Such a citation becomes the first event that touches a variable
//    of the question.
// The answer value, staleValues and the other fields do not change.
import { createMachine } from "./reference.mjs";

/** The variables that a query reads. */
export function queryVars(query) {
  if (query.q === "allowed") return [query.cond, ...new Set(Object.values(query.rules).filter(Boolean).map((r) => r.var))];
  if (query.q === "diff") return [query.a, query.b];
  if (Array.isArray(query.vars)) return query.vars;
  return [query.var];
}

/** True when the event can change one of the variables in S. */
export function touches(e, S, vars, events) {
  const op = e.op;
  if (typeof op.var === "string" && S.has(op.var)) return true;
  if (op.op === "rollback") return op.vars.some((v) => S.has(v));
  if (op.op === "rename") return [...S].some((id) => vars[id].domain === op.domain);
  if (op.op === "retract") return events.some((x) => x.op.op === "claim" && x.op.doc === op.doc && S.has(x.op.var));
  if (op.op === "authority") return [...S].some((id) => vars[id].mode === "claims");
  return false;
}

/** The events that an "allowed" answer rests on, in time order. */
function restingEvents(vars, timeline, query) {
  const m = createMachine(vars);
  const lastChange = {};
  const watch = queryVars(query);
  for (const e of timeline) {
    const before = watch.map((id) => JSON.stringify(m.valueOf(id)));
    m.apply(e.op);
    watch.forEach((id, i) => {
      if (JSON.stringify(m.valueOf(id)) !== before[i]) lastChange[id] = e;
    });
  }
  const rule = query.rules[m.valueOf(query.cond)];
  const out = [lastChange[query.cond]];
  if (rule) out.push(lastChange[rule.var]);
  return [...new Set(out.filter(Boolean))].sort((a, b) => timeline.indexOf(a) - timeline.indexOf(b));
}

/** One answer record with fixed establishedBy (and the stages that follow from it). */
export function fixAnswer(vars, events, question, answer, upToStage = Infinity) {
  const timeline = events.filter((e) => e.stage <= upToStage);
  const byId = new Map(timeline.map((e) => [e.id, e]));
  const S = new Set(queryVars(question.query));
  if (question.query.q === "allowed") {
    const rest = restingEvents(vars, timeline, question.query);
    const first = Math.min(...rest.map((e) => e.stage));
    return { ...answer, establishedBy: rest.map((e) => e.id), firstEstablishedStage: first, lastChangedStage: Math.max(first, ...rest.map((e) => e.stage)) };
  }
  const kept = answer.establishedBy.filter((id) => touches(byId.get(id), S, vars, timeline));
  if (kept.length === answer.establishedBy.length) return answer;
  const firstTouch = timeline.find((e) => touches(e, S, vars, timeline));
  const ids = [...new Set([...(firstTouch ? [firstTouch.id] : []), ...kept])].sort((a, b) => timeline.indexOf(byId.get(a)) - timeline.indexOf(byId.get(b)));
  const first = byId.get(ids[0]).stage;
  return { ...answer, establishedBy: ids, firstEstablishedStage: first, lastChangedStage: Math.max(first, answer.lastChangedStage) };
}

/** The key with fixed answers and checkpoint answers. ref: { vars, events, questions, checkpointQuestions }. */
export function fixKey(key, ref, probes) {
  const answers = Object.fromEntries(Object.entries(key.answers).map(([id, a]) => [id, fixAnswer(ref.vars, ref.events, ref.questions.find((q) => q.id === id), a)]));
  const stageOf = new Map(probes.flatMap((p) => p.questionIds.map((id) => [id, p.afterStage])));
  const checkpointAnswers = Object.fromEntries(
    Object.entries(key.checkpointAnswers).map(([id, a]) => [id, fixAnswer(ref.vars, ref.events, ref.checkpointQuestions.find((q) => q.id === id), a, stageOf.get(id))]),
  );
  return { ...key, answers, checkpointAnswers };
}
