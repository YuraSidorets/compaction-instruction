// v0.7 product triggers (EXPERIMENT-V07.md, "Arms"): standing instruction (arm N), threshold reminder (arm T) and
// summarizer instruction (arm P), plus the regression rule: without the new variables, every reply stays byte-equal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, FULL_BLOCK, tempDir, writeScript } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const T = await import(pathToFileURL(path.join(OVERLAY_DIR, "triggers.mjs")).href);
const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const dir = tempDir("ccb-triggers-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const ARGS = ["--agent", "claude-code"];
const NEW_VARS = ["CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PRECOMPACT_FILE"];
const OLD_VARS = ["CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"];

const STANDING_TEXT = "Keep clock-state.md current after each change of a tracked value.";
const REMIND_TEXT = "Write the tracked state to clock-state.md now, with one Write call.";
const PRECOMPACT_TEXT = "Keep the current value and the earlier values of each tracked item in the summary.";
const STANDING = writeScript(dir, "standing.txt", STANDING_TEXT + "\n");
const REMIND = writeScript(dir, "remind.txt", REMIND_TEXT + "\n");
const PRECOMPACT = writeScript(dir, "precompact.txt", PRECOMPACT_TEXT + "\n");

const ssReply = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "product rules\n" + FULL_BLOCK } });
const postReply = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "indexed." } });

function envFor(stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", ...extra };
  for (const k of [...NEW_VARS, ...OLD_VARS]) if (!(k in extra)) delete env[k];
  return env;
}
const payload = (event, extra = {}) => JSON.stringify({ hook_event_name: event, session_id: "s1", ...extra });
const shim = (event, stdout, extra, pl = {}, { real = true } = {}) =>
  run([SHIM, ...(real ? [HOOK, ...ARGS] : [])], { env: envFor(stdout, extra), pieces: [payload(event, pl)] });
const direct = (event, stdout, extra, pl = {}) => run([HOOK, ...ARGS], { env: envFor(stdout, extra), pieces: [payload(event, pl)] });
const logOf = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const channel = (log, ch) => logOf(log).filter((l) => l.channel === ch);
const ctxOf = (r) => JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
const strip = (l) => ({ ...l, t: 0 });

/** One transcript line of an assistant record with the given usage. */
function assistant(input, cacheRead, cacheCreate, extra = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", model: "claude-haiku", usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 50 }, content: [] },
    ...extra,
  });
}
const userLine = (text) => JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: text } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- regression ----------

test("without the v0.7 variables every reply is byte-equal to the product hook, and no trigger line is logged", async () => {
  const log = path.join(dir, "regress.jsonl");
  const transcript = path.join(dir, "regress-transcript.jsonl");
  writeFileSync(transcript, assistant(90000, 0, 0) + "\n");
  const data = path.join(dir, "regress-data");
  mkdirSync(data, { recursive: true });
  const cases = [
    ["SessionStart", ssReply, { source: "startup" }],
    ["SessionStart", ssReply, { source: "compact" }],
    ["SessionStart", "plain text\n", { source: "resume" }],
    ["PostToolUse", postReply, { tool_name: "Bash", transcript_path: transcript }],
    ["PostToolUse", "", { tool_name: "Read", transcript_path: transcript }],
    ["PreCompact", "product precompact\n", { trigger: "manual" }],
    ["PreCompact", "", { trigger: "auto" }],
  ];
  for (const [event, out, pl] of cases) {
    for (const exit of ["0", "2"]) {
      const extra = { FAKE_HOOK_EXIT: exit, CCB_DATA_DIR: data };
      const d = await direct(event, out, extra, pl);
      const s = await shim(event, out, { ...extra, CCB_SHIM_LOG: log }, pl);
      assert.ok(s.stdout.equals(d.stdout), `${event} ${JSON.stringify(pl)} stdout`);
      assert.equal(s.stderr, d.stderr);
      assert.equal(s.code, Number(exit));
    }
  }
  // the PreCompact entry with no product hook prints nothing and exits 0, as with no hook at all
  const bare = await shim("PreCompact", "ignored", { CCB_SHIM_LOG: log }, { trigger: "manual" }, { real: false });
  assert.equal(bare.code, 0);
  assert.equal(bare.stdout.length, 0);
  assert.equal(bare.stderr, "");
  const lines = logOf(log);
  assert.ok(!lines.some((l) => ["standing", "reminder", "precompact", "triggers"].includes(l.channel)));
  assert.ok(!existsSync(path.join(data, T.REMIND_MARKER)), "no marker without arm T");
});

test("triggersFor: no step without the variables; the right steps with them", async () => {
  const H = await import(pathToFileURL(SHIM).href);
  for (const ev of ["SessionStart", "PostToolUse", "PostToolUseFailure", "PreCompact", "PreToolUse", "UserPromptSubmit"]) {
    assert.deepEqual(H.triggersFor({ CCB_RETURN_STATE: "file", CCB_DATA_DIR: "/d" }, ev, { source: "compact" }), [], ev);
  }
  const all = { CCB_STANDING_FILE: "a", CCB_REMIND_FILE: "b", CCB_REMIND_THRESHOLD: "40000", CCB_PRECOMPACT_FILE: "c" };
  assert.deepEqual(H.triggersFor(all, "SessionStart", { source: "compact" }), ["standing", "rearm"]);
  assert.deepEqual(H.triggersFor(all, "SessionStart", { source: "startup" }), ["standing"]);
  assert.deepEqual(H.triggersFor(all, "PostToolUse", {}), ["reminder"]);
  assert.deepEqual(H.triggersFor(all, "PostToolUseFailure", {}), []);
  assert.deepEqual(H.triggersFor(all, "PreCompact", {}), ["precompact"]);
  assert.deepEqual(H.triggersFor(all, "PreToolUse", {}), []);
});

// ---------- arm N ----------

test("arm N: the standing instruction follows the product text of every SessionStart reply", async () => {
  const log = path.join(dir, "standing.jsonl");
  for (const source of ["startup", "resume", "compact", "clear"]) {
    const r = await shim("SessionStart", ssReply, { CCB_STANDING_FILE: STANDING, CCB_SHIM_LOG: log }, { source });
    assert.equal(r.code, 0);
    assert.equal(ctxOf(r), "product rules\n" + FULL_BLOCK + "\n" + STANDING_TEXT, source);
  }
  const lines = channel(log, "standing");
  assert.deepEqual(lines.map(strip), ["startup", "resume", "compact", "clear"].map((source) => ({ t: 0, channel: "standing", event: "SessionStart", source, delivered: true, bytes: Buffer.byteLength(STANDING_TEXT) })));
  assert.ok(!readFileSync(log, "utf8").includes("clock-state"), "log holds no text");
  // empty and plain text product replies
  const empty = await shim("SessionStart", "", { CCB_STANDING_FILE: STANDING }, { source: "startup" });
  assert.deepEqual(JSON.parse(empty.stdout.toString("utf8")), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: STANDING_TEXT } });
  const plain = await shim("SessionStart", "plain rules\n", { CCB_STANDING_FILE: STANDING }, { source: "startup" });
  assert.equal(plain.stdout.toString("utf8"), "plain rules\n" + STANDING_TEXT);
  // no effect on other events
  const post = await shim("PostToolUse", postReply, { CCB_STANDING_FILE: STANDING }, { tool_name: "Bash" });
  assert.equal(post.stdout.toString("utf8"), postReply);
});

test("arm N: a failed product hook or a bad file leaves the product reply intact", async () => {
  const log = path.join(dir, "standing-fail.jsonl");
  const failed = await shim("SessionStart", ssReply, { CCB_STANDING_FILE: STANDING, CCB_SHIM_LOG: log, FAKE_HOOK_EXIT: "2" }, { source: "compact" });
  assert.equal(failed.code, 2);
  assert.equal(failed.stdout.toString("utf8"), ssReply);
  const empty = writeScript(dir, "standing-empty.txt", " \n");
  for (const f of [path.join(dir, "no-such.txt"), empty, dir]) {
    const r = await shim("SessionStart", ssReply, { CCB_STANDING_FILE: f, CCB_SHIM_LOG: log }, { source: "startup" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), ssReply);
  }
  const notObject = await shim("SessionStart", "[1,2]", { CCB_STANDING_FILE: STANDING, CCB_SHIM_LOG: log }, { source: "startup" });
  assert.equal(notObject.stdout.toString("utf8"), "[1,2]");
  const lines = channel(log, "standing");
  assert.equal(lines.length, 5);
  assert.deepEqual([lines[0].delivered, lines[0].hookExit, lines[0].error], [false, 2, undefined]);
  for (const l of lines.slice(1)) {
    assert.equal(l.delivered, false);
    assert.equal(typeof l.error, "string");
  }
});

// ---------- arm T ----------

test("estimateContext: last main-chain assistant usage; cut, sidechain, synthetic and broken lines are skipped", () => {
  const f = path.join(dir, "est.jsonl");
  writeFileSync(f, [
    userLine("start"),
    assistant(10, 20000, 3000),
    "{ broken json",
    assistant(5, 41000, 900),
    assistant(1, 99000, 0, { isSidechain: true }),
    JSON.stringify({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }),
    userLine("tool result"),
    '{"type":"assistant","message":{"usage":{"input_tokens":77777', // cut last line
  ].join("\n"));
  const e = T.estimateContext(f);
  assert.equal(e.estimate, 5 + 41000 + 900);
  assert.match(e.timestamp, /^\d{4}-/);
  assert.deepEqual(T.estimateContext(path.join(dir, "missing.jsonl")), { reason: "transcript missing" });
  assert.deepEqual(T.estimateContext(undefined), { reason: "no transcript_path" });
  const none = path.join(dir, "est-none.jsonl");
  writeFileSync(none, userLine("only a user line") + "\n");
  assert.deepEqual(T.estimateContext(none), { reason: "no usage record" });
});

test("estimateContext: reads only the tail, also past a long tool result, and drops the cut first line", () => {
  const f = path.join(dir, "est-long.jsonl");
  writeFileSync(f, assistant(1, 12345, 0) + "\n");
  appendFileSync(f, assistant(2, 45000, 0) + "\n");
  appendFileSync(f, userLine("x".repeat(600 * 1024)) + "\n"); // longer than the first window
  assert.equal(T.estimateContext(f).estimate, 45002);
  // a usage record that is beyond the last window is not found
  const far = path.join(dir, "est-far.jsonl");
  writeFileSync(far, assistant(3, 50000, 0) + "\n" + userLine("y".repeat(T.TAIL_WINDOWS.at(-1) + 10)) + "\n");
  assert.deepEqual(T.estimateContext(far), { reason: "no usage record" });
});

test("arm T: the reminder fires one time at the threshold and arms again after a compaction", async () => {
  const log = path.join(dir, "remind.jsonl");
  const data = path.join(dir, "remind-data");
  mkdirSync(data, { recursive: true });
  const transcript = path.join(dir, "remind-transcript.jsonl");
  const env = { CCB_REMIND_FILE: REMIND, CCB_REMIND_THRESHOLD: "40000", CCB_DATA_DIR: data, CCB_SHIM_LOG: log };
  const post = (out = postReply, tool = "Bash") => shim("PostToolUse", out, env, { tool_name: tool, transcript_path: transcript });

  writeFileSync(transcript, userLine("stage 1") + "\n" + assistant(100, 30000, 2000) + "\n");
  let r = await post();
  assert.equal(r.stdout.toString("utf8"), postReply, "below the threshold: unchanged");
  assert.equal(channel(log, "reminder").length, 0, "below the threshold: no log line");

  appendFileSync(transcript, assistant(100, 38000, 1900) + "\n"); // exactly 40000
  r = await post(postReply, "Edit");
  assert.equal(ctxOf(r), "indexed.\n" + REMIND_TEXT);
  let lines = channel(log, "reminder");
  assert.deepEqual(lines.map(strip), [{ t: 0, channel: "reminder", event: "PostToolUse", fired: true, estimate: 40000, threshold: 40000, tool: "Edit", bytes: Buffer.byteLength(REMIND_TEXT) }]);
  assert.equal(JSON.parse(readFileSync(path.join(data, T.REMIND_MARKER), "utf8")).fired, true);

  appendFileSync(transcript, assistant(100, 45000, 0) + "\n");
  r = await post("");
  assert.equal(r.stdout.length, 0, "at most one time between two compactions");
  assert.equal(channel(log, "reminder").length, 1);

  // the compaction arms it again; the usage records before the compaction cannot fire it
  await pause(20);
  const ss = await shim("SessionStart", ssReply, env, { source: "compact" });
  assert.equal(ss.stdout.toString("utf8"), ssReply, "arm T does not change SessionStart");
  r = await post();
  assert.equal(r.stdout.toString("utf8"), postReply, "not in the same turn as the compaction");
  await pause(20);
  appendFileSync(transcript, userLine("summary") + "\n" + assistant(50, 8000, 4000) + "\n");
  r = await post();
  assert.equal(r.stdout.toString("utf8"), postReply, "small context after the compaction");
  appendFileSync(transcript, assistant(50, 52000, 100) + "\n");
  r = await post("");
  assert.deepEqual(JSON.parse(r.stdout.toString("utf8")), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: REMIND_TEXT } });
  lines = channel(log, "reminder");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].estimate, 52150);
  assert.ok(!readFileSync(log, "utf8").includes("clock-state"), "log holds no text");
});

test("arm T: a missing transcript logs a reason; failures keep the product reply and log an error", async () => {
  const log = path.join(dir, "remind-fail.jsonl");
  const data = path.join(dir, "remind-fail-data");
  mkdirSync(data, { recursive: true });
  const transcript = path.join(dir, "remind-fail-transcript.jsonl");
  writeFileSync(transcript, assistant(0, 60000, 0) + "\n");
  const base = { CCB_REMIND_FILE: REMIND, CCB_REMIND_THRESHOLD: "40000", CCB_DATA_DIR: data, CCB_SHIM_LOG: log };
  const post = (extra, pl = { transcript_path: transcript }, out = postReply) => shim("PostToolUse", out, { ...base, ...extra }, { tool_name: "Bash", ...pl });

  let r = await post({}, { transcript_path: path.join(dir, "gone.jsonl") });
  assert.equal(r.stdout.toString("utf8"), postReply);
  const noData = { ...base };
  delete noData.CCB_DATA_DIR;
  for (const env of [noData, { ...base, CCB_REMIND_THRESHOLD: "40k" }, { ...base, CCB_REMIND_FILE: path.join(dir, "no-remind.txt") }]) {
    r = await shim("PostToolUse", postReply, env, { tool_name: "Bash", transcript_path: transcript });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), postReply);
  }
  // a plain text product reply cannot carry context: no reminder, an error line
  r = await post({}, undefined, "plain output");
  assert.equal(r.stdout.toString("utf8"), "plain output");
  // a failed product hook: no reminder and the marker stays armed
  r = await post({ FAKE_HOOK_EXIT: "2" });
  assert.equal(r.code, 2);
  assert.equal(r.stdout.toString("utf8"), postReply);
  const lines = channel(log, "reminder");
  assert.deepEqual(lines.map((l) => [l.fired, l.reason ?? null, typeof l.error]), [
    [false, "transcript missing", "undefined"],
    [false, null, "string"],
    [false, null, "string"],
    [false, null, "string"],
    [false, null, "string"],
    [false, "hook exit", "undefined"],
  ]);
  assert.ok(!existsSync(path.join(data, T.REMIND_MARKER)), "no marker after a failure");
  // it still fires afterwards
  r = await post({});
  assert.equal(ctxOf(r), "indexed.\n" + REMIND_TEXT);
});

test("arm T: a failed rearm at the compaction logs an error and keeps the SessionStart reply", async () => {
  const log = path.join(dir, "rearm-fail.jsonl");
  const r = await shim("SessionStart", ssReply, { CCB_REMIND_FILE: REMIND, CCB_REMIND_THRESHOLD: "40000", CCB_DATA_DIR: path.join(dir, "no-such-dir"), CCB_SHIM_LOG: log }, { source: "compact" });
  assert.equal(r.stdout.toString("utf8"), ssReply);
  const [l] = channel(log, "reminder");
  assert.equal(l.event, "SessionStart");
  assert.equal(typeof l.error, "string");
});

// ---------- arm P ----------

test("arm P: the PreCompact entry with no product hook prints the instruction and exits 0", async () => {
  const log = path.join(dir, "precompact.jsonl");
  const r = await shim("PreCompact", "", { CCB_PRECOMPACT_FILE: PRECOMPACT, CCB_SHIM_LOG: log }, { trigger: "manual", custom_instructions: "" }, { real: false });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString("utf8"), PRECOMPACT_TEXT);
  assert.deepEqual(channel(log, "precompact").map(strip), [{ t: 0, channel: "precompact", event: "PreCompact", trigger: "manual", delivered: true, bytes: Buffer.byteLength(PRECOMPACT_TEXT) }]);
  assert.ok(!readFileSync(log, "utf8").includes("tracked item"), "log holds no text");
});

test("arm P: a product PreCompact output comes first; a failed product hook keeps its output and exit code", async () => {
  const log = path.join(dir, "precompact-product.jsonl");
  const env = { CCB_PRECOMPACT_FILE: PRECOMPACT, CCB_SHIM_LOG: log };
  let r = await shim("PreCompact", "product instructions\n", env, { trigger: "auto" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString("utf8"), "product instructions\n" + PRECOMPACT_TEXT);
  r = await shim("PreCompact", "blocked", { ...env, FAKE_HOOK_EXIT: "2" }, { trigger: "auto" });
  assert.equal(r.code, 2);
  assert.equal(r.stdout.toString("utf8"), "blocked");
  r = await shim("PreCompact", "product instructions\n", { ...env, CCB_PRECOMPACT_FILE: path.join(dir, "no-pc.txt") }, { trigger: "manual" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString("utf8"), "product instructions\n");
  const lines = channel(log, "precompact");
  assert.deepEqual(lines.map((l) => [l.trigger, l.delivered, l.hookExit ?? null, typeof l.error]), [
    ["auto", true, null, "undefined"],
    ["auto", false, 2, "undefined"],
    ["manual", false, null, "string"],
  ]);
  // no effect on other events
  const ss = await shim("SessionStart", ssReply, env, { source: "compact" });
  assert.equal(ss.stdout.toString("utf8"), ssReply);
});

test("readTriggerText refuses a text file over the byte limit", () => {
  const big = writeScript(dir, "big.txt", "a".repeat(T.TEXT_FILE_MAX_BYTES + 1));
  assert.throws(() => T.readTriggerText(big, "X"), /longer than/);
  assert.equal(T.readTriggerText(STANDING, "X"), STANDING_TEXT);
});
