// Reference state export of the v04 tasks (EXPERIMENT-V04.md, section "Interfaces"): the tracked state of the
// reference state machine after a stage, as plain lines "name: value". Arm G of the v0.4 experiment returns this
// text after each compaction. The text holds no question id and no answer id. It reads only the variable
// declarations and the structured events, never a question.
import { createMachine } from "./reference.mjs";

export const STATE_TEXT_MAX_BYTES = 1900;

/** "the service mesh" -> "service mesh". */
function nameOf(v) {
  return v.label.replace(/^the /, "");
}

function show(v, value) {
  if (v.type === "bool") return value ? "ON" : "OFF";
  return String(value);
}

function list(values) {
  return values.length === 0 ? "(none)" : values.join(", ");
}

/**
 * The tracked state after `afterStage`. vars: the variable declarations. events: [{ id, stage, op }] in time order.
 * side: variable ids that no question asks (the large feed side records). They are not part of the text.
 * Lines, in declaration order of the variables:
 * - "<name>: <value>" for each variable with a value. Sets list their members sorted, or "(none)".
 * - "<name> history: a, then b, then a" for each single-value variable that changed: every change, first to latest.
 * - In precedence tasks: "<name> source: <source>" for the winning claim, then "precedence: a > b > c" and
 *   "withdrawn documents: ...".
 * - With owner variables "owner.<service>": "services owned by <team>: ..." for each team that owns a service.
 * - With the sets planned and done: "planned steps not completed: ...".
 */
export function stateText(vars, events, afterStage, side = new Set()) {
  const { m, ids, history, precedence, withdrawn } = replay(vars, events, afterStage, side);
  return textOf(vars, m, ids, history, precedence, withdrawn, afterStage, side);
}

/** Fact name of a variable: its label without the leading "the". The text line of the variable uses the same name. */
export function factName(v) {
  return nameOf(v);
}

/**
 * The facts after `afterStage` (reference schema 2): one fact for each variable with a value, in declaration order.
 * { name, kind: "scalar"|"set", value, history }. value: a string, or the sorted members as strings. history: the
 * earlier values in order, first value first, without the current value; null when the value never changed. A set
 * has history null.
 */
export function stateFacts(vars, events, afterStage, side = new Set()) {
  const { m, ids, history } = replay(vars, events, afterStage, side);
  const out = [];
  for (const id of ids) {
    const v = vars[id];
    const value = m.valueOf(id);
    if (v.type === "set") {
      out.push({ name: nameOf(v), kind: "set", value: value.map(String), history: null });
      continue;
    }
    if (value === null) continue;
    const h = history[id];
    out.push({ name: nameOf(v), kind: "scalar", value: show(v, value), history: h.length > 1 ? h.slice(0, -1).map((x) => show(v, x)) : null });
  }
  return out;
}

function replay(vars, events, afterStage, side) {
  const m = createMachine(vars);
  const ids = Object.keys(vars).filter((id) => !side.has(id));
  const history = Object.fromEntries(ids.map((id) => [id, []]));
  let precedence = null;
  const withdrawn = [];
  for (const e of events) {
    if (e.stage > afterStage) break;
    m.apply(e.op);
    if (e.op.op === "authority") precedence = [...e.op.order];
    if (e.op.op === "retract" && !withdrawn.includes(e.op.doc)) withdrawn.push(e.op.doc);
    for (const id of ids) {
      if (vars[id].type === "set") continue;
      const v = m.valueOf(id);
      if (v !== null && history[id].at(-1) !== v) history[id].push(v);
    }
  }
  return { m, ids, history, precedence, withdrawn };
}

function textOf(vars, m, ids, history, precedence, withdrawn, afterStage, side) {
  const lines = [`state after stage ${afterStage}`];
  for (const id of ids) {
    const v = vars[id];
    const value = m.valueOf(id);
    if (v.type === "set") {
      lines.push(`${nameOf(v)}: ${list(value.map(String))}`);
      continue;
    }
    if (value === null) continue;
    lines.push(`${nameOf(v)}: ${show(v, value)}`);
    if (v.mode === "claims") lines.push(`${nameOf(v)} source: ${m.evaluate({ q: "source", var: id })}`);
    if (history[id].length > 1) lines.push(`${nameOf(v)} history: ${history[id].map((x) => show(v, x)).join(", then ")}`);
  }
  const owners = ids.filter((id) => id.startsWith("owner.") && m.valueOf(id) !== null);
  for (const team of [...new Set(owners.map((id) => m.valueOf(id)))].sort()) {
    lines.push(`services owned by ${team}: ${owners.filter((id) => m.valueOf(id) === team).map((id) => id.slice(6)).sort().join(", ")}`);
  }
  if (precedence) lines.push(`precedence: ${precedence.join(" > ")}`);
  if (withdrawn.length > 0) lines.push(`withdrawn documents: ${withdrawn.join(", ")}`);
  if (vars.planned?.type === "set" && vars.done?.type === "set" && !side.has("planned")) {
    const done = m.valueOf("done");
    lines.push(`planned steps not completed: ${list(m.valueOf("planned").filter((x) => !done.includes(x)).map(String))}`);
  }
  return lines.join("\n") + "\n";
}

/** reference/<taskId>.state.json content: one state for each compaction stage. */
export function referenceState(taskId, compactAfter, vars, events, side) {
  const states = compactAfter.map((afterStage) => {
    const text = stateText(vars, events, afterStage, side);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > STATE_TEXT_MAX_BYTES) throw new Error(`${taskId}: reference state after stage ${afterStage} has ${bytes} bytes`);
    return { afterStage, text };
  });
  return { schema: 1, taskId, states };
}
