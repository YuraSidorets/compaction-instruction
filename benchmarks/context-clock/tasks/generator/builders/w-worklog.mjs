// Shape "worklog" (kind W, v0.9): work items that open, close and reopen, each with an owner and at most one blocking
// item, plus files with a review status. Every fact is stated in prose inside notes, tickets and feeds; no event line
// has the form "name: value". State changes come only from deciding events. Distractors: proposals with no decision,
// drafts that their author withdraws, archived copies of the board and corrections (a wrong note, then its fix).
// The builder declares the variables, events and queries only; the key comes from reference.mjs.
import { stagePlan } from "./common.mjs";

export const ITEM_STATES = ["opened", "closed", "reopened"];
export const FILE_STATES = ["draft", "reviewed", "merged", "reverted"];
export const NO_BLOCKER = "no-blocker";

const NUM = " Answer with a number.";

/** Templates of each variable kind. {L} label, {V} marked value, {P} person, {REF} entry of an archived copy. */
const DISTRACT = {
  mention: [
    "{P} proposed in chat that {L} should become {V}. Nobody decided it, so nothing changes.",
    "In the planning thread, {P} asked whether {L} could be {V}. The thread closed with no decision and no change.",
  ],
  withdrawn: [
    "A draft plan by {P} said that {L} would be {V}. {P} withdrew the draft the same day, so it changes nothing.",
    "{P} shared a draft ticket in which {L} was {V}. The draft was withdrawn before review and changes nothing.",
  ],
  touch: [
    "{P} asked who can answer questions about {L}. The thread ended with no change.",
    "{P} linked the board view that shows {L} in the weekly notes. Nobody proposed a change.",
    "{P} wants a better description of {L} in the wiki. This is a docs task only and changes nothing.",
  ],
  restate: [
    "An archived copy of the board from the time of entry {REF} shows that {L} was {V}. The copy is history only and is not a new statement.",
    "{P} pasted an old board export made at the time of entry {REF}, in which {L} is {V}. The export is history only and changes nothing.",
  ],
};

const T = {
  status: {
    set: [
      "In the stand-up, {P} said that {L} is now {V}.",
      "{P} updated the ticket, and with that update {L} became {V}.",
      "The board sync by {P} moved the card, so {L} is {V} from now on.",
    ],
    supersede: [
      "Correction to an earlier note by {P}: in fact {L} is {V}, and the earlier note was wrong.",
      "{P} changed the card again, so {L} is {V} now and the earlier status no longer holds.",
    ],
  },
  owner: {
    set: [
      "{P} handed the work over in the stand-up, so {L} is now {V}.",
      "After the planning meeting, {L} is {V}, as {P} recorded in the ticket.",
      "{P} assigned the ticket again, and {L} became {V}.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier assignment note was a mistake.",
      "{P} took the earlier assignment back, so {L} is {V} from now on.",
    ],
  },
  blocker: {
    set: [
      "{P} linked the tickets, so {L} is now {V}.",
      "In the dependency review, {P} recorded that {L} is {V} from now on.",
      "{P} updated the dependency field, and {L} became {V}.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier dependency note was wrong.",
      "{P} removed the old link, so {L} is {V} now.",
    ],
  },
  file: {
    set: [
      "The review bot reported for {P} that {L} changed to {V}.",
      "{P} wrote in the review thread that {L} is now {V}.",
      "After the code review by {P}, {L} became {V}.",
    ],
    supersede: [
      "Correction from {P}: {L} is {V}, and the earlier review note was wrong.",
      "{P} undid the earlier step, so {L} is {V} from now on.",
    ],
  },
};

function templates(kind) {
  return { ...T[kind], ...DISTRACT };
}

/** The next status of a work item. */
function nextStatus(cur) {
  return cur === "closed" ? "reopened" : "closed";
}

/** The next status of a file. */
function nextFile(rng, cur) {
  if (cur === "draft") return "reviewed";
  if (cur === "reviewed") return rng.chance(0.75) ? "merged" : "draft";
  if (cur === "merged") return "reverted";
  return rng.chance(0.6) ? "reviewed" : "draft";
}

/**
 * p.pools: { items: ["PAY-214", ...], owners: ["okafor", ...], files: ["src/x.ts", ...] }. p.entities: the number of
 * work items. p.files: the number of files. p.updates: the number of state changes over stages 1..stages.
 */
export function buildWorklog(story, p) {
  const { rng, stages } = story;
  const P = p.pools;
  const items = rng.sample(P.items, p.entities);
  const files = rng.sample(P.files, p.files);
  const st = {};
  const own = {};
  const blk = {};
  const fst = {};
  for (const it of items) {
    st[it] = story.var(`item.${it}.status`, { label: `the status of work item ${it}`, options: ITEM_STATES, templates: templates("status") });
    own[it] = story.var(`item.${it}.owner`, { label: `the owner of work item ${it}`, options: P.owners, templates: templates("owner") });
    blk[it] = story.var(`item.${it}.blocker`, { label: `the work item that blocks ${it}`, options: [NO_BLOCKER, ...items.filter((x) => x !== it)], templates: templates("blocker") });
  }
  for (const f of files) fst[f] = story.var(`file.${f}`, { label: `the status of the file ${f}`, options: FILE_STATES, templates: templates("file") });

  // The board at the start (stage 0).
  for (const it of items) {
    story.set(0, st[it], "opened");
    story.set(0, own[it], rng.pick(P.owners));
  }
  const blocked0 = rng.sample(items.slice(1), 2);
  for (const it of items) story.set(0, blk[it], blocked0.includes(it) ? rng.pick(items.filter((x) => x !== it && !blocked0.includes(x))) : NO_BLOCKER);
  for (const f of files) story.set(0, fst[f], rng.chance(0.3) ? "reviewed" : "draft");

  const itemOf = (v) => v.split(".")[1];
  // A blocker candidate for `it`: an item that is not closed and is not blocked by `it` (no two-item loop).
  const canBlock = (it) => items.filter((x) => x !== it && story.cur[st[x]] !== "closed" && story.cur[blk[x]] !== it);
  const nextBlocker = (it) => {
    const cur = story.cur[blk[it]];
    const cands = canBlock(it).filter((x) => x !== cur);
    if (cur !== NO_BLOCKER && (cands.length === 0 || rng.chance(0.6))) return NO_BLOCKER;
    return cands.length === 0 ? null : rng.pick(cands);
  };
  const nextOf = (v) => {
    const [kind, id] = v.startsWith("file.") ? ["file", v.slice(5)] : [v.split(".")[2], v.split(".")[1]];
    if (kind === "status") return nextStatus(story.cur[v]);
    if (kind === "owner") return rng.pickOther(P.owners, story.cur[v]);
    if (kind === "blocker") return nextBlocker(id);
    return nextFile(rng, story.cur[v]);
  };

  // Changes. The first item is the hot item: every third change is one of its facts.
  const hot = items[0];
  const pickVar = (i) => {
    if (i % 3 === 0) return rng.pick([st[hot], own[hot], blk[hot]]);
    const r = rng.float();
    if (r < 0.28) return st[rng.pick(items)];
    if (r < 0.48) return own[rng.pick(items)];
    if (r < 0.66) return blk[rng.pick(items)];
    return fst[rng.pick(files)];
  };
  // Facts that change only up to the first compaction (each changes once there), so that some answers are set early
  // and kept: the owners of two items and the status of one file.
  const early = p.compactAfter.length > 0 ? p.compactAfter[0] : stages;
  const [sA, sB] = items.slice(-2);
  const sFile = files.at(-1);
  const stable = new Set([own[sA], own[sB], fst[sFile]]);
  for (const v of stable) story.set(rng.int(1, early), v, nextOf(v));
  stagePlan(rng, p.updates, stages).forEach((stage, i) => {
    let v = pickVar(i);
    for (let k = 0; k < 5 && stage > early && stable.has(v); k += 1) v = pickVar(i + 1);
    if (stage > early && stable.has(v)) return;
    const next = nextOf(v);
    if (next === null) return;
    // A correction now and then: a wrong note first, then its fix in the same stage.
    if (rng.chance(0.12) && !v.endsWith(".blocker")) {
      const wrong = rng.pickOther(story.vars[v].options.filter((x) => x !== next), story.cur[v]);
      story.set(stage, v, wrong);
      story.set(stage, v, next, { kind: "supersede" });
    } else story.set(stage, v, next, { kind: rng.chance(0.25) ? "supersede" : "state" });
    // A closed item blocks nothing: the items that it blocked lose their link in the same stage.
    if (v.endsWith(".status") && next === "closed") {
      const it = itemOf(v);
      for (const x of items) if (story.cur[blk[x]] === it) story.set(stage, blk[x], NO_BLOCKER);
    }
    // A proposal with no decision, or a draft that its author withdraws.
    if (rng.chance(0.3)) {
      const bogus = rng.pickOther(story.vars[v].options, story.cur[v]);
      story.ev(stage, "conflict", { op: "mention", var: v, value: bogus }, rng.chance(0.5) ? { withdrawn: true } : {});
    }
  });

  // The answers of the set questions must not be empty: one item blocks another one, and one file is merged.
  const blockers = () => items.filter((b) => items.some((x) => story.cur[blk[x]] === b));
  if (blockers().length === 0) {
    const a = rng.pick(items.filter((x) => canBlock(x).length > 0));
    story.set(stages, blk[a], rng.pick(canBlock(a)));
  }
  if (!files.some((f) => story.cur[fst[f]] === "merged")) {
    const f = files.find((x) => story.cur[fst[x]] === "reviewed") ?? files[0];
    if (story.cur[fst[f]] !== "reviewed") story.set(stages, fst[f], "reviewed");
    story.set(stages, fst[f], "merged");
  }

  // Questions. Subjects with a history come first, so that the history questions are not empty.
  const changes = (v) => story.events.filter((e) => e.stage > 0 && e.op.op === "set" && e.op.var === v).length;
  const most = (vs, not = []) => vs.filter((v) => !not.includes(v)).sort((x, y) => changes(y) - changes(x))[0];
  const ownQ = most(items.map((it) => own[it]), [own[hot], own[sA], own[sB]]);
  const blkQ = most(items.map((it) => blk[it]));
  const prevOwn = own[sA];
  const initOwn = own[sB];
  const fileSup = most(files.map((f) => fst[f]), [fst[sFile]]);
  const filePrev = fst[sFile];
  const by = rng.pick(blockers());
  const blkLabels = Object.fromEntries(items.map((it) => [blk[it], it]));
  const fileLabels = Object.fromEntries(files.map((f) => [fst[f], f]));
  const stLabels = Object.fromEntries(items.map((it) => [st[it], it]));

  story.q({ text: `What is the status of work item ${hot} now?`, type: "choice", aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: st[hot] } });
  story.q({ text: `Who owns work item ${itemOf(ownQ)} now? Answer with the owner handle.`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: ownQ } });
  story.q({ text: `Which work item blocks ${itemOf(blkQ)} now? Answer with the item id, or ${NO_BLOCKER} if no item blocks it.`, type: "choice", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "value", var: blkQ } });
  story.q({ text: `Which work items does ${by} block now? List every item id.`, type: "set", aspect: "relationship", errorCategory: "wrong_relationship", query: { q: "whereEq", vars: Object.keys(blkLabels), value: by, labels: blkLabels } });
  story.q({ text: `Who owned work item ${itemOf(prevOwn)} directly before its current owner? Answer with the owner handle.`, type: "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: prevOwn } });
  story.q({ text: `Which statuses did the file ${fileSup.slice(5)} have at some point that are not its status now? List every one.`, type: "set", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "superseded", var: fileSup } });
  story.q({ text: "Which files are merged now? List every path.", type: "set", aspect: "completed_work", errorCategory: "obsolete_decision", query: { q: "whereEq", vars: Object.keys(fileLabels), value: "merged", labels: fileLabels } });
  story.q({ text: `How many work items are closed now?${NUM}`, type: "int", aspect: "outstanding_work", errorCategory: "obsolete_decision", query: { q: "countEq", vars: Object.keys(stLabels), value: "closed" } });
  story.q({ text: `In the initial specification, who owned work item ${itemOf(initOwn)}? Answer with the owner handle.`, type: "choice", aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: initOwn } });
  story.q({ text: `What was the status of the file ${filePrev.slice(5)} directly before its current status?`, type: "choice", aspect: "superseded_decision", errorCategory: "obsolete_decision", query: { q: "previous", var: filePrev } });

  const rules = [
    "Rules for this task:",
    "- A value changes only by an event that decides, answers, corrects, assigns, links or reviews it. A proposal with no decision, a withdrawn draft, a question, a link to a page and an archived copy change nothing.",
    "- A correction or a new entry replaces the earlier value. The earlier value is then superseded.",
    "- The initial specification gives the first value of each item.",
    "- A question about the values of an item \"at some point\" counts every value from the initial specification on, up to the time of the question. The value \"directly before\" the current value is the value that the current value replaced.",
    `- A work item has one of the statuses ${ITEM_STATES.map((x) => `\`${x}\``).join(", ")}. A file has one of the statuses ${FILE_STATES.map((x) => `\`${x}\``).join(", ")}.`,
    `- Each work item has one owner and at most one blocking item at a time. The value \`${NO_BLOCKER}\` means that no item blocks it. A new entry for the owner or the blocking item replaces the earlier one.`,
  ];
  return { entities: items.length + files.length, depth: 2, rules };
}
