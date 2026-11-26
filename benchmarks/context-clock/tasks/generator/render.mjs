// Renders structured events into the text the agent reads, and packs each stage into files and feeds.
// It never computes state or answers. Bool values render as ON / OFF; every other value renders as its string.
import { createRng } from "./rng.mjs";
import { fillNoise } from "./story.mjs";
import { PEOPLE, RECORD_CONTEXT } from "./vocab.mjs";

export const SMALL_LIMIT = 3500; // contract: small material passes Context Mode unchanged
export const BIG_MIN = 6000; // contract: at least one feed above this per task
export const BIG_MAX = 16500; // a large feed stays at about 16 KB or less
export const DELIVERY_MIN = 1500; // most small deliveries are between DELIVERY_MIN and SMALL_LIMIT
const PACK_LIMIT = 3400; // hard cap for one small delivery
const PACK_AVG = 2600; // the packer aims at this average size

export function renderValue(v) {
  if (v === true) return "ON";
  if (v === false) return "OFF";
  return String(v);
}

/** A value as it appears in event text: code-marked, so that it stands out from the sentence. */
export function markValue(v) {
  return `\`${renderValue(v)}\``;
}

function fill(template, map) {
  let out = template;
  for (const [k, v] of Object.entries(map)) out = out.split(`{${k}}`).join(v);
  return out;
}

function bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

const T = {
  set: [
    "Decision: {L} is now {V}.",
    "After the review, the team settled on {V} for {L}.",
    "{P} confirmed in writing that {L} changes to {V}.",
    "Update from {P}: {L} is set to {V}, effective now.",
    "Agreed in the sync: {L} becomes {V}.",
  ],
  supersede: [
    "This replaces the earlier call: {L} goes to {V}.",
    "{P} withdrew the previous decision; {L} is {V} from now on.",
    "Correction to an earlier note: {L} is {V}, not what was said before.",
    "The earlier choice is cancelled. New decision: {L} is {V}.",
  ],
  add: ["Added to {L}: {V}.", "{P} added {V} to {L}.", "From now on, {L} include {V}.", "Approved: {V} joins {L}."],
  remove: ["Removed from {L}: {V}.", "{P} dropped {V} from {L}.", "From now on, {L} no longer include {V}.", "Approved removal: {V} leaves {L}."],
  rename: [
    "The {D} {F} is renamed to {T}. Every reference to {F} now means {T}.",
    "{P} announced that the {D} {F} has a new name: {T}.",
  ],
  snapshot: ["Checkpoint {C} is taken of the current configuration.", "{P} recorded checkpoint {C} of every current setting."],
  rollback: [
    "Rollback: {LIST} return to the values they had at checkpoint {C}. Nothing else is rolled back.",
    "{P} restored {LIST} from checkpoint {C}; all other settings keep their current values.",
  ],
  attempt: [
    "{P} ran {L}. Runbook rule: it ends as {S} only if {COND}; otherwise it ends as {F}. The run output was not kept.",
    "Run of {L} started by {P}. By the runbook, the result is {S} when {COND}, and {F} in every other case.",
  ],
  claim: [
    "The {SRC} document {DOC} (version {VER}) states that {L} is {V}.",
    "According to {SRC} {DOC} version {VER}, {L} is {V}.",
  ],
  authority: [
    "Precedence rule: when sources disagree, the order of authority is {ORDER}. Inside one source, the higher version wins.",
  ],
  retract: ["Document {DOC} is outdated and withdrawn. Ignore everything it states.", "{P} marked {DOC} as obsolete; none of its values apply any more."],
  mention: [
    "{P} proposed {V} for {L} again. No decision was made; nothing changes.",
    "In chat, {P} asked whether {L} could be {V}. The question was closed without a change.",
  ],
  // Near misses: the subject appears, nothing changes.
  touch: [
    "{P} asked for a load test plan that covers {L}. The thread ended without a change.",
    "{P} linked the dashboard page about {L} in the weekly notes. Nobody proposed a change.",
    "Question from {P}: who reviews changes to {L}? Answer: the usual reviewers. Nothing changes.",
    "{P} wants better documentation about {L}. This is a docs task only and changes nothing.",
    "{P} added a glossary entry that explains {L}. The entry describes the term only; nothing changes.",
  ],
  // Restatements of an earlier value, dated by the entry they copy.
  restate: [
    "Archived copy of a page as of entry {REF}: it says {L} is {V}. It is kept for history only and is not a new statement.",
    "{P} pasted an old excerpt written at the time of entry {REF}. It reads \"{L} is {V}\". The excerpt is history only and changes nothing.",
  ],
  restateClaim: [
    "Old printout of {SRC} {DOC} version {VER}, made at the time of entry {REF}: it says {L} is {V}. This is a historical copy, not a new statement.",
    "{P} found a saved copy of {SRC} {DOC} version {VER} from the time of entry {REF}. It says {L} is {V}. The copy is history only and changes nothing.",
  ],
};

const GUARD_TAIL = [
  " This change counts only if {COND}; otherwise it is void.",
  " Per the runbook, this step is valid only while {COND}. If not, it has no effect.",
];

// v06 wording (spec.wording === "v06"): a run states that it sets the status, and a condition is checked at the
// moment of the entry. No run leaves its result open. The other wording stays as above.
const T_V06 = {
  attempt: [
    "{P} ran {L}. The run sets the status of {L} by the runbook rule: {S} if {COND} at the moment of the run, {F} in every other case.",
    "Run of {L} by {P}. The run sets the status of {L} to {S} if {COND} at this moment, and to {F} if not.",
  ],
};
const GUARD_TAIL_V06 = [
  " This change counts only if {COND} at the moment of this entry. If not, it has no effect.",
  " Per the runbook, this step takes effect only if {COND} at this moment. If not, nothing changes.",
];

function condText(vars, conds) {
  return conds.map((c) => `${vars[c.var].label} is ${markValue(c.eq)}`).join(" and ");
}

/** The prose of one structured event, without label or time. Noise text can have several lines. */
export function eventText(rng, vars, e, wording) {
  const op = e.op;
  const v06 = wording === "v06" || wording === "v07" || wording === "v09";
  // v07: a variable can carry its own templates ({ set, supersede }), for reasons and conditions.
  // v09: every variable of the work log and decision shapes carries its own templates, also for the distractors
  // (mention, withdrawn, touch, restate). A mention event with `withdrawn` uses the template of a withdrawn document.
  let own;
  if ((wording === "v07" || wording === "v09") && op.op === "set") own = vars[op.var].templates?.[e.kind === "supersede" ? "supersede" : "set"];
  if (wording === "v09" && ["add", "remove"].includes(op.op)) own = vars[op.var].templates?.[op.op];
  if (wording === "v09" && ["mention", "touch", "restate"].includes(op.op)) own = vars[op.var].templates?.[op.op === "mention" && e.withdrawn ? "withdrawn" : op.op];
  const P = rng.pick(PEOPLE);
  const L = op.var ? vars[op.var].label : "";
  let text;
  switch (op.op) {
    case "set":
      text = fill(rng.pick(own ?? (e.kind === "supersede" ? T.supersede : T.set)), { L, V: markValue(op.value), P });
      break;
    case "add":
      text = fill(rng.pick(own ?? T.add), { L, V: markValue(op.item), P });
      break;
    case "remove":
      text = fill(rng.pick(own ?? T.remove), { L, V: markValue(op.item), P });
      break;
    case "rename":
      text = fill(rng.pick(T.rename), { D: op.domain, F: markValue(op.from), T: markValue(op.to), P });
      break;
    case "snapshot":
      text = fill(rng.pick(T.snapshot), { C: markValue(op.label), P });
      break;
    case "rollback":
      text = fill(rng.pick(T.rollback), { C: markValue(op.label), LIST: op.vars.map((v) => vars[v].label).join(", "), P });
      break;
    case "attempt":
      text = fill(rng.pick(v06 ? T_V06.attempt : T.attempt), { L, S: markValue(op.success), F: markValue(op.fail), COND: condText(vars, op.requires), P });
      break;
    case "claim":
      text = fill(rng.pick(T.claim), { SRC: op.source, DOC: op.doc, VER: String(op.version), L, V: markValue(op.value) });
      break;
    case "authority":
      text = fill(rng.pick(T.authority), { ORDER: op.order.join(" > ") });
      break;
    case "retract":
      text = fill(rng.pick(T.retract), { DOC: op.doc, P });
      break;
    case "mention":
      text = fill(rng.pick(own ?? T.mention), { L, V: markValue(op.value), P });
      break;
    case "touch":
      text = fill(rng.pick(own ?? T.touch), { L, P });
      break;
    case "restate":
      if (op.source) text = fill(rng.pick(T.restateClaim), { SRC: op.source, DOC: op.doc, VER: String(op.version), REF: e.refId, L, V: markValue(op.value), P });
      else text = fill(rng.pick(own ?? T.restate), { REF: e.refId, L, V: markValue(op.value), P });
      break;
    case "noise":
      text = e.noiseText;
      break;
    default:
      throw new Error(`render: unknown op ${op.op}`);
  }
  if (op.guard) text += fill(rng.pick(v06 ? GUARD_TAIL_V06 : GUARD_TAIL), { COND: condText(vars, op.guard) });
  return text;
}

/** Time of day for the n-th event of a stage. */
function stamp(n) {
  const t = 8 * 60 + n * 3;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

const FILE_KINDS = ["minutes", "ticket", "review", "notes", "journal", "design"];
const FEED_KINDS = ["log", "chat", "board", "ci"];
const FILE_TITLES = {
  minutes: "Meeting minutes",
  ticket: "Ticket thread",
  review: "Review comments",
  notes: "Team notes",
  journal: "Change journal",
  design: "Design discussion",
};

/**
 * Renders a whole task. spec: { seed, stages, compactAfter: number[], bigFeeds: [{ stage, name, tag }], introLead,
 * introRules: string[] }. Events must already carry ids (e001...), and each event of a large feed has `bigFeed`, the
 * index of its feed in spec.bigFeeds. Returns intro, stages and eventTexts (the line that holds each event).
 */
export function renderTask(spec, story) {
  const rng = createRng((spec.seed ^ 0x5bd1e995) >>> 0);
  const { vars, events } = story;
  const eventTexts = {};
  const firstLine = {};
  const moreLines = {};
  const timeOf = {};
  const perStage = {};
  for (const e of events) {
    let text = eventText(rng, vars, e, spec.wording);
    if (e.big && e.kind !== "noise") text = `${spec.bigFeeds[e.bigFeed].tag} ${text}`;
    const lines = text.split("\n");
    eventTexts[e.id] = lines[0];
    firstLine[e.id] = lines[0];
    moreLines[e.id] = lines.slice(1);
    perStage[e.stage] = (perStage[e.stage] ?? 0) + 1;
    timeOf[e.id] = stamp(perStage[e.stage]);
  }
  // Context lines of a state record depend on the delivery kind; they are drawn when the record is packed.
  const record = (type, kind, e) => {
    let extra = moreLines[e.id];
    if (e.kind !== "noise") {
      const pool = RECORD_CONTEXT[kind];
      const k = rng.int(1, Math.min(2, pool.length));
      extra = rng.sample(pool, k).map((t) => fillNoise(rng, t));
    }
    if (type === "file") return [`- [${e.id}] ${firstLine[e.id]}`, ...extra.map((l) => `  ${l}`)].join("\n");
    return [`[${e.id}] ${timeOf[e.id]} ${firstLine[e.id]}`, ...extra.map((l) => `    ${l}`)].join("\n");
  };

  const introEvents = events.filter((e) => e.stage === 0);
  const intro = [
    spec.introLead,
    "",
    "Initial specification:",
    ...introEvents.map((e) => `- [${e.id}] ${eventTexts[e.id]}`),
    "",
    ...spec.introRules,
    events.length > 999
      ? "Every event has a label of the form [eNNNN] with a four-digit number. A higher number is later in time. A later event can change or cancel an earlier one."
      : "Every event has a label of the form [eNNN] with a three-digit number. A higher number is later in time. A later event can change or cancel an earlier one.",
    "Some material quotes old pages or copies for history. A quote of that kind is not a new statement.",
  ].join("\n");

  const stages = [];
  for (let s = 1; s <= spec.stages; s += 1) {
    const evs = events.filter((e) => e.stage === s);
    const bigHere = spec.bigFeeds.map((b, i) => ({ ...b, index: i })).filter((b) => b.stage === s);
    const rest = evs.filter((e) => !e.big);

    // Plan the small deliveries: 4 to 8, about PACK_AVG bytes each, never above PACK_LIMIT.
    // The split uses estimated record sizes; the records are rendered afterwards with the kind of their delivery.
    const est = rest.map((e) => bytes(firstLine[e.id]) + 12 + (e.kind === "noise" ? moreLines[e.id].reduce((x, l) => x + bytes(l) + 4, 0) : 60));
    const total = est.reduce((a, x) => a + x, 0);
    // maxDeliveries: 8 for every task set up to v0.9; the long task of v0.9 passes a larger cap.
    const maxDeliveries = spec.maxDeliveries ?? 8;
    const maxSmall = maxDeliveries - bigHere.length;
    const n = Math.min(maxSmall, Math.max(4, Math.ceil(total / PACK_AVG)));
    const even = total / n;
    // Balanced split when the average is well above DELIVERY_MIN; otherwise all but the last pass DELIVERY_MIN.
    const balanced = even >= DELIVERY_MIN + 150;
    const groups = [];
    let idx = 0;
    for (let k = 0; idx < rest.length; k += 1) {
      if (k >= maxSmall) throw new Error(`render: stage ${s} needs more than ${maxSmall} small deliveries`);
      const start = idx;
      let size = 90;
      while (idx < rest.length) {
        const leftAfter = k < n - 1 ? n - 1 - k : 0; // later deliveries that still need a record each
        if (idx > start && rest.length - idx <= leftAfter) break;
        if (idx > start && k < n - 1 && (balanced ? size + est[idx] / 2 > even : size >= DELIVERY_MIN + 150)) break;
        if (idx > start && size + est[idx] > PACK_LIMIT - 80) break;
        size += est[idx];
        idx += 1;
      }
      groups.push(rest.slice(start, idx));
    }
    const kinds = [];
    for (let k = 0; k < maxDeliveries; k += 1) {
      const type = k === 0 ? "file" : k === 1 ? "feed" : rng.chance(0.5) ? "file" : "feed";
      kinds.push({ type, kind: rng.pick(type === "file" ? FILE_KINDS : FEED_KINDS) });
    }
    const order = [0, 1, ...rng.shuffle(Array.from({ length: maxDeliveries - 2 }, (_, i) => i + 2))];
    const parts = groups.map((g, k) => {
      const { type, kind } = kinds[order[k]];
      return { type, kind, recs: g.map((e) => record(type, kind, e)) };
    });

    const files = [];
    const feeds = [];
    let partNo = 0;
    for (const p of parts) {
      partNo += 1;
      if (p.type === "file") {
        const nn = String(files.length + 1).padStart(2, "0");
        files.push({
          path: `inbox/s${s}/${p.kind}-${nn}.md`,
          content: `# ${FILE_TITLES[p.kind]}, stage ${s}, part ${partNo}\n\n${p.recs.join("\n")}\n`,
        });
      } else {
        const name = `s${s}-${p.kind}-${feeds.length + 1}`;
        feeds.push({ name, content: `== ${p.kind} export, stage ${s}, part ${partNo} ==\n${p.recs.join("\n")}\n` });
      }
    }
    for (const b of bigHere) {
      const recs = evs.filter((e) => e.big && e.bigFeed === b.index).map((e) => record("feed", "log", e));
      feeds.push({ name: `s${s}-${b.name}`, content: `== ${b.name} export, stage ${s} ==\n${recs.join("\n")}\n` });
    }

    const lines = [`Stage ${s} of ${spec.stages}. Read all of the material of this stage now. It is removed after this turn.`];
    if (files.length > 0) lines.push(`Files (read each one with the Read tool): ${files.map((f) => f.path).join(", ")}.`);
    if (feeds.length > 0) lines.push(`Feeds (print each one with \`node feed.mjs <name>\` through Bash): ${feeds.map((f) => f.name).join(", ")}.`);
    for (const b of bigHere) {
      lines.push(`The feed s${s}-${b.name} is long. The entries that matter for this task carry the tag ${b.tag}; the other lines are routine.`);
    }
    lines.push("Keep track of every change. Reply with a short acknowledgement when you have read everything.");
    stages.push({
      stage: s,
      prompt: lines.join("\n"),
      files,
      feeds,
      eventIds: evs.map((e) => e.id),
      compactAfter: spec.compactAfter.includes(s),
    });
  }
  return { intro, stages, eventTexts };
}
