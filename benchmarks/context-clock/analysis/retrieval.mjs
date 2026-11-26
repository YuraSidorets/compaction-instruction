#!/usr/bin/env node
// Retrieval instrumentation of one run (EXPERIMENT-V03.md "Instrumentation and analysis").
//   node benchmarks/context-clock/analysis/retrieval.mjs --batch <name> [--root <dir>] [--raw-dir <dir>] [--tasks-dir <dir>]
// Input: the task, the key, run.json, grade.json and the per-turn raw streams of the last attempt
// (results/<batch>/raw/<runId>/a<N>/<turn>.jsonl). Output: results/<batch>/runs/<runId>/retrieval.json.
// Stream facts: tool calls are `assistant` lines with `tool_use` blocks; tool results are `user` lines with
// `tool_result` blocks; a compaction summary is a `user` line with string content; a compaction is a `system` line with
// subtype `compact_boundary`. The runner's prompts are not in the stream, so the intro and stage prompt texts of the
// task count as user messages of their turn.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeAnswer } from "../graders/grade.mjs";
import { cmp } from "./util.mjs";

export const RETRIEVAL_SCHEMA = 1;
/** The cut hint of Context Mode: a tool result that holds it was cut and indexed. */
export const CUT_HINT = "searches the whole output";
export const ERROR_CLASSES = Object.freeze(["tool_or_infrastructure", "retrieval", "compaction_recovery", "state_tracking", "reasoning", "indeterminate"]);
/** Lowercase phrases that the agentNotedGap heuristic looks for in assistant text. A heuristic, not a measurement. */
export const GAP_PHRASES = Object.freeze([
  "truncat", "cut off", "was cut", "is cut", "not shown", "only shows", "only part", "partial", "incomplete",
  "not visible", "not available", "could not find", "couldn't find", "can't find", "cannot find", "not found",
  "rest of the output", "whole output", "more lines", "was indexed", "missing",
]);
/** Lowercase markers for the plain-text count of assistant messages that mention the clock or the placebo tag. */
export const CLOCK_MARKERS = Object.freeze(["context-clock", "ctx_clock", "clock"]);
export const PLACEBO_MARKERS = Object.freeze(["context-note"]);

// ---------- stream reading ----------

/** JSON lines of one stream file. A line that is not JSON is skipped. */
export function parseStream(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (line.trim() === "") continue;
    try { out.push(JSON.parse(line)); } catch { /* a cut last line of a stopped run */ }
  }
  return out;
}

/** The stream file name of a run.json turn. */
export function turnLabel(turn) {
  return Number.isInteger(turn.stage) ? turn.kind + "-" + turn.stage : turn.kind;
}

function blocksOf(line) {
  const c = line?.message?.content;
  if (typeof c === "string") return [{ type: "string", text: c }];
  return Array.isArray(c) ? c : [];
}

function resultText(b) {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) return b.content.map((x) => (typeof x?.text === "string" ? x.text : JSON.stringify(x))).join("\n");
  return b.content === undefined ? "" : JSON.stringify(b.content);
}

/** Every [eNNN] tag in text (three or more digits), in order of first occurrence. */
export function eventTags(text) {
  const out = [];
  const seen = new Set();
  const s = String(text);
  let i = s.indexOf("[e");
  while (i >= 0) {
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j - (i + 2) >= 3 && s[j] === "]") {
      const id = s.slice(i + 1, j);
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    i = s.indexOf("[e", i + 1);
  }
  return out;
}

/** One turn as facts: tool calls with their results, user texts, assistant texts, compaction marker. */
export function turnFacts(lines) {
  const calls = [];
  const byId = new Map();
  const userTexts = [];
  const assistantTexts = [];
  let compactBoundary = false;
  for (const l of lines) {
    if (l.type === "system" && l.subtype === "compact_boundary") compactBoundary = true;
    if (l.type === "assistant") {
      const texts = [];
      for (const b of blocksOf(l)) {
        if (b.type === "tool_use") {
          const call = { id: b.id ?? null, name: String(b.name ?? ""), input: b.input ?? {}, results: [] };
          calls.push(call);
          if (call.id !== null) byId.set(call.id, call);
        } else if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      }
      if (texts.length > 0) assistantTexts.push(texts.join("\n"));
    } else if (l.type === "user") {
      for (const b of blocksOf(l)) {
        if (b.type === "tool_result") {
          const t = resultText(b);
          userTexts.push(t);
          const call = byId.get(b.tool_use_id);
          if (call !== undefined) call.results.push(t);
        } else if (typeof b.text === "string") userTexts.push(b.text);
      }
    }
  }
  return { calls, userTexts, assistantTexts, compactBoundary };
}

// ---------- chunks ----------

const bytesOf = (s) => Buffer.byteLength(String(s), "utf8");

/** The chunks of a task: the v0.3 `chunks` list of each stage, else derived from the staged files and feeds. */
export function taskChunks(task) {
  const out = [];
  for (const st of task.stages ?? []) {
    if (Array.isArray(st.chunks)) {
      for (const c of st.chunks) out.push({ chunkId: c.chunkId, stage: st.stage, kind: c.kind, name: c.name, bytes: c.bytes ?? null, events: [...(c.events ?? [])] });
      continue;
    }
    for (const f of st.files ?? []) out.push({ chunkId: "s" + st.stage + ":file:" + f.path, stage: st.stage, kind: "file", name: f.path, bytes: bytesOf(f.content ?? ""), events: eventTags(f.content ?? "") });
    for (const f of st.feeds ?? []) out.push({ chunkId: "s" + st.stage + ":feed:" + f.name, stage: st.stage, kind: "feed", name: f.name, bytes: bytesOf(f.content ?? ""), events: eventTags(f.content ?? "") });
  }
  return out;
}

function inputText(call) {
  return typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
}

const normSlash = (s) => s.split("\\").join("/").split("\\\\").join("/");

/** True if the text names `feed.mjs <name>` with the name ending at a non-name character. */
function namesFeed(text, name) {
  const needle = "feed.mjs " + name;
  let i = text.indexOf(needle);
  while (i >= 0) {
    const next = text[i + needle.length];
    if (next === undefined || !(/[A-Za-z0-9_.-]/).test(next)) return true;
    i = text.indexOf(needle, i + 1);
  }
  return false;
}

function requests(call, chunk) {
  const t = normSlash(inputText(call));
  return chunk.kind === "feed" ? namesFeed(t, chunk.name) : t.includes(normSlash(chunk.name));
}

function isFollowUpCall(call, chunk) {
  const n = call.name;
  if (n.endsWith("ctx_search") || n.endsWith("ctx_execute") || n.endsWith("ctx_execute_file")) return true;
  if (chunk.kind !== "feed") return false;
  const t = inputText(call);
  return namesFeed(t, chunk.name) && t.includes("|");
}

// ---------- the run ----------

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasMarker(text, markers) {
  const low = text.toLowerCase();
  return markers.some((m) => low.includes(m));
}

/**
 * Pure. Builds the retrieval record of a run.
 * @param {{ task: object, key: object, run: object, grade: object|null, turns: Array<{ label: string, kind: string, stage: number|null, lines: object[]|null }> }} input
 */
export function buildRetrieval({ task, key, run, grade, turns }) {
  const stageOfEvent = new Map((key?.events ?? []).map((e) => [e.id, e.stage]));
  const facts = turns.map((t) => ({ ...t, f: turnFacts(t.lines ?? []) }));
  // The runner's prompts are user messages of their turn: the intro and each stage prompt.
  for (const t of facts) {
    if (t.kind === "intro" && typeof task?.intro === "string") t.f.userTexts.push(task.intro);
    if (t.kind === "stage") {
      const st = (task?.stages ?? []).find((s) => s.stage === t.stage);
      if (typeof st?.prompt === "string") t.f.userTexts.push(st.prompt);
    }
  }
  // Confirmed compactions: run.json compactions[i].confirmed, else the compact_boundary marker of the turn stream.
  const confirmedStages = new Set((run.compactions ?? []).filter((c) => isObject(c) && c.confirmed === true && Number.isInteger(c.afterStage)).map((c) => c.afterStage));
  const hasRunCompactions = Array.isArray(run.compactions) && run.compactions.length > 0;
  const compactIdx = [];
  facts.forEach((t, i) => {
    if (t.kind !== "compact") return;
    const ok = hasRunCompactions ? confirmedStages.has(t.stage) : t.f.compactBoundary;
    if (ok) compactIdx.push(i);
  });
  const lastCompact = compactIdx.length === 0 ? null : compactIdx[compactIdx.length - 1];

  // First and last turn index at which each event tag was model-visible.
  const seenAt = new Map();
  facts.forEach((t, i) => {
    for (const txt of t.f.userTexts) for (const id of eventTags(txt)) {
      const s = seenAt.get(id) ?? [];
      if (s[s.length - 1] !== i) s.push(i);
      seenAt.set(id, s);
    }
  });
  const visible = (id) => seenAt.has(id);
  const before = (id) => lastCompact !== null && (seenAt.get(id) ?? []).some((i) => i < lastCompact);
  const after = (id) => (seenAt.get(id) ?? []).some((i) => lastCompact === null || i >= lastCompact);

  // Chunks: requested, returned bytes, cut, follow-up within the stage turn.
  const chunks = taskChunks(task).map((c) => {
    const stageTurns = facts.filter((t) => t.kind === "stage" && t.stage === c.stage);
    let requested = false;
    let returnedBytes = 0;
    let cut = false;
    let followUp = false;
    for (const t of stageTurns) {
      let firstReq = -1;
      t.f.calls.forEach((call, ci) => {
        if (!requests(call, c)) return;
        requested = true;
        if (firstReq < 0) firstReq = ci;
        for (const r of call.results) {
          returnedBytes += bytesOf(r);
          if (r.includes(CUT_HINT)) cut = true;
        }
      });
      if (firstReq >= 0 && cut) followUp = followUp || t.f.calls.slice(firstReq + 1).some((call) => isFollowUpCall(call, c));
    }
    return {
      chunkId: c.chunkId, stage: c.stage, kind: c.kind, name: c.name, bytes: c.bytes, requested, returnedBytes, cut, followUp,
      eventsTotal: c.events.length, eventsVisible: c.events.filter(visible).length,
    };
  });

  const assistantByStage = new Map();
  for (const t of facts) {
    if (t.kind !== "stage") continue;
    assistantByStage.set(t.stage, [...(assistantByStage.get(t.stage) ?? []), ...t.f.assistantTexts]);
  }
  const gapInStage = (stage) => (assistantByStage.get(stage) ?? []).some((txt) => hasMarker(txt, GAP_PHRASES));

  const completed = run.status === "completed";
  const questionOf = (list, id) => (list ?? []).find((q) => q.id === id) ?? { id, type: "choice" };
  const classify = (q, item, keyEntry, needed) => {
    if (item.correct === true) return null;
    if (!completed) return "tool_or_infrastructure";
    if (needed.some((id) => (stageOfEvent.get(id) ?? 0) >= 1 && !visible(id))) return "retrieval";
    if (needed.length > 0 && needed.every(visible) && needed.some((id) => before(id) && !after(id))) return "compaction_recovery";
    const reason = typeof item.reason === "string" ? item.reason : keyEntry ? gradeAnswer(q, keyEntry, item.given).reason : null;
    if (reason === "stale") return "state_tracking";
    if (reason === "missing" || reason === "malformed" || item.given === null || item.given === undefined) return "indeterminate";
    return "reasoning";
  };
  const question = (scope, item, q, keyEntry) => {
    const needed = [...(keyEntry?.establishedBy ?? [])];
    return {
      id: item.id,
      scope,
      correct: item.correct === true,
      needed,
      visibleBefore: needed.filter(before),
      visibleAfter: lastCompact === null ? [] : needed.filter(after),
      neverVisible: needed.filter((id) => (stageOfEvent.get(id) ?? 0) >= 1 && !visible(id)),
      agentNotedGap: needed.some((id) => gapInStage(stageOfEvent.get(id))),
      errorClass: classify(q, item, keyEntry, needed),
    };
  };
  const finals = (grade?.questions ?? []).map((item) => question("final", item, questionOf(task?.final?.questions, item.id), key?.answers?.[item.id]));
  // A probe that the runner did not ask (asked false, EXPERIMENT-V09.md part 2) gets no error class.
  const probes = (grade?.checkpointItems ?? []).filter((item) => item?.asked !== false).map((item) => question("probe", item, questionOf(task?.checkpoint?.questions, item.id), key?.checkpointAnswers?.[item.id]));

  const assistantMessages = facts.flatMap((t) => t.f.assistantTexts);
  return {
    schema: RETRIEVAL_SCHEMA,
    runId: run.runId,
    streamsFound: turns.filter((t) => t.lines !== null).length,
    streamsExpected: turns.length,
    compactionTurns: compactIdx.map((i) => facts[i].label),
    chunks,
    questions: [...finals, ...probes],
    assistantMentions: {
      note: "plain text count of assistant messages; not a measure of use",
      messages: assistantMessages.length,
      clock: assistantMessages.filter((m) => hasMarker(m, CLOCK_MARKERS)).length,
      placebo: assistantMessages.filter((m) => hasMarker(m, PLACEBO_MARKERS)).length,
    },
  };
}

// ---------- file access ----------

/** The folder of the last attempt (a<N> with the highest N), or null. */
export function lastAttemptDir(rawRunDir) {
  if (!existsSync(rawRunDir)) return null;
  const dirs = readdirSync(rawRunDir).filter((d) => d.length > 1 && d[0] === "a" && Number.isInteger(Number(d.slice(1)))).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return dirs.length === 0 ? null : join(rawRunDir, dirs[dirs.length - 1]);
}

/** The turns of run.json with their parsed stream, or lines null when the stream file is missing. */
export function loadTurns(rawRunDir, run) {
  const dir = lastAttemptDir(rawRunDir);
  return (run.turns ?? []).map((t) => {
    const label = turnLabel(t);
    const p = dir === null ? null : join(dir, label + ".jsonl");
    return { label, kind: t.kind, stage: Number.isInteger(t.stage) ? t.stage : null, lines: p !== null && existsSync(p) ? parseStream(readFileSync(p, "utf8")) : null };
  });
}

/** The retrieval record of one run, or null when no raw stream of the run exists. */
export function retrievalForRun({ task, key, run, grade, rawRunDir }) {
  if (lastAttemptDir(rawRunDir) === null) return null;
  return buildRetrieval({ task, key, run, grade, turns: loadTurns(rawRunDir, run) });
}

// CLI: writes retrieval.json for every run of a batch (the same step that analyze.mjs runs).
if (process.argv[1] !== undefined && process.argv[1].endsWith("retrieval.mjs")) {
  const { writeRetrievals, parseArgs } = await import("./analyze.mjs");
  try {
    const args = parseArgs(process.argv.slice(2));
    const n = writeRetrievals(args);
    process.stdout.write("retrieval: " + n.written + " retrieval.json written, " + n.withoutStreams + " runs without raw streams\n");
  } catch (err) {
    process.stderr.write("retrieval: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}
