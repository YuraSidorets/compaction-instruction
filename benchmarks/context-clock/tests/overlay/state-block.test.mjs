import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { OVERLAY_DIR, FULL_BLOCK, tempDir, writeScript, bytesOf } from "./helpers.mjs";
import { FAKE_HOOK, run } from "./fakes.mjs";

const S = await import(pathToFileURL(path.join(OVERLAY_DIR, "state-block.mjs")).href);
const SHIM = path.join(OVERLAY_DIR, "hook-shim.mjs");
const dir = tempDir("ccb-state-");
const HOOK = writeScript(dir, "fake-hook.mjs", FAKE_HOOK);
const ARGS = ["--agent", "claude-code"];

// The product table, as in src/core/clock/store/schema.ts.
const TABLE = `CREATE TABLE IF NOT EXISTS clock_state_revisions (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
  summary TEXT NOT NULL, findings_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id, revision)) WITHOUT ROWID;`;

/** A data folder with one context.db per project key. rows: [key, session, agent, revision, summary, findings, createdAt]. */
function dataDir(rows, { noClock = [] } = {}) {
  const d = tempDir("ccb-data-");
  const byKey = new Map();
  for (const r of rows) byKey.set(r[0], [...(byKey.get(r[0]) ?? []), r]);
  for (const key of [...byKey.keys(), ...noClock]) {
    mkdirSync(path.join(d, "projects", key), { recursive: true });
    const db = new DatabaseSync(path.join(d, "projects", key, "context.db"));
    if (noClock.includes(key)) db.exec("CREATE TABLE other (x INTEGER)");
    else {
      db.exec(TABLE);
      const ins = db.prepare("INSERT INTO clock_state_revisions VALUES (?, ?, ?, ?, ?, ?)");
      for (const [, s, a, rev, sum, f, t] of byKey.get(key)) ins.run(s, a, rev, sum, JSON.stringify(f.map((text) => ({ text, evidenceEventIds: ["e1"] }))), t);
    }
    db.close();
  }
  return d;
}

const lineOk = (text) => {
  const lines = text.split("\n");
  assert.equal(lines[0], S.STATE_OPEN);
  assert.equal(lines.at(-1), S.STATE_CLOSE);
  return lines.slice(1, -1);
};

// ---------- pure parts ----------

test("formatStateBlock: summary and labeled findings inside the tags", () => {
  const b = S.formatStateBlock({ summary: "Deploy is on step 3.\nCanary is green.", findings: [{ text: "region eu-1 rolled back" }, { text: "owner: ops-7" }] });
  assert.deepEqual(lineOk(b.text), [
    "summary: Deploy is on step 3. Canary is green.",
    "finding 1 (reported claim, not verified): region eu-1 rolled back",
    "finding 2 (reported claim, not verified): owner: ops-7",
  ]);
  assert.equal(b.bytes, bytesOf(b.text));
  assert.equal(b.findings, 2);
  assert.equal(b.cut, false);
  assert.equal(S.STATE_BLOCK_MAX_BYTES, 2000);
  assert.equal(S.formatStateBlock({ summary: "", findings: [] }).text, S.STATE_OPEN + "\n" + S.STATE_CLOSE);
});

test("formatStateBlock: cut at a line end inside 2000 bytes, tags included", () => {
  const findings = Array.from({ length: 60 }, (_, i) => ({ text: `value ${i} ` + "ü".repeat(20) }));
  const b = S.formatStateBlock({ summary: "s", findings });
  assert.equal(b.cut, true);
  assert.ok(b.bytes <= 2000 && b.bytes === bytesOf(b.text));
  const body = lineOk(b.text);
  assert.equal(body.length, b.findings + 1);
  body.slice(1).forEach((l, i) => assert.equal(l, `finding ${i + 1} (reported claim, not verified): value ${i} ` + "ü".repeat(20)));
  // one more finding line would not fit
  const next = bytesOf(`finding ${b.findings + 1} (reported claim, not verified): value ${b.findings} ` + "ü".repeat(20)) + 1;
  assert.ok(b.bytes + next > 2000);
  // exactly at the limit is not a cut
  const exact = S.wrapStateText("x".repeat(2000 - bytesOf(S.STATE_OPEN) - bytesOf(S.STATE_CLOSE) - 2));
  assert.equal(exact.bytes, 2000);
  assert.equal(exact.cut, false);
});

test("a single line over the limit is cut at a code point, never past 2000 bytes", () => {
  const b = S.formatStateBlock({ summary: "€".repeat(1000), findings: [{ text: "lost" }] });
  assert.equal(b.cut, true);
  assert.ok(b.bytes <= 2000);
  assert.equal(b.findings, 0);
  assert.ok(!b.text.includes("�"));
  assert.match(lineOk(b.text)[0], /^summary: €+$/);
});

test("wrapStateText: same tags and limit, CRLF and blank edges handled", () => {
  const w = S.wrapStateText("\r\nstage: 2\r\nowner: ops-7\r\n\r\n");
  assert.equal(w.text, "[committed-state]\nstage: 2\nowner: ops-7\n[/committed-state]");
  assert.equal(w.cut, false);
  const big = S.wrapStateText(Array.from({ length: 200 }, (_, i) => `name${i}: value${i}`).join("\n"));
  assert.equal(big.cut, true);
  assert.ok(big.bytes <= 2000);
  assert.ok(big.text.endsWith("\n[/committed-state]"));
});

// ---------- database ----------

test("readCommittedState: latest commit of agent main over every context.db, read-only", () => {
  const d = dataDir([
    ["p1", "s1", "main", 1, "old", ["a"], 100],
    ["p1", "s1", "main", 2, "middle", ["b"], 200],
    ["p1", "s1", "sub-1", 9, "subagent", ["x"], 900],
    ["p2", "s2", "main", 1, "newest", ["c", "d"], 300],
  ], { noClock: ["p3"] });
  const before = readFileSync(path.join(d, "projects", "p1", "context.db"));
  assert.deepEqual(S.readCommittedState(d), { revision: 1, summary: "newest", findings: [{ text: "c" }, { text: "d" }] });
  assert.ok(readFileSync(path.join(d, "projects", "p1", "context.db")).equals(before), "database unchanged");
  assert.equal(S.readCommittedState(dataDir([], { noClock: ["p1"] })), null);
  assert.equal(S.readCommittedState(tempDir("ccb-empty-")), null);
  assert.equal(S.readCommittedState(dataDir([["p1", "s1", "sub-1", 1, "x", [], 1]])), null);
});

test("readCommittedState throws on an unreadable database", () => {
  const d = tempDir("ccb-bad-");
  mkdirSync(path.join(d, "projects", "p1"), { recursive: true });
  writeFileSync(path.join(d, "projects", "p1", "context.db"), "this is not a database ".repeat(100));
  assert.throws(() => S.readCommittedState(d));
  assert.throws(() => S.readCommittedState(""));
});

// ---------- hook shim ----------

const ssPayload = (source) => JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", source });
const PRODUCT = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "product rules\n" + FULL_BLOCK } });

function envFor(stdout, extra = {}) {
  const env = { ...process.env, FAKE_HOOK_STDOUT: stdout, CTX_CLOCK: "1", CTX_CLOCK_FEEDBACK: "off", ...extra };
  for (const k of ["CCB_FEEDBACK", "CCB_RETURN_STATE", "CCB_STATE_FILE", "CCB_DATA_DIR", "CCB_SHIM_LOG"]) if (!(k in extra)) delete env[k];
  return env;
}
const stateLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.channel === "state_block") : []);
const shim = (stdout, extra, source = "compact") => run([SHIM, HOOK, ...ARGS], { env: envFor(stdout, extra), pieces: [ssPayload(source)] });

const COMMITTED = dataDir([["p1", "s1", "main", 1, "Deploy on step 3", ["eu-1 rolled back", "owner ops-7"], 100]]);

test("arm committed: block appended after the product text; log has no text", async () => {
  const log = path.join(dir, "committed.jsonl");
  const r = await shim(PRODUCT, { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: COMMITTED, CCB_SHIM_LOG: log });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
  const block = S.formatStateBlock({ summary: "Deploy on step 3", findings: [{ text: "eu-1 rolled back" }, { text: "owner ops-7" }] });
  assert.equal(ctx, "product rules\n" + FULL_BLOCK + "\n" + block.text);
  const [l] = stateLines(log);
  assert.deepEqual(Object.keys(l).sort(), ["arm", "bytes", "channel", "cut", "delivered", "event", "findings", "t"]);
  assert.deepEqual({ ...l, t: 0 }, { t: 0, channel: "state_block", event: "SessionStart", arm: "committed", delivered: true, bytes: block.bytes, findings: 2, cut: false });
  const text = readFileSync(log, "utf8");
  assert.ok(!text.includes("Deploy") && !text.includes("ops-7") && !text.includes("committed-state"));
});

test("reply shapes: no additionalContext, empty reply, plain text reply", async () => {
  const env = { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: COMMITTED };
  const block = S.formatStateBlock({ summary: "Deploy on step 3", findings: [{ text: "eu-1 rolled back" }, { text: "owner ops-7" }] }).text;
  const a = JSON.parse((await shim(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart" }, suppressOutput: true }), env)).stdout.toString("utf8"));
  assert.deepEqual(a, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block }, suppressOutput: true });
  const b = JSON.parse((await shim("", env)).stdout.toString("utf8"));
  assert.deepEqual(b, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } });
  const c = JSON.parse((await shim("{}", env)).stdout.toString("utf8"));
  assert.deepEqual(c, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } });
  const d = (await shim("plain product text\n", env)).stdout.toString("utf8");
  assert.equal(d, "plain product text\n" + block);
});

test("arm committed with no commit: nothing appended, delivered false", async () => {
  const log = path.join(dir, "nostate.jsonl");
  const r = await shim(PRODUCT, { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: dataDir([], { noClock: ["p1"] }), CCB_SHIM_LOG: log });
  assert.equal(r.stdout.toString("utf8"), PRODUCT);
  const [l] = stateLines(log);
  assert.equal(l.delivered, false);
  assert.equal(l.bytes, 0);
  assert.equal(l.error, undefined);
});

test("arm reference: file text in the same tags; missing or empty file appends nothing", async () => {
  const log = path.join(dir, "reference.jsonl");
  const file = path.join(dir, "reference-state.txt");
  writeFileSync(file, "stage: 2\nowner: ops-7\n");
  const r = await shim(PRODUCT, { CCB_RETURN_STATE: "reference", CCB_STATE_FILE: file, CCB_SHIM_LOG: log });
  const ctx = JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
  assert.ok(ctx.endsWith("\n[committed-state]\nstage: 2\nowner: ops-7\n[/committed-state]"));
  assert.ok(ctx.startsWith("product rules\n"));
  const empty = path.join(dir, "empty-state.txt");
  writeFileSync(empty, "\n  \n");
  for (const f of [path.join(dir, "missing.txt"), empty]) {
    const r2 = await shim(PRODUCT, { CCB_RETURN_STATE: "reference", CCB_STATE_FILE: f, CCB_SHIM_LOG: log });
    assert.equal(r2.stdout.toString("utf8"), PRODUCT);
  }
  const lines = stateLines(log);
  assert.deepEqual(lines.map((l) => [l.arm, l.delivered, l.findings, l.error]), [["reference", true, 0, undefined], ["reference", false, 0, undefined], ["reference", false, 0, undefined]]);
  assert.ok(!readFileSync(log, "utf8").includes("ops-7"));
});

test("CCB_RETURN_STATE unset: output byte-identical to the product hook, no state_block line", async () => {
  const log = path.join(dir, "unset.jsonl");
  for (const out of [PRODUCT, "", "plain\n", "{}"]) {
    for (const extra of [{}, { CCB_FEEDBACK: "placebo" }, { CCB_DATA_DIR: COMMITTED, CCB_STATE_FILE: path.join(dir, "reference-state.txt") }]) {
      const direct = await run([HOOK, ...ARGS], { env: envFor(out, extra), pieces: [ssPayload("compact")] });
      const r = await shim(out, { ...extra, CCB_SHIM_LOG: log });
      assert.ok(r.stdout.equals(direct.stdout));
      assert.equal(r.stderr, direct.stderr);
      assert.equal(r.code, direct.code);
    }
  }
  assert.deepEqual(stateLines(log), []);
});

test("a SessionStart that is not a compaction stays unchanged in both arms", async () => {
  const log = path.join(dir, "startup.jsonl");
  for (const source of ["startup", "resume", "clear", null]) {
    for (const arm of ["committed", "reference"]) {
      const r = await shim(PRODUCT, { CCB_RETURN_STATE: arm, CCB_DATA_DIR: COMMITTED, CCB_STATE_FILE: path.join(dir, "reference-state.txt"), CCB_SHIM_LOG: log }, source);
      assert.equal(r.stdout.toString("utf8"), PRODUCT);
    }
  }
  assert.deepEqual(stateLines(log), []);
  const other = await shim(PRODUCT, { CCB_RETURN_STATE: "other", CCB_DATA_DIR: COMMITTED });
  assert.equal(other.stdout.toString("utf8"), PRODUCT);
});

test("failure path: unreadable state sends the product reply unchanged and logs an error", async () => {
  const log = path.join(dir, "fail.jsonl");
  const bad = tempDir("ccb-bad-");
  mkdirSync(path.join(bad, "projects", "p1"), { recursive: true });
  writeFileSync(path.join(bad, "projects", "p1", "context.db"), "garbage ".repeat(200));
  const cases = [
    { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: bad },
    { CCB_RETURN_STATE: "committed" },
    { CCB_RETURN_STATE: "reference" },
  ];
  for (const extra of cases) {
    const r = await shim(PRODUCT, { ...extra, CCB_SHIM_LOG: log });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString("utf8"), PRODUCT);
  }
  const notObject = await shim("[1,2]", { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: COMMITTED, CCB_SHIM_LOG: log });
  assert.equal(notObject.stdout.toString("utf8"), "[1,2]");
  const lines = stateLines(log);
  assert.equal(lines.length, 4);
  for (const l of lines) {
    assert.equal(l.delivered, false);
    assert.ok(typeof l.error === "string" && l.error.length > 0);
  }
});

test("a failed product hook gets no block; the exit code and stderr are kept", async () => {
  const log = path.join(dir, "exit.jsonl");
  const r = await shim(PRODUCT, { CCB_RETURN_STATE: "committed", CCB_DATA_DIR: COMMITTED, CCB_SHIM_LOG: log, FAKE_HOOK_EXIT: "2" });
  assert.equal(r.code, 2);
  assert.equal(r.stdout.toString("utf8"), PRODUCT);
  assert.ok(r.stderr.includes("fake hook argv="));
  const [l] = stateLines(log);
  assert.equal(l.delivered, false);
  assert.equal(l.hookExit, 2);
});

test("v0.3 placebo still applies to PostToolUse when CCB_RETURN_STATE is set", async () => {
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: FULL_BLOCK } });
  const r = await run([SHIM, HOOK, ...ARGS], {
    env: envFor(out, { CCB_FEEDBACK: "placebo", CCB_RETURN_STATE: "committed", CCB_DATA_DIR: COMMITTED }),
    pieces: [JSON.stringify({ hook_event_name: "PostToolUse", source: "compact" })],
  });
  const ctx = JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith("[context-note]"));
  assert.ok(!ctx.includes("committed-state"));
});
