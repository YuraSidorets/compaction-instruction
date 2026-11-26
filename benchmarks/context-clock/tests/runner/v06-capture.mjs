// Capture of what the runner sends in a mock batch: the prompt of every turn, the compaction prompts and the agent
// environment, with the per-run folders replaced by placeholders. tests/runner/v06.test.mjs uses it to compare modes
// (J against H, K against H, L against J) and to pin modes B and H to their v0.5 behavior.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createMockHost } from "../../runner/hosts/mock.mjs";
import { parseArgs, runBatch } from "../../runner/run.mjs";
import { cleanup, tmp } from "./helpers.mjs";

/** Agent variables that the mode decides (all others come from the parent environment of the test process). */
const ENV_KEY = /^(CTX_CLOCK|CCB_|CONTEXT_MODE_DATA_DIR$)/i;

function stubOverlay() {
  return {
    findInstalledPlugin: () => "C:/fake/installed/context-mode",
    buildOverlay: ({ destDir }) => {
      mkdirSync(destDir, { recursive: true });
      return { pluginDir: destDir, sourceSha: "sha-stub-1" };
    },
  };
}

function normalizer(pairs) {
  const list = pairs.filter(([p]) => typeof p === "string" && p.length > 0).sort((a, b) => b[0].length - a[0].length);
  return (s) => {
    let out = String(s);
    for (const [p, name] of list) {
      out = out.split(p).join(name);
      out = out.split(p.replace(/\\/g, "/")).join(name);
    }
    return out;
  };
}

/**
 * Run `modes` for one task of `tasksDir` with the mock host (persistent session mode, as a live Claude batch) and
 * return, per mode, { turns: [{ label, prompt }], compacts: [prompt], env: { key: value } } with placeholders <ws>,
 * <data> and <overlay> for the per-run folders.
 */
export async function capture({ tasksDir, taskId, modes, suite = null, hostOpts = {}, extraArgs = [] }) {
  const results = tmp("v06cap-res");
  const work = tmp("v06cap-work");
  const byMode = {};
  const slot = (m) => (byMode[m] ??= { turns: [], compacts: [], env: null, pairs: null, tools: null });
  const host = createMockHost({
    mockDir: null,
    ...hostOpts,
    onCompact: () => {},
    behave: ({ workspace, prompt, env, label, mock }) => {
      const s = slot(mock.mode);
      s.pairs ??= [[workspace, "<ws>"], [env.CONTEXT_MODE_DATA_DIR, "<data>"], [env.CCB_OVERLAY_DIR, "<overlay>"]];
      const norm = normalizer(s.pairs);
      s.turns.push({ label, prompt: norm(prompt) });
      if (s.env === null) s.env = Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEY.test(k)).map(([k, v]) => [k, norm(v).split("\\").join("/")]).sort(([a], [b]) => a.localeCompare(b)));
      return null;
    },
  });
  const baseCompact = host.compact;
  const wrapped = {
    ...host,
    compact: (a) => {
      slot(a.mock.mode).compacts.push(a.instruction ? `/compact ${a.instruction}` : "/compact");
      return baseCompact(a);
    },
    openSession: (a) => {
      slot(a.mock.mode).tools = [...(a.allowedTools ?? [])];
      const s = host.openSession(a);
      if (!s) return s;
      return { ...s, compact: (x) => wrapped.compact({ ...x, mock: a.mock }) };
    },
  };
  try {
    const args = ["--host", "claude", "--batch", "cap", "--mock", "--tasks", taskId, "--modes", modes.join(","), "--overlay", "on"];
    if (suite) args.push("--suite", suite);
    args.push(...extraArgs);
    const opts = { ...parseArgs(args), tasksDir, resultsDir: results, workRoot: work };
    const r = await runBatch(opts, { host: wrapped, overlay: stubOverlay(), log: () => {} });
    const out = {};
    for (const m of modes) {
      const s = byMode[m];
      out[m] = { turns: s.turns, compacts: s.compacts, env: s.env, tools: s.tools, record: r.records.find((x) => x.mode === m), status: r.records.find((x) => x.mode === m)?.status };
    }
    return out;
  } finally {
    cleanup(results, work);
  }
}

export const sha256 = (v) => createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
