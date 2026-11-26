// Scenario builder helper. A builder declares variables, emits structured events per stage, adds noise and declares
// questions as queries. It never computes answers: the key comes from reference.mjs. `cur` is a rough steering copy
// the builder may use to choose meaningful next changes (for example: rename a team that exists).
import { NOISE_AREAS, NOISE_BOTS, NOISE_DAYS, NOISE_FILES, NOISE_GENRES, NOISE_LOG_DETAILS, NOISE_LONG, NOISE_SHORT, NOISE_TOOLS, PEOPLE } from "./vocab.mjs";

const PLACEHOLDER_FILL = {
  person: (rng) => rng.pick(PEOPLE),
  person2: (rng) => rng.pick(PEOPLE),
  person3: (rng) => rng.pick(PEOPLE),
  day: (rng) => rng.pick(NOISE_DAYS),
  num: (rng) => String(rng.int(100, 999)),
  ver: (rng) => `${rng.int(1, 9)}.${rng.int(0, 19)}.${rng.int(0, 9)}`,
  tool: (rng) => rng.pick(NOISE_TOOLS),
  area: (rng) => rng.pick(NOISE_AREAS),
  file: (rng) => rng.pick(NOISE_FILES),
  bot: (rng) => rng.pick(NOISE_BOTS),
  n: (rng) => String(rng.int(2, 9)),
  m: (rng) => String(rng.int(10, 99)),
  pct: (rng) => String(rng.int(40, 97)),
  hh: (rng) => String(rng.int(8, 18)).padStart(2, "0"),
  mm: (rng) => String(rng.int(0, 59)).padStart(2, "0"),
};

export function fillNoise(rng, template) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    const close = template.indexOf("}", open);
    out += template.slice(i, open);
    const name = template.slice(open + 1, close);
    const fill = PLACEHOLDER_FILL[name];
    if (!fill) throw new Error(`noise template placeholder ${name}`);
    out += fill(rng);
    i = close + 1;
  }
  return out;
}

export function createStory(rng, { category, stages }) {
  const vars = {};
  const events = [];
  const questions = [];
  const checkpointQuestions = [];
  const cur = {};

  const story = {
    rng,
    category,
    stages,
    vars,
    events,
    questions,
    checkpointQuestions,
    cur,
    /** label: noun phrase in text; options: the answer universe for choice and set questions. */
    var(id, def) {
      if (id in vars) throw new Error(`duplicate var ${id}`);
      vars[id] = { type: "scalar", ...def };
      cur[id] = vars[id].type === "set" ? [] : null;
      return id;
    },
    ev(stage, kind, op, extra = {}) {
      if (stage < 0 || stage > stages) throw new Error(`stage ${stage} outside 0..${stages}`);
      events.push({ stage, kind, op, ...extra });
      // steering copy only
      if (op.op === "set" && !op.guard) cur[op.var] = op.value;
      if (op.op === "add" && !op.guard && !cur[op.var].includes(op.item)) cur[op.var] = [...cur[op.var], op.item];
      if (op.op === "remove" && !op.guard) cur[op.var] = cur[op.var].filter((x) => x !== op.item);
      if (op.op === "rename") {
        for (const [id, v] of Object.entries(vars)) {
          if (v.domain !== op.domain) continue;
          if (v.type === "set") cur[id] = cur[id].map((x) => (x === op.from ? op.to : x));
          else if (cur[id] === op.from) cur[id] = op.to;
        }
      }
      if (op.op === "claim") cur[op.var] = op.value;
      return events[events.length - 1];
    },
    set(stage, v, value, extra = {}) {
      return story.ev(stage, extra.kind ?? "state", { op: "set", var: v, value }, extra);
    },
    add(stage, v, item, extra = {}) {
      return story.ev(stage, extra.kind ?? "state", { op: "add", var: v, item }, extra);
    },
    remove(stage, v, item, extra = {}) {
      return story.ev(stage, extra.kind ?? "supersede", { op: "remove", var: v, item }, extra);
    },
    /** n noise events in a stage. big: verbose log lines for the large feed. */
    noise(stage, n, { big = false } = {}) {
      for (let i = 0; i < n; i += 1) {
        const bank = big ? NOISE_LONG : NOISE_SHORT;
        const text = fillNoise(rng, rng.pick(bank));
        story.ev(stage, "noise", { op: "noise" }, { noiseText: text, big });
      }
    },
    /** One multi-line routine record (a genre head line plus body lines) for notes, tickets and small feeds. */
    noiseBlock(stage) {
      const g = rng.pick(NOISE_GENRES);
      const k = rng.int(g.pick[0], Math.min(g.pick[1], g.body.length));
      const chosen = rng.sample(g.body.map((_, i) => i), k).sort((a, b) => a - b);
      const lines = [fillNoise(rng, g.head), ...chosen.map((i) => fillNoise(rng, g.body[i]))];
      return story.ev(stage, "noise", { op: "noise" }, { noiseText: lines.join("\n") });
    },
    /** Verbose log records for large feed number `feed` of a stage until their text passes minBytes. */
    bigNoise(stage, minBytes, feed = 0) {
      let bytes = 0;
      let n = 0;
      while (bytes < minBytes) {
        const lines = [fillNoise(rng, rng.pick(NOISE_LONG))];
        const k = rng.int(1, 3);
        for (const i of rng.sample(NOISE_LOG_DETAILS.map((_, j) => j), k).sort((a, b) => a - b)) lines.push(fillNoise(rng, NOISE_LOG_DETAILS[i]));
        const text = lines.join("\n");
        story.ev(stage, "noise", { op: "noise" }, { noiseText: text, big: true, bigFeed: feed });
        bytes += Buffer.byteLength(text, "utf8") + 20 + 4 * (lines.length - 1);
        n += 1;
      }
      return n;
    },
    /** Marks the given events as entries of large feed number `feed` (they get that feed's tag). */
    toBig(evs, feed = 0) {
      for (const e of evs) {
        e.big = true;
        e.bigFeed = feed;
      }
    },
    q(def) {
      questions.push({ id: `q${questions.length + 1}`, ...def });
    },
    cq(def) {
      checkpointQuestions.push({ id: `c${checkpointQuestions.length + 1}`, ...def });
    },
  };
  return story;
}

/** Spreads n items over stages 1..stages, at least `min` per stage, in a seeded way. */
export function spread(rng, n, stages, min = 1) {
  const out = new Array(stages).fill(min);
  let left = n - min * stages;
  while (left > 0) {
    out[rng.int(0, stages - 1)] += 1;
    left -= 1;
  }
  return out;
}
