// v0.8 periodic reminder (EXPERIMENT-V08.md, arm U) in the UserPromptSubmit path of the hook shim, and the PreCompact
// text of arm Q (configs/precompact-strong-instruction.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, tempDir, writeScript } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const T = await import(pathToFileURL(path.join(OVERLAY_DIR, "triggers.mjs")).href);
const B = await import(pathToFileURL(path.join(OVERLAY_DIR, "build.mjs")).href);
const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const CONFIGS = path.resolve(OVERLAY_DIR, "..", "..", "configs");
const dir = tempDir("ccb-periodic-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const ARGS = ["--agent", "claude-code"];
const VARS = ["CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PRECOMPACT_FILE", "CCB_PERIODIC_FILE", "CCB_PERIODIC_EVERY", "CCB_PERIODIC_OFFSET",
  "CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"];

const REMIND_TEXT = "Write the tracked state to clock-state.md now, with one Write call.";
const REMIND = writeScript(dir, "periodic.txt", REMIND_TEXT + "\n");
const upsReply = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "product note" } });

function envFor(stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", ...extra };
  for (const k of VARS) if (!(k in extra)) delete env[k];
  return env;
}
const payload = (event, extra = {}) => JSON.stringify({ hook_event_name: event, session_id: "s1", ...extra });
const prompt = (stdout, extra, text = "stage message") => run([SHIM, HOOK, ...ARGS], { env: envFor(stdout, extra), pieces: [payload("UserPromptSubmit", { prompt: text })] });
const logOf = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const periodic = (log) => logOf(log).filter((l) => l.channel === "periodic");
const ctxOf = (r) => JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
const freshData = (name) => {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  return d;
};

test("periodicFires and periodOf: count, period and offset", () => {
  const fired = (every, offset) => Array.from({ length: 10 }, (_, i) => i + 1).filter((n) => T.periodicFires(n, { every, offset }));
  assert.deepEqual(fired(2, 0), [2, 4, 6, 8, 10]);
  assert.deepEqual(fired(2, 1), [3, 5, 7, 9]);
  assert.deepEqual(fired(3, 0), [3, 6, 9]);
  assert.deepEqual(fired(1, 0), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(fired(2, 4), [6, 8, 10]);
  assert.deepEqual(T.periodOf({}), { every: 2, offset: 0 });
  assert.deepEqual(T.periodOf({ CCB_PERIODIC_EVERY: " 3 ", CCB_PERIODIC_OFFSET: "1" }), { every: 3, offset: 1 });
  for (const bad of [{ CCB_PERIODIC_EVERY: "0" }, { CCB_PERIODIC_EVERY: "2.5" }, { CCB_PERIODIC_EVERY: "x" }, { CCB_PERIODIC_OFFSET: "-1" }]) {
    assert.throws(() => T.periodOf(bad), /integer/, JSON.stringify(bad));
  }
  assert.equal(T.commandOf("/compact keep the values"), "compact");
  assert.equal(T.commandOf("  /clear"), "clear");
  assert.equal(T.commandOf("stage 3: deploy /opt/x"), null);
  assert.equal(T.commandOf(undefined), null);
});

test("arm U: every prompt counts; the reminder goes with prompts 2, 4, 6 and 8 by default", async () => {
  const log = path.join(dir, "default.jsonl");
  const data = freshData("default-data");
  const env = { CCB_PERIODIC_FILE: REMIND, CCB_DATA_DIR: data, CCB_SHIM_LOG: log };
  const outs = [];
  for (let n = 1; n <= 8; n++) outs.push(await prompt(upsReply, env, `stage ${n}`));
  outs.forEach((r, i) => {
    assert.equal(r.code, 0);
    const n = i + 1;
    if (n % 2 === 0) assert.equal(ctxOf(r), "product note\n" + REMIND_TEXT, `prompt ${n}`);
    else assert.equal(r.stdout.toString("utf8"), upsReply, `prompt ${n}`);
  });
  const lines = periodic(log);
  assert.deepEqual(lines.map((l) => ({ ...l, t: 0 })), Array.from({ length: 8 }, (_, i) => ({
    t: 0, channel: "periodic", event: "UserPromptSubmit", n: i + 1, fired: (i + 1) % 2 === 0, bytes: (i + 1) % 2 === 0 ? Buffer.byteLength(REMIND_TEXT) : 0,
  })));
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, T.PERIODIC_COUNTER), "utf8")), { n: 8 });
  assert.ok(!readFileSync(log, "utf8").includes("clock-state") && !readFileSync(log, "utf8").includes("stage"), "log holds no text");
});

test("arm U: period and offset; a slash command counts and the log names it", async () => {
  const log = path.join(dir, "offset.jsonl");
  const env = { CCB_PERIODIC_FILE: REMIND, CCB_PERIODIC_EVERY: "3", CCB_PERIODIC_OFFSET: "1", CCB_DATA_DIR: freshData("offset-data"), CCB_SHIM_LOG: log };
  const texts = ["stage 1", "stage 2", "/compact keep values", "stage 3", "stage 4", "stage 5", "stage 6", "stage 7"];
  for (const t of texts) await prompt("", env, t);
  const lines = periodic(log);
  assert.deepEqual(lines.map((l) => [l.n, l.fired, l.command ?? null]), [
    [1, false, null], [2, false, null], [3, false, "compact"], [4, true, null], [5, false, null], [6, false, null], [7, true, null], [8, false, null],
  ]);
});

test("arm U: empty and plain text product replies get the text", async () => {
  const env = { CCB_PERIODIC_FILE: REMIND, CCB_PERIODIC_EVERY: "1", CCB_DATA_DIR: freshData("plain-data") };
  const empty = await prompt("", env);
  assert.deepEqual(JSON.parse(empty.stdout.toString("utf8")), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: REMIND_TEXT } });
  const plain = await prompt("plain product text\n", env);
  assert.equal(plain.stdout.toString("utf8"), "plain product text\n" + REMIND_TEXT);
});

test("arm U: a missing file, a bad period or no data folder keeps the product reply and logs an error", async () => {
  const log = path.join(dir, "fail.jsonl");
  const data = freshData("fail-data");
  const cases = [
    { CCB_PERIODIC_FILE: path.join(dir, "no-such.txt"), CCB_PERIODIC_EVERY: "1", CCB_DATA_DIR: data },
    { CCB_PERIODIC_FILE: dir, CCB_PERIODIC_EVERY: "1", CCB_DATA_DIR: data },
    { CCB_PERIODIC_FILE: REMIND, CCB_PERIODIC_EVERY: "0", CCB_DATA_DIR: data },
    { CCB_PERIODIC_FILE: REMIND, CCB_PERIODIC_EVERY: "1" },
  ];
  for (const extra of cases) {
    const r = await prompt(upsReply, { ...extra, CCB_SHIM_LOG: log });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), upsReply);
  }
  const lines = periodic(log);
  assert.deepEqual(lines.map((l) => [l.n, l.fired, typeof l.error]), [[1, false, "string"], [2, false, "string"], [3, false, "string"], [null, false, "string"]]);
  // a missing file on a prompt that does not fire is no error
  const quiet = path.join(dir, "quiet.jsonl");
  const r = await prompt(upsReply, { CCB_PERIODIC_FILE: path.join(dir, "no-such.txt"), CCB_DATA_DIR: freshData("quiet-data"), CCB_SHIM_LOG: quiet });
  assert.equal(r.stdout.toString("utf8"), upsReply);
  assert.deepEqual(periodic(quiet).map((l) => [l.n, l.fired, l.error]), [[1, false, undefined]]);
});

test("arm U: a failed product hook still counts, adds nothing and keeps its exit code", async () => {
  const log = path.join(dir, "exit.jsonl");
  const env = { CCB_PERIODIC_FILE: REMIND, CCB_DATA_DIR: freshData("exit-data"), CCB_SHIM_LOG: log };
  await prompt(upsReply, env);
  const r = await prompt("blocked", { ...env, FAKE_HOOK_EXIT: "2" });
  assert.equal(r.code, 2);
  assert.equal(r.stdout.toString("utf8"), "blocked");
  const third = await prompt(upsReply, env);
  assert.equal(third.stdout.toString("utf8"), upsReply, "prompt 3 does not fire");
  assert.deepEqual(periodic(log).map((l) => [l.n, l.fired, l.hookExit ?? null]), [[1, false, null], [2, false, 2], [3, false, null]]);
});

test("without CCB_PERIODIC_FILE the UserPromptSubmit reply is byte-equal and nothing is counted", async () => {
  const log = path.join(dir, "none.jsonl");
  const data = freshData("none-data");
  for (const out of [upsReply, "", "plain\n"]) {
    for (const exit of ["0", "2"]) {
      const extra = { CCB_PERIODIC_EVERY: "1", CCB_PERIODIC_OFFSET: "0", CCB_DATA_DIR: data, FAKE_HOOK_EXIT: exit };
      const d = await run([HOOK, ...ARGS], { env: envFor(out, extra), pieces: [payload("UserPromptSubmit", { prompt: "x" })] });
      const s = await run([SHIM, HOOK, ...ARGS], { env: envFor(out, { ...extra, CCB_SHIM_LOG: log }), pieces: [payload("UserPromptSubmit", { prompt: "x" })] });
      assert.ok(s.stdout.equals(d.stdout));
      assert.equal(s.stderr, d.stderr);
      assert.equal(s.code, d.code);
    }
  }
  assert.deepEqual(logOf(log), []);
  assert.ok(!existsSync(path.join(data, T.PERIODIC_COUNTER)));
});

test("build: the installed hook layout keeps its UserPromptSubmit entry; a plugin with none gets a shim entry", () => {
  const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
  const SHIM_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs"';
  const entry = { hooks: [{ command: CMD, timeout: 5, type: "command" }] };
  const withUps = B.rewriteHooks({ hooks: { PreToolUse: [structuredClone(entry)], UserPromptSubmit: [structuredClone(entry)] } }).hooks;
  assert.equal(withUps.UserPromptSubmit.length, 1);
  assert.equal(withUps.UserPromptSubmit[0].hooks[0].command, `${SHIM_CMD} "\${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code`);
  const without = B.rewriteHooks({ hooks: { PreToolUse: [structuredClone(entry)] } });
  assert.deepEqual(without.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: SHIM_CMD, timeout: 5 }] }]);
  assert.deepEqual(B.rewriteHooks(without), without, "idempotent");
});

// ---------- arm Q: PreCompact text up to 10 000 characters ----------

test("arm Q: configs/precompact-strong-instruction.txt goes out whole through the PreCompact entry", async () => {
  const file = path.join(CONFIGS, "precompact-strong-instruction.txt");
  const text = readFileSync(file, "utf8").replace(/\s+$/, "");
  assert.ok(text.length > 0 && text.length <= T.TEXT_MAX_CHARS);
  const log = path.join(dir, "q.jsonl");
  const r = await run([SHIM], { env: envFor("", { CCB_PRECOMPACT_FILE: file, CCB_SHIM_LOG: log }), pieces: [payload("PreCompact", { trigger: "manual", custom_instructions: null })] });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString("utf8"), text);
  const [l] = logOf(log);
  assert.deepEqual({ ...l, t: 0 }, { t: 0, channel: "precompact", event: "PreCompact", trigger: "manual", delivered: true, bytes: Buffer.byteLength(text) });
});

test("arm Q: a text of exactly 10 000 characters passes; one more character is refused and the product output stays", async () => {
  const exact = "ü".repeat(4000) + "a".repeat(5998) + "\n" + "z"; // 10 000 characters, more bytes
  assert.equal(exact.length, 10000);
  const f1 = writeScript(dir, "pc-10000.txt", exact + "\n");
  const f2 = writeScript(dir, "pc-10001.txt", exact + "z\n");
  const log = path.join(dir, "q-limit.jsonl");
  const ok = await run([SHIM, HOOK, ...ARGS], { env: envFor("product\n", { CCB_PRECOMPACT_FILE: f1, CCB_SHIM_LOG: log }), pieces: [payload("PreCompact", { trigger: "manual" })] });
  assert.equal(ok.stdout.toString("utf8"), "product\n" + exact);
  const over = await run([SHIM, HOOK, ...ARGS], { env: envFor("product\n", { CCB_PRECOMPACT_FILE: f2, CCB_SHIM_LOG: log }), pieces: [payload("PreCompact", { trigger: "manual" })] });
  assert.equal(over.code, 0);
  assert.equal(over.stdout.toString("utf8"), "product\n");
  // Context Clock v0.3: the shim also logs one precompact_product line for each call of the product hook.
  const lines = logOf(log).filter((l) => l.channel !== "precompact_product");
  assert.deepEqual(logOf(log).filter((l) => l.channel === "precompact_product").map((l) => l.bytes), [8, 8]);
  assert.deepEqual(lines.map((l) => [l.delivered, typeof l.error]), [[true, "undefined"], [false, "string"]]);
  assert.match(lines[1].error, /10000 characters/);
});
