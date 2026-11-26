// Work-result tasks (plan step 2.6) with the mock host only. No model call.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildArgs, buildPersistentArgs } from "../../runner/hosts/claude.mjs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { guardDecision } from "../../runner/overlay/guard.mjs";
import { plainHooks } from "../../runner/plain.mjs";
import { validateTask } from "../../runner/plan.mjs";
import { EXIT, loadConfigs, parseArgs, runBatch } from "../../runner/run.mjs";
import { redactionPairs } from "../../runner/telemetry.mjs";
import { COLLECT_LIMIT_BYTES, collectWorkspace, workTaskProblems, workspacePathProblem, writeWorkspaceFiles } from "../../runner/worktask.mjs";
import { TASKS, cleanup, readJson, tmp } from "./helpers.mjs";

const T1 = JSON.parse(readFileSync(join(TASKS, "T1-runner-long.task.json"), "utf8"));
const T2 = JSON.parse(readFileSync(join(TASKS, "T2-runner-compaction.task.json"), "utf8"));
const FINAL_PROMPT = "All stages are complete. Write REPORT.md in the workspace root.";

function workTask() {
  return {
    ...structuredClone(T1),
    workspace: {
      files: [{ path: "src/app.js", content: "export const x = 1;\n" }, { path: "README.md", content: "# Service\n" }],
      collect: ["src", "REPORT.md", "missing.txt"],
    },
    final: { questions: [], prompt: FINAL_PROMPT },
  };
}

test("work tasks: validateTask accepts the new fields and keeps the old rules for other tasks", () => {
  assert.deepEqual(validateTask(T1), []);
  assert.deepEqual(validateTask(workTask()), []);
  // Empty questions need a final prompt.
  assert.ok(validateTask({ ...T1, final: { questions: [] } }).includes("final questions missing"));
  assert.ok(validateTask({ ...T1, final: { questions: [], prompt: " " } }).includes("final questions missing"));
  assert.ok(validateTask({ ...T1, final: {} }).includes("final questions missing"));
  for (const bad of ["../x", "/etc/passwd", "C:\\x", "\\\\host\\share\\x", ".git/config", "a/../../x", "", ".", 3]) assert.notEqual(workspacePathProblem(bad), "", String(bad));
  for (const ok of ["a.txt", "src/app.js", "src\\app.js", "./a/b.txt", ".github/ci.yml"]) assert.equal(workspacePathProblem(ok), "", ok);
  assert.deepEqual(workTaskProblems({ workspace: { files: [{ path: "../x", content: "" }, { path: "a", content: 1 }, { path: "A", content: "" }], collect: [] } }), [
    "workspace.files[0].path leaves the workspace",
    "workspace.files[1].content is not a string",
    "workspace.files[2].path is a duplicate",
    "workspace.collect is not a non-empty list",
  ]);
  assert.deepEqual(workTaskProblems({ workspace: { other: 1 } }), ["workspace.other is not a known field"]);
  assert.deepEqual(workTaskProblems({ workspace: [] }), ["workspace is not an object"]);
  assert.deepEqual(workTaskProblems(T1), []);
});

test("work tasks: writeWorkspaceFiles writes inside the workspace and refuses other paths", () => {
  const ws = tmp("ws");
  try {
    assert.deepEqual(writeWorkspaceFiles(ws, [{ path: "a/b/c.txt", content: "c" }]), ["a/b/c.txt"]);
    assert.equal(readFileSync(join(ws, "a", "b", "c.txt"), "utf8"), "c");
    assert.deepEqual(writeWorkspaceFiles(ws, undefined), []);
    assert.throws(() => writeWorkspaceFiles(ws, [{ path: "../out.txt", content: "x" }]), /leaves the workspace/);
    assert.equal(existsSync(join(ws, "..", "out.txt")), false);
  } finally {
    cleanup(ws);
  }
});

test("work tasks: collectWorkspace copies text inside the size limit, without secrets, binaries or host paths", () => {
  const ws = tmp("ws");
  const out = tmp("out");
  try {
    mkdirSync(join(ws, "src", ".git"), { recursive: true });
    mkdirSync(join(ws, "src", "node_modules"), { recursive: true });
    writeFileSync(join(ws, "src", "app.js"), `// built in ${ws}\nconst cfg = "${join(homedir(), "x.json")}";\nconst other = "D:\\\\data\\\\y";\n`);
    writeFileSync(join(ws, "src", ".env"), "TOKEN=1\n");
    writeFileSync(join(ws, "src", "key.txt"), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n");
    writeFileSync(join(ws, "src", "img.bin"), Buffer.from([1, 0, 2]));
    writeFileSync(join(ws, "src", ".git", "HEAD"), "ref\n");
    writeFileSync(join(ws, "src", "node_modules", "m.js"), "m\n");
    writeFileSync(join(ws, "big.txt"), "x".repeat(200));
    writeFileSync(join(ws, "small.txt"), "ok\n");
    const pairs = redactionPairs({ workspace: ws, dataDir: null, workRoot: null });
    const r = collectWorkspace(ws, ["src", "big.txt", "small.txt", "nope.txt", "../x"], out, pairs, 150);
    assert.equal(r.limitBytes, 150);
    assert.deepEqual(r.files.map((f) => [f.path, f.redacted]), [["src/app.js", true], ["small.txt", false]]);
    assert.deepEqual(r.skipped, [
      { path: "src/.env", reason: "secret_name" },
      { path: "src/img.bin", reason: "binary" },
      { path: "src/key.txt", reason: "secret_text" },
      { path: "big.txt", reason: "size_limit" },
      { path: "../x", reason: "outside_workspace" },
    ]);
    assert.deepEqual(r.missing, ["nope.txt"]);
    const app = readFileSync(join(out, "src", "app.js"), "utf8");
    assert.equal(app, '// built in <workspace>\nconst cfg = "<home>\\x.json";\nconst other = "<host-path>";\n'.replace("<home>\\", process.platform === "win32" ? "<home>\\" : "<home>/"));
    assert.equal(r.bytes, Buffer.byteLength(app) + 3);
    assert.deepEqual(readdirSync(join(out, "src")).sort(), ["app.js"]);
    assert.equal(existsSync(join(out, "big.txt")), false);
    // The default limit is 1 MB.
    assert.equal(COLLECT_LIMIT_BYTES, 1048576);
  } finally {
    cleanup(ws, out);
  }
});

test("work tasks: a mock batch writes the files before stage 1, sends final.prompt, and copies the collect paths", async () => {
  const tasks = tmp("tasks");
  const results = tmp("res");
  const work = tmp("work");
  try {
    writeFileSync(join(tasks, "T1-runner-long.task.json"), JSON.stringify(workTask()));
    writeFileSync(join(tasks, "T2-runner-compaction.task.json"), JSON.stringify(T2));
    const seen = [];
    const behave = ({ workspace, prompt, label }) => {
      const isWork = existsSync(join(workspace, "src", "app.js"));
      seen.push({ label, isWork, prompt });
      // The agent of the work task writes a report that names the workspace path.
      if (isWork && label === "stage-1") writeFileSync(join(workspace, "REPORT.md"), `Report from ${workspace}\n`);
      return null;
    };
    const opts = { ...parseArgs(["--batch", "t", "--suite", "smoke", "--mock"]), tasksDir: tasks, resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host: createMockHost({ behave }), configs: loadConfigs(), log: () => {} });
    assert.equal(r.exitCode, EXIT.ok);
    const runsDir = join(results, "t", "runs");
    const recs = readdirSync(runsDir).map((id) => ({ id, rec: readJson(join(runsDir, id, "run.json")) }));
    const work1 = recs.filter((x) => x.rec.taskId === T1.taskId);
    const other = recs.filter((x) => x.rec.taskId === T2.taskId);
    assert.ok(work1.length > 0 && other.length > 0);
    for (const { id, rec } of work1) {
      assert.equal(rec.status, "completed");
      assert.deepEqual(rec.answers.final, {});
      assert.equal(rec.answers.finalParseError, null);
      const manifest = readJson(join(runsDir, id, "workspace-collect.json"));
      assert.equal(manifest.attempt, 1);
      assert.deepEqual(manifest.files.map((f) => f.path), ["src/app.js", "REPORT.md"]);
      assert.deepEqual(manifest.missing, ["missing.txt"]);
      assert.equal(readFileSync(join(runsDir, id, "workspace", "REPORT.md"), "utf8"), "Report from <workspace>\n");
      assert.equal(readFileSync(join(runsDir, id, "workspace", "src", "app.js"), "utf8"), "export const x = 1;\n");
      assert.equal(existsSync(join(runsDir, id, "workspace", "README.md")), false);
    }
    // The task files are in the workspace from the intro on and stay until the final turn; the final turn sends final.prompt.
    const workTurns = seen.filter((s) => s.isWork);
    assert.ok(workTurns.some((s) => s.label === "intro") && workTurns.some((s) => s.label === "stage-1"));
    const finals = workTurns.filter((s) => s.label === "final");
    assert.equal(finals.length, work1.length);
    for (const f of finals) assert.equal(f.prompt, FINAL_PROMPT);
    // A task without the fields runs as before: answers parsed, no copy, the same record keys.
    for (const { id, rec } of other) {
      assert.equal(rec.status, "completed");
      assert.equal(Object.keys(rec.answers.final).length, T2.final.questions.length);
      assert.equal(existsSync(join(runsDir, id, "workspace")), false);
      assert.equal(existsSync(join(runsDir, id, "workspace-collect.json")), false);
      assert.deepEqual(Object.keys(rec), Object.keys(work1[0].rec));
    }
    assert.ok(seen.filter((s) => !s.isWork && s.label === "final").every((s) => s.prompt !== FINAL_PROMPT && s.prompt.includes('"answers"')));
    // No workspace is left behind.
    assert.deepEqual(readdirSync(work).filter((d) => d.startsWith("ws-")), []);
  } finally {
    cleanup(tasks, results, work);
  }
});

/** A mock smoke batch over T1 as a work task and T2 unchanged, with the Claude stage tools; records the host arguments. */
async function argsBatch(extraArgs) {
  const tasks = tmp("tasks");
  const results = tmp("res");
  const work = tmp("work");
  try {
    writeFileSync(join(tasks, "T1-runner-long.task.json"), JSON.stringify(workTask()));
    writeFileSync(join(tasks, "T2-runner-compaction.task.json"), JSON.stringify(T2));
    // The Claude host values of configs/hosts.json without the Context Mode tools (the mock host has no tool list).
    const configs = loadConfigs();
    Object.assign(configs.hosts.mock, { stageTools: ["Read", "Bash", "ToolSearch"], introMaxTurns: 3, stageMaxTurns: 30, questionMaxTurns: 2 });
    const host = createMockHost();
    const turns = [];
    const sessions = [];
    const isWork = (o) => existsSync(join(o.workspace, "src", "app.js"));
    const tail = (args) => args.slice(args.indexOf("--verbose") + 1);
    const runTurn = host.runTurn;
    host.runTurn = (o) => {
      turns.push({ work: isWork(o), label: o.label, args: tail(buildArgs({ ...o, sessionId: null, model: null, pluginDir: null, settingsPath: null, isolation: null })) });
      return runTurn(o);
    };
    const openSession = host.openSession;
    host.openSession = (o) => {
      sessions.push({ work: isWork(o), args: tail(buildPersistentArgs({ ...o, model: null, pluginDir: null, settingsPath: null, isolation: null })) });
      return openSession(o);
    };
    const opts = { ...parseArgs(["--batch", "t", "--suite", "smoke", "--mock", ...extraArgs]), tasksDir: tasks, resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host, configs, log: () => {} });
    assert.equal(r.exitCode, EXIT.ok);
    const runsDir = join(results, "t", "runs");
    const recs = readdirSync(runsDir).map((id) => readJson(join(runsDir, id, "run.json")));
    return { turns, sessions, recs };
  } finally {
    cleanup(tasks, results, work);
  }
}

const WORK = "Read,Bash,ToolSearch,Write,Edit";
const PLAIN = "Read,Bash,ToolSearch";

test("work tasks: the persistent Claude session of a work task may Write and Edit without a prompt; other tasks keep their arguments", async () => {
  const { turns, sessions, recs } = await argsBatch([]);
  assert.equal(turns.length, 0);
  assert.ok(sessions.some((x) => x.work) && sessions.some((x) => !x.work));
  for (const x of sessions) assert.deepEqual(x.args, ["--allowedTools", x.work ? WORK : PLAIN]);
  for (const rec of recs) {
    const work = rec.taskId === T1.taskId;
    assert.equal(rec.sessionMode, "persistent");
    assert.deepEqual(rec.session.permissions, {
      workTask: work, permissionMode: "default",
      stageAllowedTools: (work ? WORK : PLAIN).split(","),
      finalAllowedTools: work ? WORK.split(",") : [],
      finalMaxTurns: work ? 30 : 2,
      guard: rec.session.plain || rec.overlay !== null,
    });
  }
});

test("work tasks: in resume mode the work task gets Write and Edit in the stage and final turns; other tasks keep their arguments", async () => {
  const { turns, sessions } = await argsBatch(["--session-mode", "resume"]);
  assert.equal(sessions.length, 0);
  const argsOf = (work, label) => {
    const c = turns.find((x) => x.work === work && x.label === label);
    assert.ok(c, `${work} ${label}`);
    return c.args;
  };
  assert.deepEqual(argsOf(true, "intro"), ["--max-turns", "3", "--disallowedTools", WORK]);
  assert.deepEqual(argsOf(true, "stage-1"), ["--max-turns", "30", "--allowedTools", WORK]);
  assert.deepEqual(argsOf(true, "final"), ["--max-turns", "30", "--allowedTools", WORK]);
  assert.deepEqual(argsOf(false, "intro"), ["--max-turns", "3", "--disallowedTools", PLAIN]);
  assert.deepEqual(argsOf(false, "stage-1"), ["--max-turns", "30", "--allowedTools", PLAIN]);
  assert.deepEqual(argsOf(false, "final"), ["--max-turns", "2", "--disallowedTools", PLAIN]);
});

test("work tasks: the benchmark guard still denies Write and Edit outside the workspace", () => {
  const matcher = new RegExp(plainHooks("Z").hooks.PreToolUse[0].matcher);
  assert.ok(matcher.test("Write") && matcher.test("Edit") && matcher.test("Bash"));
  const ws = process.platform === "win32" ? "C:\\ws\\run" : "/ws/run";
  const ctx = { workspace: ws, platform: process.platform };
  const outside = process.platform === "win32" ? "C:\\other\\x.mjs" : "/other/x.mjs";
  assert.equal(guardDecision({ tool_name: "Write", tool_input: { file_path: join(ws, "src", "a.mjs"), content: "x" } }, ctx).allow, true);
  assert.equal(guardDecision({ tool_name: "Write", tool_input: { file_path: outside, content: "x" } }, ctx).allow, false);
  assert.equal(guardDecision({ tool_name: "Edit", tool_input: { file_path: "../x.mjs", old_string: "a", new_string: "b" } }, ctx).allow, false);
});
