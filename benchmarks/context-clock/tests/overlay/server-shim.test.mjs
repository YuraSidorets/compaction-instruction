import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { OVERLAY_DIR, FULL_BLOCK, LINE_FORM, tempDir, writeScript, bytesOf } from "./helpers.mjs";
import { FAKE_SERVER, run, cutPieces } from "./fakes.mjs";

const SHIM = path.join(OVERLAY_DIR, "server-shim.mjs");
const dir = tempDir("ccb-server-shim-");
const SERVER = writeScript(dir, "fake-server.mjs", FAKE_SERVER);

const BIG = "x".repeat(1_500_000) + " ünïcode ✓";
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
const note = (method) => JSON.stringify({ jsonrpc: "2.0", method }) + "\n";

const INPUT = [
  rpc(1, "initialize", {}),
  note("notifications/initialized"),
  rpc(2, "tools/call", { name: "ctx_execute", arguments: { reply: "result one", feedback: FULL_BLOCK } }),
  rpc("s3", "tools/call", { name: "ctx_search", arguments: { reply: "result two", feedback: LINE_FORM } }),
  rpc(4, "tools/call", { name: "ctx_index", arguments: { reply: BIG } }),
  rpc(5, "raw", {}),
  rpc(6, "tools/list", {}),
].join("");

function envFor(mode, log, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CCB_FEEDBACK;
  if (mode === "D") env.CCB_FEEDBACK = "placebo";
  if (log) env.CCB_SHIM_LOG = log;
  return env;
}

const logLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const mode of ["B", "C"]) {
  test(`mode ${mode}: byte-transparent proxy (partial lines, large message, stderr, exit code)`, async () => {
    const log = path.join(dir, `log-${mode}.jsonl`);
    const env = envFor(mode, log, { FAKE_EXIT: "3", CTX_CLOCK: "1", ...(mode === "B" ? { CTX_CLOCK_FEEDBACK: "off" } : {}) });
    const pieces = cutPieces(INPUT, 65536).flatMap((p) => cutPieces(p, p.length > 1000 ? 65536 : 29));
    const direct = await run([SERVER], { env: envFor(mode, null, { FAKE_EXIT: "3" }), pieces });
    const shim = await run([SHIM, SERVER], { env, pieces });
    assert.equal(direct.code, 3);
    assert.equal(shim.code, 3, "exit code forwarded");
    assert.ok(shim.stdout.equals(direct.stdout), "stdout bytes are identical");
    assert.equal(shim.stderr, direct.stderr, "stderr forwarded");
    assert.ok(shim.stderr.includes("fake server: stdin closed"), "stdin close reached the server");
    const lines = logLines(log);
    assert.equal(lines.length, 3, "one log line per tools/call result");
    assert.deepEqual(lines.map((l) => l.mode), ["real", "real", "none"]);
    for (const l of lines) {
      assert.equal(l.channel, "mcp_reply");
      assert.equal(l.replaced, 0);
      assert.equal(l.originalBytes, l.deliveredBytes);
    }
    assert.equal(lines[0].originalBytes, bytesOf(FULL_BLOCK));
    const text = readFileSync(log, "utf8");
    assert.ok(!text.includes("result one") && !text.includes("context-clock") && !text.includes("xxxx"), "log holds no text");
  });
}

test("mode D: snapshots get the placebo; reply text and other messages unchanged", async () => {
  const log = path.join(dir, "log-D.jsonl");
  const pieces = cutPieces(INPUT, 65536).flatMap((p) => cutPieces(p, p.length > 1000 ? 65536 : 29));
  const shim = await run([SHIM, SERVER], { env: envFor("D", log), pieces });
  const direct = await run([SERVER], { env: envFor("D", null), pieces });
  assert.equal(shim.code, 0);
  const s = shim.stdout.toString("utf8");
  assert.ok(!s.includes("[context-clock]") && !s.includes("[/context-clock]"), "no real snapshot passes");
  const outLines = s.split("\n").filter(Boolean);
  const dirLines = direct.stdout.toString("utf8").split("\n").filter(Boolean);
  assert.equal(outLines.length, dirLines.length);
  const byId = Object.fromEntries(outLines.filter((l) => l.startsWith("{")).map((l) => [JSON.parse(l).id, JSON.parse(l)]));
  assert.equal(byId[2].result.content[0].text, "result one");
  assert.equal(bytesOf(byId[2].result.content[1].text), bytesOf(FULL_BLOCK));
  assert.ok(byId[2].result.content[1].text.startsWith("[context-note]"));
  assert.equal(bytesOf(byId.s3.result.content[1].text), bytesOf(LINE_FORM));
  assert.equal(byId[4].result.content[0].text, BIG);
  assert.ok(outLines.includes("not json at all"));
  const lines = logLines(log);
  assert.deepEqual(lines.map((l) => l.mode), ["placebo", "placebo", "none"]);
  assert.equal(lines[0].originalBytes, bytesOf(FULL_BLOCK));
  assert.equal(lines[0].deliveredBytes, bytesOf(FULL_BLOCK));
  assert.equal(lines[0].replaced, 1);
  for (const l of lines) assert.equal(l.error, undefined);
  const text = readFileSync(log, "utf8");
  assert.ok(!text.includes("result one") && !text.includes("context-note") && !text.includes("context-clock"));
});

test("mode D fails closed: unrecognized clock text never passes and is logged as error", async () => {
  const log = path.join(dir, "log-D-fail.jsonl");
  const broken = FULL_BLOCK.split("\n").slice(0, -1).join("\n"); // no close tag
  const input = [
    rpc(1, "tools/call", { name: "ctx_execute", arguments: { reply: "kept reply", feedback: broken } }),
    rpc(2, "tools/call", { name: "ctx_execute", arguments: { reply: "first block\n" + broken } }),
    rpc(3, "leak", { text: "x " + LINE_FORM }),
  ].join("");
  const shim = await run([SHIM, SERVER], { env: envFor("D", log), pieces: [input] });
  const s = shim.stdout.toString("utf8");
  assert.ok(!s.includes("context-clock"), "no clock text passes");
  const msgs = s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(msgs.length, 3, "every reply still reaches the client");
  assert.deepEqual(msgs[0].result.content, [{ type: "text", text: "kept reply" }], "feedback block dropped");
  assert.equal(msgs[1].result.content[0].text, "first block", "clock lines removed from the reply block");
  const lines = logLines(log);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(typeof l.error === "string" && l.error.length > 0);
  assert.ok(!readFileSync(log, "utf8").includes("kept reply"));
});

test("child exit while stdin is still open: the shim exits with the child code", async () => {
  const shim = await run([SHIM, SERVER], { env: envFor("C", null), pieces: [rpc(1, "initialize", {}), rpc(2, "exit", { code: 7 })], keepOpen: true });
  assert.equal(shim.code, 7);
  assert.ok(shim.stdout.toString("utf8").includes('"id":1'));
  const shimD = await run([SHIM, SERVER], { env: envFor("D", null), pieces: [rpc(1, "initialize", {}), rpc(2, "exit", { code: 5 })], keepOpen: true });
  assert.equal(shimD.code, 5);
});

test("a last server line with no newline is kept in mode D", async () => {
  const tail = writeScript(dir, "tail-server.mjs", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("partial-without-newline"));`);
  const r = await run([SHIM, tail], { env: envFor("D", null), pieces: ["x\n"] });
  assert.equal(r.stdout.toString("utf8"), "partial-without-newline");
});
