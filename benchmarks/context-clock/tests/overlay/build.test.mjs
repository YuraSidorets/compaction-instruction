import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, tempDir } from "./helpers.mjs";

const B = await import(pathToFileURL(path.join(OVERLAY_DIR, "build.mjs")).href);

const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
const POST = "^(Bash|PowerShell|Read|Grep|WebFetch|Write|Edit|NotebookEdit|mcp__plugin_context-mode_context-mode__ctx_.*|mcp__.*)$";
const PRE = "^(Bash|PowerShell|Read|Grep|WebFetch|Write|Edit|NotebookEdit|mcp__plugin_context-mode_context-mode__ctx_.*)$";
const entry = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ command: CMD, timeout: 5, type: "command" }] });

/** A fake plugin folder with the same layout as the installed context-mode plugin. */
function fakePlugin(root) {
  const p = path.join(root, "plugin");
  mkdirSync(path.join(p, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(p, "hooks"), { recursive: true });
  writeFileSync(path.join(p, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "context-mode",
    hooks: "./hooks/claude-code.json",
    mcpServers: { "context-mode": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "--agent", "claude-code"] } },
  }, null, 2));
  writeFileSync(path.join(p, "hooks", "claude-code.json"), JSON.stringify({
    hooks: {
      PreToolUse: [entry(PRE)],
      PostToolUse: [entry(POST)],
      PostToolUseFailure: [entry(POST)],
      SessionStart: [entry(null)],
      UserPromptSubmit: [entry(null)],
    },
  }, null, 2));
  writeFileSync(path.join(p, "hook.mjs"), "// real hook\n");
  writeFileSync(path.join(p, "server.mjs"), "// real server\n");
  return p;
}

test("buildOverlay: copies the plugin, rewrites manifest and hooks, adds the guard with Glob", () => {
  const root = tempDir("ccb-build-");
  const src = fakePlugin(root);
  const srcManifest = readFileSync(path.join(src, ".claude-plugin", "plugin.json"), "utf8");
  const srcHooks = readFileSync(path.join(src, "hooks", "claude-code.json"), "utf8");
  const dest = path.join(root, "run", "overlay");
  const r = B.buildOverlay({ sourceDir: src, destDir: dest });
  assert.equal(r.pluginDir, path.resolve(dest));
  assert.match(r.sourceSha, /^[0-9a-f]{64}$/);

  const m = JSON.parse(readFileSync(path.join(dest, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(m.mcpServers["context-mode"].args, ["${CLAUDE_PLUGIN_ROOT}/ccb/server-shim.mjs", "${CLAUDE_PLUGIN_ROOT}/server.mjs", "--agent", "claude-code"]);
  assert.equal(m.name, "context-mode");

  const h = JSON.parse(readFileSync(path.join(dest, "hooks", "claude-code.json"), "utf8")).hooks;
  const shimCmd = 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs" "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code';
  for (const ev of ["PostToolUse", "PostToolUseFailure", "SessionStart", "UserPromptSubmit"]) {
    assert.equal(h[ev].length, 1);
    assert.equal(h[ev][0].hooks[0].command, shimCmd, ev);
    assert.equal(h[ev][0].hooks[0].timeout, 5);
  }
  assert.equal(h.PostToolUse[0].matcher, POST);
  assert.equal(h.PreToolUse.length, 2);
  assert.equal(h.PreToolUse[0].hooks[0].command, shimCmd);
  const guard = h.PreToolUse[1];
  assert.deepEqual(guard.hooks, [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/ccb/guard.mjs"', timeout: 5 }]);
  assert.equal(guard.matcher, "^(Bash|PowerShell|Read|Grep|WebFetch|Write|Edit|NotebookEdit|mcp__plugin_context-mode_context-mode__ctx_.*|Glob)$");
  assert.ok(new RegExp(guard.matcher).test("Glob"));
  assert.ok(new RegExp(guard.matcher).test("mcp__plugin_context-mode_context-mode__ctx_execute"));
  // v0.7: the product has no PreCompact hook, so the overlay adds one that runs the shim with no product hook
  assert.deepEqual(h.PreCompact, [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs"', timeout: 5 }] }]);

  for (const f of B.OVERLAY_FILES) assert.ok(existsSync(path.join(dest, "ccb", f)), f);
  assert.equal(JSON.parse(readFileSync(path.join(dest, "ccb", "overlay.json"), "utf8")).sourceSha, r.sourceSha);
  assert.equal(readFileSync(path.join(dest, "hook.mjs"), "utf8"), "// real hook\n");

  // the source is only read
  assert.equal(readFileSync(path.join(src, ".claude-plugin", "plugin.json"), "utf8"), srcManifest);
  assert.equal(readFileSync(path.join(src, "hooks", "claude-code.json"), "utf8"), srcHooks);
  assert.ok(!existsSync(path.join(src, "ccb")));
});

test("buildOverlay is idempotent", () => {
  const root = tempDir("ccb-build-");
  const src = fakePlugin(root);
  const dest = path.join(root, "overlay");
  const a = B.buildOverlay({ sourceDir: src, destDir: dest });
  const treeA = B.treeSha(dest);
  writeFileSync(path.join(dest, "stray.txt"), "left over");
  const b = B.buildOverlay({ sourceDir: src, destDir: dest });
  assert.equal(a.sourceSha, b.sourceSha);
  assert.equal(B.treeSha(dest), treeA, "same tree after a rebuild");
  assert.ok(!existsSync(path.join(dest, "stray.txt")));
  // the rewrites themselves are idempotent too
  const h = JSON.parse(readFileSync(path.join(dest, "hooks", "claude-code.json"), "utf8"));
  assert.deepEqual(B.rewriteHooks(h).hooks.PreToolUse.length, 2);
  assert.deepEqual(B.rewriteHooks(h).hooks.PreCompact, h.hooks.PreCompact);
  const m = JSON.parse(readFileSync(path.join(dest, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(B.rewriteManifest(m), m);
});

test("buildOverlay refuses unsafe destinations", () => {
  const root = tempDir("ccb-build-");
  const src = fakePlugin(root);
  assert.throws(() => B.buildOverlay({ sourceDir: src, destDir: path.join(src, "sub") }));
  assert.throws(() => B.buildOverlay({ sourceDir: src, destDir: root }));
  const other = path.join(root, "not-empty");
  mkdirSync(other);
  writeFileSync(path.join(other, "keep.txt"), "x");
  assert.throws(() => B.buildOverlay({ sourceDir: src, destDir: other }), /not empty/);
  assert.equal(readFileSync(path.join(other, "keep.txt"), "utf8"), "x");
  assert.throws(() => B.buildOverlay({ sourceDir: path.join(root, "missing"), destDir: path.join(root, "o2") }));
});

test("findInstalledPlugin reads installed_plugins.json under the given home", () => {
  const home = tempDir("ccb-home-");
  const src = fakePlugin(home);
  mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "context-mode@context-mode": [{ scope: "user", installPath: src, version: "0.0.0-dev" }] },
  }));
  assert.equal(B.findInstalledPlugin({ home }), src);
  writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  assert.throws(() => B.findInstalledPlugin({ home }), /not in/);
});

test("rewriteHooks: a product PreCompact hook runs through the shim, and no second PreCompact entry is added", () => {
  const hooks = { hooks: { PreToolUse: [entry(PRE)], PreCompact: [entry("manual")] } };
  const r = B.rewriteHooks(hooks).hooks;
  assert.equal(r.PreCompact.length, 1);
  assert.equal(r.PreCompact[0].matcher, "manual");
  assert.equal(r.PreCompact[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/ccb/hook-shim.mjs" "${CLAUDE_PLUGIN_ROOT}/hook.mjs" --agent claude-code');
  assert.equal(hooks.hooks.PreCompact[0].hooks[0].command, CMD, "input not changed");
});
