// Independent reference implementation of the benchmark keys (contract: "a state machine that replays the event
// list"). It reads only structured data: the variable declarations, the ordered structured events and the query of
// each question. It imports nothing from the renderer or the scenario builders, and it never reads event text.

function canon(v) {
  if (Array.isArray(v)) return JSON.stringify([...v].sort());
  return JSON.stringify(v);
}

function isEmpty(v) {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/** A replayable machine over one task's variables. */
export function createMachine(vars) {
  const state = {};
  const claims = {};
  const snaps = {};
  const retracted = new Set();
  const everValues = {};
  const trail = {}; // every value of a single-value variable in time order, repeats after a change included
  let authority = [];
  let order = 0;

  for (const [id, v] of Object.entries(vars)) {
    if (v.type === "set") state[id] = [];
    else state[id] = null;
    if (v.mode === "claims") claims[id] = [];
    everValues[id] = [];
    trail[id] = [];
  }

  function holds(conds) {
    if (!conds) return true;
    return conds.every((c) => valueOf(c.var) === c.eq);
  }

  function rank(source) {
    const i = authority.indexOf(source);
    return i < 0 ? authority.length : i;
  }

  function winningClaim(id) {
    const live = claims[id].filter((c) => !retracted.has(c.doc));
    if (live.length === 0) return null;
    live.sort((x, y) => rank(x.source) - rank(y.source) || y.version - x.version || y.order - x.order);
    return live[0];
  }

  function valueOf(id) {
    if (!(id in vars)) throw new Error(`reference: unknown variable ${id}`);
    if (vars[id].mode === "claims") {
      const w = winningClaim(id);
      return w === null ? null : w.value;
    }
    const v = state[id];
    return Array.isArray(v) ? [...v].sort() : v;
  }

  function noteValues() {
    for (const id of Object.keys(vars)) {
      if (vars[id].type === "set") continue;
      const v = valueOf(id);
      if (v !== null && !everValues[id].some((x) => x === v)) everValues[id].push(v);
      if (v !== null && trail[id].at(-1) !== v) trail[id].push(v);
    }
  }

  function apply(op) {
    switch (op.op) {
      case "set":
        if (holds(op.guard)) state[op.var] = op.value;
        break;
      case "add":
        if (holds(op.guard) && !state[op.var].includes(op.item)) state[op.var] = [...state[op.var], op.item];
        break;
      case "remove":
        if (holds(op.guard)) state[op.var] = state[op.var].filter((x) => x !== op.item);
        break;
      case "rename":
        for (const [id, v] of Object.entries(vars)) {
          if (v.domain !== op.domain) continue;
          if (v.type === "set") state[id] = state[id].map((x) => (x === op.from ? op.to : x));
          else if (state[id] === op.from) state[id] = op.to;
        }
        break;
      case "snapshot":
        snaps[op.label] = JSON.parse(JSON.stringify(state));
        break;
      case "rollback":
        if (!(op.label in snaps)) throw new Error(`reference: rollback to unknown snapshot ${op.label}`);
        for (const id of op.vars) state[id] = JSON.parse(JSON.stringify(snaps[op.label][id]));
        break;
      case "attempt":
        state[op.var] = holds(op.requires) ? op.success : op.fail;
        break;
      case "claim":
        claims[op.var].push({ value: op.value, source: op.source, version: op.version, doc: op.doc, order: order });
        break;
      case "authority":
        authority = [...op.order];
        break;
      case "retract":
        retracted.add(op.doc);
        break;
      case "mention":
      case "touch":
      case "restate":
      case "noise":
        break;
      default:
        throw new Error(`reference: unknown op ${op.op}`);
    }
    order += 1;
    noteValues();
  }

  function evaluate(q) {
    switch (q.q) {
      case "value":
        return valueOf(q.var);
      case "initial":
        return everValues[q.var].length === 0 ? null : everValues[q.var][0];
      case "previous": {
        // v09: the value directly before the current one (one step back in time), or null without a change.
        // v12: steps > 1 goes further back, for example steps 2 is the value two values before the current one.
        const t = trail[q.var];
        const n = q.steps ?? 1;
        return t.length < n + 1 ? null : t[t.length - 1 - n];
      }
      case "superseded": {
        const cur = valueOf(q.var);
        return everValues[q.var].filter((x) => x !== cur).map(String).sort();
      }
      case "source": {
        const w = winningClaim(q.var);
        return w === null ? null : w.source;
      }
      case "count":
        return valueOf(q.var).length;
      case "contains":
        return valueOf(q.var).includes(q.item);
      case "eq":
        return valueOf(q.var) === q.value;
      case "members":
        return valueOf(q.var);
      case "diff": {
        const b = valueOf(q.b);
        return valueOf(q.a).filter((x) => !b.includes(x)).sort();
      }
      case "whereEq":
        return q.vars.filter((id) => valueOf(id) === q.value).map((id) => q.labels[id]).sort();
      case "countEq":
        return q.vars.filter((id) => valueOf(id) === q.value).length;
      case "allowed": {
        // v07 condition: rules maps each condition id to { var, eq } or to null (allowed at all times).
        const rule = q.rules[valueOf(q.cond)];
        if (rule === undefined) return null;
        return rule === null ? true : valueOf(rule.var) === rule.eq;
      }
      default:
        throw new Error(`reference: unknown query ${q.q}`);
    }
  }

  return { apply, evaluate, valueOf };
}

/** Short structured summary of an event for the key (not the prose the agent reads). */
export function summarize(op) {
  switch (op.op) {
    case "set":
      return `${op.var} := ${JSON.stringify(op.value)}${op.guard ? " if " + op.guard.map((g) => `${g.var}=${JSON.stringify(g.eq)}`).join(" and ") : ""}`;
    case "add":
      return `${op.var} += ${op.item}${op.guard ? " (guarded)" : ""}`;
    case "remove":
      return `${op.var} -= ${op.item}`;
    case "rename":
      return `rename ${op.domain} ${op.from} -> ${op.to}`;
    case "snapshot":
      return `snapshot ${op.label}`;
    case "rollback":
      return `rollback ${op.vars.join(", ")} to ${op.label}`;
    case "attempt":
      return `${op.var} := ${op.success} if ${op.requires.map((g) => `${g.var}=${JSON.stringify(g.eq)}`).join(" and ")}, else ${op.fail}`;
    case "claim":
      return `${op.source} v${op.version} (${op.doc}) claims ${op.var} = ${JSON.stringify(op.value)}`;
    case "authority":
      return `precedence ${op.order.join(" > ")}`;
    case "retract":
      return `document ${op.doc} withdrawn`;
    case "mention":
      return `mention of ${JSON.stringify(op.value)} for ${op.var}, no change`;
    case "touch":
      return `near miss about ${op.var}, no change`;
    case "restate":
      return `historical copy says ${op.var} = ${JSON.stringify(op.value)}, no change`;
    case "noise":
      return "irrelevant";
    default:
      return op.op;
  }
}

/**
 * Replays the events and computes the answer record of each query.
 * events: [{ id, stage, op }] in time order. upToStage: only events with stage <= upToStage (checkpoint).
 */
export function computeAnswers(vars, events, questions, upToStage = Infinity) {
  const timeline = events.filter((e) => e.stage <= upToStage);
  const out = {};
  for (const question of questions) {
    const m = createMachine(vars);
    const values = [];
    for (const e of timeline) {
      m.apply(e.op);
      values.push(m.evaluate(question.query));
    }
    const final = values.length === 0 ? null : values[values.length - 1];
    const finalKey = canon(final);
    const establishedBy = [];
    const stale = [];
    let prev = canon(null);
    let firstStage = null;
    let lastStage = null;
    for (let i = 0; i < values.length; i += 1) {
      const k = canon(values[i]);
      if (k !== prev) {
        if (!isEmpty(values[i]) || prev !== canon(null)) {
          establishedBy.push(timeline[i].id);
          lastStage = timeline[i].stage;
        }
        if (firstStage === null && !isEmpty(values[i])) firstStage = timeline[i].stage;
        if (i > 0 && !isEmpty(values[i - 1]) && canon(values[i - 1]) !== finalKey && !stale.some((s) => canon(s) === canon(values[i - 1]))) {
          stale.push(values[i - 1]);
        }
      }
      prev = k;
    }
    out[question.id] = {
      value: final,
      aspect: question.aspect,
      establishedBy,
      staleValues: stale,
      errorCategory: question.errorCategory,
      firstEstablishedStage: firstStage,
      lastChangedStage: lastStage,
    };
  }
  return out;
}
