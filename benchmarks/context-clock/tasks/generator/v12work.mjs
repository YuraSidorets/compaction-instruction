#!/usr/bin/env node
// Context Clock v12 work-result tasks (docs/context-clock/PLAN-standalone.md, step 2.6): tasks/v12-work. Each task
// has a small code base in the workspace (workspace.files) and the requirements of one Node module. The requirements
// arrive and change over 8 stages with compactions after stages 3, 5 and 7: values are replaced and corrected,
// constraints are added, and distractors (proposals, withdrawn drafts, archived copies, rules of other teams) name
// the requirements. The final turn asks the agent to write the module. Hidden tests (keys/<id>.tests.json, never
// in the task file) check the current values and that replaced values are not used; graders/work-tests.mjs runs
// them against the collected workspace copy. The score of a run is passed tests / all tests.
//
//   node benchmarks/context-clock/tasks/generator/v12work.mjs            rewrite the files of the set
//   node benchmarks/context-clock/tasks/generator/v12work.mjs --check    exit 1 when a committed file differs
//   node benchmarks/context-clock/tasks/generator/v12work.mjs --freeze   write FROZEN.json (status candidate)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TASKS_DIR } from "./generate.mjs";
import { createRng } from "./rng.mjs";
import { sha256 } from "./v07.mjs";

export const WORK_DIR = join(TASKS_DIR, "v12-work");
export const WORK_STAGES = 8;
export const WORK_COMPACT_AFTER = [3, 5, 7];
export const WORK_SEED_TRIES = 200;
const STAGE_BYTES = [4500, 8500];

// ---------------------------------------------------------------------------------------------------------------
// Kinds. Each kind has the module, the README of the module (the fixed rules, no values), the variables with their
// pools and phrases, the logic of the module (its only input is the object REQUIREMENTS), and the candidate inputs.

const eur = (c) => `${(c / 100).toFixed(2)} EUR`;
const listText = (xs) => (xs.length === 0 ? "none" : xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const SHIPPING = {
  area: "shipping",
  module: "src/shipping/quote.mjs",
  exportName: "quote",
  signature: "quote(order)",
  stub: 'export function quote(order) {\n  throw new Error("not implemented");\n}\n',
  readme: [
    "# Shipping quote",
    "",
    "`src/shipping/quote.mjs` exports `quote(order)`.",
    "",
    "`order` is `{ subtotalCents, weightGrams, country, express }`. `subtotalCents` and `weightGrams` are integers, `country` is a two-letter code, and `express` is true or false.",
    "",
    "The function returns one of two objects:",
    "",
    '- `{ ok: false, reason: "blocked-country" }` if the country is on the list of countries that the shop does not ship to.',
    "- `{ ok: true, shippingCents }` in all other cases.",
    "",
    "`shippingCents` is the sum of three parts:",
    "",
    "1. The standard shipping fee. It is 0 if the order subtotal is at or above the free shipping threshold.",
    "2. The surcharge for each started kilogram above the weight limit for the standard fee. For example, 1 gram above the limit counts as one started kilogram. The free shipping threshold does not remove this surcharge.",
    "3. The express fee, if `express` is true. The free shipping threshold does not remove the express fee.",
    "",
    "The product team sets the values of these requirements. All amounts are in cents in the code.",
  ].join("\n"),
  vars: [
    { id: "freeThreshold", type: "value", label: "the free shipping threshold", pool: [3500, 4000, 4500, 5000, 6000, 7500, 9000], show: eur },
    { id: "baseFee", type: "value", label: "the standard shipping fee", pool: [299, 349, 399, 449, 499, 599, 699], show: eur },
    { id: "weightLimit", type: "value", label: "the weight limit for the standard fee", pool: [1000, 1500, 2000, 2500, 3000, 4000, 5000], show: (g) => `${g / 1000} kg` },
    { id: "perKg", type: "value", label: "the surcharge for each started kilogram above the weight limit", pool: [50, 75, 100, 125, 150, 200, 250], show: eur },
    { id: "expressFee", type: "value", label: "the express fee", pool: [600, 700, 800, 950, 1000, 1200, 1500], show: eur },
    { id: "blocked", type: "set", label: "the list of countries that the shop does not ship to", pool: ["RU", "BY", "IR", "KP", "SY", "CU", "VE", "MM"], initialSize: 1 },
  ],
  logic: `function quote(order) {
  const P = REQUIREMENTS;
  if (P.blocked.includes(order.country)) return { ok: false, reason: "blocked-country" };
  const base = order.subtotalCents >= P.freeThreshold ? 0 : P.baseFee;
  const over = Math.max(0, order.weightGrams - P.weightLimit);
  const surcharge = Math.ceil(over / 1000) * P.perKg;
  const express = order.express ? P.expressFee : 0;
  return { ok: true, shippingCents: base + surcharge + express };
}`,
  candidates(rng, kind) {
    const v = Object.fromEntries(kind.vars.map((x) => [x.id, x]));
    const subs = [...new Set(v.freeThreshold.pool.flatMap((t) => [t - 1, t, t + 1]))].sort((a, b) => a - b);
    const weights = [...new Set(v.weightLimit.pool.flatMap((w) => [w, w + 1, w + 999, w + 1001]))].sort((a, b) => a - b);
    const countries = ["DE", "FR", "US", ...v.blocked.pool];
    const out = [];
    // Boundary inputs first: the free threshold with no surcharge, the weight limit with a high subtotal, express.
    for (const s of subs) out.push([{ subtotalCents: s, weightGrams: 500, country: "DE", express: false }]);
    for (const w of weights) out.push([{ subtotalCents: 1000, weightGrams: w, country: "DE", express: false }]);
    for (const w of weights) out.push([{ subtotalCents: 99999, weightGrams: w, country: "FR", express: false }]);
    out.push([{ subtotalCents: 99999, weightGrams: 500, country: "US", express: true }], [{ subtotalCents: 1000, weightGrams: 500, country: "US", express: true }]);
    for (const c of countries) out.push([{ subtotalCents: 2000, weightGrams: 800, country: c, express: false }]);
    for (let i = 0; i < 60; i += 1) out.push([{ subtotalCents: rng.pick(subs), weightGrams: rng.pick(weights), country: rng.pick(countries), express: rng.chance(0.4) }]);
    return out;
  },
};

const PASSWORD = {
  area: "accounts",
  module: "src/accounts/password-policy.mjs",
  exportName: "checkPassword",
  signature: "checkPassword(password, context)",
  stub: 'export function checkPassword(password, context = {}) {\n  throw new Error("not implemented");\n}\n',
  readme: [
    "# Password policy",
    "",
    "`src/accounts/password-policy.mjs` exports `checkPassword(password, context)`.",
    "",
    "`password` is a string. `context` is `{ username }`, and `username` can be missing.",
    "",
    "The function returns the codes of the broken rules as an array, sorted in alphabetical order. It returns an empty array if the password breaks no rule. The codes are:",
    "",
    '- `"too-short"`: the password has fewer characters than the minimum password length.',
    '- `"too-long"`: the password has more characters than the maximum password length.',
    '- `"needs-digit"`: a digit is required and the password has no digit (0 to 9).',
    '- `"needs-upper"`: an uppercase letter is required and the password has no letter from A to Z.',
    '- `"needs-symbol"`: a symbol is required and the password has no character that is not a letter from A to Z or a to z and not a digit.',
    '- `"contains-username"`: the username rule is on, the username has 3 or more characters, and the password contains the username. Case does not matter.',
    '- `"banned-word"`: the password contains a word from the list of banned words. Case does not matter.',
    "",
    "The security team sets the values of these requirements.",
  ].join("\n"),
  vars: [
    { id: "minLength", type: "value", label: "the minimum password length", pool: [8, 9, 10, 11, 12, 14, 16], show: (n) => `${n} characters` },
    { id: "maxLength", type: "value", label: "the maximum password length", pool: [24, 32, 40, 48, 64, 72, 128], show: (n) => `${n} characters` },
    { id: "requireDigit", type: "flag", on: "a password must contain a digit", off: "a password does not need a digit" },
    { id: "requireUpper", type: "flag", on: "a password must contain an uppercase letter", off: "a password does not need an uppercase letter" },
    { id: "requireSymbol", type: "flag", on: "a password must contain a symbol", off: "a password does not need a symbol" },
    { id: "noUsername", type: "flag", on: "the username rule is on, so a password must not contain the username", off: "the username rule is off" },
    { id: "banned", type: "set", label: "the list of banned words", pool: ["welcome", "letmein", "qwerty", "dragon", "monkey", "sunshine", "admin", "secret"], initialSize: 2 },
  ],
  logic: `function checkPassword(password, context = {}) {
  const P = REQUIREMENTS;
  const out = [];
  if (password.length < P.minLength) out.push("too-short");
  if (password.length > P.maxLength) out.push("too-long");
  if (P.requireDigit && !/[0-9]/.test(password)) out.push("needs-digit");
  if (P.requireUpper && !/[A-Z]/.test(password)) out.push("needs-upper");
  if (P.requireSymbol && !/[^A-Za-z0-9]/.test(password)) out.push("needs-symbol");
  const lower = password.toLowerCase();
  const user = typeof context.username === "string" ? context.username.toLowerCase() : "";
  if (P.noUsername && user.length >= 3 && lower.includes(user)) out.push("contains-username");
  if (P.banned.some((w) => lower.includes(w))) out.push("banned-word");
  return out.sort();
}`,
  candidates(rng, kind) {
    const v = Object.fromEntries(kind.vars.map((x) => [x.id, x]));
    const lens = [...new Set([...v.minLength.pool.flatMap((n) => [n - 1, n]), ...v.maxLength.pool.flatMap((n) => [n, n + 1])])].sort((a, b) => a - b);
    const filler = "bcdfghjkmnpqrstvwxz";
    const make = (len, { digit = true, upper = true, symbol = true, word = "", user = "" } = {}) => {
      let s = (digit ? "7" : "") + (upper ? "K" : "") + (symbol ? "#" : "") + word + user;
      for (let i = 0; s.length < len; i += 1) s += filler[i % filler.length];
      return s.slice(0, Math.max(len, s.length));
    };
    const out = [];
    for (const n of lens) out.push([make(n), { username: "mira" }]);
    for (const flag of ["digit", "upper", "symbol"]) for (const n of [20, 30]) out.push([make(n, { [flag]: false }), { username: "mira" }]);
    out.push([make(20, { user: "mira" }), { username: "mira" }], [make(20, { user: "MIRA" }), { username: "mira" }], [make(20, { user: "jo" }), { username: "jo" }], [make(20), {}]);
    for (const w of v.banned.pool) out.push([make(20, { word: w }), { username: "mira" }], [make(20, { word: w.toUpperCase() }), {}]);
    for (let i = 0; i < 60; i += 1) {
      const flags = { digit: rng.chance(0.6), upper: rng.chance(0.6), symbol: rng.chance(0.6), word: rng.chance(0.3) ? rng.pick(v.banned.pool) : "", user: rng.chance(0.3) ? "mira" : "" };
      out.push([make(rng.pick(lens), flags), { username: "mira" }]);
    }
    return out;
  },
};

const RETRY = {
  area: "http",
  module: "src/http/retry-policy.mjs",
  exportName: "retryDelay",
  signature: "retryDelay(status, retry)",
  stub: 'export function retryDelay(status, retry) {\n  throw new Error("not implemented");\n}\n',
  readme: [
    "# Retry policy",
    "",
    "`src/http/retry-policy.mjs` exports `retryDelay(status, retry)`.",
    "",
    "`status` is the HTTP status code of a failed request, as an integer. `retry` is the number of the retry, as an integer: 0 is the first retry.",
    "",
    "The function returns the delay in milliseconds before that retry, as an integer, or null if the client does not make that retry:",
    "",
    "- If the status code is on the list of status codes that are never retried, the result is null.",
    "- The client makes at most the maximum number of attempts, the first request included. Thus the retries 0 to (maximum number of attempts - 2) exist, and a higher retry number gives null.",
    "- The delay before retry number i is the base delay times the backoff factor to the power i. A delay above the maximum delay is cut to the maximum delay.",
    "- For status 429, the extra delay for rate limits is added after the cut. Thus a delay for status 429 can be above the maximum delay.",
    "",
    "The platform team sets the values of these requirements.",
  ].join("\n"),
  vars: [
    { id: "baseDelay", type: "value", label: "the base delay", pool: [100, 150, 200, 250, 300, 400, 500], show: (n) => `${n} ms` },
    { id: "factor", type: "value", label: "the backoff factor", pool: [2, 3, 4, 5], show: (n) => `${n}` },
    { id: "maxDelay", type: "value", label: "the maximum delay", pool: [700, 900, 1200, 1600, 2000, 2400, 3000], show: (n) => `${n} ms` },
    { id: "maxAttempts", type: "value", label: "the maximum number of attempts", pool: [3, 4, 5, 6, 7, 8], show: (n) => `${n}` },
    { id: "extra429", type: "value", label: "the extra delay for rate limits", pool: [250, 500, 750, 1000, 1500, 2000], show: (n) => `${n} ms` },
    { id: "nonRetryable", type: "set", label: "the list of status codes that are never retried", pool: ["400", "401", "403", "404", "409", "410", "422", "501"], initialSize: 3 },
  ],
  logic: `function retryDelay(status, retry) {
  const P = REQUIREMENTS;
  if (P.nonRetryable.includes(String(status))) return null;
  if (retry > P.maxAttempts - 2) return null;
  const extra = status === 429 ? P.extra429 : 0;
  return Math.min(P.maxDelay, P.baseDelay * P.factor ** retry) + extra;
}`,
  candidates(rng, kind) {
    const v = Object.fromEntries(kind.vars.map((x) => [x.id, x]));
    const codes = [500, 502, 503, 504, 429, 408, ...v.nonRetryable.pool.map(Number)];
    const out = [];
    for (const r of [0, 1, 2, 3, 4, 5, 6, 7]) for (const c of [503, 429]) out.push([c, r]);
    for (const c of codes) out.push([c, 0]);
    for (let i = 0; i < 40; i += 1) out.push([rng.pick(codes), rng.int(0, 7)]);
    return out;
  },
};

export const WORK_KINDS = { shipping: SHIPPING, password: PASSWORD, retry: RETRY };

// ---------------------------------------------------------------------------------------------------------------
// Specs.

export const V12_WORK_TASKS = [
  { taskId: "K13-shipping-quote", kind: "shipping", seed: 2700000, changes: 15, people: ["Abel", "Bea", "Cyril", "Dana", "Emre", "Fia"], ticket: "SHP", team: "marketplace",
    lead: "You keep the requirements of the shipping quote module of a web shop. The product team changes the shipping requirements while the shop prepares a new season." },
  { taskId: "K13-password-policy", kind: "password", seed: 2725000, changes: 15, people: ["Gil", "Hana", "Ivo", "Jun", "Kara", "Lio"], ticket: "SEC", team: "support portal",
    lead: "You keep the requirements of the password policy module of a customer account service. The security team changes the password requirements after an audit." },
  { taskId: "K13-retry-policy", kind: "retry", seed: 2750000, changes: 14, people: ["Mila", "Noor", "Otto", "Pia", "Rui", "Sena"], ticket: "PLT", team: "data export",
    lead: "You keep the requirements of the retry policy module of an HTTP client library. The platform team changes the retry requirements after a series of load tests." },
];

// ---------------------------------------------------------------------------------------------------------------
// The module logic as a function of the requirements.

const fnCache = new Map();
/** The module function for one set of requirements. */
export function moduleFunction(kind, req) {
  const k = `${kind.exportName}:${JSON.stringify(req)}`;
  if (!fnCache.has(k)) fnCache.set(k, new Function("REQUIREMENTS", `return (${kind.logic});`)(req));
  return fnCache.get(k);
}

/** The JSON text of a value with sorted object keys: the comparison of graders/work-tests.mjs. */
export function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

const outOf = (kind, req, args) => canon(moduleFunction(kind, req)(...structuredClone(args)));

/** The source of the reference solution: the current requirements and the module logic. */
export function solutionSource(spec, kind, req) {
  return `// Reference solution of ${spec.taskId}: the requirements after stage ${WORK_STAGES}.\nconst REQUIREMENTS = ${JSON.stringify(req)};\n\nexport ${kind.logic}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan of the requirement events.

const valueEq = (a, b) => canon(a) === canon(b);

/**
 * The events of one task: stage 0 (the initial requirements in the task specification) and changes in stages 1 to
 * 8. A change replaces a value, turns a flag, adds or removes a set item, or corrects an earlier change.
 */
function planEvents(rng, spec, kind) {
  const vars = kind.vars;
  const cur = {};
  const events = [];
  for (const v of vars) {
    if (v.type === "value") cur[v.id] = rng.pick(v.pool);
    else if (v.type === "flag") cur[v.id] = rng.chance(0.5);
    else cur[v.id] = rng.sample(v.pool, v.initialSize).sort();
    events.push({ stage: 0, kind: "initial", var: v.id, value: structuredClone(cur[v.id]) });
  }
  // Roles: three items keep their value from stage 3 on (their last change is in stages 1 to 3), two items change
  // late (stage 6 or later), one value item has a correction, and the set gets an added item in stage 4 or later.
  // Late items are value items, so that one of them can get the correction. Early items are values first, then flags.
  const valueIds = rng.shuffle(vars.filter((v) => v.type === "value").map((v) => v.id));
  const flagIds = rng.shuffle(vars.filter((v) => v.type === "flag").map((v) => v.id));
  const setId = vars.find((v) => v.type === "set").id;
  const late = valueIds.slice(0, 2);
  const early = [...valueIds.slice(2), ...flagIds].slice(0, 3);
  const others = [...valueIds, ...flagIds].filter((id) => !late.includes(id) && !early.includes(id));
  const corrected = rng.pick(late);
  const slots = [];
  for (const id of early) for (const s of rng.sample([1, 2, 3], rng.int(1, 2))) slots.push({ stage: s, var: id });
  for (const id of late) {
    slots.push({ stage: rng.int(1, 4), var: id }, { stage: rng.int(6, 8), var: id });
    if (rng.chance(0.5)) slots.push({ stage: rng.int(4, 5), var: id });
  }
  for (const id of others) slots.push({ stage: rng.int(1, 8), var: id });
  slots.push({ stage: rng.int(4, 7), var: setId, op: "add" }, { stage: rng.int(1, 8), var: setId, op: rng.chance(0.5) ? "add" : "remove" });
  // Extra changes go to the late and other items with the fewest changes so far.
  while (slots.length < spec.changes) {
    const pool = [...late, ...others];
    const n = (id) => slots.filter((x) => x.var === id).length;
    const min = Math.min(...pool.map(n));
    slots.push({ stage: rng.int(4, 8), var: rng.pick(pool.filter((id) => n(id) === min)) });
  }
  for (let s = 1; s <= WORK_STAGES; s += 1) if (!slots.some((x) => x.stage === s)) slots.push({ stage: s, var: rng.pick([...late, ...others, setId]) });
  slots.sort((a, b) => a.stage - b.stage);
  const used = Object.fromEntries(vars.map((v) => [v.id, new Set([canon(cur[v.id])])]));
  let correctionDone = false;
  for (const slot of slots) {
    const v = vars.find((x) => x.id === slot.var);
    if (v.type === "value") {
      const fresh = v.pool.filter((x) => !used[v.id].has(canon(x)));
      const value = fresh.length > 0 ? rng.pick(fresh) : rng.pickOther(v.pool, cur[v.id]);
      const ev = { stage: slot.stage, kind: "change", var: v.id, value };
      events.push(ev);
      cur[v.id] = value;
      used[v.id].add(canon(value));
      // The correction: the next change of this item corrects a typo in this one, in the same stage.
      if (v.id === corrected && !correctionDone && slot.stage < 7) {
        const fix = v.pool.filter((x) => !used[v.id].has(canon(x)));
        const fixed = fix.length > 0 ? rng.pick(fix) : rng.pickOther(v.pool, value);
        events.push({ stage: slot.stage, kind: "correction", var: v.id, value: fixed, of: ev });
        cur[v.id] = fixed;
        used[v.id].add(canon(fixed));
        correctionDone = true;
      }
    } else if (v.type === "flag") {
      cur[v.id] = !cur[v.id];
      events.push({ stage: slot.stage, kind: "change", var: v.id, value: cur[v.id] });
    } else {
      const op = slot.op ?? "add";
      const outside = v.pool.filter((x) => !cur[v.id].includes(x));
      if (op === "add" || cur[v.id].length <= 1) {
        const item = rng.pick(outside);
        cur[v.id] = [...cur[v.id], item].sort();
        events.push({ stage: slot.stage, kind: "add", var: v.id, item, value: structuredClone(cur[v.id]) });
      } else {
        const item = rng.pick(cur[v.id]);
        cur[v.id] = cur[v.id].filter((x) => x !== item);
        events.push({ stage: slot.stage, kind: "remove", var: v.id, item, value: structuredClone(cur[v.id]) });
      }
    }
  }
  return { events, current: cur };
}

/** The values of each item in time order (a value that comes back counts again). */
function historyOf(events, varId, upTo = WORK_STAGES) {
  const out = [];
  for (const e of events) if (e.var === varId && e.stage <= upTo && (out.length === 0 || !valueEq(out.at(-1), e.value))) out.push(e.value);
  return out;
}

const requirementsAt = (kind, events, stage) => Object.fromEntries(kind.vars.map((v) => [v.id, structuredClone(historyOf(events, v.id, stage).at(-1))]));

// ---------------------------------------------------------------------------------------------------------------
// Hidden tests.

/**
 * The hidden tests: for each item, one case for each replaced value (the output with that value differs from the
 * output with the current value) and up to three cases for values that the item never had, then five general cases.
 * Fails when a replaced value has no case that tells it apart.
 */
function buildTests(rng, spec, kind, events, cur) {
  const cands = kind.candidates(rng, kind);
  const cases = [];
  const seen = new Set();
  const add = (args, varId, purpose, value) => {
    const k = canon(args);
    if (seen.has(k)) return;
    seen.add(k);
    cases.push({ id: `t${String(cases.length + 1).padStart(2, "0")}`, var: varId, purpose, other: value, args: structuredClone(args), expect: JSON.parse(canon(moduleFunction(kind, cur)(...structuredClone(args)))) });
  };
  const tellApart = (variant) => cands.find((a) => outOf(kind, cur, a) !== outOf(kind, variant, a));
  for (const v of kind.vars) {
    const hist = historyOf(events, v.id).filter((x) => !valueEq(x, cur[v.id]));
    const replaced = [...new Map(hist.map((x) => [canon(x), x])).values()];
    for (const old of replaced) {
      const args = tellApart({ ...cur, [v.id]: old });
      if (!args) throw new Error(`${spec.taskId}: no input tells the replaced value ${canon(old)} of ${v.id} apart`);
      add(args, v.id, "replaced", old);
    }
    let others = [];
    if (v.type === "value") others = v.pool.filter((x) => !valueEq(x, cur[v.id]) && !replaced.some((r) => valueEq(r, x)));
    else if (v.type === "flag") others = replaced.length === 0 ? [!cur[v.id]] : [];
    else {
      const outside = v.pool.filter((x) => !cur[v.id].includes(x));
      others = [...outside.slice(0, 1).map((x) => [...cur[v.id], x].sort()), ...cur[v.id].slice(0, 1).map((x) => cur[v.id].filter((y) => y !== x))];
      others = others.filter((o) => !replaced.some((r) => valueEq(r, o)));
    }
    for (const o of rng.shuffle(others).slice(0, 3)) {
      const args = tellApart({ ...cur, [v.id]: o });
      if (args) add(args, v.id, "current", o);
    }
  }
  for (const a of rng.shuffle(cands)) {
    if (cases.filter((c) => c.purpose === "general").length >= 5) break;
    const before = cases.length;
    add(a, null, "general", null);
    if (cases.length > before) cases.at(-1).purpose = "general";
  }
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering.

const NOISE = [
  "{P} moved the team retro to {DAY}. The agenda is the same.",
  "{P} asked who has the key to the meeting room on the third floor. {Q} has it.",
  "The build of the docs site took {N} minutes today. {P} looks at the cache.",
  "{P} shared photos of the team lunch. {Q} wants the recipe of the soup.",
  "Reminder from {P}: the expense reports for this month are due on {DAY}.",
  "{P} cleaned up {N} stale branches in the repository. Nothing else changed.",
  "{Q} is out of office on {DAY}. {P} covers the on-call rotation.",
  "{P} renamed the channel for the design reviews. The old link still works.",
  "The linter update by {P} found {N} warnings in old test files. {Q} fixes them next week.",
  "{P} asked for volunteers for the onboarding buddy program. {Q} signed up.",
  "{P} posted the slides of the architecture talk. The recording follows on {DAY}.",
  "The weekly dependency report lists {N} minor updates. {P} merges them in one pull request.",
  "{Q} thanked {P} for the help with the flaky integration test.",
  "{P} booked the large room for the planning session on {DAY}.",
  "The status page had a short maintenance window. {P} confirmed that no customer saw it.",
  "{P} updated the README of the tooling repository with the new setup steps.",
  "{Q} proposed a shorter stand-up format. The team tries it for {N} days.",
  "{P} reported that the coffee machine on the second floor works again.",
  "The test suite ran in {N} minutes on the new CI runners, says {P}.",
  "{P} added {Q} to the reviewers of the logging library.",
  "{P} wrote a short guide for the new code search tool. {Q} reviews it.",
  "The office network gets new access points on {DAY}, says {P}.",
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MEETINGS = ["planning meeting", "requirements review", "weekly sync", "design review", "release meeting"];

function fill(rng, spec, t) {
  return t
    .replace(/\{P\}/g, () => rng.pick(spec.people))
    .replace(/\{Q\}/g, () => rng.pick(spec.people))
    .replace(/\{DAY\}/g, () => rng.pick(DAYS))
    .replace(/\{N\}/g, () => String(rng.int(2, 9)));
}

/** The words that state a value of an item. */
function phrase(v, value) {
  if (v.type === "flag") return value ? v.on : v.off;
  if (v.type === "set") return value.length === 0 ? `${v.label} is empty` : `${v.label} is ${listText(value)}`;
  return `${v.label} is ${v.show(value)}`;
}

function eventText(rng, spec, kind, e, labelOf) {
  const v = kind.vars.find((x) => x.id === e.var);
  const P = rng.pick(spec.people);
  const meeting = rng.pick(MEETINGS);
  const ticket = `${spec.ticket}-${rng.int(100, 999)}`;
  switch (e.kind) {
    case "initial":
      return `At the start, ${phrase(v, e.value)}.`;
    case "change":
      return rng.pick([
        `${P} confirmed in the ${meeting}: from now on, ${phrase(v, e.value)}.`,
        `Decision of the ${meeting}, minuted by ${P}: ${phrase(v, e.value)}. This replaces the earlier requirement.`,
        `Ticket ${ticket} is done. With it, ${phrase(v, e.value)} from now on.`,
      ]);
    case "correction":
      return `${P} corrected entry ${labelOf(e.of)}: ${phrase(v, e.value)}. The value in that entry was a typo.`;
    case "add":
      return rng.pick([`${P} confirmed in the ${meeting}: ${e.item} is added to ${v.label}.`, `Ticket ${ticket} is done: ${e.item} is now on ${v.label}.`]);
    case "remove":
      return rng.pick([`${P} confirmed in the ${meeting}: ${e.item} is removed from ${v.label}.`, `Ticket ${ticket} is done: ${e.item} is no longer on ${v.label}.`]);
    case "proposal":
      return `${P} proposed that ${phrase(v, e.value)}. The proposal was not accepted, so nothing changes.`;
    case "withdrawn":
      return `A draft by ${P} said that ${phrase(v, e.value)}. ${P} withdrew the draft, so it changes nothing.`;
    case "archive":
      return `An archived copy of the requirements from the time of entry ${labelOf(e.of)} says that ${phrase(v, e.value)}. The copy is history only and changes nothing.`;
    case "other":
      return `The ${spec.team} team has its own rule: for them, ${phrase(v, e.value)}. That rule does not apply to this module.`;
    default:
      throw new Error(`unknown event kind ${e.kind}`);
  }
}

/** Distractors of one stage: they name items and values but change nothing. */
function distractors(rng, kind, events, stage, n) {
  const out = [];
  const before = events.filter((e) => e.stage <= stage);
  for (let i = 0; i < n; i += 1) {
    // A distractor value is neither the value at the start of the stage nor the value at its end.
    const v = rng.pick(kind.vars.filter((x) => x.type !== "flag"));
    const cur = historyOf(before, v.id, stage).at(-1);
    const start = historyOf(before, v.id, stage - 1).at(-1);
    let value;
    if (v.type === "value") value = rng.pick(v.pool.filter((x) => x !== cur && x !== start));
    else {
      const outside = v.pool.filter((x) => !cur.includes(x) && !start.includes(x));
      value = [...cur, rng.pick(outside)].sort();
    }
    const olds = before.filter((e) => e.var === v.id && e.stage < stage && !valueEq(e.value, cur));
    const k = olds.length > 0 && rng.chance(0.35) ? "archive" : rng.pick(["proposal", "withdrawn", "other"]);
    if (k === "archive") {
      const of = rng.pick(olds);
      out.push({ stage, kind: "archive", var: v.id, value: of.value, of });
    } else out.push({ stage, kind: k, var: v.id, value });
  }
  return out;
}

function renderTask(rng, spec, kind, events) {
  const all = [];
  const stageEvents = (s) => events.filter((e) => e.stage === s);
  for (let s = 0; s <= WORK_STAGES; s += 1) {
    const mine = stageEvents(s);
    if (s === 0) {
      all.push(...mine);
      continue;
    }
    const d = distractors(rng, kind, events, s, rng.int(3, 4));
    // A distractor never comes directly before the change that it could be read as.
    all.push(...rng.shuffle([...mine.filter((e) => e.kind !== "correction"), ...d]));
    for (const c of mine.filter((e) => e.kind === "correction")) all.splice(all.indexOf(c.of) + 1, 0, c);
  }
  all.forEach((e, i) => (e.label = `e${String(i + 1).padStart(3, "0")}`));
  const labelOf = (e) => e.label;
  const lines = new Map(all.map((e) => [e, `- [${e.label}] ${eventText(rng, spec, kind, e, labelOf)}`]));
  const intro = [
    spec.lead,
    "",
    `The code base is in the current folder. The module is \`${kind.module}\`, and its rules are in \`src/${kind.area}/README.md\`. Read the README with the Read tool when you start stage 1.`,
    "The values of the requirements come from the team in the stage material. Later material can replace a value, correct an earlier entry, or add a constraint. A proposal, a withdrawn draft, an archived copy or a rule of another team changes nothing.",
    `After the last stage you write \`${kind.module}\`. Its code must use the requirements as they are at the end of the task. Do not write the module before that.`,
    "",
    "Initial requirements:",
    ...all.filter((e) => e.stage === 0).map((e) => lines.get(e)),
  ].join("\n");
  const stages = [];
  let bytes = 0;
  for (let s = 1; s <= WORK_STAGES; s += 1) {
    const evs = all.filter((e) => e.stage === s);
    const nDel = 3;
    const parts = Array.from({ length: nDel }, () => []);
    evs.forEach((e, i) => parts[i % nDel].push(lines.get(e)));
    // Noise to the stage size: each delivery gets noise lines between its entries.
    const target = rng.int(5200, 6400);
    const size = () => parts.reduce((a, p) => a + p.join("\n").length, 0);
    while (size() < target) {
      const p = parts[rng.int(0, nDel - 1)];
      p.splice(rng.int(0, p.length), 0, `- ${fill(rng, spec, rng.pick(NOISE))}`);
    }
    const files = [
      { path: `inbox/s${s}/minutes-01.md`, content: `# Meeting minutes, stage ${s}\n\n${parts[0].join("\n")}\n` },
      { path: `inbox/s${s}/tickets-02.md`, content: `# Ticket digest, stage ${s}\n\n${parts[1].join("\n")}\n` },
    ];
    const feeds = [{ name: `s${s}-chat-1`, content: `Team chat, stage ${s}\n\n${parts[2].join("\n")}\n` }];
    const stageBytes = [...files, ...feeds].reduce((a, f) => a + Buffer.byteLength(f.content), 0);
    bytes += stageBytes;
    stages.push({
      stage: s,
      prompt: [
        `Stage ${s} of ${WORK_STAGES}. Read all of the material of this stage now. It is removed after this turn.`,
        `Files (read each one with the Read tool): ${files.map((f) => f.path).join(", ")}.`,
        `Feeds (print each one with \`node feed.mjs <name>\` through Bash): ${feeds.map((f) => f.name).join(", ")}.`,
        `Keep track of every requirement change. Do not write \`${kind.module}\` yet. Reply with a short acknowledgement when you have read everything.`,
      ].join("\n"),
      files,
      feeds,
      compactAfter: WORK_COMPACT_AFTER.includes(s),
    });
  }
  return { intro, stages, bytes, all };
}

// ---------------------------------------------------------------------------------------------------------------
// One task.

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function workspaceFiles(spec, kind) {
  return [
    { path: "README.md", content: `# ${kind.readme.split("\n")[0].slice(2)} service\n\nThis repository holds one module of the service. The module and its rules are in \`src/${kind.area}/\`.\n\nRun \`node --input-type=module -e "import('./${kind.module}').then(m => console.log(m.${kind.exportName}))"\` to load the module.\n` },
    { path: `src/${kind.area}/README.md`, content: kind.readme + "\n" },
    { path: kind.module, content: kind.stub },
  ];
}

/**
 * Rules of the work-result set. Fails with an error.
 * - 8 stages, compactions after stages 3, 5 and 7, no checkpoint, no final question, a final prompt.
 * - A requirement changes in every stage, at least 3 items keep their value from stage 3 on, at least 2 items change in
 *   stage 6 or later, one item has 3 or more values, there is a correction, and the set gets an item in stage 4 or later.
 * - Each stage has 4500 to 8500 bytes of material. No requirement value is in the workspace files.
 * - At least 15 hidden tests, a case for each replaced value. The solution with the initial requirements fails at least
 *   30% of the cases, and each solution with one replaced value fails at least one case.
 */
export function validateWork(spec, kind, task, key, tests) {
  const fail = (m) => {
    throw new Error(`${spec.taskId}: ${m}`);
  };
  if (task.stages.length !== WORK_STAGES || task.stages.filter((s) => s.compactAfter).map((s) => s.stage).join() !== WORK_COMPACT_AFTER.join()) fail("8 stages with compactions after 3, 5 and 7");
  if (task.checkpoint !== null || task.final.questions.length !== 0 || typeof task.final.prompt !== "string") fail("final block");
  const changes = key.events.filter((e) => e.stage > 0 && ["change", "correction", "add", "remove"].includes(e.kind));
  for (let s = 1; s <= WORK_STAGES; s += 1) if (!changes.some((e) => e.stage === s)) fail(`no change in stage ${s}`);
  const lastChange = (id) => Math.max(0, ...key.events.filter((e) => e.var === id && e.kind !== "initial" && ["change", "correction", "add", "remove"].includes(e.kind)).map((e) => e.stage));
  const ids = kind.vars.map((v) => v.id);
  if (ids.filter((id) => lastChange(id) <= 3).length < 3) fail("fewer than 3 items keep their value from stage 3 on");
  if (ids.filter((id) => lastChange(id) >= 6).length < 2) fail("fewer than 2 items change in stage 6 or later");
  if (!key.requirements.some((r) => r.history.length >= 3)) fail("no item with 3 or more values");
  if (!changes.some((e) => e.kind === "correction")) fail("no correction");
  if (!changes.some((e) => e.kind === "add" && e.stage >= 4)) fail("no constraint added in stage 4 or later");
  for (const s of task.stages) {
    const b = [...s.files, ...s.feeds].reduce((a, f) => a + Buffer.byteLength(f.content), 0);
    if (b < STAGE_BYTES[0] || b > STAGE_BYTES[1]) fail(`stage ${s.stage} has ${b} bytes`);
  }
  const ws = task.workspace.files.map((f) => f.content).join("\n");
  // A value with a unit (for example "50.00 EUR" or "2 kg"); bare numbers such as a factor of 2 are too common to check.
  for (const v of kind.vars) if (v.type === "value") for (const x of v.pool) if (/\D/.test(v.show(x)) && ws.includes(v.show(x))) fail(`workspace names the value ${v.show(x)}`);
  const cases = tests.cases;
  if (cases.length < 15) fail(`only ${cases.length} hidden tests`);
  const cur = key.current;
  const score = (req) => cases.filter((c) => outOf(kind, req, c.args) === canon(c.expect)).length / cases.length;
  if (score(cur) !== 1) fail("the reference logic fails a hidden test");
  if (score(requirementsAt(kind, key.events, 0)) > 0.7) fail("the initial requirements pass more than 70% of the hidden tests");
  for (const r of key.requirements) for (const old of r.history.filter((x) => !valueEq(x, cur[r.id]))) if (score({ ...cur, [r.id]: old }) === 1) fail(`the replaced value ${canon(old)} of ${r.id} passes every test`);
}

function attempt(spec, seed) {
  const kind = WORK_KINDS[spec.kind];
  const rng = createRng(seed);
  const { events, current } = planEvents(rng, spec, kind);
  const r = renderTask(rng, spec, kind, events);
  const tests = { schema: 1, taskId: spec.taskId, module: kind.module, exportName: kind.exportName, cases: buildTests(createRng(seed + 7919), spec, kind, events, current) };
  const task = {
    schema: 1,
    taskId: spec.taskId,
    category: spec.taskId[0],
    shape: "work",
    seed,
    profile: "compaction",
    params: { requirements: kind.vars.length, changes: events.filter((e) => e.stage > 0 && e.kind !== "initial").length, approxBytes: r.bytes, sizeGroup: "v12-work" },
    intro: r.intro,
    stages: r.stages,
    checkpoint: null,
    final: {
      questions: [],
      prompt: [
        `All stages are complete. Write the module \`${kind.module}\` now.`,
        `It must export \`${kind.signature}\` with the rules in \`src/${kind.area}/README.md\`, and it must use the requirements as they are now: not a value that was replaced, corrected, only proposed, withdrawn, archived, or set by another team.`,
        "Replace the stub in the file. You can run the module with node to try it. Reply with one short line when the file is written.",
      ].join("\n"),
    },
    workspace: { files: workspaceFiles(spec, kind), collect: [`src/${kind.area}`] },
  };
  const key = {
    schema: 1,
    taskId: spec.taskId,
    seed,
    current,
    requirements: kind.vars.map((v) => ({ id: v.id, type: v.type, history: historyOf(events, v.id), lastChangedStage: Math.max(0, ...events.filter((e) => e.var === v.id).map((e) => e.stage)) })),
    events: r.all.map((e) => ({ id: e.label, stage: e.stage, kind: e.kind, var: e.var, value: e.value, ...(e.item ? { item: e.item } : {}), ...(e.of ? { of: e.of.label } : {}) })),
  };
  validateWork(spec, kind, task, key, tests);
  const states = WORK_COMPACT_AFTER.map((afterStage) => {
    const req = requirementsAt(kind, events, afterStage);
    const facts = kind.vars.map((v) => ({ name: v.type === "flag" ? v.on : v.label, kind: v.type, value: req[v.id], history: historyOf(events, v.id, afterStage).length > 1 ? historyOf(events, v.id, afterStage).slice(0, -1) : null }));
    const text = `Requirements of ${kind.module} after stage ${afterStage}:\n${kind.vars.map((v) => `- ${phrase(v, req[v.id])}`).join("\n")}\n`;
    return { afterStage, text, facts };
  });
  return {
    files: {
      [`generated/${spec.taskId}.task.json`]: serialize(task),
      [`keys/${spec.taskId}.key.json`]: serialize(key),
      [`keys/${spec.taskId}.tests.json`]: serialize(tests),
      [`reference/${spec.taskId}.state.json`]: serialize({ schema: 2, taskId: spec.taskId, states }),
      [`reference/${spec.taskId}.solution.mjs`]: solutionSource(spec, kind, current),
    },
    seed,
  };
}

/** The files of one task, from the first seed on that passes every rule. */
export function generateOneWork(spec, { tries = WORK_SEED_TRIES } = {}) {
  let last = null;
  for (let k = 0; k < tries; k += 1) {
    try {
      return attempt(spec, spec.seed + k);
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${spec.taskId}: no seed in ${tries} tries: ${last?.message}`);
}

export function generateWorkSet() {
  const files = {};
  const seeds = {};
  for (const spec of V12_WORK_TASKS) {
    const r = generateOneWork(spec);
    Object.assign(files, r.files);
    seeds[spec.taskId] = r.seed;
  }
  return { files, seeds };
}

export function frozenRecordWork(commit, files, seeds) {
  const entry = (path) => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path], "utf8") });
  return {
    schema: 1,
    experiment: "v12-standalone-work",
    set: "v12-work",
    status: "candidate",
    generatorCommit: commit,
    generator: "benchmarks/context-clock/tasks/generator/v12work.mjs",
    grader: "benchmarks/context-clock/graders/work-tests.mjs",
    tasks: V12_WORK_TASKS.map((s) => ({
      taskId: s.taskId,
      category: s.taskId[0],
      kind: s.kind,
      shape: "work",
      baseSeed: s.seed,
      seed: seeds[s.taskId],
      stages: WORK_STAGES,
      compactAfter: WORK_COMPACT_AFTER,
      task: entry(`generated/${s.taskId}.task.json`),
      key: entry(`keys/${s.taskId}.key.json`),
      tests: entry(`keys/${s.taskId}.tests.json`),
      reference: entry(`reference/${s.taskId}.state.json`),
      solution: entry(`reference/${s.taskId}.solution.mjs`),
    })),
  };
}

function main(argv) {
  const { files, seeds } = generateWorkSet();
  if (argv.includes("--check")) {
    let diff = 0;
    for (const [rel, content] of Object.entries(files)) {
      const path = join(WORK_DIR, rel);
      if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        diff += 1;
        process.stderr.write(`differs: ${rel}\n`);
      }
    }
    process.stdout.write(diff === 0 ? `ok: ${Object.keys(files).length} files match\n` : `${diff} files differ\n`);
    process.exitCode = diff === 0 ? 0 : 1;
    return;
  }
  if (argv.includes("--freeze")) {
    for (const [rel, content] of Object.entries(files)) if (readFileSync(join(WORK_DIR, rel), "utf8") !== content) throw new Error(`${rel} differs from the generator output: run v12work.mjs first`);
    const gen = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ".", "../../graders/work-tests.mjs"], { cwd: gen, encoding: "utf8" }).trim();
    if (dirty !== "") throw new Error(`the generator or the grader has uncommitted changes:\n${dirty}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gen, encoding: "utf8" }).trim();
    writeFileSync(join(WORK_DIR, "FROZEN.json"), serialize(frozenRecordWork(commit, files, seeds)));
    process.stdout.write(`wrote v12-work/FROZEN.json for ${commit}\n`);
    return;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(WORK_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files under ${WORK_DIR} (seeds ${JSON.stringify(seeds)})\n`);
}

if (import.meta.main) main(process.argv.slice(2));
