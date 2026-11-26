// Context Clock v0.3 (docs/context-clock/v0.3-design.md, "Acceptance with the benchmark", runner mode M): the product
// manifest has its own PreCompact entry. rewriteHooks runs it through the shim once and adds no second entry; a
// manifest without one still gets the shim entry of the overlay. The shim logs one "precompact_product" line for each
// PreCompact call of the product hook: trigger, bytes of the product stdout, sha256 of the trimmed stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rewriteHooks } from "../../runner/overlay/build.mjs";
import { OVERLAY_DIR, tempDir, writeScript } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
const SHIMMED = 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs" "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
const SHIM_ONLY = 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs"';
const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const TEXT_FILE = path.resolve(OVERLAY_DIR, "..", "..", "configs", "precompact-general-instruction.txt");
const dir = tempDir("ccb-product-precompact-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const VARS = ["CCB_STANDING_FILE", "CCB_REMIND_FILE", "CCB_REMIND_THRESHOLD", "CCB_PRECOMPACT_FILE", "CCB_PERIODIC_FILE", "CCB_PERIODIC_EVERY", "CCB_PERIODIC_OFFSET",
  "CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"];
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function envFor(stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, ...extra };
  for (const k of VARS) if (!(k in extra)) delete env[k];
  return env;
}
const input = (event, trigger) => JSON.stringify({ hook_event_name: event, session_id: "s1", ...(trigger === undefined ? {} : { trigger }), custom_instructions: null });
const lines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const commandsOf = (entries) => (entries ?? []).flatMap((e) => (e?.hooks ?? []).map((h) => h.command));

test("rewriteHooks: a product PreCompact entry runs through the shim once, with no second entry", () => {
  const product = { hooks: { PostToolUse: [{ matcher: "^(Bash)$", hooks: [{ type: "command", command: CMD }] }], PreCompact: [{ hooks: [{ type: "command", command: CMD }] }] } };
  const once = rewriteHooks(product);
  assert.deepEqual(commandsOf(once.hooks.PreCompact), [SHIMMED]);
  assert.equal(once.hooks.PreCompact.length, 1);
  const twice = rewriteHooks(once);
  assert.deepEqual(commandsOf(twice.hooks.PreCompact), [SHIMMED], "idempotent");
  assert.deepEqual(commandsOf(product.hooks.PreCompact), [CMD], "the input stays unchanged");
});

test("rewriteHooks: a manifest without a PreCompact entry still gets the overlay entry (shim with no product hook)", () => {
  const out = rewriteHooks({ hooks: { PostToolUse: [{ matcher: "^(Bash)$", hooks: [{ type: "command", command: CMD }] }] } });
  assert.deepEqual(commandsOf(out.hooks.PreCompact), [SHIM_ONLY]);
  assert.deepEqual(commandsOf(rewriteHooks(out).hooks.PreCompact), [SHIM_ONLY]);
});

test("hook shim: one precompact_product line per PreCompact call of the product hook, with bytes and sha256", async () => {
  const text = readFileSync(TEXT_FILE, "utf8");
  const log = path.join(dir, "product.jsonl");
  for (const trigger of ["manual", "auto"]) {
    const r = await run([SHIM, HOOK], { env: envFor(text, { CCB_SHIM_LOG: log }), pieces: [input("PreCompact", trigger)] });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), text, "the product stdout passes unchanged");
  }
  assert.deepEqual(lines(log).map((l) => ({ ...l, t: 0 })), ["manual", "auto"].map((trigger) => ({
    t: 0, channel: "precompact_product", event: "PreCompact", trigger, bytes: Buffer.byteLength(text), sha256: sha(text.trim()), exitCode: 0,
  })));
});

test("hook shim: an empty product stdout (modes B and R) is logged with 0 bytes and no sha256", async () => {
  const log = path.join(dir, "empty.jsonl");
  const r = await run([SHIM, HOOK], { env: envFor("", { CCB_SHIM_LOG: log }), pieces: [input("PreCompact", "manual")] });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 0);
  assert.deepEqual(lines(log).map((l) => ({ ...l, t: 0 })), [{ t: 0, channel: "precompact_product", event: "PreCompact", trigger: "manual", bytes: 0, sha256: null, exitCode: 0 }]);
});

test("hook shim: with the overlay text (mode R) the product line has 0 bytes and the overlay line records the overlay text", async () => {
  const log = path.join(dir, "mode-r.jsonl");
  const r = await run([SHIM, HOOK], { env: envFor("", { CCB_SHIM_LOG: log, CCB_PRECOMPACT_FILE: TEXT_FILE }), pieces: [input("PreCompact", "auto")] });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.toString("utf8"), readFileSync(TEXT_FILE, "utf8").replace(/\s+$/, ""));
  assert.deepEqual(lines(log).map((l) => [l.channel, l.bytes]), [["precompact_product", 0], ["precompact", Buffer.byteLength(readFileSync(TEXT_FILE, "utf8").replace(/\s+$/, ""))]]);
});

test("hook shim: no product line without a product hook, or for another event", async () => {
  const log = path.join(dir, "none.jsonl");
  await run([SHIM], { env: envFor("", { CCB_SHIM_LOG: log }), pieces: [input("PreCompact", "manual")] });
  await run([SHIM, HOOK], { env: envFor("x", { CCB_SHIM_LOG: log }), pieces: [input("Stop")] });
  assert.deepEqual(lines(log).filter((l) => l.channel === "precompact_product"), []);
});
