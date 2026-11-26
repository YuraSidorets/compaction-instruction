// Shape "incident" (kind T, v12): the timeline of one production incident. The working state is a set of roles that
// people hand over (incident commander, communications lead, operations lead), the severity, the services that are
// affected now (a set that grows and shrinks), the state of the status page, two times of the timeline that a
// correction can fix, mitigation actions with a status, and the leading root cause hypothesis (earlier hypotheses
// are ruled out). Every fact is stated in prose inside notes, tickets and feeds; no event line has the form
// "name: value". Distractors as in the other shapes: proposals with no decision, withdrawn drafts, archived copies
// and corrections. The builder declares the variables, events and queries only; the key comes from reference.mjs.
import { stagePlan } from "./common.mjs";

export const SEVERITIES = ["sev-1", "sev-2", "sev-3", "sev-4"];
export const PAGE_STATES = ["investigating", "identified", "monitoring", "resolved"];
export const ACTION_STATES = ["planned", "running", "finished", "abandoned"];

const DISTRACT = {
  mention: [
    "{P} suggested in the incident channel that {L} should be {V}. Nobody decided it, so nothing changes.",
    "On the bridge call, {P} asked whether {L} could be {V}. The question was dropped with no change.",
  ],
  withdrawn: [
    "A draft of the postmortem by {P} said that {L} was {V}. {P} withdrew the draft, so it changes nothing.",
    "{P} posted a draft update in which {L} was {V}. The draft was withdrawn before it went out and changes nothing.",
  ],
  touch: [
    "{P} asked where the runbook explains {L}. The thread ended with no change.",
    "{P} linked the dashboard that tracks {L} in the incident notes. Nobody proposed a change.",
    "{P} wants the postmortem template to describe {L} better. This is a docs task only and changes nothing.",
  ],
  restate: [
    "An archived copy of the incident document from the time of entry {REF} says that {L} was {V}. The copy is history only and is not a new statement.",
    "{P} quoted an old bridge summary written at the time of entry {REF}, in which {L} is {V}. The quote is history only and changes nothing.",
  ],
};

const T = {
  role: {
    set: [
      "On the bridge call, {P} handed over, so {L} is now {V}.",
      "{P} wrote in the incident channel that {L} is {V} from now on.",
      "After the shift change, {L} became {V}, as {P} recorded.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier handover note was wrong.",
      "{P} took the handover back, so {L} is {V} again from now on.",
    ],
  },
  severity: {
    set: [
      "{P} reassessed the impact, and {L} is now {V}.",
      "On the bridge call, the group agreed that {L} is {V}, as {P} recorded.",
      "{P} changed the incident record, so {L} became {V}.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier assessment was wrong.",
      "{P} revised the assessment again, so {L} is {V} from now on.",
    ],
  },
  page: {
    set: [
      "{P} published an update, and {L} is now {V}.",
      "The status page changed after a post by {P}, so {L} became {V}.",
      "{P} wrote in the channel that {L} is {V} from now on.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier post went out by mistake.",
      "{P} moved the status page back, so {L} is {V} now.",
    ],
  },
  time: {
    set: [
      "{P} checked the graphs and recorded that {L} is {V}.",
      "In the timeline document, {P} wrote that {L} is {V}.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier entry in the timeline was wrong.",
      "{P} found an earlier alert in the logs, so {L} is {V} now.",
    ],
  },
  action: {
    set: [
      "{P} reported on the bridge call that {L} is now {V}.",
      "{P} updated the action list, and {L} became {V}.",
      "In the incident channel, {P} wrote that {L} is {V} from now on.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier action note was wrong.",
      "{P} changed the plan, so {L} is {V} now.",
    ],
  },
  cause: {
    set: [
      "{P} presented the evidence, and {L} is now {V}.",
      "After the log review, the group agreed that {L} is {V}, as {P} recorded.",
      "{P} wrote in the timeline that {L} became {V}.",
    ],
    supersede: [
      "The earlier hypothesis is ruled out. As {P} recorded, {L} is {V} from now on.",
      "Correction from {P}: {L} is {V}, and the earlier hypothesis was a mistake.",
    ],
  },
  affected: {
    add: [
      "{P} confirmed errors on {V}, so {V} joins the affected services.",
      "In the incident channel, {P} reported that {V} is among the affected services from now on.",
      "The error graphs that {P} shared add {V} to the affected services.",
    ],
    remove: [
      "{P} reported that {V} recovered, so {V} leaves the affected services.",
      "After the check by {P}, {V} is no longer among the affected services.",
      "{P} confirmed that {V} is healthy again, and {V} is removed from the affected services.",
    ],
  },
};

function templates(kind) {
  return { ...T[kind], ...DISTRACT };
}

/** The next state of a mitigation action. */
function nextAction(rng, cur) {
  if (cur === "planned") return "running";
  if (cur === "running") return rng.chance(0.7) ? "finished" : "abandoned";
  if (cur === "abandoned") return "planned";
  return "running"; // a finished action runs again
}

/**
 * p.pools: { people: [...], services: [...], times: ["13:41", ...], actions: ["act-..."], causes: ["cause-..."] }.
 * p.actions: the number of mitigation actions. p.updates: the number of state changes over stages 1..stages.
 */
export function buildIncident(story, p) {
  const { rng, stages } = story;
  const P = p.pools;
  const roles = [
    story.var("role.commander", { label: "the incident commander", options: P.people, templates: templates("role") }),
    story.var("role.comms", { label: "the communications lead", options: P.people, templates: templates("role") }),
    story.var("role.ops", { label: "the operations lead", options: P.people, templates: templates("role") }),
  ];
  const [cmd, comms, ops] = roles;
  const sev = story.var("severity", { label: "the severity of the incident", options: SEVERITIES, templates: templates("severity") });
  const page = story.var("statuspage", { label: "the state of the status page", options: PAGE_STATES, templates: templates("page") });
  const affected = story.var("affected", { label: "the affected services", type: "set", options: P.services, templates: templates("affected") });
  const tStart = story.var("time.start", { label: "the start time of the customer impact", options: P.times, templates: templates("time") });
  const tDetect = story.var("time.detect", { label: "the detection time of the incident", options: P.times, templates: templates("time") });
  const acts = rng.sample(P.actions, p.actions).map((a) => story.var(`action.${a}`, { label: `the status of the mitigation action ${a}`, options: ACTION_STATES, templates: templates("action") }));
  const cause = story.var("cause", { label: "the leading root cause hypothesis", options: P.causes, templates: templates("cause") });

  // The first page (stage 0).
  const people = rng.sample(P.people, 3);
  roles.forEach((r, i) => story.set(0, r, people[i]));
  story.set(0, sev, "sev-3");
  story.set(0, page, "investigating");
  for (const s of rng.sample(P.services, 2)) story.add(0, affected, s);
  const [t0, t1] = rng.sample(P.times.slice(2, -2), 2).sort(); // earlier and later times stay free for corrections
  story.set(0, tStart, t0);
  story.set(0, tDetect, t1);
  for (const a of acts) story.set(0, a, "planned");
  story.set(0, cause, rng.pick(P.causes));

  // Facts that change only up to the first compaction (once each), so that some answers are set early and kept.
  const early = p.compactAfter.length > 0 ? p.compactAfter[0] : stages;
  const stableAct = acts.at(-1);
  const stable = new Set([comms, tStart, stableAct]);
  story.set(rng.int(1, early), comms, rng.pickOther(P.people, story.cur[comms]));
  story.set(rng.int(1, early), tStart, rng.pick(P.times.filter((t) => t < story.cur[tStart])), { kind: "supersede" });
  const sa = rng.int(1, early);
  story.set(sa, stableAct, "running");
  story.set(sa, stableAct, "finished");

  const nextOf = (v) => {
    const cur = story.cur[v];
    if (v.startsWith("role.")) return rng.pickOther(P.people.filter((x) => !roles.some((r) => r !== v && story.cur[r] === x)), cur);
    if (v === sev) {
      const i = SEVERITIES.indexOf(cur);
      return SEVERITIES[i === 0 ? 1 : i === SEVERITIES.length - 1 ? i - 1 : rng.chance(0.55) ? i - 1 : i + 1];
    }
    if (v === page) return cur === "investigating" ? "identified" : cur === "identified" ? rng.pick(["monitoring", "investigating"]) : "identified";
    if (v === tDetect) {
      const later = P.times.filter((t) => t > story.cur[tStart] && t !== cur);
      return later.length === 0 ? null : rng.pick(later);
    }
    if (v.startsWith("action.")) return nextAction(rng, cur);
    return rng.pickOther(P.causes, cur);
  };
  const pick = (i) => {
    if (i % 4 === 0) return cmd;
    const r = rng.float();
    if (r < 0.12) return rng.pick([cmd, ops]);
    if (r < 0.24) return sev;
    if (r < 0.46) return affected;
    if (r < 0.66) return rng.pick(acts);
    if (r < 0.8) return cause;
    if (r < 0.94) return page;
    return tDetect;
  };
  stagePlan(rng, p.updates, stages).forEach((stage, i) => {
    let v = pick(i);
    for (let k = 0; k < 5 && stable.has(v); k += 1) v = pick(i + 1);
    if (stable.has(v)) return;
    if (v === affected) {
      const cur = story.cur[affected];
      if (cur.length > 1 && rng.chance(0.45)) story.remove(stage, affected, rng.pick(cur));
      else {
        const free = P.services.filter((s) => !cur.includes(s));
        if (free.length > 0) story.add(stage, affected, rng.pick(free), { kind: "state" });
      }
      return;
    }
    const next = nextOf(v);
    if (next === undefined || next === null) return;
    if (rng.chance(0.1) && !v.startsWith("time.")) {
      // A correction: a wrong note first, then its fix in the same stage.
      const wrongs = story.vars[v].options.filter((x) => x !== next && x !== story.cur[v] && x !== "resolved");
      if (wrongs.length > 0) {
        story.set(stage, v, rng.pick(wrongs));
        story.set(stage, v, next, { kind: "supersede" });
      } else story.set(stage, v, next);
    } else story.set(stage, v, next, { kind: rng.chance(0.25) ? "supersede" : "state" });
    if (rng.chance(0.3)) {
      const bogus = rng.pickOther(story.vars[v].options, story.cur[v]);
      story.ev(stage, "conflict", { op: "mention", var: v, value: bogus }, rng.chance(0.5) ? { withdrawn: true } : {});
    }
  });
  // The answers of the set questions must not be empty: one service is affected and one action is finished.
  if (story.cur[affected].length === 0) story.add(stages, affected, rng.pick(P.services));

  const actLabels = Object.fromEntries(acts.map((a) => [a, a.slice(7)]));

  story.q({ text: "Who is the incident commander now? Answer with the handle.", type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: cmd } });
  story.q({ text: "Who was the incident commander directly before the current one? Answer with the handle.", type: "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: cmd } });
  story.q({ text: "Which people were the incident commander at some point and are not the incident commander now? List every handle.", type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: cmd } });
  story.q({ text: "What is the severity of the incident now?", type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: sev } });
  story.q({ text: "Which services are affected now? List every service.", type: "set", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "members", var: affected } });
  story.q({ text: "What is the start time of the customer impact now? Answer with the time.", type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: tStart } });
  story.q({ text: "Which mitigation actions are finished now? List every action id.", type: "set", aspect: "completed_work", errorCategory: "obsolete_decision", query: { q: "whereEq", vars: acts, value: "finished", labels: actLabels } });
  story.q({ text: "What is the leading root cause hypothesis now?", type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: cause } });
  story.q({ text: "Who was the communications lead directly before the current one? Answer with the handle.", type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "previous", var: comms } });
  story.q({ text: "On the first page, what was the severity of the incident?", type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: sev } });

  const rules = [
    "Rules for this task:",
    "- A value changes only by an event that decides, hands over, reports, corrects, adds or removes it. A proposal with no decision, a withdrawn draft, a question, a link to a page and an archived copy change nothing.",
    "- A correction or a new entry replaces the earlier value. The earlier value is then superseded.",
    "- The initial specification is the first page of the incident. It gives the first value of each item.",
    "- A question about the values of an item \"at some point\" counts every value from the initial specification on, up to the time of the question. The value \"directly before\" the current value is the value that the current value replaced.",
    "- Each role has one person at a time. A handover replaces the earlier person.",
    `- The severity is one of ${SEVERITIES.map((x) => `\`${x}\``).join(", ")}. The status page is one of ${PAGE_STATES.map((x) => `\`${x}\``).join(", ")}. A mitigation action is one of ${ACTION_STATES.map((x) => `\`${x}\``).join(", ")}.`,
    "- A service is affected from the event that adds it until an event removes it. The leading root cause hypothesis has one value at a time. A new hypothesis rules out the earlier one.",
  ];
  return { entities: roles.length + 6 + acts.length, depth: 2, rules };
}
