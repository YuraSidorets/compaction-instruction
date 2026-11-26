import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, tempDir } from "./helpers.mjs";

const G = await import(pathToFileURL(path.join(OVERLAY_DIR, "guard.mjs")).href);

const WIN = { workspace: "C:\\Temp\\ccb-run-1\\ws", overlayDir: "C:\\Temp\\ccb-run-1\\overlay", home: "C:\\Users\\tester", temp: "C:\\Temp", platform: "win32" };
const NIX = { workspace: "/tmp/ccb-run-1/ws", overlayDir: "/tmp/ccb-run-1/overlay", home: "/home/tester", temp: "/tmp", platform: "linux" };

const call = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: "ignored" });
const allowed = (ctx, tool, input) => G.guardDecision(call(tool, input), ctx).allow;

test("allow: relative paths, workspace paths, overlay paths, plain commands", () => {
  const cases = [
    ["Read", { file_path: "src/a.ts" }],
    ["Read", { file_path: "./notes/b.md" }],
    ["Read", { file_path: "C:\\Temp\\ccb-run-1\\ws\\src\\a.ts" }],
    ["Read", { file_path: "c:/temp/CCB-RUN-1/ws/x.txt" }],
    ["Read", { file_path: "/c/Temp/ccb-run-1/ws/x.txt" }],
    ["Read", { file_path: "C:\\Temp\\ccb-run-1\\overlay\\ccb\\guard.mjs" }],
    ["Bash", { command: "npm test" }],
    ["Bash", { command: "git status && ls -la src" }],
    ["Bash", { command: "node scripts/run.mjs --out=out/x.json" }],
    ["Bash", { command: "cat src/../README.md" }],
    ["Bash", { command: "curl -s https://example.com/api/v1" }],
    ["Bash", { command: "cat $PWD/src/a.ts" }],
    ["Grep", { pattern: "/etc/passwd", path: "src" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Glob", { pattern: "src/**/*.md", path: "C:\\Temp\\ccb-run-1\\ws" }],
    ["Write", { file_path: "out.txt", content: "see /etc/hosts and C:\\Windows" }],
    ["Edit", { file_path: "a.ts", old_string: "~/x", new_string: "$HOME/y" }],
    ["WebFetch", { url: "https://example.com/", prompt: "read /etc" }],
  ];
  for (const [tool, input] of cases) assert.equal(allowed(WIN, tool, input), true, `${tool} ${JSON.stringify(input)}`);
});

test("deny: Windows forms outside the workspace", () => {
  const cases = [
    ["Read", { file_path: "C:\\Users\\tester\\.claude\\settings.json" }],
    ["Read", { file_path: "C:/Users/tester/.codex/config.toml" }],
    ["Read", { file_path: "/c/Git/personal/context-clock/README.md" }],
    ["Read", { file_path: "/mnt/c/Users/tester/x" }],
    ["Read", { file_path: "C:\\Temp\\ccb-run-2\\ws\\a.ts" }],
    ["Read", { file_path: "C:\\Temp\\ccb-run-1\\ws-other\\a.ts" }],
    ["Read", { file_path: "..\\..\\secret.txt" }],
    ["Read", { file_path: "D:" }],
    ["Bash", { command: "type %USERPROFILE%\\.claude\\CLAUDE.md" }],
    ["Bash", { command: "cat ~/.claude/settings.json" }],
    ["Bash", { command: "ls ~" }],
    ["Bash", { command: "cat $HOME/.codex/auth.json" }],
    ["Bash", { command: "cat ${HOME}/x" }],
    ["PowerShell", { command: "Get-Content $env:USERPROFILE\\.claude\\x" }],
    ["Bash", { command: "cat ../../../repo/benchmarks/context-clock/tasks/v03/keys/k.json" }],
    ["Bash", { command: "cd .. && ls" }],
    ["Bash", { command: "cat \\\\server\\share\\f" }],
    ["Bash", { command: "cat file:///C:/Users/tester/x" }],
    ["Bash", { command: "gcc -IC:/Users/tester/include a.c" }],
    ["Glob", { pattern: "C:/Users/tester/**/*.json" }],
    ["Grep", { pattern: "x", path: "C:\\Git" }],
    ["NotebookEdit", { notebook_path: "C:\\Users\\tester\\n.ipynb" }],
    ["mcp__plugin_context-mode_context-mode__ctx_execute", { language: "shell", code: "cat /c/Users/tester/.claude/x" }],
  ];
  for (const [tool, input] of cases) assert.equal(allowed(WIN, tool, input), false, `${tool} ${JSON.stringify(input)}`);
});

const CTX = "mcp__plugin_context-mode_context-mode__ctx_execute";

test("live smoke cases: retrieval commands with regex text are allowed", () => {
  const cases = [
    ["Bash", { command: 'node feed.mjs s3-activity | grep -E "CR-6014|\\[e[0-9]{3}\\]"' }],
    ["Bash", { command: 'node feed.mjs s1-log | grep -n -A3 -B1 "INC-1697"' }],
    ["Bash", { command: "node feed.mjs x 2>/dev/null | sed -n '1,40p'" }],
    ["Bash", { command: "node feed.mjs x | awk -F'|' '/e[0-9]+/ {print $1}'" }],
    ["Bash", { command: "ls inbox/s1 && cat inbox/s1/notes-01.md" }],
    ["Bash", { command: 'node feed.mjs x | grep -E "^\\[e\\d{3}\\]|step-\\w+"' }],
    [CTX, { language: "javascript", code: 'const s=require("fs").readFileSync("inbox/s2/a.md","utf8"); console.log(s.match(/\\[e\\d+\\]/g))' }],
    ["Bash", { command: "sed -e 's/a/b/' -e 's|x|y|g' notes.md > out.md" }],
    ["Bash", { command: "grep -rn '\\.\\|\\d\\n' . 2>/dev/stderr < /dev/stdin > /dev/stdout" }],
    ["PowerShell", { command: "node feed.mjs x > NUL" }],
    ["Bash", { command: "curl -s 'https://example.com/a/../b?q=[1]' --max-time=5" }],
    ["Bash", { command: "cat src/../README.md" }],
  ];
  for (const ctx of [WIN, NIX]) {
    for (const [tool, input] of cases) assert.equal(allowed(ctx, tool, input), true, `${ctx.platform} ${tool} ${JSON.stringify(input)}`);
  }
});

test("live smoke cases: paths outside the workspace are denied", () => {
  const cases = [
    ["Bash", { command: "node feed.mjs s3-audit > /tmp/s3-audit.txt; wc -l /tmp/s3-audit.txt" }],
    ["Bash", { command: "cat ~/.claude/projects/x/y.jsonl" }],
    ["PowerShell", { command: "type C:\\Users\\someone\\.claude\\projects\\a.jsonl" }],
    ["Bash", { command: "cat ../../other/file" }],
    ["Bash", { command: "ls /c/Users" }],
    ["Bash", { command: "cat .claude/settings.json" }],
    ["Bash", { command: "cat inbox/.codex/auth.json" }],
    ["Read", { file_path: ".claude\\settings.local.json" }],
    ["Bash", { command: "ls $TMPDIR/other" }],
    ["PowerShell", { command: "dir %TEMP%\\x" }],
    ["PowerShell", { command: "dir $env:TEMP" }],
  ];
  for (const ctx of [WIN, NIX]) {
    for (const [tool, input] of cases) assert.equal(allowed(ctx, tool, input), false, `${ctx.platform} ${tool} ${JSON.stringify(input)}`);
  }
});

test("POSIX: allow inside, deny home, /etc, other temp folders and leaving ..", () => {
  assert.equal(allowed(NIX, "Read", { file_path: "/tmp/ccb-run-1/ws/a.ts" }), true);
  assert.equal(allowed(NIX, "Bash", { command: "ls /tmp/ccb-run-1/overlay/ccb" }), true);
  assert.equal(allowed(NIX, "Bash", { command: "echo hi | wc -l" }), true);
  assert.equal(allowed(NIX, "Read", { file_path: "/etc/passwd" }), false);
  assert.equal(allowed(NIX, "Read", { file_path: "/tmp/other/a" }), false);
  assert.equal(allowed(NIX, "Bash", { command: "cat ~/.claude/x" }), false);
  assert.equal(allowed(NIX, "Bash", { command: "cat src/../../x" }), false);
});

test("workspace falls back to the payload cwd when CCB_WORKSPACE is empty", () => {
  const ctx = { ...NIX, workspace: "" };
  const p = { tool_name: "Read", tool_input: { file_path: "/w/a.ts" }, cwd: "/w" };
  assert.equal(G.guardDecision(p, ctx).allow, true);
  assert.equal(G.guardDecision({ ...p, tool_input: { file_path: "/x/a.ts" } }, ctx).allow, false);
});

test("hook process: deny reply format, log with no path, allow is silent", () => {
  const dir = tempDir();
  const log = path.join(dir, "guard.jsonl");
  const ws = path.join(dir, "ws");
  const env = { ...process.env, CCB_WORKSPACE: ws, CCB_OVERLAY_DIR: path.join(dir, "overlay"), CCB_GUARD_LOG: log };
  const script = path.join(OVERLAY_DIR, "guard.mjs");
  const secret = path.join(dir, "secret-target.txt");
  const deny = spawnSync(process.execPath, [script], { input: JSON.stringify(call("Read", { file_path: secret })), env, encoding: "utf8" });
  assert.equal(deny.status, 0);
  const out = JSON.parse(deny.stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: G.DENY_REASON } });
  assert.equal(G.DENY_REASON, "This path is outside the task workspace and is not available.");
  const text = readFileSync(log, "utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["reason", "t", "tool"]);
  assert.equal(lines[0].tool, "Read");
  assert.ok(!text.includes("secret-target"), "log holds no path");

  const allow = spawnSync(process.execPath, [script], { input: JSON.stringify(call("Read", { file_path: path.join(ws, "a.ts") })), env, encoding: "utf8" });
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout, "");
  const bad = spawnSync(process.execPath, [script], { input: "not json", env, encoding: "utf8" });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.ok(existsSync(log));
});
