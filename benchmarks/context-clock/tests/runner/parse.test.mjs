// Answer parsing and stream parsing against recorded samples.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswers } from "../../runner/answers.mjs";
import * as claude from "../../runner/hosts/claude.mjs";
import * as codex from "../../runner/hosts/codex.mjs";
import { checkpointPrompt, finalPrompt, introPrompt, stagePrompt } from "../../runner/prompts.mjs";
import { isLimitText } from "../../runner/stream.mjs";
import { readStream, readTask } from "./helpers.mjs";

const QS = [
  { id: "q1", type: "choice", options: ["sqlite", "postgres"] },
  { id: "q2", type: "set", options: ["db", "cache"] },
  { id: "q3", type: "int", options: [] },
  { id: "q4", type: "bool", options: [] },
];

test("answers: the last fenced json block wins", () => {
  const text = 'Draft:\n```json\n{"answers":{"q1":"sqlite"}}\n```\nFinal:\n```json\n{"answers":{"q1":"postgres","q2":["db"],"q3":4,"q4":true}}\n```';
  const r = parseAnswers(text, QS);
  assert.equal(r.error, null);
  assert.deepEqual(r.answers, { q1: "postgres", q2: ["db"], q3: 4, q4: true });
});

test("answers: a balanced object without a fence, with braces inside strings", () => {
  const r = parseAnswers('Here: {"answers": {"q1": "sqlite", "q2": ["db", "cache"], "q3": 2, "q4": false, "note": "a } b"}} thanks', QS);
  assert.equal(r.error, null);
  assert.equal(r.answers.q1, "sqlite");
  assert.deepEqual(r.answers.q2, ["db", "cache"]);
});

test("answers: value types are normalized", () => {
  const r = parseAnswers('```json\n{"answers":{"q1":["sqlite"],"q2":"db, cache","q3":"7","q4":"true"}}\n```', QS);
  assert.deepEqual(r.answers, { q1: "sqlite", q2: ["db", "cache"], q3: 7, q4: true });
});

test("answers: a top-level map of ids is accepted; no json gives an error", () => {
  assert.equal(parseAnswers('```json\n{"q1":"sqlite","q3":1}\n```', QS).answers.q1, "sqlite");
  const bad = parseAnswers("I cannot answer.", QS);
  assert.equal(bad.answers, null);
  assert.match(bad.error, /no parsable answers/);
  assert.ok(parseAnswers("```json\n{broken\n```", QS).error);
});

test("prompts are neutral and list each question with id, type and options", () => {
  const t = readTask("T2-runner-compaction");
  const all = [introPrompt(t), ...t.stages.map((s) => stagePrompt(t, s)), checkpointPrompt(t), finalPrompt(t)].join("\n");
  assert.doesNotMatch(all, /clock|memory|context.mode|ctx_/i);
  const fin = finalPrompt(t);
  assert.match(fin, /- q1 \[choice\] Which tag is planned\? Options: v1\.1\.0 \| v1\.2\.0 \| v2\.0\.0/);
  assert.match(fin, /- q3 \[int\]/);
  assert.match(fin, /```json/);
  assert.match(fin, /Do not call any tool/);
  assert.match(stagePrompt(t, t.stages[1]), /- output: node feed\.mjs build/);
  assert.match(stagePrompt(t, t.stages[0]), /- file: docs\/checklist\.md/);
});

test("claude stream: usage is the turn sum with cache tokens; tools and session id", () => {
  const p = claude.parseStream(readStream("claude-turn-bash.jsonl"));
  assert.equal(p.sessionId, "1f2b16ef-47fe-4121-9963-2e881f39684e");
  assert.equal(p.model, "claude-haiku-5-5");
  assert.deepEqual(p.usage, { inputTokens: 4, outputTokens: 90, cacheReadTokens: 51302, cacheCreationTokens: 15208 });
  assert.deepEqual(p.toolCalls, [{ name: "Bash", isError: false }]);
  assert.equal(p.compactBoundary, false);
  assert.equal(p.limitEvent, null, "an allowed_warning rate_limit_event is not a limit");
  assert.equal(p.resultText, "done");
});

test("claude stream: the compact turn has a compact_boundary and keeps the session id", () => {
  const p = claude.parseStream(readStream("claude-compact.jsonl"));
  assert.equal(p.compactBoundary, true);
  assert.equal(p.sessionId, "1f2b16ef-47fe-4121-9963-2e881f39684e");
  assert.equal(p.clockSnapshots.count, 0);
});

test("claude stream: snapshot blocks in tool results count; assistant text does not", () => {
  const lines = [
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "[context-clock] fake [/context-clock]" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "out\n[context-clock] tick=1\n[/context-clock]" }] } },
    { type: "result", subtype: "success", is_error: false, result: "x", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const p = claude.parseStream(lines);
  assert.equal(p.clockSnapshots.count, 1);
  assert.ok(p.clockSnapshots.bytes > 10);
  assert.deepEqual(p.toolCalls, [{ name: "Bash", isError: true }]);
});

test("claude stream: a rejected rate_limit_event is a limit", () => {
  const p = claude.parseStream(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }));
  assert.notEqual(p.limitEvent, null);
  assert.equal(isLimitText("Claude usage limit reached. Your limit will reset at 5pm"), true);
  assert.equal(isLimitText("API Error: 429 rate_limit_error"), true);
  assert.equal(isLimitText("file not found"), false);
});

test("codex stream (synthetic sample): thread id, usage, tool errors, snapshots from tools only", () => {
  const p = codex.parseStream(readStream("codex-turn.synthetic.jsonl"));
  assert.equal(p.sessionId, "0199a000-0000-7000-8000-000000000001");
  assert.deepEqual(p.usage, { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 800, cacheCreationTokens: null });
  assert.deepEqual(p.toolCalls, [
    { name: "shell", isError: false },
    { name: "shell", isError: true },
    { name: "mcp__context-mode__ctx_search", isError: false },
  ]);
  assert.equal(p.clockSnapshots.count, 1);
  assert.equal(p.resultText, "Summary: the log has 120 lines.");
  assert.equal(p.compactBoundary, false);
});

test("codex: compact() never confirms; args carry the env_vars override and resume", async () => {
  assert.equal((await codex.compact()).confirmed, false);
  const args = codex.buildArgs({ sessionId: "abc", model: "gpt-x" });
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
  assert.ok(args.includes("-c"));
  assert.deepEqual(args.slice(-3), ["resume", "abc", "-"]);
});

test("claude args: allowed and disallowed tools, max turns, resume", () => {
  const a = claude.buildArgs({ sessionId: "s1", model: "haiku", allowedTools: ["Read", "Bash"], disallowedTools: ["Read"], maxTurns: 5 });
  assert.ok(a.includes("-p"));
  assert.ok(a.includes("stream-json"));
  assert.equal(a[a.indexOf("--resume") + 1], "s1");
  assert.equal(a[a.indexOf("--max-turns") + 1], "5");
  assert.equal(a[a.indexOf("--model") + 1], "haiku");
});
