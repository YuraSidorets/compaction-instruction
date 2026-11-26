#!/usr/bin/env node
// Fact-level analysis of one run (EXPERIMENT-V06.md "Fact-level analysis" and "Interfaces"): for each reference fact
// at each compaction, the status of the fact in the state file copy, the host summary and the returned block. Then
// the join with the final and probe questions, and the reads of the state file. facts.json holds statuses and sizes
// only, never text of a summary, a block or a state file. Plain Node built-ins. The pure part is buildFacts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactTurns, lastStateBlock, lastSummary } from "./coverage.mjs";
import { lastAttemptDir, parseStream, turnFacts, turnLabel } from "./retrieval.mjs";

export const FACTS_SCHEMA = 1;
/**
 * Fact statuses. "not assigned" (v0.9): the matcher found a line or a phrase for the fact, but the name ties with
 * another fact and nothing else gives a reading. It is not missing.
 */
export const NOT_ASSIGNED = "not assigned";
export const FACT_STATUSES = Object.freeze(["correct", "formatted", "stale", "incorrect", "missing", NOT_ASSIGNED, "absent"]);
/** The statuses of the v0.6 to v0.8 tables, without "not assigned". */
export const FACT_STATUSES_V06 = Object.freeze(FACT_STATUSES.filter((s) => s !== NOT_ASSIGNED));
export const STATE_FILE_NAME = "clock-state.md";
/** A history line in a host summary (EXPERIMENT-V10.md "Stop rules"): "<name> history: <values>". */
export const HISTORY_LINE = /^.*history: .+/m;
const READ_TOOLS = Object.freeze(["Read", "Grep", "Bash"]);

// ---------- normalization of values ----------

/** Case, backticks, quotes, asterisks and spaces removed or folded. A final period is dropped. */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[`"'‘’“”*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .trim();
}

/** Words and marks that stand for the empty set. */
const EMPTY_SET_WORDS = Object.freeze(["none", "(none)", "-", "empty", "[]", "{}", "()", ""]);
const QUOTES = /[`"'‘’“”*]/g;

/**
 * The elements of a set value, sorted and unique. A string loses its outer brackets and is split on commas,
 * semicolons, pipes, "and" and "plus". "none", "[]", "(none)", "-" and an empty value are the empty set.
 * `fold` also folds case, quotes and backticks.
 */
export function setElements(value, fold = true) {
  const clean = (x) => {
    const t = String(x).replace(/\s+/g, " ").trim().replace(/\.$/, "");
    return fold ? norm(t) : t;
  };
  let parts;
  if (Array.isArray(value)) parts = value;
  else {
    const t = String(value ?? "").trim().replace(/\.$/, "").trim();
    const inner = /^[[{(].*[\]})]$/.test(t) && norm(t) !== "(none)" ? t.slice(1, -1) : t;
    parts = inner.split(/\s*(?:,|;|\||\band\b|\bplus\b)\s*/);
  }
  const out = [...new Set(parts.map(clean).filter((p) => !EMPTY_SET_WORDS.includes(norm(p))))];
  return out.sort();
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isSet = (fact) => fact.kind === "set" || Array.isArray(fact.value);

/** The exact text form of a reference value: a string as is, a list joined with ", " ("(none)" when empty). */
function exactForm(value) {
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.map(String).join(", ");
  return String(value);
}

/** Equal with no folding: a scalar after trimming, a set in any order. */
function exactEqual(raw, value, kind) {
  if (kind === "set" || Array.isArray(value)) return sameList(setElements(raw, false), setElements(value, false));
  return String(raw).trim() === String(value);
}

/** The content words of a text value: words of letters and digits, without the name stop words. */
const contentWords = (t) => (String(t ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !NAME_STOP_WORDS.includes(w));

/**
 * Equal after folding case, quotes and backticks (a set in any order). A text value of two or more content words
 * (a reason or a condition) is also equal when the content words are the same, in the same order: "only while
 * region = EU" for "only while region is eu".
 */
function formattedEqual(raw, value, kind) {
  if (kind === "set" || Array.isArray(value)) return sameList(setElements(raw), setElements(value));
  if (norm(raw) === norm(value)) return true;
  const want = contentWords(value);
  return want.length >= 2 && sameList(contentWords(raw), want);
}

/** The earlier values of a fact that differ from the current value (a value can come back, as in 5, then 7, then 5). */
function earlierValues(fact) {
  const h = Array.isArray(fact.history) ? fact.history : [];
  return h.filter((v) => !formattedEqual(exactForm(v), fact.value, fact.kind));
}

const hasHistoryOf = (fact) => Array.isArray(fact.history) && fact.history.length > 0;

// ---------- tokens of names ----------

const NAME_STOP_WORDS = Object.freeze(["of", "for", "the", "in", "a", "an", "to", "is"]);
const OPTIONAL_WORDS = Object.freeze(["flag", "migration"]);
const SYNONYMS = Object.freeze({
  owner: "owner", owners: "owner", owning: "owner", owned: "owner",
  deps: "deps", dep: "deps", dependency: "deps", dependencies: "deps", depends: "deps",
  oncall: "oncall", database: "db", db: "db", kb: "kb", hours: "hours", hour: "hours", hrs: "hours", id: "id", ids: "id",
});
/** A plural word folded to its singular ("locales" is "locale"), not for words that end in ss, us, is or ies. */
const singular = (w) => (w.length > 3 && w.endsWith("s") && !/(ss|us|is|ies)$/.test(w) ? w.slice(0, -1) : w);
/** Joins two words into one compound ("parcel-track", "time_series"). */
const COMPOUND_JOINS = Object.freeze(["-", "_"]);

/**
 * The words of a text, lower case, split on every character that is not a letter or a digit. Words joined by "-"
 * or "_" share a group (a compound such as "team-m1").
 * @returns {Array<{ w: string, s: number, e: number, group: number }>}
 */
export function rawTokens(text) {
  const t = String(text ?? "");
  const out = [];
  let group = -1;
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
    const prev = out[out.length - 1];
    const joined = prev !== undefined && COMPOUND_JOINS.includes(t.slice(prev.e, m.index));
    if (!joined) group++;
    out.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length, group });
  }
  return out;
}

/**
 * The name tokens of raw words: stop words dropped, synonyms mapped ("owning" is owner, "dependencies" is deps,
 * "on call" and "on-call" are oncall, "database" is db, "hrs" is hours), plurals folded to the singular, "team"
 * next to owner and "engineer" after oncall dropped. Each token keeps the raw indices it covers.
 * @returns {Array<{ t: string, raw: number[] }>}
 */
export function nameTokensOf(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i].w;
    if (w === "on" && raw[i + 1]?.w === "call") { out.push({ t: "oncall", raw: [i, i + 1] }); i++; continue; }
    if (NAME_STOP_WORDS.includes(w)) continue;
    const t = SYNONYMS[w] ?? singular(w);
    const last = out[out.length - 1]?.t;
    if (t === "team" && (last === "owner" || SYNONYMS[raw[i + 1]?.w] === "owner")) continue;
    if (t === "engineer" && last === "oncall") continue;
    out.push({ t, raw: [i] });
  }
  return out;
}

/** The raw indices that a name rule drops (stop words, "team" next to owner, "engineer" after oncall). */
function droppedIndices(raw, toks) {
  const kept = new Set(toks.flatMap((x) => x.raw));
  return new Set(raw.map((_, i) => i).filter((i) => !kept.has(i)));
}

/**
 * Pure. The name key of a fact: all name tokens, the core tokens (without the optional "flag" and "migration"),
 * and the entity tokens (the tokens after "of" or "for", which a line must hold).
 */
export function factKey(name) {
  const raw = rawTokens(name);
  const toks = nameTokensOf(raw).map((x) => x.t);
  const at = raw.findIndex((r) => r.w === "of" || r.w === "for");
  const entity = at < 0 ? [] : nameTokensOf(raw.slice(at + 1)).map((x) => x.t);
  return { name, all: [...new Set(toks)], core: [...new Set(toks.filter((t) => !OPTIONAL_WORDS.includes(t)))], entity: [...new Set(entity)] };
}

/**
 * Score of a fact for a set of line tokens, or null when the fact does not fit: every entity token must be in the
 * line; every core token of the shorter side must be in the other side. Higher overlap is better; fewer tokens
 * that only one side has break a tie.
 */
function fitOf(key, tokens) {
  const line = new Set(tokens);
  const coreLine = [...line].filter((t) => !OPTIONAL_WORDS.includes(t));
  if (coreLine.length === 0 || key.core.length === 0) return null;
  if (!key.entity.every((t) => line.has(t))) return null;
  const factSet = new Set(key.all);
  const ok = key.core.length <= coreLine.length ? key.core.every((t) => line.has(t)) : coreLine.every((t) => factSet.has(t));
  if (!ok) return null;
  const overlap = key.core.filter((t) => line.has(t)).length;
  const extra = key.core.filter((t) => !line.has(t)).length + coreLine.filter((t) => !factSet.has(t)).length;
  return { overlap, extra };
}

/**
 * Pure. The fact that a line name stands for, by the token rule: the fact with the highest overlap, then the fewest
 * extra tokens. A tie gives `ambiguous` with the tied facts. A word of a compound in the line ("team-m1") that is
 * not in the fact makes the whole compound a mismatch.
 * @returns {{ fact: string|null, ambiguous: string[] }}
 */
export function assignName(lineName, keys) {
  const raw = rawTokens(lineName);
  const toks = nameTokensOf(raw);
  const dropped = droppedIndices(raw, toks);
  let best = [];
  let bestScore = null;
  for (const key of keys) {
    const factSet = new Set(key.all);
    const matched = new Set(toks.filter((x) => factSet.has(x.t)).flatMap((x) => x.raw));
    const split = [...new Set(raw.map((r) => r.group))].some((g) => {
      const idx = raw.map((r, i) => (r.group === g ? i : -1)).filter((i) => i >= 0 && !dropped.has(i));
      return idx.some((i) => matched.has(i)) && idx.some((i) => !matched.has(i));
    });
    if (split) continue;
    const fit = fitOf(key, toks.map((x) => x.t));
    if (fit === null) continue;
    const cmpScore = bestScore === null ? 1 : fit.overlap - bestScore.overlap || bestScore.extra - fit.extra;
    if (cmpScore > 0) { best = [key.name]; bestScore = fit; } else if (cmpScore === 0) best.push(key.name);
  }
  return best.length === 1 ? { fact: best[0], ambiguous: [], extra: bestScore.extra } : { fact: null, ambiguous: best, extra: null };
}

// ---------- state file and block: "name: value" lines ----------

/**
 * Pure. The "name: value" lines of a state file or a block. List marks and bold marks are removed. A name whose last
 * word is "history" is a history line; `name` is then the name without that word.
 * @returns {Array<{ name: string, history: boolean, value: string }>}
 */
export function parseRecord(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    const at = line.indexOf(":");
    if (at <= 0) continue;
    let name = line.slice(0, at).replace(QUOTES, "").trim();
    const value = line.slice(at + 1).trim().replace(/^\*+|\*+$/g, "").trim();
    if (name === "") continue;
    const words = rawTokens(name);
    const history = words.length > 1 && words[words.length - 1].w === "history";
    if (history) name = name.slice(0, words[words.length - 1].s).trim();
    out.push({ name, history, value });
  }
  return out;
}

/** The fact keys of a name list (the fact names of a task). */
export function keysOf(names) {
  return names.map(factKey);
}

/** The value without a trailing note in parentheses ("5 (e053)" is "5"). */
const withoutNote = (raw) => raw.replace(/\s*\([^()]*\)\s*$/, "").trim();

/** Status of a current value against the fact: correct, formatted (case, quotes, backticks), stale or incorrect. */
export function valueStatus(raw, fact) {
  if (exactEqual(raw, fact.value, fact.kind)) return "correct";
  const plain = withoutNote(raw);
  if (plain !== raw && exactEqual(plain, fact.value, fact.kind)) return "correct";
  if (formattedEqual(raw, fact.value, fact.kind) || formattedEqual(plain, fact.value, fact.kind)) return "formatted";
  if (earlierValues(fact).some((v) => formattedEqual(raw, exactForm(v), fact.kind) || formattedEqual(plain, exactForm(v), fact.kind))) return "stale";
  return "incorrect";
}

const HISTORY_SPLIT = /\s*(?:,\s*then\b|\bthen\b|->|→|=>)\s*/;
const historyItems = (raw) => raw.split(HISTORY_SPLIT).map((x) => x.trim()).filter((x) => x !== "");

/** Status of a history line against the reference history (earlier values in order). null when the fact has none. */
export function historyStatus(raw, fact) {
  if (!hasHistoryOf(fact)) return null;
  const earlier = fact.history;
  const chain = [...earlier, fact.value];
  const given = historyItems(raw);
  const eq = (list, f) => list.length === given.length && list.every((v, i) => f(given[i], v, fact.kind));
  if (eq(earlier, exactEqual) || eq(chain, exactEqual)) return "correct";
  if (eq(earlier, formattedEqual) || eq(chain, formattedEqual)) return "formatted";
  const prefix = given.length > 0 && given.length < earlier.length && given.every((g, i) => formattedEqual(g, earlier[i], fact.kind));
  return prefix ? "stale" : "incorrect";
}

/**
 * Pure. The lines of a parsed record by fact: for each fact the last current line and the last history line that
 * the token rule assigns to it, and the facts that a tied line touches.
 */
export function assignRecord(lines, names) {
  const keys = keysOf(names);
  const by = new Map(names.map((n) => [n, { current: null, history: null, currentExtra: null, historyExtra: null, tied: false }]));
  for (const l of lines) {
    const a = assignName(l.name, keys);
    if (a.fact !== null) {
      const slot = by.get(a.fact);
      const k = l.history ? "history" : "current";
      // The best fit wins ("usage-metering" over "snap-c9 usage-metering"); a later line wins a tie.
      if (slot[k] === null || a.extra <= slot[k + "Extra"]) { slot[k] = l; slot[k + "Extra"] = a.extra; }
    }
    for (const n of a.ambiguous) by.get(n).tied = true;
  }
  return by;
}

const MEMBER_YES = Object.freeze(["supported", "yes", "true", "on", "active", "included", "enabled", "present", "in", "done", "applied", "planned", "completed"]);

/**
 * The set that membership lines state ("locale fa-IR: supported", "locale en-AU: not supported"): lines whose name
 * holds the last name word of the set fact (singular), followed by an element. A value that starts with "not" or
 * "no" leaves the element out. null when no such line exists.
 */
function membershipSet(lines, fact) {
  const head = factKey(fact.name).core.at(-1);
  if (head === undefined) return null;
  const members = [];
  let seen = false;
  for (const l of lines) {
    if (l.history) continue;
    const raw = rawTokens(l.name);
    const at = raw.findIndex((r) => singular(r.w) === head);
    if (at < 0 || at === raw.length - 1) continue;
    const element = l.name.slice(raw[at + 1].s).trim();
    const v = norm(l.value);
    if (/^(not|no)\b/.test(v) || ["false", "off", "removed"].includes(v)) { seen = true; continue; }
    if (MEMBER_YES.includes(v)) { seen = true; members.push(element); }
  }
  return seen ? members : null;
}

/**
 * Pure. Current and history status of one fact in a parsed state file or block (null lines: the record is absent).
 * `names` are the fact names of the task. A fact with only a history line has the last element of that line as its
 * stated current value. A set fact with no line of its own can be stated by membership lines.
 */
export function recordStatus(lines, fact, names = [fact.name], assigned = null) {
  const hasHistory = hasHistoryOf(fact);
  if (lines === null) return { status: "absent", history: hasHistory ? "absent" : null, reasons: [] };
  const all = names.includes(fact.name) ? names : [...names, fact.name];
  const a = (assigned ?? assignRecord(lines, all)).get(fact.name);
  const reasons = a.tied ? ["a line name ties with another fact"] : [];
  let status = a.tied ? NOT_ASSIGNED : "missing";
  if (a.current !== null) status = valueStatus(a.current.value, fact);
  else if (a.history !== null) {
    const items = historyItems(a.history.value);
    if (items.length > 0) status = valueStatus(items[items.length - 1], fact);
  } else if (isSet(fact)) {
    const members = membershipSet(lines, fact);
    if (members !== null) status = valueStatus(members.length === 0 ? "none" : members.join(", "), fact);
  }
  const history = !hasHistory ? null : a.history === null ? (a.tied ? NOT_ASSIGNED : "missing") : historyStatus(a.history.value, fact);
  return { status, history, reasons };
}

// ---------- host summary: free text ----------

/** The units of a free text: its lines (code block lines too), each split into sentences, with the line index. */
function unitsOf(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  lines.forEach((l, i) => {
    for (const u of l.split(/(?<=[.!?])\s+/)) if (u.trim() !== "") out.push({ raw: u.trim(), line: i });
  });
  return { units: out, lines };
}

const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_MAX_WORDS = 8;

/**
 * Pure. The heading of each line: the nearest heading line at or above it, or null. A note in parentheses is
 * dropped. A heading line is one of these:
 * - a markdown heading ("## Owners");
 * - a line that ends with its only colon outside parentheses ("Owners (team per service):", "**Owners:**");
 * - a short line that is not a list item, with no colon outside parentheses and no final period, when the next
 *   line that is not blank is a list item ("Owning team (identifier: current value; history where changed)").
 */
export function headingsOf(lines) {
  const out = [];
  let h = null;
  const nextIsItem = (i) => {
    for (let k = i + 1; k < lines.length; k++) if (lines[k].trim() !== "") return LIST_MARK.test(lines[k]);
    return false;
  };
  lines.forEach((l, i) => {
    const t = l.replace(LIST_MARK, "").replace(/\*\*/g, "").trim();
    const bare = t.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
    const md = /^#{1,6}\s+(.*)$/.exec(t);
    let head = null;
    if (md !== null) head = md[1];
    else if (bare.length > 1 && bare.indexOf(":") === bare.length - 1) head = bare.slice(0, -1);
    else if (bare !== "" && !LIST_MARK.test(l) && !bare.includes(":") && !/[.!?]$/.test(bare) && bare.split(" ").length <= HEADING_MAX_WORDS && nextIsItem(i)) head = bare;
    if (head !== null) h = head.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim() || null;
    out.push(h);
  });
  return out;
}

/** The units of a free text: its lines, each split into sentences. */
export function summaryUnits(text) {
  return unitsOf(text).units.map((u) => u.raw);
}

/** True when the raw words of `text` hold the words of `value` in a row, on compound borders ("5" is not "15" or "5-day"). */
function holdsWords(text, value) {
  const hay = rawTokens(text);
  const need = rawTokens(value).map((r) => r.w);
  if (need.length === 0) return false;
  for (let i = 0; i + need.length <= hay.length; i++) {
    if (!need.every((w, k) => hay[i + k].w === w)) continue;
    const first = hay[i], last = hay[i + need.length - 1];
    const before = hay[i - 1], after = hay[i + need.length];
    if (before !== undefined && before.group === first.group) continue;
    if (after !== undefined && after.group === last.group) continue;
    return true;
  }
  return false;
}

/** True when the text holds the value: a scalar as words in a row, a set with every element ("none" or "[]" when empty). */
function holds(text, value, kind) {
  if (kind === "set" || Array.isArray(value)) {
    const els = setElements(value);
    if (els.length === 0) return holdsWords(text, "none") || /\[\s*\]/.test(text);
    return els.every((e) => holdsWords(text, e));
  }
  return holdsWords(text, String(value));
}

/** The lines after `line` up to a blank line, at most 8: the wrapped list that follows a name. */
function continuation(lines, line) {
  const out = [];
  for (let i = line + 1; i < lines.length && i <= line + 8 && lines[i].trim() !== ""; i++) out.push(lines[i]);
  return out.join(" ");
}

/**
 * The fact occurrences in one prose unit: a short run of name tokens that holds every core and entity token of a
 * fact, with no compound split at its edges. Where runs of two facts overlap, the run with more tokens wins; equal
 * runs are ambiguous. @returns {Array<{ fact: string|null, ambiguous: string[], s: number, e: number }>} (char offsets)
 */
function proseOccurrences(text, keys) {
  const raw = rawTokens(text);
  const toks = nameTokensOf(raw);
  const found = [];
  const needs = [];
  for (const key of keys) {
    const full = [...new Set([...key.core, ...key.entity])];
    if (full.length > 0) needs.push({ key, need: full });
    // The name without its first word ("pricing table" for "active pricing table"), when no other fact has those words.
    const rest = full.slice(1);
    if (rest.length >= 2 && !key.entity.includes(full[0]) && !keys.some((k) => k !== key && rest.every((t) => k.all.includes(t)))) needs.push({ key, need: rest });
  }
  for (const { key, need } of needs) {
    for (let i = 0; i < toks.length; i++) {
      if (!need.includes(toks[i].t)) continue;
      for (let len = need.length; len <= need.length + 1 && i + len <= toks.length; len++) {
        const span = toks.slice(i, i + len);
        if (!need.every((t) => span.some((x) => x.t === t))) continue;
        if (!need.includes(span[span.length - 1].t)) continue;
        const a = span[0].raw[0], b = span[span.length - 1].raw[span[span.length - 1].raw.length - 1];
        if ((raw[a - 1] && raw[a - 1].group === raw[a].group) || (raw[b + 1] && raw[b + 1].group === raw[b].group)) continue;
        found.push({ fact: key.name, size: need.length, a, b, s: raw[a].s, e: raw[b].e });
        break;
      }
    }
  }
  found.sort((x, y) => x.s - y.s || y.size - x.size);
  const out = [];
  for (const f of found) {
    const clash = out.filter((o) => f.a <= o.b && o.a <= f.b);
    if (clash.length === 0) { out.push({ ...f, ambiguous: [] }); continue; }
    const top = clash[0];
    if (f.size > top.size) Object.assign(top, f, { ambiguous: [] });
    else if (f.size === top.size && f.fact !== top.fact) top.ambiguous = [...new Set([...top.ambiguous, top.fact, f.fact])];
  }
  return out.map((o) => (o.ambiguous.length > 0 ? { fact: null, ambiguous: o.ambiguous, s: o.s, e: o.e } : { fact: o.fact, ambiguous: [], s: o.s, e: o.e }));
}

/**
 * A grouped line: "<heading>: <entity> = value; <entity> {a, b}; ..." ("Owners: parcel-track = team-customs;
 * geo-fence = team-routing"). The heading holds the relation words of a fact (its core words that are not entity
 * words) and each item separated by ";" starts with the entity. Each item gives a reading of that fact. Returns true
 * when the unit is such a line.
 */
function groupedReads(unit, keys, addRead) {
  const at = unit.raw.indexOf(":");
  if (at <= 0 || !unit.raw.includes(";")) return false;
  const heading = new Set(nameTokensOf(rawTokens(unit.raw.slice(0, at))).map((x) => x.t));
  const items = unit.raw.slice(at + 1).split(";");
  let any = false;
  for (const key of keys) {
    if (key.entity.length === 0) continue;
    const relation = key.core.filter((t) => !key.entity.includes(t));
    if (relation.length === 0 || !relation.every((t) => heading.has(t))) continue;
    for (const item of items) {
      const raw = rawTokens(item);
      const toks = nameTokensOf(raw);
      const n = key.entity.length;
      if (toks.length < n || !key.entity.every((t, i) => toks[i]?.t === t)) continue;
      const last = toks[n - 1].raw.at(-1);
      if (raw[last + 1] !== undefined && raw[last + 1].group === raw[last].group) continue;
      addRead(key.name, item.slice(raw[last].e).replace(/^\s*(?:=|:|is\b)?\s*/, ""), unit, false);
      any = true;
    }
  }
  return any;
}

/**
 * Pure. The readings of every fact in a summary: for each fact, the texts that state its value (current and
 * history), the units that name it, and whether a tie touched it. A unit that parses as "name: value" uses the
 * line rule. A line name that ties between facts ("geo-index" for "owning team of geo-index" and "dependencies of
 * geo-index") is tried again with the heading of its section ("geo-index Owners"). The result counts only when it is
 * one of the tied facts. Else each fact occurrence reads the text after it up to the next occurrence; when that text
 * holds no known value of the fact, the whole unit counts.
 */
export function summaryReadings(summary, facts, names) {
  const keys = keysOf(names);
  const { units, lines } = unitsOf(summary);
  const headingAt = headingsOf(lines);
  const byName = new Map(facts.map((f) => [f.name, f]));
  const out = new Map(names.map((n) => [n, { reads: [], historyReads: [], units: [], tied: false }]));
  const known = (fact, t) => holds(t, fact.value, fact.kind) || earlierValues(fact).some((v) => holds(t, v, fact.kind));
  const addRead = (name, text, unit, history) => {
    const fact = byName.get(name);
    const r = out.get(name);
    if (fact === undefined || r === undefined) return;
    let w = text;
    if (isSet(fact) && !holds(w, fact.value, fact.kind)) w += " " + continuation(lines, unit.line);
    if (!known(fact, w)) w = unit.raw;
    (history ? r.historyReads : r.reads).push(w);
    if (!r.units.includes(unit.raw)) r.units.push(unit.raw);
  };
  for (const u of units) {
    if (groupedReads(u, keys, addRead)) continue;
    const rec = parseRecord(u.raw);
    if (rec.length === 1) {
      const a = assignName(rec[0].name, keys);
      if (a.fact !== null) { addRead(a.fact, rec[0].value, u, rec[0].history); continue; }
      if (a.ambiguous.length > 0) {
        const h = headingAt[u.line];
        const b = h === null ? null : assignName(rec[0].name + " " + h, keys);
        if (b !== null && b.fact !== null && a.ambiguous.includes(b.fact)) { addRead(b.fact, rec[0].value, u, rec[0].history); continue; }
        for (const n of a.ambiguous) out.get(n).tied = true;
        continue;
      }
    }
    const occ = proseOccurrences(u.raw, keys);
    occ.forEach((o, k) => {
      if (o.fact === null) { for (const n of o.ambiguous) out.get(n).tied = true; return; }
      const end = k + 1 < occ.length ? occ[k + 1].s : u.raw.length;
      let w = u.raw.slice(o.e, end);
      const history = /^\W*history\b/i.test(w);
      if (history) w = w.replace(/^\W*history\b\W*/i, "");
      addRead(o.fact, w, u, history);
    });
  }
  return out;
}

/**
 * Pure. Current and history status of one fact in a host summary (null summary: absent). correct: a reading holds
 * the current value (ambiguous when every such reading also holds an earlier value). stale: readings hold only
 * earlier values. A history reading counts for the current value only when no other reading gives a value: its last
 * element is then the stated value. missing: no reading, or no known value.
 */
export function summaryStatus(summary, fact, names = [fact.name], readings = null) {
  const hasHistory = hasHistoryOf(fact);
  if (summary === null) return { status: "absent", history: hasHistory ? "absent" : null, reasons: [] };
  const all = names.includes(fact.name) ? names : [...names, fact.name];
  const r = (readings ?? summaryReadings(summary, [fact], all)).get(fact.name);
  const earlier = earlierValues(fact);
  const reasons = r.tied ? ["a name ties with another fact"] : [];
  const judge = (ws) => {
    const cur = ws.filter((w) => holds(w, fact.value, fact.kind));
    if (cur.length > 0) {
      if (cur.every((w) => earlier.some((v) => holds(w, v, fact.kind)))) reasons.push("current and earlier value in the same unit");
      return "correct";
    }
    return ws.some((w) => earlier.some((v) => holds(w, v, fact.kind))) ? "stale" : null;
  };
  let status = judge(r.reads);
  if (status === null && r.historyReads.length > 0) {
    const lastItems = r.historyReads.map((w) => historyItems(w).pop() ?? "");
    status = lastItems.some((x) => holds(x, fact.value, fact.kind)) ? "correct" : lastItems.some((x) => earlier.some((v) => holds(x, v, fact.kind))) ? "stale" : null;
  }
  if (status === null && isSet(fact)) {
    // Membership lines in the summary ("locale fa-IR: supported"), as in a state file.
    const members = membershipSet(parseRecord(summary), fact);
    if (members !== null) {
      const v = valueStatus(members.length === 0 ? "none" : members.join(", "), fact);
      status = v === "formatted" ? "correct" : v === "incorrect" ? "missing" : v;
    }
  }
  status = status ?? (r.tied ? NOT_ASSIGNED : "missing");

  let history = null;
  if (hasHistory) {
    const named = [...r.units, ...r.historyReads];
    const values = [];
    for (const v of fact.history) if (!values.some((x) => formattedEqual(exactForm(x), v, fact.kind))) values.push(v);
    const present = values.map((v) => named.some((u) => holds(u, v, fact.kind)));
    if (present.every(Boolean)) history = "correct";
    else if (!present.some(Boolean)) history = r.tied ? NOT_ASSIGNED : "missing";
    else {
      const k = present.indexOf(false);
      history = present.slice(k).every((x) => !x) ? "stale" : "incorrect";
    }
  }
  return { status, history, reasons };
}

// ---------- the facts record ----------

/** The reference facts of a stage (schema 2), or null. */
export function referenceFactsAt(reference, afterStage) {
  const states = Array.isArray(reference?.states) ? reference.states : [];
  const s = states.find((x) => x?.afterStage === afterStage && Array.isArray(x.facts));
  return s === undefined ? null : s.facts.filter((f) => f && typeof f.name === "string");
}

/** The fact names of all stages of the reference, sorted: the name set for the aliases. */
export function factNamesOf(reference) {
  const states = Array.isArray(reference?.states) ? reference.states : [];
  return [...new Set(states.flatMap((s) => (Array.isArray(s?.facts) ? s.facts : []).map((f) => f?.name).filter((n) => typeof n === "string")))].sort();
}

/** True when the reference has facts (schema 2) for any stage. */
export function hasReferenceFacts(reference) {
  return Array.isArray(reference?.states) && reference.states.some((s) => Array.isArray(s?.facts));
}

const bytes = (t) => (t === null ? null : Buffer.byteLength(t, "utf8"));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** preTokens of a compaction: run.json compactions, else compact_metadata.pre_tokens of the stream, else null. */
function preTokensOf(run, afterStage, lines) {
  const c = (Array.isArray(run.compactions) ? run.compactions : []).find((x) => x?.afterStage === afterStage);
  if (num(c?.preTokens) !== null) return c.preTokens;
  for (const l of lines ?? []) {
    const m = l?.compact_metadata ?? l?.compactMetadata;
    const v = num(m?.pre_tokens) ?? num(m?.preTokens);
    if (v !== null) return v;
  }
  return null;
}

/** The stage of the probe question `id` (task checkpoint or checkpoints), or null. */
function probeStageOf(task, id) {
  const list = [...(Array.isArray(task?.checkpoints) ? task.checkpoints : []), ...(task?.checkpoint ? [task.checkpoint] : [])];
  const cp = list.find((c) => Array.isArray(c?.questions) && c.questions.some((q) => q?.id === id));
  return Number.isInteger(cp?.afterStage) ? cp.afterStage : null;
}

const WRONG_SAVED = Object.freeze(["stale", "incorrect"]);
const GOOD_SUMMARY = Object.freeze(["correct", "formatted"]);

/** The stage numbers with a write of the state file (run.json telemetry.stateFile.writeStages), or null. */
export function writeStagesOf(run) {
  const w = run?.telemetry?.stateFile?.writeStages;
  return Array.isArray(w) ? w.filter((x) => Number.isInteger(x)) : null;
}

/** Compaction stage minus the last write stage at or before it. null with no write or no writeStages. */
export function stagesSinceWrite(writeStages, afterStage) {
  if (!Array.isArray(writeStages) || !Number.isInteger(afterStage)) return null;
  const before = writeStages.filter((w) => w <= afterStage);
  return before.length === 0 ? null : afterStage - Math.max(...before);
}

/**
 * What the compact stream shows of a PreCompact hook: the hook_response lines with hook_event PreCompact, their
 * count, the bytes of their standard output, and how many ended with outcome success. null when the stream has no
 * such line.
 */
export function precompactHookOf(lines) {
  const rows = (lines ?? []).filter((l) => l?.type === "system" && l.subtype === "hook_response" && l.hook_event === "PreCompact");
  if (rows.length === 0) return null;
  return {
    responses: rows.length,
    bytes: rows.reduce((a, l) => a + Buffer.byteLength(typeof l.stdout === "string" ? l.stdout : typeof l.output === "string" ? l.output : "", "utf8"), 0),
    success: rows.filter((l) => l.outcome === "success").length,
  };
}

/**
 * Pure. The facts record of a run.
 * @param {{ run: object, task: object|null, key: object|null, grade: object|null, reference: object|null,
 *   compactions: Array<{ afterStage: number|null, lines: object[]|null, stateFile: string|null }>,
 *   turns: Array<{ label: string, kind: string, lines: object[]|null }> }} input
 */
export function buildFacts({ run, task, key, grade, reference, compactions, turns }) {
  const writes = writeStagesOf(run);
  const names = factNamesOf(reference);
  for (const f of (reference?.states ?? []).flatMap((st) => st?.facts ?? [])) if (typeof f?.name === "string" && !names.includes(f.name)) names.push(f.name);
  const comps = compactions.map((c) => {
    const summary = c.lines === null ? null : lastSummary(c.lines);
    const block = c.lines === null ? null : lastStateBlock(c.lines);
    const fileLines = c.stateFile === null ? null : parseRecord(c.stateFile);
    const blockLines = block === null ? null : parseRecord(block);
    const stageFacts = referenceFactsAt(reference, c.afterStage) ?? [];
    const fileAssigned = fileLines === null ? null : assignRecord(fileLines, names);
    const blockAssigned = blockLines === null ? null : assignRecord(blockLines, names);
    const readings = summary === null ? null : summaryReadings(summary, stageFacts, names);
    const facts = stageFacts.map((f) => {
      const sf = recordStatus(fileLines, f, names, fileAssigned);
      const bl = recordStatus(blockLines, f, names, blockAssigned);
      const su = summaryStatus(summary, f, names, readings);
      const reasons = [...sf.reasons.map((r) => "state file: " + r), ...su.reasons.map((r) => "summary: " + r), ...bl.reasons.map((r) => "block: " + r)];
      return {
        name: f.name,
        stateFile: sf.status, summary: su.status, block: bl.status,
        historyStateFile: sf.history, historySummary: su.history, historyBlock: bl.history,
        ambiguous: reasons.length > 0,
        ambiguousReasons: reasons,
      };
    });
    return {
      afterStage: c.afterStage,
      preTokens: preTokensOf(run, c.afterStage, c.lines),
      stateFile: { present: c.stateFile !== null, bytes: bytes(c.stateFile) },
      stagesSinceWrite: stagesSinceWrite(writes, c.afterStage),
      precompactHook: c.lines === null ? null : precompactHookOf(c.lines),
      // historyLine (v0.10 stop rule): the summary holds a line that matches HISTORY_LINE.
      summary: { present: summary !== null, bytes: bytes(summary), historyLine: summary !== null && HISTORY_LINE.test(summary) },
      block: { present: block !== null, bytes: bytes(block) },
      facts,
    };
  });

  const completed = run.status === "completed";
  const finalOk = new Map((grade?.questions ?? []).map((q) => [q.id, q.correct === true]));
  const probeOk = new Map((grade?.checkpointItems ?? []).map((q) => [q.id, q.correct === true]));
  // Probes that the runner did not ask (asked false, EXPERIMENT-V09.md part 2) are left out of the question join.
  const notAsked = new Set((grade?.checkpointItems ?? []).filter((q) => q?.asked === false).map((q) => q.id));
  const lastBefore = (stage) => {
    const list = comps.filter((c) => Number.isInteger(c.afterStage) && (stage === null || c.afterStage <= stage));
    return list.length === 0 ? null : list.reduce((a, b) => (b.afterStage > a.afterStage ? b : a));
  };
  // The first compaction at or after a stage (the stage that last changed a fact), else null.
  const ordered = comps.filter((c) => Number.isInteger(c.afterStage)).sort((a, b) => a.afterStage - b.afterStage);
  const firstFrom = (stage) => ordered.find((c) => stage === null || c.afterStage >= stage) ?? null;
  const questions = [];
  const addQuestions = (answers, scope) => {
    for (const id of Object.keys(answers ?? {}).sort()) {
      if (scope === "probe" && notAsked.has(id)) continue;
      const a = answers[id];
      const fact = a?.fact;
      if (!fact || typeof fact.name !== "string") continue;
      const part = fact.part === "history" ? "history" : "current";
      const comp = lastBefore(scope === "final" ? null : probeStageOf(task, id));
      const f = comp?.facts.find((x) => x.name === fact.name) ?? null;
      const pick = (cur, hist) => (f === null ? null : part === "history" ? f[hist] : f[cur]);
      const status = { stateFile: pick("stateFile", "historyStateFile"), summary: pick("summary", "historySummary"), block: pick("block", "historyBlock") };
      const correct = completed && (scope === "final" ? finalOk.get(id) : probeOk.get(id)) === true;
      const last = num(a.lastChangedStage);
      // Early wrong reading: a wrong final answer whose fact was already stale or incorrect in the state file or the
      // summary at the first compaction that holds its last value. null for other questions or with no such status.
      let earlyWrong = null;
      if (scope === "final" && completed && !correct) {
        const early = firstFrom(last)?.facts.find((x) => x.name === fact.name) ?? null;
        const sf = early === null ? null : part === "history" ? early.historyStateFile : early.stateFile;
        const su = early === null ? null : part === "history" ? early.historySummary : early.summary;
        if (FACT_STATUSES.includes(sf) || FACT_STATUSES.includes(su)) earlyWrong = WRONG_SAVED.includes(sf) || WRONG_SAVED.includes(su);
      }
      questions.push({
        id, scope, fact: fact.name, part,
        compactionStage: comp === null ? null : comp.afterStage,
        changedAfterLastCompaction: comp === null || last === null ? null : last > comp.afterStage,
        ...status,
        correct,
        // A run that did not complete gave no answer, so it has no anchoring candidate.
        anchoringCandidate: completed && !correct && (WRONG_SAVED.includes(status.block) || WRONG_SAVED.includes(status.stateFile)) && GOOD_SUMMARY.includes(status.summary),
        earlyWrong,
      });
    }
  };
  addQuestions(key?.answers, "final");
  addQuestions(key?.checkpointAnswers, "probe");

  const stateFileReads = [];
  let seenCompact = false;
  for (const t of turns) {
    if (t.kind === "compact") { seenCompact = true; continue; }
    if (t.lines === null) continue;
    for (const c of turnFacts(t.lines).calls) {
      if (!READ_TOOLS.includes(c.name)) continue;
      if (!JSON.stringify(c.input ?? {}).includes(STATE_FILE_NAME)) continue;
      stateFileReads.push({ turn: t.label, tool: c.name, afterCompaction: seenCompact });
    }
  }
  return { schema: FACTS_SCHEMA, runId: run.runId ?? null, compactions: comps, questions, stateFileReads };
}

// ---------- file access ----------

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * The facts record of one run, or null when the task has no reference facts (schema 2) or the run has no raw
 * stream. The state file copy of compaction N is state-file-<N>.md in the last attempt folder.
 */
export function factsForRun({ run, task, key, grade, reference, rawRunDir }) {
  if (!hasReferenceFacts(reference)) return null;
  const dir = lastAttemptDir(rawRunDir);
  if (dir === null) return null;
  const readLines = (label) => {
    const t = readText(join(dir, label + ".jsonl"));
    return t === null ? null : parseStream(t);
  };
  const compactions = compactTurns(dir, run).map((c) => ({
    afterStage: c.afterStage,
    lines: readLines(c.label),
    stateFile: c.afterStage === null ? null : readText(join(dir, "state-file-" + c.afterStage + ".md")),
  }));
  const turns = (run.turns ?? []).map((t) => ({ label: turnLabel(t), kind: t.kind, lines: readLines(turnLabel(t)) }));
  return buildFacts({ run, task, key, grade, reference, compactions, turns });
}

// CLI: writes facts.json for every run of a batch (the same step that analyze.mjs runs).
if (process.argv[1] !== undefined && process.argv[1].endsWith("facts.mjs")) {
  const { writeDerived, parseArgs } = await import("./analyze.mjs");
  try {
    const n = writeDerived(parseArgs(process.argv.slice(2)));
    process.stdout.write("facts: " + n.facts + " facts.json written\n");
  } catch (err) {
    process.stderr.write("facts: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}
