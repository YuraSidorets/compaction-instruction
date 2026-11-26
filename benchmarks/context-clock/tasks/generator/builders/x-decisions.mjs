// Shape "decision" (kind X, v0.9): decisions in prose with a recorded reason (a later event can replace the decision,
// or only its reason), constraints that the user sets and later lifts, and open questions that receive an answer or
// stay open. Every fact is stated in prose inside notes, tickets and feeds; no event line has the form
// "name: value". Distractors as in the old tasks: proposals with no decision, withdrawn drafts, archived copies and
// corrections. The builder declares the variables, events and queries only; the key comes from reference.mjs.
import { stagePlan } from "./common.mjs";

export const CONSTRAINT_STATES = ["in-force", "lifted"];
export const STILL_OPEN = "still-open";

const NUM = " Answer with a number.";

const DISTRACT = {
  mention: [
    "{P} suggested in the meeting that {L} should be {V}. The group made no decision, so nothing changes.",
    "In chat, {P} asked whether {L} could be {V}. The question was closed without a change.",
  ],
  withdrawn: [
    "A draft memo by {P} said that {L} would be {V}. {P} withdrew the memo before the review, so it changes nothing.",
    "{P} circulated a draft in which {L} was {V}. The draft was withdrawn the same day and changes nothing.",
  ],
  touch: [
    "{P} asked who keeps the record of {L}. The thread ended with no change.",
    "{P} linked the wiki page about {L} in the weekly notes. Nobody proposed a change.",
    "{P} wants a short history of {L} for new team members. This is a docs task only and changes nothing.",
  ],
  restate: [
    "An archived copy of the decision log from the time of entry {REF} says that {L} was {V}. The copy is history only and is not a new statement.",
    "{P} quoted old meeting notes written at the time of entry {REF}, in which {L} is {V}. The quote is history only and changes nothing.",
  ],
};

const T = {
  decision: {
    set: [
      "In the design meeting, the group chose {V}, and {P} recorded it as {L}.",
      "After the trial results, {P} wrote in the decision log that {L} is {V}.",
      "The architecture review approved {V} as {L}, as {P} noted in the minutes.",
    ],
    supersede: [
      "The group replaced the earlier choice. As {P} recorded, {L} is {V} from now on.",
      "Correction from {P}: {L} is {V}, and the earlier entry in the decision log was wrong.",
    ],
  },
  reason: {
    set: [
      "{P} recorded why the group chose it, and {L} is {V}.",
      "The minutes by {P} give the motive of the choice, so {L} is {V}.",
      "In the decision log, {P} wrote down that {L} is {V}.",
    ],
    supersede: [
      "The choice stays, but {P} replaced its motive in the log, so {L} is {V} now.",
      "Correction from {P}: {L} is {V}, and the earlier motive in the log was wrong.",
    ],
  },
  constraint: {
    set: [
      "After a message from the user, {P} recorded that {L} is {V}.",
      "In the call with the user, {P} noted that {L} is {V} from now on.",
      "{P} forwarded the decision of the user, and with it {L} became {V}.",
    ],
    supersede: [
      "The user changed the rule again, so {L} is {V} now, as {P} recorded.",
      "Correction from {P}: {L} is {V}, and the earlier note about the rule of the user was wrong.",
    ],
  },
  question: {
    set: [
      "{P} brought the question to the meeting, and {L} is {V} for now.",
      "In the review, {P} recorded that {L} is {V}.",
      "{P} wrote in the ticket that {L} is {V}.",
    ],
    supersede: [
      "The group came back to the question. {P} recorded that {L} is {V} from now on.",
      "Correction from {P}: {L} is {V}, and the earlier note about the question was wrong.",
    ],
  },
};

function templates(kind) {
  return { ...T[kind], ...DISTRACT };
}

/**
 * p.pools: { topics: [{ id, label, options, type? }], reasons: ["why-..."], constraints: ["cn-..."],
 * questions: [{ id, options }] }. p.entities: the number of decisions. p.reasons, p.constraints, p.questions: the
 * counts. p.updates: the number of state changes over stages 1..stages.
 */
export function buildDecisionRecord(story, p) {
  const { rng, stages } = story;
  const P = p.pools;
  const scalarTopics = P.topics.filter((t) => !t.type);
  const intTopic = rng.pick(P.topics.filter((t) => t.type === "int"));
  const topics = [...rng.sample(scalarTopics, p.entities - 1), intTopic];
  const dec = {};
  const rsn = {};
  for (const t of topics) dec[t.id] = story.var(`decision.${t.id}`, { label: `the decision on ${t.label}`, type: t.type === "int" ? "int" : "scalar", options: t.options, templates: templates("decision") });
  const withReason = topics.filter((t) => !t.type).slice(0, p.reasons);
  for (const t of withReason) rsn[t.id] = story.var(`reason.${t.id}`, { label: `the reason for the decision on ${t.label}`, options: P.reasons, templates: templates("reason") });
  const cons = rng.sample(P.constraints, p.constraints);
  const con = Object.fromEntries(cons.map((c) => [c, story.var(`constraint.${c}`, { label: `the status of the constraint ${c}`, options: CONSTRAINT_STATES, templates: templates("constraint") })]));
  const oqs = rng.sample(P.questions, p.questions);
  const oq = Object.fromEntries(oqs.map((x) => [x.id, story.var(`question.${x.id}`, { label: `the answer to the open question ${x.id}`, options: [STILL_OPEN, ...x.options], templates: templates("question") })]));

  // The initial record (stage 0): every decision with its reason, two constraints of the user, all questions open.
  for (const t of topics) story.set(0, dec[t.id], rng.pick(t.options));
  for (const t of withReason) story.set(0, rsn[t.id], rng.pick(P.reasons));
  for (const c of cons.slice(0, 2)) story.set(0, con[c], "in-force");
  for (const x of oqs) story.set(0, oq[x.id], STILL_OPEN);

  const hot = topics[0];
  // Facts that change only up to the first compaction (each changes once there), so that some answers are set early
  // and kept: the reason of one decision, one constraint and the answer of one open question.
  const early = p.compactAfter.length > 0 ? p.compactAfter[0] : stages;
  const stableReason = withReason.at(-1);
  const stable = new Set([rsn[stableReason.id], con[cons[0]], oq[oqs[0].id]]);
  story.set(rng.int(1, early), rsn[stableReason.id], rng.pickOther(P.reasons, story.cur[rsn[stableReason.id]]), { kind: "supersede" });
  story.set(rng.int(1, early), con[cons[0]], "lifted", { kind: "supersede" });
  story.set(rng.int(1, early), oq[oqs[0].id], rng.pick(oqs[0].options));
  const later = cons.slice(2); // constraints that the user sets after the start
  const pickChange = (i) => {
    if (i % 4 === 0) return { kind: "decision", t: hot };
    const r = rng.float();
    if (r < 0.32) return { kind: "decision", t: rng.pick(topics) };
    if (r < 0.52) return { kind: "reason", t: rng.pick(withReason) };
    if (r < 0.74) return { kind: "constraint", c: rng.pick(cons) };
    return { kind: "question", x: rng.pick(oqs) };
  };
  // An open question that stays open: the last question gets no answer.
  const keepOpen = oqs.at(-1).id;
  const set = (stage, v, value, kind) => {
    if (rng.chance(0.12)) {
      // A correction: a wrong entry first, then its fix in the same stage.
      const wrongs = story.vars[v].options.filter((x) => x !== value && x !== story.cur[v]);
      if (wrongs.length > 0) {
        story.set(stage, v, rng.pick(wrongs));
        story.set(stage, v, value, { kind: "supersede" });
        return;
      }
    }
    story.set(stage, v, value, { kind });
  };
  const varOf = (ch) => (ch.kind === "decision" ? dec[ch.t.id] : ch.kind === "reason" ? rsn[ch.t.id] : ch.kind === "constraint" ? con[ch.c] : oq[ch.x.id]);
  stagePlan(rng, p.updates, stages).forEach((stage, i) => {
    let ch = pickChange(i);
    for (let k = 0; k < 5 && stage > early && stable.has(varOf(ch)); k += 1) ch = pickChange(i + 1);
    if (stage > early && stable.has(varOf(ch))) return;
    let v;
    let value;
    if (ch.kind === "decision") {
      v = dec[ch.t.id];
      value = rng.pickOther(ch.t.options, story.cur[v]);
      set(stage, v, value, rng.chance(0.5) ? "supersede" : "state");
      // A new decision often comes with a new reason.
      if (rsn[ch.t.id] && !(stage > early && stable.has(rsn[ch.t.id])) && rng.chance(0.6)) story.set(stage, rsn[ch.t.id], rng.pickOther(P.reasons, story.cur[rsn[ch.t.id]]), { kind: "supersede" });
    } else if (ch.kind === "reason") {
      v = rsn[ch.t.id];
      value = rng.pickOther(P.reasons, story.cur[v]);
      set(stage, v, value, "supersede");
    } else if (ch.kind === "constraint") {
      v = con[ch.c];
      const cur = story.cur[v];
      value = cur === "in-force" ? "lifted" : "in-force";
      // A constraint that the user has not set yet starts in force.
      if (cur === null && !later.includes(ch.c)) return;
      set(stage, v, value, cur === null ? "state" : "supersede");
    } else {
      if (ch.x.id === keepOpen) return;
      v = oq[ch.x.id];
      value = rng.pickOther(ch.x.options, story.cur[v]);
      set(stage, v, value, story.cur[v] === STILL_OPEN ? "state" : "supersede");
    }
    if (rng.chance(0.3)) {
      const bogus = rng.pickOther(story.vars[v].options, story.cur[v]);
      story.ev(stage, "conflict", { op: "mention", var: v, value: bogus }, rng.chance(0.5) ? { withdrawn: true } : {});
    }
  });
  // Every constraint is set at some point, and one constraint is in force at the end.
  for (const c of later) if (story.cur[con[c]] === null) story.set(rng.int(2, stages), con[c], "in-force");
  if (!cons.some((c) => story.cur[con[c]] === "in-force")) story.set(stages, con[cons[1]], "in-force", { kind: "supersede" });

  const changes = (v) => story.events.filter((e) => e.stage > 0 && e.op.op === "set" && e.op.var === v).length;
  const most = (vs, not = []) => vs.filter((v) => !not.includes(v)).sort((x, y) => changes(y) - changes(x))[0];
  const label = (v) => story.vars[v].label;
  const rPrev = rsn[stableReason.id];
  const rNow = most(Object.values(rsn), [rPrev]);
  const initT = rng.pick(topics.filter((t) => !t.type && t !== hot));
  const conLabels = Object.fromEntries(cons.map((c) => [con[c], c]));
  const oqLabels = Object.fromEntries(oqs.map((x) => [oq[x.id], x.id]));
  const lifted = con[cons[0]];
  const answered = oq[oqs[0].id];

  story.q({ text: `What is ${label(dec[hot.id])} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: dec[hot.id] } });
  story.q({ text: `Which values were decided for ${hot.label} at some point and are no longer the decision? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: dec[hot.id] } });
  story.q({ text: `What is ${label(rNow)} now? Answer with the reason id.`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: rNow } });
  story.q({ text: `What was ${label(rPrev)} directly before its current reason? Answer with the reason id.`, type: "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: rPrev } });
  story.q({ text: `What is ${label(dec[intTopic.id])} now?${NUM}`, type: "int", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: dec[intTopic.id] } });
  story.q({ text: "Which constraints of the user are in force now? List every constraint id.", type: "set", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "whereEq", vars: Object.keys(conLabels), value: "in-force", labels: conLabels } });
  story.q({ text: `Is the constraint ${lifted.slice(11)} lifted now? Answer true or false.`, type: "bool", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "eq", var: lifted, value: "lifted" } });
  story.q({ text: `What is ${label(answered)} now? Answer ${STILL_OPEN} if it has no answer.`, type: "choice", aspect: "outstanding_work", errorCategory: "obsolete_decision", query: { q: "value", var: answered } });
  story.q({ text: "Which open questions have no answer now? List every question id.", type: "set", aspect: "outstanding_work", errorCategory: "obsolete_decision", query: { q: "whereEq", vars: Object.keys(oqLabels), value: STILL_OPEN, labels: oqLabels } });
  story.q({ text: `In the initial specification, what was ${label(dec[initT.id])}?`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: dec[initT.id] } });

  const rules = [
    "Rules for this task:",
    "- A value changes only by an event that decides, answers, corrects, assigns, links or reviews it. A proposal with no decision, a withdrawn draft, a question, a link to a page and an archived copy change nothing.",
    "- A correction or a new entry replaces the earlier value. The earlier value is then superseded.",
    "- The initial specification gives the first value of each item.",
    "- A question about the values of an item \"at some point\" counts every value from the initial specification on, up to the time of the question. The value \"directly before\" the current value is the value that the current value replaced.",
    `- Some decisions have a recorded reason. The closed list of reason ids is ${P.reasons.map((x) => `\`${x}\``).join(", ")}.`,
    "- Each decision with a recorded reason has one reason at a time. An entry that records a reason for it replaces the earlier reason. A later entry can replace the reason and keep the decision. A new decision with no such entry keeps the earlier reason.",
    `- The user sets constraints and can lift them later. A constraint is \`${CONSTRAINT_STATES[0]}\` or \`${CONSTRAINT_STATES[1]}\`.`,
    `- An open question has the answer \`${STILL_OPEN}\` until an entry answers it. A later entry can replace an answer.`,
  ];
  return { entities: topics.length + cons.length + oqs.length, depth: 2, rules };
}
