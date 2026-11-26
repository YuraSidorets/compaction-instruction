#!/usr/bin/env node
// Context Clock benchmark task generator. Writes tasks/generated/<taskId>.task.json and tasks/keys/<taskId>.key.json
// from the fixed seeds in tasks.mjs. Same seed, same bytes: the only random source is the seeded generator in
// rng.mjs, and no clock time is read.
//
//   node benchmarks/context-clock/tasks/generator/generate.mjs           rewrite all 40 files
//   node benchmarks/context-clock/tasks/generator/generate.mjs --check   exit 1 when a committed file differs
//
// Pipeline per task: builder (structured events and queries) -> ordering and ids -> renderer (prose, files, feeds)
// -> self-check (rendered text holds the values of each structured event) -> reference.mjs (the key).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRng } from "./rng.mjs";
import { createStory } from "./story.mjs";
import { BIG_MAX, BIG_MIN, DELIVERY_MIN, SMALL_LIMIT, renderTask } from "./render.mjs";
import { computeAnswers, summarize } from "./reference.mjs";
import { SIZE_GROUPS, TASKS } from "./tasks.mjs";
import { COMMON_WORDS } from "./vocab.mjs";
import { addDistractors } from "./builders/common.mjs";
import { buildDecisions } from "./builders/a-decisions.mjs";
import { buildEntities } from "./builders/b-entities.mjs";
import { buildConditional } from "./builders/c-conditional.mjs";
import { buildConflicts } from "./builders/d-conflicts.mjs";
import { buildContinuity } from "./builders/e-continuity.mjs";
import { buildWorklog } from "./builders/w-worklog.mjs";
import { buildDecisionRecord } from "./builders/x-decisions.mjs";
import { buildIncident } from "./builders/t-incident.mjs";
import { buildProbes, PROBE_ASPECTS } from "./probes.mjs";
import { benchPaths } from "../../paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TASKS_DIR = join(HERE, "..");
// Output root: CCB_TASKS_DIR replaces benchmarks/context-clock/tasks; generated/ and keys/ go under it.
export const OUTPUT_DIR = process.env.CCB_TASKS_DIR ? resolve(process.env.CCB_TASKS_DIR) : TASKS_DIR;
export const GENERATED_DIR = join(OUTPUT_DIR, "generated");
export const KEYS_DIR = join(OUTPUT_DIR, "keys");

const BUILDERS = { A: buildDecisions, B: buildEntities, C: buildConditional, D: buildConflicts, E: buildContinuity, W: buildWorklog, X: buildDecisionRecord, T: buildIncident };
const TAG_PREFIX = ["CR", "CHG", "INC"];
const BIG_NAMES = ["ops-log", "audit", "activity"];
/** approxBytes ranges of the size groups (the tests use the same ranges). */
export const SIZE_RANGES = { small: [28000, 42000], medium: [55000, 75000], large: [100000, 125000] };

/** Tokens that the rendered text of a structured event must contain (the self-check). Bool: ON / OFF. */
/** A value token as the self-check expects it: code-marked with backticks. Bool: ON / OFF. */
function tok(v) {
  const t = v === true ? "ON" : v === false ? "OFF" : String(v);
  return "`" + t + "`";
}

export function requiredTokens(vars, op) {
  const L = (id) => vars[id].label;
  const conds = (cs) => (cs ?? []).flatMap((c) => [L(c.var), tok(c.eq)]);
  switch (op.op) {
    case "set":
      return [L(op.var), tok(op.value), ...conds(op.guard)];
    case "add":
    case "remove":
      return [L(op.var), tok(op.item), ...conds(op.guard)];
    case "rename":
      return [op.domain, tok(op.from), tok(op.to)];
    case "snapshot":
      return [tok(op.label)];
    case "rollback":
      return [tok(op.label), ...op.vars.map(L)];
    case "attempt":
      return [L(op.var), tok(op.success), tok(op.fail), ...conds(op.requires)];
    case "claim":
      return [op.source, op.doc, String(op.version), L(op.var), tok(op.value)];
    case "authority":
      return [...op.order];
    case "retract":
      return [op.doc];
    case "mention":
      return [L(op.var), tok(op.value)];
    case "touch":
      return [L(op.var)];
    case "restate":
      return op.source ? [op.source, op.doc, String(op.version), L(op.var), tok(op.value)] : [L(op.var), tok(op.value)];
    default:
      return [];
  }
}

/** Interleaves noise among the other events of each stage, keeping their order; assigns e001, e002, ... */
function orderAndLabel(rng, story) {
  const out = [];
  for (let s = 0; s <= story.stages; s += 1) {
    const evs = story.events.filter((e) => e.stage === s);
    const main = evs.filter((e) => e.kind !== "noise");
    const noise = evs.filter((e) => e.kind === "noise");
    let i = 0;
    let j = 0;
    while (i < main.length || j < noise.length) {
      const leftMain = main.length - i;
      const leftNoise = noise.length - j;
      if (leftNoise > 0 && (leftMain === 0 || rng.float() < leftNoise / (leftMain + leftNoise))) out.push(noise[j++]);
      else out.push(main[i++]);
    }
  }
  // Three digits; a task with more than 999 events (the v0.9 long task) gets four digits for every label.
  const width = out.length > 999 ? 4 : 3;
  out.forEach((e, k) => (e.id = `e${String(k + 1).padStart(width, "0")}`));
  story.events.length = 0;
  story.events.push(...out);
}

function optionsFor(vars, q) {
  const qq = q.query;
  if (q.type === "int" || q.type === "bool") return undefined;
  let list;
  switch (qq.q) {
    case "source":
      list = q.sourceOptions;
      break;
    case "whereEq":
      list = Object.values(qq.labels);
      break;
    case "diff":
      list = vars[qq.a].options;
      break;
    default:
      list = vars[qq.var].options;
  }
  return [...new Set(list.map(String))].sort();
}

function bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

function canon(v) {
  return Array.isArray(v) ? JSON.stringify([...v].sort()) : JSON.stringify(v);
}

/**
 * The events that one answer needs: every event whose removal changes the final answer (leave-one-out replay with
 * the reference). Distractors and noise never count, because they change no state.
 */
export function neededEvents(vars, refEvents, question) {
  const base = canon(computeAnswers(vars, refEvents, [question])[question.id].value);
  const out = [];
  for (let i = 0; i < refEvents.length; i += 1) {
    const op = refEvents[i].op.op;
    if (op === "noise" || op === "touch" || op === "restate" || op === "mention") continue;
    const without = refEvents.filter((_, j) => j !== i);
    let v;
    try {
      v = canon(computeAnswers(vars, without, [question])[question.id].value);
    } catch {
      v = "error"; // for example a rollback without its checkpoint
    }
    if (v !== base) out.push(refEvents[i].id);
  }
  return out;
}

/** Band of a stage: 0 early (the intro and the first third), 1 middle, 2 late. */
export function band(stage, stages) {
  return stage <= 0 ? 0 : Math.floor((3 * (stage - 1)) / stages);
}

/**
 * Where the facts of each final question sit. history: the stages of the events that changed the answer
 * (establishedBy). needed: the count of events that the final answer needs (leave-one-out). Counts:
 * early: questions with a fact from the early band; earlyChanged: of those, a later band changes the answer;
 * earlyKept: the answer was last changed in the early band and nothing repeats it later; delivered: questions
 * with a fact from stage 1 or later in the early band; deep: questions that need three or more events.
 */
export function coverage(spec, vars, refEvents, questions, answers) {
  const stageOf = new Map(refEvents.map((e) => [e.id, e.stage]));
  const b = (s) => band(s, spec.stages);
  const per = questions.map((q) => {
    const a = answers[q.id];
    const history = a.establishedBy.map((id) => stageOf.get(id));
    return {
      id: q.id,
      needed: neededEvents(vars, refEvents, q).length,
      history,
      early: history.some((s) => b(s) === 0),
      earlyChanged: history.some((s) => b(s) === 0) && b(a.lastChangedStage) > 0,
      earlyKept: b(a.lastChangedStage) === 0,
      delivered: history.some((s) => s >= 1 && b(s) === 0),
    };
  });
  const all = per.flatMap((p) => p.history);
  return {
    per,
    early: per.filter((p) => p.early).length,
    earlyChanged: per.filter((p) => p.earlyChanged).length,
    earlyKept: per.filter((p) => p.earlyKept).length,
    delivered: per.filter((p) => p.delivered).length,
    deep: per.filter((p) => p.needed >= 3).length,
    spread: [0, 1, 2].map((k) => all.some((s) => s >= 1 && b(s) === k)),
  };
}

/** Builds one task. Returns { task, key } as plain objects. Throws when a contract rule fails. */
export function generateTask(spec, { withReference = false, checkCoverage = true } = {}) {
  const rng = createRng(spec.seed);
  const story = createStory(rng, { category: spec.category, stages: spec.stages });
  const p = { ...spec, compactAfter: spec.compactAfter, theme: spec.theme ?? 0 };
  const info = BUILDERS[spec.category](story, p);
  // v06: question texts with one reading and added history questions. The hook uses no random numbers.
  if (spec.v06) spec.v06.prepare(story);
  // v07: added items, reasons, conditions and questions. The hook uses its own seeded generator.
  if (spec.v07) spec.v07.prepare(story, p);
  // v12: an extra hook of a task set (for example the history questions of the harder set).
  if (spec.extraHook) spec.extraHook(story, p);
  const group = spec.group ?? SIZE_GROUPS[spec.size];
  if (!group) throw new Error(`${spec.taskId}: unknown size group ${spec.size}`);

  // Distractors: near misses, rejected proposals and dated copies of old values.
  addDistractors(story, group.distractors);

  // Large feeds: one per part of the stage range (early, middle, late), each with two to four tagged state events
  // among verbose routine records.
  const isNeeded = (e) => e.kind !== "noise" && !["mention", "touch", "restate"].includes(e.op.op);
  const bigFeeds = [];
  const side = new Set();
  if (spec.v03) placeBigFeedsV03(rng, story, spec, group, isNeeded, bigFeeds, side);
  else for (let k = 0; k < group.bigFeeds; k += 1) {
    const lo = 1 + Math.floor((k * spec.stages) / group.bigFeeds);
    const hi = Math.floor(((k + 1) * spec.stages) / group.bigFeeds);
    const ok = (s) => !bigFeeds.some((b) => b.stage === s) && story.events.filter((e) => e.stage === s && isNeeded(e)).length >= 2;
    let choices = [];
    for (let s = lo; s <= hi; s += 1) if (ok(s)) choices.push(s);
    if (choices.length === 0) for (let s = 1; s <= spec.stages; s += 1) if (ok(s)) choices.push(s);
    if (choices.length === 0) throw new Error(`${spec.taskId}: no stage for large feed ${k + 1}`);
    const stage = rng.pick(choices);
    const cands = story.events.filter((e) => e.stage === stage && isNeeded(e));
    story.toBig(rng.sample(cands, Math.min(cands.length, rng.int(2, 4))), k);
    const name = k === 0 ? spec.bigFeedName : BIG_NAMES.filter((x) => x !== spec.bigFeedName && !bigFeeds.some((b) => b.name === x))[0];
    const tag = `${TAG_PREFIX[k]}-${1000 + ((spec.seed + 1777 * k) % 9000)}`;
    story.bigNoise(stage, rng.int(group.bigBytes[0], group.bigBytes[1]), k);
    bigFeeds.push({ stage, name, tag });
  }

  // Routine records per stage until the small deliveries of the stage reach their byte budget.
  const bigTotal = bigFeeds.length * ((group.bigBytes[0] + group.bigBytes[1]) / 2 + 300);
  const stageBudget = Math.max(group.minStage, (group.target - bigTotal) / spec.stages);
  const estimate = (e) => (e.kind === "noise" ? Buffer.byteLength(e.noiseText, "utf8") + 30 : 230);
  for (let s = 1; s <= spec.stages; s += 1) {
    let est = story.events.filter((e) => e.stage === s && !e.big).reduce((a, e) => a + estimate(e), 0);
    while (est < stageBudget) est += estimate(story.noiseBlock(s));
  }

  orderAndLabel(rng, story);
  for (const e of story.events) if (e.refEvent) e.refId = e.refEvent.id;
  // v03: one probe directly after each compaction. Its own seeded generator keeps the rest of the task unchanged.
  // v09: probeAfter (the long task) lists the probe stages when they are not the compaction stages.
  const probeAt = spec.probeAfter ?? spec.compactAfter;
  let probes = null;
  if (spec.v03) {
    const ref0 = story.events.map((e) => ({ id: e.id, stage: e.stage, op: e.op }));
    probes = buildProbes(createRng(spec.seed + 7919), story, ref0, probeAt, side, (q) => optionsFor(story.vars, q));
    story.checkpointQuestions.length = 0;
    story.checkpointQuestions.push(...probes.flatMap((pr) => pr.questions));
  }
  const rendered = renderTask(
    {
      seed: spec.seed,
      stages: spec.stages,
      compactAfter: spec.compactAfter,
      bigFeeds,
      introLead: spec.lead,
      introRules: [...(info.rules ?? []), ...(spec.v06?.rules ?? []), ...(spec.v07?.rules ?? [])],
      wording: spec.wording ?? (spec.v07 ? "v07" : spec.v06 ? "v06" : undefined),
      maxDeliveries: spec.limits?.deliveries?.[1],
    },
    story,
  );

  // Value check: no option and no event value is a common English word, so every value reads as a value.
  const values = [];
  for (const v of Object.values(story.vars)) if (v.type !== "bool") values.push(...(v.options ?? []));
  for (const e of story.events) for (const x of [e.op.value, e.op.item, e.op.from, e.op.to, e.op.success, e.op.fail]) if (x !== undefined && typeof x !== "boolean") values.push(x);
  for (const q of [...story.questions, ...story.checkpointQuestions]) values.push(...(q.sourceOptions ?? []));
  for (const x of values) if (COMMON_WORDS.has(String(x).toLowerCase())) throw new Error(`${spec.taskId}: value "${x}" is a common English word`);

  // Self-check: each structured event's values are in its rendered text, and each label is placed once.
  const allText = [rendered.intro, ...rendered.stages.flatMap((s) => [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)])].join("\n");
  for (const e of story.events) {
    const text = rendered.eventTexts[e.id];
    for (const t of requiredTokens(story.vars, e.op)) {
      if (!text.includes(t)) throw new Error(`${spec.taskId} ${e.id}: rendered text lacks "${t}": ${text}`);
    }
    if (e.op.op === "restate" && !(e.refId < e.id && text.includes(`entry ${e.refId}`))) throw new Error(`${spec.taskId} ${e.id}: bad copy reference`);
    if (e.big && e.kind !== "noise" && !text.includes(bigFeeds[e.bigFeed].tag)) throw new Error(`${spec.taskId} ${e.id}: tag missing`);
    const label = `[${e.id}]`;
    const first = allText.indexOf(label);
    if (first < 0 || allText.indexOf(label, first + 1) >= 0) throw new Error(`${spec.taskId}: label ${label} must appear exactly once`);
  }
  for (const [k, b] of bigFeeds.entries()) {
    const tagged = story.events.filter((e) => e.big && e.bigFeed === k && e.kind !== "noise").length;
    if (allText.split(b.tag).length - 1 !== tagged) throw new Error(`${spec.taskId}: tag ${b.tag} appears outside its entries`);
  }

  // Key: the independent reference replays the structured events.
  const refEvents = story.events.map((e) => ({ id: e.id, stage: e.stage, op: e.op }));
  const answers = computeAnswers(story.vars, refEvents, story.questions);
  const afterStage = probeAt.length > 0 ? probeAt[0] : null;
  let checkpointAnswers = afterStage === null ? {} : computeAnswers(story.vars, refEvents, story.checkpointQuestions, afterStage);
  if (probes) checkpointAnswers = Object.assign({}, ...probes.map((pr) => computeAnswers(story.vars, refEvents, pr.questions, pr.afterStage)));
  if (spec.v03) for (const s of rendered.stages) s.chunks = chunkList(s);

  const material = rendered.stages.flatMap((s) => [...s.files.map((f) => f.content), ...s.feeds.map((f) => f.content)]);
  const eventsTotal = story.events.length;
  const noiseTotal = story.events.filter((e) => e.kind === "noise").length;
  const params = {
    events: eventsTotal,
    entities: info.entities,
    updates: story.events.filter((e) => e.stage > 0 && e.kind !== "noise").length,
    dependencyDepth: info.depth,
    noiseRatio: Math.round((noiseTotal / eventsTotal) * 100) / 100,
    approxBytes: material.reduce((a, m) => a + bytes(m), 0),
    sizeGroup: spec.size,
  };

  const qOut = (q) => {
    const o = { id: q.id, text: q.text, type: q.type };
    const options = optionsFor(story.vars, q);
    if (options) o.options = options;
    return o;
  };
  const task = {
    schema: 1,
    taskId: spec.taskId,
    category: spec.category,
    seed: spec.seed,
    profile: spec.profile,
    params,
    intro: rendered.intro,
    stages: rendered.stages,
    checkpoint:
      afterStage === null
        ? null
        : probes
          ? {
              afterStage,
              timing: spec.probeTiming ?? "after_compaction",
              questions: story.checkpointQuestions.map(qOut),
              probes: probes.map((pr) => ({ afterStage: pr.afterStage, questionIds: pr.questions.map((q) => q.id) })),
            }
          : { afterStage, questions: story.checkpointQuestions.map(qOut) },
    final: { questions: story.questions.map(qOut) },
  };
  const key = {
    schema: 1,
    taskId: spec.taskId,
    seed: spec.seed,
    events: story.events.map((e) => ({ id: e.id, stage: e.stage, kind: e.kind, summary: summarize(e.op) })),
    answers,
    checkpointAnswers,
  };
  validate(task, key, spec);
  const cov = coverage(spec, story.vars, refEvents, story.questions, answers);
  // v12 no-harm tasks ask only late facts, so the coverage rules do not apply (spec.coverage false).
  if (checkCoverage && spec.coverage !== false) validateCoverage(task, key, cov);
  // The v0.9 long task has no compaction in its plan; v09.mjs checks its probes.
  if (spec.v03 && checkCoverage && !spec.probeAfter) validateV03(task, key, { vars: story.vars, events: refEvents, questions: story.questions });
  if (!withReference) return { task, key };
  return { task, key, reference: { vars: story.vars, events: refEvents, questions: story.questions, checkpointQuestions: story.checkpointQuestions }, coverage: cov };
}

/** Rules on where the needed facts sit and how many events an answer needs. */
export function validateCoverage(task, key, cov) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  if (!cov.spread.every(Boolean)) fail(`needed facts do not cover early, middle and late stages (${cov.spread})`);
  if (cov.early < 3) fail(`only ${cov.early} questions need a fact from the first third`);
  if (cov.earlyChanged < 2 || cov.earlyKept < 1) fail(`first-third facts: ${cov.earlyChanged} changed later, ${cov.earlyKept} kept`);
  if (cov.delivered < 1) fail("no question needs a fact from the stage material of the first third");
  if ((task.category === "C" || task.category === "D") && cov.deep < 2) fail(`only ${cov.deep} questions need three or more events`);
  if (task.profile === "compaction") {
    const first = task.checkpoint.afterStage;
    const pre = Object.values(key.answers).filter((a) => a.firstEstablishedStage <= first);
    if (pre.length < 3 || !pre.some((a) => a.lastChangedStage > first)) fail(`pre-compaction questions: ${pre.length}`);
  }
}

/** Contract rules the generator enforces before it writes anything. The tests check them again on the files. */
export function validate(task, key, spec = null) {
  const id = task.taskId;
  const fail = (m) => {
    throw new Error(`${id}: ${m}`);
  };
  const fq = task.final.questions;
  // v07 tasks pass wider limits: 8 stages and 8 to 10 final questions.
  const [fqMin, fqMax] = spec?.limits?.final ?? [5, 8];
  const [stMin, stMax] = spec?.limits?.stages ?? [4, 7];
  if (fq.length < fqMin || fq.length > fqMax) fail(`final question count ${fq.length}`);
  const aspects = new Set(fq.map((q) => key.answers[q.id].aspect));
  if (aspects.size < 3) fail(`only ${aspects.size} aspects`);
  if (task.stages.length < stMin || task.stages.length > stMax) fail("stage count");
  const all = [...fq.map((q) => [q, key.answers[q.id]]), ...(task.checkpoint?.questions ?? []).map((q) => [q, key.checkpointAnswers[q.id]])];
  for (const [q, a] of all) {
    if (a === undefined) fail(`no answer for ${q.id}`);
    if (a.value === null) fail(`${q.id} has no value`);
    if (q.type === "choice" && !q.options.includes(a.value)) fail(`${q.id}: answer not in options`);
    if (q.type === "set" && (!Array.isArray(a.value) || a.value.length === 0 || a.value.some((x) => !q.options.includes(x)))) fail(`${q.id}: set answer`);
    if (q.type === "int" && !Number.isInteger(a.value)) fail(`${q.id}: int answer`);
    if (q.type === "bool" && typeof a.value !== "boolean") fail(`${q.id}: bool answer`);
    for (const s of a.staleValues) {
      if (canon(s) === canon(a.value)) fail(`${q.id}: stale equals value`);
      if (q.type === "choice" && !q.options.includes(s)) fail(`${q.id}: stale value not an option`);
    }
  }
  if (!key.events.some((e) => e.kind === "supersede")) fail("no superseded fact");
  let big = 0;
  let small = 0;
  let inBand = 0;
  for (const s of task.stages) {
    const n = s.files.length + s.feeds.length;
    const [dMin, dMax] = spec?.limits?.deliveries ?? [4, 8];
    if (n < dMin || n > dMax) fail(`stage ${s.stage} has ${n} deliveries`);
    for (const f of s.files) {
      const b = Buffer.byteLength(f.content);
      if (b >= SMALL_LIMIT) fail(`file ${f.path} too large`);
      small += 1;
      if (b >= DELIVERY_MIN) inBand += 1;
    }
    for (const f of s.feeds) {
      const b = Buffer.byteLength(f.content);
      if (b > BIG_MIN) {
        big += 1;
        if (b > BIG_MAX) fail(`feed ${f.name} above ${BIG_MAX} (${b})`);
      } else if (b >= SMALL_LIMIT) fail(`feed ${f.name} between the limits (${b})`);
      else {
        small += 1;
        if (b >= DELIVERY_MIN) inBand += 1;
      }
    }
  }
  if (big < 1 || big > (spec?.limits?.bigFeeds ?? 3)) fail(`${big} feeds above the large limit`);
  if (inBand / small < 0.6) fail(`only ${inBand} of ${small} small deliveries are ${DELIVERY_MIN} bytes or more`);
  const range = spec?.range ?? SIZE_RANGES[task.params.sizeGroup];
  if (task.params.approxBytes < range[0] || task.params.approxBytes > range[1]) fail(`approxBytes ${task.params.approxBytes} outside the ${task.params.sizeGroup} range`);
  // v12 no-harm tasks have compactions but no checkpoint: their own validator checks them.
  if (task.profile === "compaction" && task.checkpoint !== null) {
    const first = task.checkpoint.afterStage;
    const changedLater = fq.some((q) => {
      const a = key.answers[q.id];
      return a.firstEstablishedStage <= first && a.lastChangedStage > first;
    });
    if (!changedLater) fail("no pre-compaction fact changes after the compaction");
    if (task.checkpoint.probes) {
      for (const pr of task.checkpoint.probes) if (pr.questionIds.length < 4 || pr.questionIds.length > 6) fail(`probe after stage ${pr.afterStage}: question count`);
    } else {
      const n = task.checkpoint.questions.length;
      if (n < 2 || n > 3) fail("checkpoint question count");
    }
  }
}

/** The event labels of a text, in order. */
export function eventLabels(text) {
  return [...text.matchAll(/\[(e\d{3,4})\]/g)].map((m) => m[1]);
}

/** v03: the chunks of a stage, files first, then feeds, in delivery order. */
function chunkList(stage) {
  const parts = [...stage.files.map((f) => ({ kind: "file", name: f.path, content: f.content })), ...stage.feeds.map((f) => ({ kind: "feed", name: f.name, content: f.content }))];
  return parts.map((p, i) => ({ chunkId: `s${stage.stage}-c${i + 1}`, kind: p.kind, name: p.name, bytes: bytes(p.content), events: eventLabels(p.content) }));
}

/** The structured events that any final answer needs or that changed a final answer (temporary ids, before labels). */
function decisiveEvents(story) {
  const order = story.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.stage - b.e.stage || a.i - b.i);
  const ref = order.map(({ e }, k) => ({ id: `t${k}`, stage: e.stage, op: e.op }));
  const back = new Map(ref.map((r, k) => [r.id, order[k].e]));
  const answers = computeAnswers(story.vars, ref, story.questions);
  const out = new Set();
  for (const q of story.questions) {
    for (const id of answers[q.id].establishedBy) out.add(back.get(id));
    for (const id of neededEvents(story.vars, ref, q)) out.add(back.get(id));
  }
  return out;
}

/**
 * v03 large feeds. Each feed carries two or three records of a side variable that no question asks. One feed of the
 * task also carries one decisive event, so at most one event that a final answer needs is inside a large feed.
 */
function placeBigFeedsV03(rng, story, spec, group, isNeeded, bigFeeds, side) {
  const decisive = decisiveEvents(story);
  const pool = rng.shuffle(spec.v03.side);
  const dFeed = rng.int(0, group.bigFeeds - 1);
  const hasDecisive = (s) => story.events.some((e) => e.stage === s && isNeeded(e) && decisive.has(e));
  for (let k = 0; k < group.bigFeeds; k += 1) {
    const lo = 1 + Math.floor((k * spec.stages) / group.bigFeeds);
    const hi = Math.floor(((k + 1) * spec.stages) / group.bigFeeds);
    const ok = (s) => !bigFeeds.some((b) => b.stage === s) && (k !== dFeed || hasDecisive(s));
    let choices = [];
    for (let s = lo; s <= hi; s += 1) if (ok(s)) choices.push(s);
    if (choices.length === 0) for (let s = 1; s <= spec.stages; s += 1) if (ok(s)) choices.push(s);
    if (choices.length === 0) throw new Error(`${spec.taskId}: no stage for large feed ${k + 1}`);
    const stage = rng.pick(choices);
    const def = pool[k];
    const v = story.var(def.id, { label: def.label, options: def.options });
    side.add(v);
    const evs = [];
    let prev = null;
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i += 1) {
      const value = prev === null ? rng.pick(def.options) : rng.pickOther(def.options, prev);
      evs.push(story.set(stage, v, value));
      prev = value;
    }
    if (k === dFeed) evs.push(rng.pick(story.events.filter((e) => e.stage === stage && isNeeded(e) && decisive.has(e) && !e.big)));
    story.toBig(evs, k);
    const name = k === 0 ? spec.bigFeedName : BIG_NAMES.filter((x) => x !== spec.bigFeedName && !bigFeeds.some((b) => b.name === x))[0];
    const tag = `${TAG_PREFIX[k]}-${1000 + ((spec.seed + 1777 * k) % 9000)}`;
    story.bigNoise(stage, rng.int(group.bigBytes[0], group.bigBytes[1]), k);
    bigFeeds.push({ stage, name, tag });
  }
}

/**
 * v03 rules. ref: { vars, events, questions } of the reference. One probe per compaction, 4 to 6 questions each;
 * at least three final answers set before the first compaction and unchanged after it (two of them not a question
 * about the initial specification); at least two final answers set before the first compaction and changed after
 * it; at most one event inside the large feeds that a final answer needs; the probes cover the category aspects.
 */
export function validateV03(task, key, ref) {
  const fail = (m) => {
    throw new Error(`${task.taskId}: ${m}`);
  };
  const compacts = task.stages.filter((s) => s.compactAfter).map((s) => s.stage);
  // Id number: 5 (v03) and 7 (v04) have one compaction, 6 (v03), 8 (v04) and 9 (v06) have two, 10 (v07), 11 (v08), 12 (v09) and 13 (v12) have three, and 14 (v12-hard) has five.
  const want = { 5: 1, 6: 2, 7: 1, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 13: 3, 14: 5 }[task.taskId.match(/^[A-Z](\d+)-/)?.[1]] ?? -1;
  if (task.profile !== "compaction" || compacts.length !== want) fail(`compaction count ${compacts.length} does not fit the id`);
  const probes = task.checkpoint?.probes ?? [];
  if (probes.length !== compacts.length || probes.some((p, i) => p.afterStage !== compacts[i])) fail("one probe directly after each compaction");
  const ids = probes.flatMap((p) => p.questionIds);
  if (JSON.stringify(ids) !== JSON.stringify(task.checkpoint.questions.map((q) => q.id))) fail("probe ids do not match the checkpoint questions");
  for (const p of probes) if (p.questionIds.length < 4 || p.questionIds.length > 6) fail(`probe after stage ${p.afterStage} has ${p.questionIds.length} questions`);
  const first = compacts[0];
  const qById = new Map(ref.questions.map((q) => [q.id, q]));
  const fa = task.final.questions.map((q) => [qById.get(q.id), key.answers[q.id]]);
  const stable = fa.filter(([, a]) => a.firstEstablishedStage <= first && a.lastChangedStage <= first);
  const stableLive = stable.filter(([q]) => q.query.q !== "initial");
  if (stable.length < 3 || stableLive.length < 2) fail(`only ${stable.length} final answers are set before the first compaction and kept (${stableLive.length} not initial)`);
  const changed = fa.filter(([, a]) => a.firstEstablishedStage <= first && a.lastChangedStage > first);
  if (changed.length < 2) fail(`only ${changed.length} final answers change after the first compaction`);
  const decisive = new Set(fa.flatMap(([q, a]) => [...a.establishedBy, ...neededEvents(ref.vars, ref.events, q)]));
  const inBig = task.stages.flatMap((s) => s.feeds.filter((f) => bytes(f.content) > BIG_MIN).flatMap((f) => eventLabels(f.content))).filter((id) => decisive.has(id));
  if (inBig.length > 1) fail(`${inBig.length} decisive events inside the large feeds: ${inBig.join(", ")}`);
  const aspects = new Set(task.checkpoint.questions.map((q) => key.checkpointAnswers[q.id].aspect));
  for (const a of PROBE_ASPECTS[task.category]) if (!aspects.has(a)) fail(`no probe question with the aspect ${a}`);
  return { stable: stable.length, changed: changed.length, decisiveInBig: inBig.length };
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** All 40 files as { relativePath: content }, relative to tasks/. */
export function generateAll() {
  const out = {};
  for (const spec of TASKS) {
    const { task, key } = generateTask(spec);
    out[`generated/${spec.taskId}.task.json`] = serialize(task);
    out[`keys/${spec.taskId}.key.json`] = serialize(key);
  }
  return out;
}

function main(argv) {
  const check = argv.includes("--check");
  const files = generateAll();
  const outDir = benchPaths().tasksDir; // CCB_TASKS_DIR or tasks/
  let diff = 0;
  for (const [rel, content] of Object.entries(files)) {
    const path = join(outDir, rel);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        diff += 1;
        process.stderr.write(`differs: ${rel}\n`);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  if (check) {
    process.stdout.write(diff === 0 ? `ok: ${Object.keys(files).length} files match\n` : `${diff} files differ\n`);
    process.exitCode = diff === 0 ? 0 : 1;
  } else {
    process.stdout.write(`wrote ${Object.keys(files).length} files under ${outDir}\n`);
  }
}

if (import.meta.main) main(process.argv.slice(2));
