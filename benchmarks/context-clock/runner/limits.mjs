// Hard limits of one run and the budget of a batch (EXPERIMENT-V03.md "Runner", limits table).
// - A run limit (wall time, tool calls, total tokens) is checked live from the host stream and between turns. When one
//   trips, the runner aborts the running turn (the host kills that run's process tree only), keeps the raw stream and
//   records status "limit_exceeded" with limitHit.
// - The batch budget (total tokens, wall time) adds up every invocation of the same batch. When it is spent, no new
//   run starts and the batch gets a budget_stopped mark. A new start continues only with --raise-budget.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LIMIT_NAMES = Object.freeze(["wallTime", "toolCalls", "totalTokens"]);

export function loadLimits(file = join(BENCH_ROOT, "configs", "limits.json")) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  return { run: { ...doc.run }, batch: { ...doc.batch } };
}

/** Total tokens of a usage object in the runner shape or the Claude API shape. */
export function usageTokens(u) {
  if (!u || typeof u !== "object") return 0;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if ("inputTokens" in u || "outputTokens" in u) return n(u.inputTokens) + n(u.outputTokens) + n(u.cacheReadTokens) + n(u.cacheCreationTokens);
  return n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

/**
 * The limit monitor of one attempt.
 * - `beginTurn()` returns { onLine, signal } for the host. onLine parses Claude stream-json lines: each distinct
 *   tool_use id counts as a tool call, the usage of each assistant message (by message id) and then of the result line
 *   counts as tokens. If the running total passes a limit, the monitor aborts the signal.
 * - `endTurn(turnRecord)` adds the turn record (the authoritative counts) to the committed totals and checks again.
 * - `beforeTurn()` checks the wall time before a new turn starts.
 * - `elapsed()` is the run time: wall time, or the sum of recorded turn durations for a deterministic host (mock).
 * `hit` is null or the name of the first limit that tripped.
 */
export function createLimitMonitor({ limits, deterministic = false, now = Date.now }) {
  const t0 = now();
  let committed = { toolCalls: 0, tokens: 0, durationMs: 0 };
  let live = null;
  let controller = null;
  let timer = null;
  const m = { hit: null, counts: () => ({ ...committed }) };

  const elapsed = () => (deterministic ? committed.durationMs : now() - t0);
  const trip = (name) => {
    if (m.hit) return;
    m.hit = name;
    controller?.abort();
  };
  const liveTotals = () => ({
    toolCalls: committed.toolCalls + (live ? live.tools.size : 0),
    tokens: committed.tokens + (live ? (live.resultTokens ?? [...live.msgTokens.values()].reduce((a, b) => a + b, 0)) : 0),
  });
  const check = () => {
    const t = liveTotals();
    if (Number.isFinite(limits.toolCalls) && t.toolCalls > limits.toolCalls) trip("toolCalls");
    else if (Number.isFinite(limits.totalTokens) && t.tokens > limits.totalTokens) trip("totalTokens");
    else if (Number.isFinite(limits.wallTimeMs) && elapsed() > limits.wallTimeMs) trip("wallTime");
  };

  m.elapsed = elapsed;
  m.beforeTurn = () => {
    check();
    return m.hit;
  };
  m.beginTurn = () => {
    controller = new AbortController();
    live = { tools: new Set(), msgTokens: new Map(), resultTokens: null };
    if (m.hit) controller.abort();
    if (!deterministic && Number.isFinite(limits.wallTimeMs)) {
      const left = Math.max(0, limits.wallTimeMs - elapsed());
      timer = setTimeout(() => trip("wallTime"), left + 1);
      timer.unref?.();
    }
    const onLine = (line) => {
      if (!live || !line || line[0] !== "{") return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "assistant" && e.message) {
        for (const c of Array.isArray(e.message.content) ? e.message.content : []) if (c?.type === "tool_use") live.tools.add(c.id ?? `n${live.tools.size}`);
        if (e.message.usage) live.msgTokens.set(e.message.id ?? `m${live.msgTokens.size}`, usageTokens(e.message.usage));
      } else if (e.type === "result" && e.usage) {
        live.resultTokens = usageTokens(e.usage);
      }
      check();
    };
    return { onLine, signal: controller.signal };
  };
  m.endTurn = (rec) => {
    if (timer) clearTimeout(timer);
    timer = null;
    live = null;
    controller = null;
    if (rec) {
      const tools = Object.values(rec.toolCalls ?? {}).reduce((a, b) => a + b, 0);
      committed = { toolCalls: committed.toolCalls + tools, tokens: committed.tokens + usageTokens(rec.usage), durationMs: committed.durationMs + (rec.durationMs ?? 0) };
    }
    check();
    return m.hit;
  };
  m.stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return m;
}

/** The budget in force: the configured budget times (1 + number of raises). */
export function effectiveBudget(batchLimits, raises = 0) {
  const k = 1 + Math.max(0, raises);
  return { totalTokens: batchLimits.totalTokens * k, wallTimeMs: batchLimits.wallTimeMs * k };
}

/** Totals of earlier invocations of a batch: tokens and wall time (ended or last saved). */
export function priorUsage(invocations, excludeId = null) {
  let tokens = 0;
  let wallMs = 0;
  for (const x of invocations ?? []) {
    if (x.id === excludeId) continue;
    tokens += typeof x.tokens === "number" ? x.tokens : 0;
    if (typeof x.wallMs === "number") wallMs += x.wallMs;
    else if (x.startedAt && x.endedAt) wallMs += Math.max(0, Date.parse(x.endedAt) - Date.parse(x.startedAt));
  }
  return { tokens, wallMs };
}

/** null, or the reason the budget is spent. */
export function budgetReason(used, budget) {
  if (used.tokens >= budget.totalTokens) return `total tokens ${used.tokens} >= budget ${budget.totalTokens}`;
  if (used.wallMs >= budget.wallTimeMs) return `wall time ${Math.round(used.wallMs / 1000)} s >= budget ${Math.round(budget.wallTimeMs / 1000)} s`;
  return null;
}
