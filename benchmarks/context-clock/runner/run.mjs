#!/usr/bin/env node
// Experiment runner of the Context Clock effectiveness benchmark (CONTRACT.md "Run record", "Host adapter").
//   node benchmarks/context-clock/runner/run.mjs --host claude --batch <name> --suite smoke|pilot|full|v03-*|v04-*
//        [--tasks id,id] [--modes A,B,C] [--reps 2] [--concurrency 4] [--model haiku] [--seed 1] [--mock]
//        [--session-mode persistent|resume] [--overlay on|off] [--raise-budget]
//        [--keep] [--tasks-dir <dir>] [--results-dir <dir>] [--work-root <dir>]
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchPaths } from "../paths.mjs";
import { parseAnswers } from "./answers.mjs";
import { budgetReason, createLimitMonitor, effectiveBudget, loadLimits, priorUsage, usageTokens } from "./limits.mjs";
import { keepLogs, prepareOverlay, readGuardLog, readShimLog, readStateBlockLog, runOverlay } from "./overlay-run.mjs";
import { MODES, ORDERS, blocksOf, buildRunList, checkpointsOf, loadTasks, selectTasks } from "./plan.mjs";
import { PROMPT_VERSION, checkpointPrompt, finalPrompt, introPrompt, stagePrompt } from "./prompts.mjs";
import { EMPTY_USAGE, addChannels, addUsage, emptyChannels } from "./stream.mjs";
import { countByName, countShort, findContextDbs, integrityScan, readClockTelemetry, redact, redactionPairs } from "./telemetry.mjs";
import { COMMIT_MODES, commitInstructionSha, commitTelemetry, emptyCommits, loadReferenceState, stageMessage, writeReferenceState } from "./v04.mjs";
import { compactInstructionOf, emptyStateFile, instructionRecords, stageToolsOf, stateFileTelemetry } from "./v05.mjs";
import { copyStateFile, createCostTracker, hostCostOf, preTokensOf } from "./v06.mjs";
import { DEFAULT_REMIND_THRESHOLD, TRIGGER_MODES, emptyTriggers, shimLineCount, triggerRecords, triggerTelemetry } from "./v07.mjs";
import { V08_TRIGGER_MODES, periodicPlan, probeLabel, totalCostUsd, v08Records } from "./v08.mjs";
import { V09_TRIGGER_MODES, autoCompactionEntries, contextTokensOf, hasCompactionPlan, v09Records } from "./v09.mjs";
import { V10_TRIGGER_MODES, v10Records } from "./v10.mjs";
import { collectWorkspace, finalTurnOf, permissionsRecord, sessionToolsOf, writeWorkspaceFiles } from "./worktask.mjs";
import {
  CONTEXT_MODE_NAME, ISOLATED_ENV, OVERLAY_ISOLATION, PLAIN_SETTING_SOURCES, initPartsOf, isPlain, isolationViolations, keepPlainLogs, mergeParts,
  overlayPluginInfo, plainBatchRecord, preparePlain, runPlain, sessionRecord, claudeMdLoaded, compactStdoutRecords, instructionFilesOf, standaloneTelemetry,
  STANDALONE_MODES, hostDebugRuns, preCompactDebugLines,
} from "./plain.mjs";
import {
  CONFIGS_DIR, MIN_AUTO_COMPACT_WINDOW, MODE_ENV, TRIGGER_ENV, PRODUCT_COMPACT_MODES, PRODUCT_COMPACT_TEXT_FILE, REPO_ROOT, createWorkspace, defaultWorkRoot, modeEnv, removeStageMaterial, removeWorkspace, writeStageMaterial,
} from "./workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BENCH_ROOT = resolve(HERE, "..");
export const MOCK_TASKS_DIR = join(BENCH_ROOT, "tests", "runner", "fixtures", "task-files");
export const MAX_ATTEMPTS = 3; // the first attempt and at most 2 retries
export const RATE_LIMIT_STOP = 3; // consecutive rate-limit failures that stop the batch
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, rateLimitStop: 3, budgetStop: 4 });

const HOSTS = new Set(["claude", "codex"]);
const SUITES = new Set(["smoke", "pilot", "full", "v03-smoke", "v03-full", "v04-smoke", "v04-full", "v05-smoke", "v05-full", "v06-smoke", "v06-a", "v06-b-restore", "v06-b-prep", "v07-calib", "v07-smoke", "v07-full", "v08-smoke", "v08-full", "v09-calib", "v09-smoke", "v09-full", "v09-auto-smoke", "v09-auto", "v10-smoke", "v10-full", "v11-smoke", "v11-full", "v11-b-smoke", "v11-clock", "v11-plain-smoke", "v11-plain", "v11-iso-smoke", "v11-iso", "v12-calib", "v12-full", "v12-smoke", "v12-main", "v12-opus", "v12-auto", "v12-rerun", "v12-hard-calib", "v12-hard-opus", "v12-indep", "v12-noharm", "v12-work-smoke", "v12-work", "v12-rules-calib", "v12-rules-opus"]);
export const SESSION_MODES = Object.freeze(["persistent", "resume"]);

/** The session mode of a run: the option, else persistent for claude and resume for codex. */
export function sessionModeOf(opts) {
  return opts.sessionMode ?? (opts.host === "claude" ? "persistent" : "resume");
}

function relPosix(p) {
  return relative(REPO_ROOT, p).split("\\").join("/");
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJsonAtomic(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------- command line

export function parseArgs(argv) {
  const o = {
    host: "claude", batch: null, suite: null, tasks: null, modes: null, reps: null, concurrency: 1, model: null,
    seed: 1, mock: false, keep: false, tasksDir: null, resultsDir: null, workRoot: null, sessionMode: null, overlay: null, isolated: null,
    raiseBudget: false, help: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const int = (v, flag, min) => {
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${flag} must be an integer >= ${min}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--host": o.host = need(i, a); i++; break;
      case "--batch": o.batch = need(i, a); i++; break;
      case "--suite": o.suite = need(i, a); i++; break;
      case "--tasks": o.tasks = need(i, a).split(",").map((s) => s.trim()).filter(Boolean); i++; break;
      case "--modes": o.modes = need(i, a).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean); i++; break;
      case "--reps": o.reps = int(need(i, a), a, 1); i++; break;
      case "--concurrency": o.concurrency = int(need(i, a), a, 1); i++; break;
      case "--model": o.model = need(i, a); i++; break;
      case "--session-mode": o.sessionMode = need(i, a); i++; break;
      case "--isolated": {
        const v = need(i, a);
        if (v !== "on" && v !== "off") throw new Error("--isolated must be on or off");
        o.isolated = v === "on";
        i++;
        break;
      }
      case "--overlay": {
        const v = need(i, a);
        if (v !== "on" && v !== "off") throw new Error("--overlay must be on or off");
        o.overlay = v === "on";
        i++;
        break;
      }
      case "--raise-budget": o.raiseBudget = true; break;
      case "--seed": o.seed = int(need(i, a), a, 0); i++; break;
      case "--tasks-dir": o.tasksDir = resolve(need(i, a)); i++; break;
      case "--results-dir": o.resultsDir = resolve(need(i, a)); i++; break;
      case "--work-root": o.workRoot = resolve(need(i, a)); i++; break;
      case "--mock": o.mock = true; break;
      case "--keep": o.keep = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (o.help) return o;
  if (!o.batch) throw new Error("--batch is required");
  if (!/^[A-Za-z0-9._-]+$/.test(o.batch)) throw new Error("--batch may hold only letters, digits, '.', '_' and '-'");
  if (!o.suite && !o.tasks) throw new Error("--suite or --tasks is required");
  if (o.suite && !SUITES.has(o.suite)) throw new Error(`--suite must be one of ${[...SUITES].join(", ")}`);
  if (!HOSTS.has(o.host)) throw new Error(`--host must be claude or codex`);
  for (const m of o.modes ?? []) if (!MODES.includes(m)) throw new Error(`unknown mode ${m}`);
  if (o.sessionMode !== null && !SESSION_MODES.includes(o.sessionMode)) throw new Error("--session-mode must be persistent or resume");
  if (o.sessionMode === "persistent" && o.host === "codex" && !o.mock) throw new Error("--session-mode persistent needs --host claude (codex exec resumes per turn)");
  return o;
}

export const USAGE = `Usage: node benchmarks/context-clock/runner/run.mjs --host claude|codex --batch <name> --suite smoke|pilot|full|v03-smoke|v03-full|v04-smoke|v04-full|v05-smoke|v05-full|v06-smoke|v06-a|v06-b-restore|v06-b-prep|v07-calib|v07-smoke|v07-full|v08-smoke|v08-full|v09-calib|v09-smoke|v09-full|v09-auto-smoke|v09-auto
  [--tasks id,id] [--modes A,B,C,D,E,F,G,H,S,J,K,L,N,T,P,U,Q,R] [--reps N] [--concurrency N (at most 6)] [--model NAME] [--seed N] [--mock]
  [--session-mode persistent|resume] [--overlay on|off] [--raise-budget] [--keep] [--tasks-dir DIR] [--results-dir DIR] [--work-root DIR]`;

// ---------------------------------------------------------------- plan

export function loadConfigs() {
  return { hosts: readJson(join(BENCH_ROOT, "configs", "hosts.json")), suites: readJson(join(BENCH_ROOT, "configs", "suites.json")).suites, limits: loadLimits() };
}

/** The batch plan: tasks, the seeded run list, and the folders. Pure apart from reading task files. */
export function buildPlan(opts, configs = loadConfigs()) {
  // With --mock the run keeps the --host name (runId, run.json host); the budgets come from the "mock" config entry.
  const hostName = opts.host;
  const paths = benchPaths();
  const notes = [];
  const suiteCfg = opts.suite ? configs.suites[opts.suite] : null;
  if (opts.suite && !suiteCfg) throw new Error(`configs/suites.json has no suite ${opts.suite}`);
  // A suite with tasksDir (v03) reads <tasksDir>/generated under benchmarks/context-clock; keys are in <tasksDir>/keys.
  let tasksDir = opts.tasksDir ?? (suiteCfg?.tasksDir ? join(BENCH_ROOT, suiteCfg.tasksDir, "generated") : paths.generatedDir);
  let all = loadTasks(tasksDir);
  if (all.length === 0 && opts.mock && !opts.tasksDir) {
    notes.push(`no task files in ${relPosix(tasksDir)}: --mock uses the test tasks in ${relPosix(MOCK_TASKS_DIR)}`);
    tasksDir = MOCK_TASKS_DIR;
    all = loadTasks(tasksDir);
  }
  if (all.length === 0) throw new Error(`no task files (*.task.json) in ${tasksDir}`);
  const suite = suiteCfg ?? { tasks: [], pick: "all", count: Infinity, modes: ["A", "B", "C"], reps: 1 };
  const tasks = selectTasks(all, suite, opts.tasks);
  if (opts.suite && !opts.tasks && tasks.length < suite.count) {
    notes.push(`suite ${opts.suite} expects ${suite.count} tasks; ${tasks.length} found`);
  }
  const modes = opts.modes ?? suite.modes;
  const reps = opts.reps ?? suite.reps;
  const order = suite.order ?? "shuffle";
  if (!ORDERS.includes(order)) throw new Error(`suite order must be one of ${ORDERS.join(", ")}`);
  const overlay = opts.overlay ?? suite.overlay === true;
  // Isolated sessions (suite field "isolated", overridden by --isolated on|off): no user plugin, hook or MCP server.
  const isolated = opts.isolated ?? suite.isolated === true;
  if (modes.includes("D") && !overlay) throw new Error("mode D needs the overlay (the shims make the placebo): use --overlay on");
  // EXPERIMENT-V04.md: the overlay hook shim delivers the state block of modes F and G.
  // EXPERIMENT-V05.md: the same shim returns the state file of mode H.
  // EXPERIMENT-V06.md: and of mode K (mode H with the sparse paragraph).
  for (const m of ["F", "G", "H", "K"]) if (modes.includes(m) && !overlay) throw new Error(`mode ${m} needs the overlay (the hook shim sends the state block): use --overlay on`);
  // EXPERIMENT-V07.md: the overlay hooks deliver the texts of modes N, T and P.
  for (const m of [...TRIGGER_MODES, ...V08_TRIGGER_MODES, ...V09_TRIGGER_MODES, ...V10_TRIGGER_MODES]) if (modes.includes(m) && !overlay) throw new Error(`mode ${m} needs the overlay (an overlay hook delivers its text): use --overlay on`);
  // EXPERIMENT-V11.md: the plain arms start the Claude host with a benchmark plugin and no user settings.
  for (const m of modes.filter(isPlain)) if (hostName !== "claude") throw new Error(`mode ${m} needs --host claude (a plain session with the benchmark plugin)`);
  // Context Clock v0.3: the hook shim records the product PreCompact output of mode M.
  if (modes.includes("M") && !overlay) throw new Error("mode M needs the overlay (the hook shim records the product PreCompact output): use --overlay on");
  if (overlay && hostName !== "claude") throw new Error("--overlay on needs --host claude");
  let limits = configs.limits ?? loadLimits();
  // EXPERIMENT-V05.md: a suite can carry its own batch token limit (batchTokens). Without it configs/limits.json applies.
  if (suite.batchTokens !== undefined) {
    if (!Number.isInteger(suite.batchTokens) || suite.batchTokens <= 0) throw new Error(`suite ${opts.suite} batchTokens must be a positive integer`);
    limits = { ...limits, batch: { ...limits.batch, totalTokens: suite.batchTokens } };
    notes.push(`suite ${opts.suite} sets the batch token limit to ${suite.batchTokens}`);
  }
  // EXPERIMENT-V07.md: a suite can replace the run time limit (runWallTimeMs) and the tool call limit (runToolCalls).
  // EXPERIMENT-V09.md: and the run token limit (runTotalTokens).
  for (const [field, key] of [["runWallTimeMs", "wallTimeMs"], ["runToolCalls", "toolCalls"], ["runTotalTokens", "totalTokens"]]) {
    if (suite[field] === undefined) continue;
    if (!Number.isInteger(suite[field]) || suite[field] <= 0) throw new Error(`suite ${opts.suite} ${field} must be a positive integer`);
    limits = { ...limits, run: { ...limits.run, [key]: suite[field] } };
    notes.push(`suite ${opts.suite} sets the run limit ${key} to ${suite[field]}`);
  }
  // EXPERIMENT-V07.md: mode T reminds above a context estimate of 40 000 tokens; a suite can set remindThreshold.
  const remindThreshold = suite.remindThreshold ?? DEFAULT_REMIND_THRESHOLD;
  if (!Number.isInteger(remindThreshold) || remindThreshold <= 0) throw new Error(`suite ${opts.suite} remindThreshold must be a positive integer`);
  // EXPERIMENT-V08.md: mode U reminds with the user messages of the stages that the suite names (v08.mjs periodicPlan).
  const periodic = periodicPlan(suite, tasks, modes);
  // EXPERIMENT-V09.md part 2: with autoCompact the runner sends no /compact and records the compactions of the host.
  if (suite.autoCompact !== undefined && typeof suite.autoCompact !== "boolean") throw new Error(`suite ${opts.suite} autoCompact must be true or false`);
  const autoCompact = suite.autoCompact === true;
  if (autoCompact) notes.push(`suite ${opts.suite}: automatic compaction mode, no /compact from the runner`);
  else for (const t of tasks) {
    if (t.profile === "compaction" && !hasCompactionPlan(t)) throw new Error(`task ${t.taskId} has no compaction stage: it needs a suite with autoCompact true`);
    if (t.checkpoint?.timing === "after_auto_compaction") throw new Error(`task ${t.taskId} has probes after automatic compactions: it needs a suite with autoCompact true`);
  }
  // EXPERIMENT-V09.md part 2: the automatic compaction window of the host for the runs of this suite only.
  const autoCompactWindow = suite.autoCompactWindow ?? null;
  if (autoCompactWindow !== null && (!Number.isInteger(autoCompactWindow) || autoCompactWindow < MIN_AUTO_COMPACT_WINDOW)) throw new Error(`suite ${opts.suite} autoCompactWindow must be an integer >= ${MIN_AUTO_COMPACT_WINDOW}`);
  if (autoCompactWindow !== null) notes.push(`suite ${opts.suite} sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=${autoCompactWindow} for its runs`);
  if (periodic) for (const [id, p] of Object.entries(periodic.byTask)) notes.push(`mode U, task ${id}: every ${p.every}, offset ${p.offset} remind ${p.turns.join(", ") || "nothing"}`);
  if (opts.concurrency > limits.batch.maxConcurrency) throw new Error(`--concurrency ${opts.concurrency} is above the limit ${limits.batch.maxConcurrency} (configs/limits.json)`);
  // Mode G: every task needs its reference state (one text for each compaction), checked before any run starts.
  const referenceStates = new Map();
  if (modes.includes("G")) for (const t of tasks) referenceStates.set(t.taskId, loadReferenceState(tasksDir, t));
  const runs = buildRunList({ host: hostName, tasks, modes, reps, seed: opts.seed, order });
  const cfgName = opts.mock ? "mock" : hostName;
  const baseCfg = configs.hosts[cfgName];
  if (!baseCfg) throw new Error(`configs/hosts.json has no entry for ${cfgName}`);
  // The turn time limit caps the host turn timeout (a compaction is a turn too).
  const cap = (v) => (Number.isFinite(limits.run.turnTimeoutMs) ? Math.min(v ?? Infinity, limits.run.turnTimeoutMs) : v);
  const hostCfg = { ...baseCfg, turnTimeoutMs: cap(baseCfg.turnTimeoutMs), compactTimeoutMs: cap(baseCfg.compactTimeoutMs) };
  return {
    hostName, tasksDir, tasks, taskById: new Map(tasks.map((t) => [t.taskId, t])), modes, reps, runs, notes, hostCfg, order, overlay, isolated, limits,
    referenceStates, comparisons: Array.isArray(suite.comparisons) ? [...suite.comparisons] : null, remindThreshold, periodic, autoCompact, autoCompactWindow,
    // v12: a suite can name its model (v12-opus); --model overrides it.
    model: opts.model ?? suite.model ?? hostCfg.defaultModel ?? null,
    sessionMode: sessionModeOf(opts),
    resultsDir: opts.resultsDir ?? paths.resultsDir,
    mockDir: paths.mockDir,
    workRoot: opts.workRoot ?? defaultWorkRoot(),
  };
}

// ---------------------------------------------------------------- run record

/** A run is final when resume must not run it again. */
export function isFinal(record) {
  if (!record || record.schema !== 1) return false;
  if (record.status === "completed" || record.status === "agent_failed" || record.status === "limit_exceeded") return true;
  const kind = record.failure?.kind;
  if (kind === "rate_limit" || kind === "stopped") return false;
  return record.status === "infra_failed" || record.status === "timeout";
}

function runPath(resultsDir, batch, runId) {
  return join(resultsDir, batch, "runs", runId, "run.json");
}

export function readRun(resultsDir, batch, runId) {
  const p = runPath(resultsDir, batch, runId);
  if (!existsSync(p)) return null;
  try {
    return readJson(p);
  } catch {
    return null;
  }
}

/** sha256 of the trimmed text that the product hook prints in mode M. */
export function productCompactSha() {
  return createHash("sha256").update(readFileSync(join(CONFIGS_DIR, PRODUCT_COMPACT_TEXT_FILE), "utf8").trim(), "utf8").digest("hex");
}

function envRecord(mode, plan = null) {
  const v = MODE_ENV[mode];
  const out = { CTX_CLOCK: v.CTX_CLOCK, CTX_CLOCK_FEEDBACK: v.CTX_CLOCK_FEEDBACK };
  for (const k of ["CCB_FEEDBACK", "CCB_RETURN_STATE"]) if (k in v) out[k] = v[k];
  // Context Clock v0.3: in a batch with mode M, CTX_CLOCK_COMPACT (unset, null, in mode M and "off" in every other
  // mode). The runner sets it in every batch; older batches keep their record.
  if (plan?.modes?.includes("M")) out.CTX_CLOCK_COMPACT = PRODUCT_COMPACT_MODES.includes(mode) ? null : "off";
  // Isolated sessions: the variable that turns the claude.ai connectors off.
  if (plan?.isolated) Object.assign(out, ISOLATED_ENV);
  // EXPERIMENT-V09.md part 2: the automatic compaction window of the suite, when it sets one.
  if (plan?.autoCompactWindow) out.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(plan.autoCompactWindow);
  return out;
}

/** The run limits in force, as recorded in run.json. */
function limitsRecord(plan) {
  return { wallTimeMs: plan.limits.run.wallTimeMs, turnTimeoutMs: plan.hostCfg.turnTimeoutMs, toolCalls: plan.limits.run.toolCalls, totalTokens: plan.limits.run.totalTokens };
}

/** Channels of a host result without channel data: every snapshot counts as "other", so the total stays equal. */
function unclassified(snap) {
  const ch = emptyChannels();
  ch.other = { count: snap?.count ?? 0, bytes: snap?.bytes ?? 0 };
  return ch;
}

function turnRecord(kind, stage, r) {
  return {
    kind, stage, exitCode: r.exitCode ?? null, timedOut: r.timedOut === true, durationMs: r.durationMs ?? 0,
    usage: { ...EMPTY_USAGE, ...(r.usage ?? {}) },
    toolCalls: countByName(r.toolCalls ?? []),
    clockSnapshots: r.clockSnapshots ?? { count: 0, bytes: 0 },
    compactBoundary: r.compactBoundary === true,
    // Extra field: the snapshots of this turn by delivery channel (tool_reply, hook_context, session_start, other).
    clockSnapshotsByChannel: r.clockChannels ? addChannels(emptyChannels(), r.clockChannels) : unclassified(r.clockSnapshots),
  };
}

export function summarizeTelemetry(turns, clock) {
  let usage = { ...EMPTY_USAGE };
  const byName = {};
  let feedbackCount = 0;
  let feedbackBytes = 0;
  let byChannel = emptyChannels();
  for (const t of turns) {
    byChannel = addChannels(byChannel, t.clockSnapshotsByChannel);
    usage = addUsage(usage, t.usage);
    for (const [k, v] of Object.entries(t.toolCalls)) byName[k] = (byName[k] ?? 0) + v;
    feedbackCount += t.clockSnapshots.count;
    feedbackBytes += t.clockSnapshots.bytes;
  }
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
    toolCalls: Object.values(byName).reduce((a, b) => a + b, 0),
    toolCallsByName: byName,
    clockFeedbackCount: feedbackCount,
    clockFeedbackBytes: feedbackBytes,
    clockFeedbackByChannel: byChannel,
    clock: {
      events: clock?.events ?? 0, maxTick: clock?.maxTick ?? 0, stateRevision: clock?.stateRevision ?? 0,
      statusCalls: countShort(byName, "ctx_clock_status"), commitCalls: countShort(byName, "ctx_clock_commit"),
    },
    searchCalls: countShort(byName, "ctx_search"),
  };
}

class TurnFailure extends Error {
  constructor(status, kind, message, limitHit = null) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.limitHit = limitHit;
  }
}

function limitFailure(name) {
  return new TurnFailure("limit_exceeded", "limit", `run limit ${name} exceeded`, name);
}

/** Map a turn result to a failure, or null. A stop at the turn limit is agent behavior, not a host failure. */
export function turnFailure(r, { needSession }) {
  if (r.timedOut) return new TurnFailure("timeout", "timeout", "turn timeout");
  if (r.rateLimited) return new TurnFailure("infra_failed", "rate_limit", r.errorText || "rate or usage limit");
  const maxTurns = r.resultSubtype === "error_max_turns";
  if (r.isError && !maxTurns) return new TurnFailure("infra_failed", "cli_error", r.errorText || `exit code ${r.exitCode}`);
  if (needSession && !r.sessionId) return new TurnFailure("infra_failed", "no_session", "the host reported no session id");
  return null;
}

// ---------------------------------------------------------------- one attempt

async function runAttempt(ctx, run, task, attempt) {
  const { host, plan, opts } = ctx;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const turns = [];
  const compactions = [];
  const streams = [];
  let sessionId = null;
  let model = null;
  let status = "completed";
  let failure = null;
  const answers = { final: null, checkpoint: null, finalParseError: null };
  let clock = null;
  let integrity = { violations: [] };
  let hooks = null;
  let limitHit = null;
  let shim = null;
  let guard = null;
  let stateBlock = null;
  let commits = emptyCommits(0);
  let stateFile = emptyStateFile(0);
  let triggers = null;
  // EXPERIMENT-V07.md: the shim log line count after each turn, so that a reminder line names the turn that wrote it.
  const marks = [];

  const rawDir = join(plan.resultsDir, opts.batch, "raw", run.runId, `a${attempt}`);
  mkdirSync(rawDir, { recursive: true });
  let ws = null;
  try {
    ws = createWorkspace(plan.workRoot, run.runId, attempt);
    // Plan step 2.6: the task files go into the workspace before the session starts; the runner never removes them.
    writeWorkspaceFiles(ws.dir, task.workspace?.files);
  } catch (err) {
    if (ws && !opts.keep) removeWorkspace(ws);
    return { startedAt, durationMs: Date.now() - t0, status: "infra_failed", failure: { kind: "workspace_error", message: String(err.message) }, turns, compactions, answers, sessionId, model, telemetry: withExtras(withHooks(summarizeTelemetry(turns, null), null), null, null, ctx.overlay ? emptyStateBlock() : null, emptyCommits(0), emptyStateFile(0), ctx.overlay ? emptyTriggers() : null), integrity, limitHit, pairs: [], tokens: 0 };
  }
  const pairs = [[REPO_ROOT, "<repo>"], ...redactionPairs({ workspace: ws.dir, dataDir: ws.dataDir, workRoot: plan.workRoot, overlay: ctx.overlay?.pluginDir ?? null })];
  const periodicOfTask = plan.periodic?.byTask?.[run.taskId];
  const env = modeEnv(run.mode, ws.dataDir, process.env, ws.dir, {
    remindThreshold: plan.remindThreshold ?? DEFAULT_REMIND_THRESHOLD,
    ...(periodicOfTask ? { periodic: { every: periodicOfTask.every, offset: periodicOfTask.offset } } : {}),
    autoCompactWindow: plan.autoCompactWindow ?? null,
  });
  const cfg = plan.hostCfg;
  // EXPERIMENT-V05.md: mode H adds Write to the stage tools (one Write call on clock-state.md).
  // EXPERIMENT-V11.md: a plain run gets no Context Mode tool in its tool list.
  const plainMode = isPlain(run.mode);
  const tools = toolsOfRun(cfg, run.mode, task);
  // Overlay (EXPERIMENT-V03.md): per-run log files in the data folder, workspace and overlay folders for the guard,
  // and a settings file that disables the installed plugin.
  const ov = ctx.overlay && !plainMode ? runOverlay({ overlay: ctx.overlay, env, workspace: ws.dir, dataDir: ws.dataDir }) : null;
  // EXPERIMENT-V11.md: the plain arms run with the benchmark plugin of their mode and no user settings.
  // v12: in a batch with mode Z, every plain run writes the host debug log (the same flags for Z and its references).
  const hostDebug = plan.modes.some((m) => STANDALONE_MODES.includes(m));
  const pl = plainMode ? runPlain({ plain: ctx.plain[run.mode], env, workspace: ws.dir, dataDir: ws.dataDir, hostDebug }) : null;
  const hookLog = ov?.shimLog ?? pl?.shimLog ?? null;
  // Isolated sessions: the claude.ai connectors off for this host process only; no global setting changes.
  if (plan.isolated) Object.assign(env, ISOLATED_ENV);
  let sessionParts = null;
  // v12 mode Z: one entry for each compaction, { trigger, segments } from the "Compacted" message of the host stream.
  const standaloneEvents = [];
  let instructionFiles = null;
  // `mock` is read only by the mock host: it selects the recorded transcript of this run.
  const common = {
    workspace: ws.dir, env, model: plan.model, rawDir, mock: { taskId: run.taskId, mode: run.mode, rep: run.rep, attempt },
    ...(ov ? { pluginDir: ov.pluginDir, settingsPath: ov.settingsPath, ...(plan.isolated ? { isolation: OVERLAY_ISOLATION } : {}) } : {}),
    // v12 mode Z: two plugin folders (the benchmark plugin and the standalone plugin), one --plugin-dir each.
    ...(pl ? { pluginDir: pl.pluginDirs.length > 1 ? pl.pluginDirs : pl.pluginDir, settingsPath: pl.settingsPath, isolation: pl.isolation } : {}),
  };
  const monitor = createLimitMonitor({ limits: plan.limits.run, deterministic: ctx.info.deterministic === true });
  // EXPERIMENT-V06.md: costUsd of each turn, as the increment of the host session total (never a sum of totals).
  const costs = createCostTracker();
  const costOf = (streamPath) => {
    let text = null;
    try {
      text = streamPath && existsSync(streamPath) ? readFileSync(streamPath, "utf8") : null;
    } catch {
      text = null;
    }
    return { cost: costs.next(hostCostOf(text)), text };
  };

  // Persistent mode: one host process for the whole attempt (one SessionStart, as in a real long session).
  let session = null;
  if (plan.sessionMode === "persistent") {
    if (typeof host.openSession !== "function") throw new Error(`host ${plan.hostName} has no persistent session mode`);
    session = await host.openSession({ ...common, allowedTools: tools, sessionMode: "persistent" });
  }
  const via = session ?? host;
  const mark = (label) => {
    if (hookLog) marks.push({ turn: label, lines: shimLineCount(hookLog) });
  };

  const turn = async (kind, stage, prompt, extra, label = stage ? `${kind}-${stage}` : kind) => {
    if (monitor.beforeTurn()) throw limitFailure(monitor.hit);
    const live = monitor.beginTurn();
    const r = await via.runTurn({ ...common, ...extra, prompt, sessionId, label, timeoutMs: cfg.turnTimeoutMs, onLine: live.onLine, signal: live.signal });
    mark(label);
    const ct = costOf(r.streamPath);
    // EXPERIMENT-V11.md: the plugins, MCP servers, tools, skills and commands of the session, from its init lines.
    sessionParts = mergeParts(sessionParts, initPartsOf(ct.text));
    // EXPERIMENT-V09.md: the context size after each turn.
    const rec = { ...turnRecord(kind, stage, r), costUsd: ct.cost, contextTokens: contextTokensOf(ct.text) };
    turns.push(rec);
    // EXPERIMENT-V09.md part 2: each compaction that the host made by itself during this turn.
    let autoCompactions = 0;
    if (plan.autoCompact) {
      const found = autoCompactionEntries(ct.text, { afterStage: stage ?? (kind === "final" ? task.stages.length : 0), turn: label });
      compactions.push(...found);
      autoCompactions = found.length;
      // v12 mode Z: Claude Code 2.1.331 records no PreCompact output for an automatic compaction (segments null).
      if (pl?.standalone && found.length > 0) {
        const recs = compactStdoutRecords(ct.text);
        found.forEach((_, i) => standaloneEvents.push({ trigger: "auto", segments: recs[i] ?? null }));
      }
    }
    if (r.streamPath) streams.push({ turn: label, path: r.streamPath });
    if (!model && r.model) model = r.model;
    if (r.sessionId) sessionId = r.sessionId;
    // A run limit wins over the turn result: the host killed the run's process tree because the limit tripped.
    if (monitor.endTurn(rec)) throw limitFailure(monitor.hit);
    const f = turnFailure(r, { needSession: true });
    if (f) throw f;
    return { ...r, autoCompactions };
  };
  const probes = checkpointsOf(task);
  const askProbes = async (stageNo, afterCompaction) => {
    const list = probes.filter((c) => c.afterStage === stageNo && c.afterCompaction === afterCompaction);
    for (const c of list) {
      // Probe turns keep the order of the task file. The label stays checkpoint-<stage> for the first one of a stage.
      const label = probeLabel(probes, c, stageNo);
      const r = await turn("checkpoint", stageNo, checkpointPrompt({ checkpoint: c }), { allowedTools: [], disallowedTools: tools, maxTurns: cfg.questionMaxTurns }, label);
      const p = parseAnswers(r.resultText, c.questions);
      answers.checkpoint = { ...(answers.checkpoint ?? {}), ...(p.answers ?? {}) };
    }
  };

  try {
    if (!ws.git) throw new TurnFailure("infra_failed", "workspace_error", "git init failed in the workspace");
    const stageTools = { allowedTools: tools };
    await turn("intro", null, introPrompt(task), { allowedTools: [], disallowedTools: tools, maxTurns: cfg.introMaxTurns });
    for (const stage of task.stages) {
      const written = writeStageMaterial(ws.dir, stage);
      let stageResult = null;
      try {
        // EXPERIMENT-V04.md: modes E and F end each stage message with the commit paragraph (V05: mode H, the state file paragraph).
        stageResult = await turn("stage", stage.stage, stageMessage(stagePrompt(task, stage), run.mode, stage), { ...stageTools, maxTurns: cfg.stageMaxTurns });
      } finally {
        removeStageMaterial(ws.dir, written);
      }
      // EXPERIMENT-V09.md part 2: in the automatic mode no probe comes before a compaction.
      if (!plan.autoCompact) await askProbes(stage.stage, false);
      if (plan.autoCompact) {
        // EXPERIMENT-V09.md part 2: the probes of this stage boundary only after an automatic compaction in its turn.
        if (stageResult?.autoCompactions > 0) await askProbes(stage.stage, true);
      } else if (stage.compactAfter === true) {
        if (monitor.beforeTurn()) throw limitFailure(monitor.hit);
        // Mode G: the reference state of this stage, for the hook shim of the coming SessionStart:compact.
        // (Mode H also sets CCB_STATE_FILE, but there the agent writes the file.)
        if (env.CCB_RETURN_STATE === "reference" && env.CCB_STATE_FILE) {
          const ref = plan.referenceStates?.get(task.taskId);
          if (!ref) throw new TurnFailure("infra_failed", "reference_state", `no reference state for ${task.taskId}`);
          try {
            writeReferenceState(env.CCB_STATE_FILE, ref, stage.stage);
          } catch (err) {
            throw new TurnFailure("infra_failed", "reference_state", String(err?.message ?? err));
          }
        }
        // EXPERIMENT-V06.md: directly before /compact, in every mode, copy the state file of the agent to the raw folder.
        let copy;
        try {
          copy = copyStateFile(ws.dir, rawDir, stage.stage);
        } catch (err) {
          throw new TurnFailure("infra_failed", "state_file_copy", String(err?.message ?? err));
        }
        // EXPERIMENT-V05.md: mode S sends "/compact <instruction>"; every other mode sends the plain "/compact".
        const instruction = compactInstructionOf(run.mode);
        const live = monitor.beginTurn();
        const c = await via.compact({ ...common, sessionId, label: `compact-${stage.stage}`, timeoutMs: cfg.compactTimeoutMs, onLine: live.onLine, signal: live.signal, instruction });
        mark(`compact-${stage.stage}`);
        const cc = costOf(c.streamPath);
        const rec = { ...turnRecord("compact", stage.stage, { ...c, toolCalls: [], compactBoundary: c.confirmed }), compactInstruction: instruction !== null, costUsd: cc.cost, contextTokens: contextTokensOf(cc.text) };
        turns.push(rec);
        if (c.streamPath) streams.push({ turn: `compact-${stage.stage}`, path: c.streamPath });
        compactions.push({ afterStage: stage.stage, confirmed: c.confirmed === true, mechanism: c.mechanism, ...copy, preTokens: preTokensOf(cc.text), trigger: "manual" });
        // v12 mode Z: the PreCompact outputs that the host lists in its "Compacted" message of this compaction.
        if (pl?.standalone) {
          const recs = compactStdoutRecords(cc.text);
          standaloneEvents.push({ trigger: "manual", segments: recs.length > 0 ? recs.flat() : null });
        }
        if (monitor.endTurn(rec)) throw limitFailure(monitor.hit);
        if (c.timedOut) throw new TurnFailure("timeout", "timeout", "compaction turn timeout");
        if (c.rateLimited) throw new TurnFailure("infra_failed", "rate_limit", c.errorText || "rate or usage limit");
        // CONTRACT.md: confirmed only with a compaction marker in the host stream. An unconfirmed compaction stays in
        // `compactions` with confirmed: false, the run goes on, and the grader counts only confirmed compactions.
        await askProbes(stage.stage, true);
      }
    }
    // Plan step 2.6: with no final questions, the final turn sends final.prompt and parses no answers.
    const workFinal = task.final.questions.length === 0;
    // A work task (workspace.collect) writes its result in the final turn, with the session tools (finalTurnOf).
    const r = await turn("final", null, workFinal ? task.final.prompt : finalPrompt(task), finalTurnOf(tools, task, cfg));
    const p = workFinal ? { answers: {}, error: null } : parseAnswers(r.resultText, task.final.questions);
    answers.final = p.answers;
    answers.finalParseError = p.error;
    if (p.error) {
      status = "agent_failed";
      failure = { kind: "no_final_answer", message: p.error };
    }
  } catch (err) {
    if (err instanceof TurnFailure) {
      status = err.status;
      failure = { kind: err.kind, message: err.message };
      limitHit = err.limitHit;
    } else {
      status = "infra_failed";
      failure = { kind: "runner_error", message: String(err?.stack ?? err).slice(0, 1000) };
    }
  } finally {
    monitor.stop();
    if (session) {
      try {
        await session.close();
      } catch {
        // the attempt result stands; close only ends the process
      }
    }
    try {
      clock = readClockTelemetry(ws.dataDir);
      const dbs = findContextDbs(ws.dataDir);
      if (dbs.length > 0) {
        const evidence = join(plan.resultsDir, opts.batch, "work", run.runId, `a${attempt}`);
        mkdirSync(evidence, { recursive: true });
        dbs.forEach((p, i) => copyFileSync(p, join(evidence, dbs.length === 1 ? "context.db" : `context-${i + 1}.db`)));
      }
      const inputs = [];
      const texts = [];
      for (const s of streams) {
        if (!existsSync(s.path)) continue;
        const text = readFileSync(s.path, "utf8");
        texts.push({ turn: s.turn, text });
        for (const ti of host.toolInputs(text)) inputs.push({ turn: s.turn, name: ti.name, input: ti.input });
      }
      // EXPERIMENT-V04.md: telemetry.commits from the stream (Claude stream format; the mock writes the same format).
      commits = commitTelemetry(texts, turns.filter((t) => t.kind === "stage").length);
      // EXPERIMENT-V05.md: telemetry.stateFile (Write or Edit calls on clock-state.md), in every mode.
      stateFile = stateFileTelemetry(texts, turns.filter((t) => t.kind === "stage").length);
      integrity = { violations: integrityScan(inputs, ws.dir) };
    } catch (err) {
      integrity = { violations: [], error: String(err?.message ?? err) };
    }
    // The hook_context channel is not in the Claude stream; the host reads it from its session transcript.
    if (typeof host.hookTelemetry === "function") {
      try {
        hooks = host.hookTelemetry({ workspace: ws.dir, sessionId, rawDir });
      } catch {
        hooks = null;
      }
    }
    // The CLAUDE.md files that the host loaded, from the "instructions" attachments of the transcript copy, if any.
    try {
      const tp = join(rawDir, "transcript.jsonl");
      instructionFiles = existsSync(tp) ? instructionFilesOf(readFileSync(tp, "utf8")) : null;
    } catch {
      instructionFiles = null;
    }
    if (ov) {
      try {
        keepLogs(ov, rawDir);
        shim = readShimLog(ov.shimLog);
        guard = readGuardLog(ov.guardLog);
        stateBlock = readStateBlockLog(ov.shimLog);
        triggers = triggerTelemetry(ov.shimLog, marks);
      } catch (err) {
        shim = { byChannel: readShimLog(null).byChannel, errors: 1, readError: String(err?.message ?? err) };
        guard = guard ?? { denied: 0, byTool: {} };
        stateBlock = stateBlock ?? emptyStateBlock();
        triggers = triggers ?? emptyTriggers();
      }
    } else if (pl) {
      // EXPERIMENT-V11.md: a plain run has no shim, so telemetry.shim and stateBlock stay null (not applicable). The
      // guard log and the PreCompact hook log of arm I read as in the overlay runs.
      try {
        keepPlainLogs(pl, rawDir);
        guard = readGuardLog(pl.guardLog);
        triggers = triggerTelemetry(pl.shimLog, marks);
        // v12: the PreCompact lines of the host debug log go to the raw folder; the rest of the log is not kept.
        let debugText = null;
        if (pl.debugFile && existsSync(pl.debugFile)) {
          debugText = readFileSync(pl.debugFile, "utf8");
          writeFileSync(join(rawDir, "host-debug-precompact.txt"), preCompactDebugLines(debugText).join("\n") + "\n");
        }
        if (pl.standalone) {
          const commands = pl.standalone.hooks.filter((h) => h.event === "PreCompact").map((h) => h.command);
          triggers.precompactStandalone = standaloneTelemetry(standaloneEvents, commands, debugText === null ? null : hostDebugRuns(debugText, commands));
        }
      } catch {
        guard = guard ?? { denied: 0, byTool: {} };
        triggers = triggers ?? emptyTriggers();
      }
    }
    // Plan step 2.6: copy the workspace.collect paths to runs/<runId>/workspace/ before the workspace is deleted. A later
    // attempt replaces the copy of an earlier one; workspace-collect.json lists what was copied and skipped.
    if (Array.isArray(task.workspace?.collect)) {
      const runDir = join(plan.resultsDir, opts.batch, "runs", run.runId);
      let manifest;
      try {
        manifest = { attempt, ...collectWorkspace(ws.dir, task.workspace.collect, join(runDir, "workspace"), pairs) };
      } catch (err) {
        manifest = { attempt, error: redact(String(err?.message ?? err), pairs) };
      }
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "workspace-collect.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    if (!opts.keep) removeWorkspace(ws);
  }
  // Isolated sessions: a plugin or MCP server outside the allowed list makes the run infra_failed (never retried).
  if (plan.isolated && sessionParts && status !== "infra_failed") {
    const bad = isolationViolations(sessionParts, run.mode, ctx.overlayInfo?.name ?? "context-mode", pl?.standalone?.name);
    if (bad.length > 0) {
      status = "infra_failed";
      failure = { kind: "isolation_violation", message: `isolated session had parts outside the allowed list: ${bad.join(", ")}` };
      limitHit = null;
    }
  }
  // EXPERIMENT-V03.md: a shim failure could let a real snapshot through (or drop one), so the run is infra_failed.
  if (shim && shim.errors > 0 && status !== "infra_failed") {
    status = "infra_failed";
    failure = { kind: "shim_error", message: `${shim.errors} shim error(s) in the shim log` };
    limitHit = null;
  }
  // A deterministic host (the mock) reports recorded turn durations; the run duration is then their sum, never wall time.
  const durationMs = ctx.info.deterministic ? turns.reduce((n, t) => n + (t.durationMs ?? 0), 0) : Date.now() - t0;
  const telemetry = withExtras(withHooks(summarizeTelemetry(turns, clock), hooks), shim, guard, stateBlock, commits, stateFile, triggers, totalCostUsd(turns));
  return {
    startedAt, durationMs, status, failure, turns, compactions, answers, sessionId, model, limitHit,
    telemetry, integrity, pairs, workspace: opts.keep ? ws : null, tokens: usageTokens(telemetry), sessionParts, instructionFiles,
    // v12 mode W: the CLAUDE.md that the runner wrote, and whether the host listed it as a loaded instruction file.
    claudeMd: pl?.claudeMd ? { written: true, path: pl.claudeMd.path, file: pl.claudeMd.file, bytes: pl.claudeMd.bytes, sha256: pl.claudeMd.sha256, loaded: claudeMdLoaded(instructionFiles, pl.claudeMd.path) } : null,
  };
}

/** telemetry.stateBlock of an overlay run with no state block line. */
export function emptyStateBlock() {
  return { deliveries: 0, missing: 0, bytes: 0, findings: 0, cuts: 0 };
}

/**
 * telemetry.shim and telemetry.guard (EXPERIMENT-V03.md), null when the run had no overlay. telemetry.stateBlock
 * (from the shim log, null without the overlay) and telemetry.commits (from the stream) (EXPERIMENT-V04.md).
 * telemetry.stateFile: the writes of clock-state.md (from the stream) (EXPERIMENT-V05.md).
 * telemetry.triggers: the trigger hooks of modes N, T and P (from the shim log, null without the overlay) (EXPERIMENT-V07.md),
 * and of mode U (triggers.periodic, EXPERIMENT-V08.md). telemetry.costUsd: the sum of the turn costs in dollars as the
 * host reports them, null when no turn has one (EXPERIMENT-V08.md).
 */
export function withExtras(telemetry, shim, guard, stateBlock = null, commits = null, stateFile = null, triggers = null, costUsd = null) {
  return { ...telemetry, shim: shim ?? null, guard: guard ?? null, stateBlock: stateBlock ?? null, commits: commits ?? emptyCommits(0), stateFile: stateFile ?? emptyStateFile(0), triggers: triggers ?? null, costUsd: costUsd ?? null };
}

/**
 * Merge the host's hook telemetry. With source "transcript" the hook_context channel comes from the transcript
 * (the stream never shows it) and the totals include it. `clockHooks` records the source and the PostToolUse outcomes.
 */
export function withHooks(telemetry, hooks) {
  const out = { ...telemetry, clockHooks: { source: "stream", postToolUse: null } };
  if (!hooks) return out;
  out.clockHooks = { source: hooks.source, postToolUse: hooks.postToolUse ?? null };
  if (hooks.source !== "transcript") return out;
  const prev = telemetry.clockFeedbackByChannel.hook_context;
  const next = hooks.hookContext ?? { count: 0, bytes: 0 };
  out.clockFeedbackByChannel = { ...telemetry.clockFeedbackByChannel, hook_context: { ...next } };
  out.clockFeedbackCount = telemetry.clockFeedbackCount - prev.count + next.count;
  out.clockFeedbackBytes = telemetry.clockFeedbackBytes - prev.bytes + next.bytes;
  return out;
}

function buildRecord(ctx, run, a, attempts) {
  const task = ctx.taskOf(run);
  const rec = {
    schema: 1,
    runId: run.runId,
    batch: ctx.opts.batch,
    host: run.host,
    taskId: run.taskId,
    mode: run.mode,
    rep: run.rep,
    profile: run.profile,
    order: run.order,
    status: a.status,
    failure: a.failure,
    attempts,
    startedAt: a.startedAt,
    durationMs: a.durationMs,
    cli: { version: ctx.info.cliVersion, model: a.model ?? ctx.plan.model },
    env: envRecord(run.mode, ctx.plan),
    sessionId: a.sessionId,
    turns: a.turns,
    compactions: a.compactions,
    answers: a.answers,
    telemetry: a.telemetry,
    integrity: a.integrity,
    sessionMode: ctx.plan.sessionMode,
    overlay: ctx.overlay ? { sourceSha: ctx.overlay.sourceSha } : null,
    limits: limitsRecord(ctx.plan),
    limitHit: a.limitHit ?? null,
    // EXPERIMENT-V11.md: the configuration and the reported parts of the host session.
    session: sessionRecord({
      mode: run.mode, plainRun: ctx.plain?.[run.mode] ?? null, overlay: Boolean(ctx.overlay) && !isPlain(run.mode), parts: a.sessionParts ?? null,
      isolated: ctx.plan.isolated === true, overlayHooks: ctx.overlayInfo?.hooks ?? null, overlayPluginName: ctx.overlayInfo?.name ?? "context-mode",
      standalone: ctx.plain?.[run.mode]?.standalone ?? null, instructionFiles: a.instructionFiles ?? null, claudeMd: a.claudeMd ?? null,
    }),
  };
  // Work tasks: the tool grants of the run (session.permissions), for every run.
  rec.session.permissions = permissionsOfRun(ctx, run, task);
  return rec;
}

/**
 * The stage tools of a run. EXPERIMENT-V05.md: mode H adds Write. EXPERIMENT-V11.md: a plain run gets no Context Mode
 * tool. A work task adds Write and Edit (sessionToolsOf).
 */
function toolsOfRun(cfg, mode, task) {
  const plainMode = isPlain(mode);
  return sessionToolsOf(stageToolsOf(cfg.stageTools, mode).filter((t) => !(plainMode && CONTEXT_MODE_NAME.test(t))), task);
}

function permissionsOfRun(ctx, run, task) {
  const cfg = ctx.plan.hostCfg;
  return permissionsRecord({ tools: toolsOfRun(cfg, run.mode, task), task, cfg, guard: isPlain(run.mode) || Boolean(ctx.overlay) });
}

function notExecutableRecord(ctx, run) {
  const rec = {
    schema: 1, runId: run.runId, batch: ctx.opts.batch, host: run.host, taskId: run.taskId, mode: run.mode, rep: run.rep,
    profile: run.profile, order: run.order, status: "infra_failed",
    failure: { kind: "profile_not_executable", message: `profile compaction needs a host compaction; ${ctx.info.compactMechanism}` },
    attempts: [], startedAt: new Date().toISOString(), durationMs: 0,
    cli: { version: ctx.info.cliVersion, model: ctx.plan.model }, env: envRecord(run.mode, ctx.plan), sessionId: null, turns: [],
    compactions: ctx.taskOf(run).stages.filter((s) => s.compactAfter === true).map((s) => ({ afterStage: s.stage, confirmed: false, mechanism: ctx.info.compactMechanism })),
    answers: { final: null, checkpoint: null, finalParseError: null },
    telemetry: withExtras(withHooks(summarizeTelemetry([], null), null), null, null, ctx.overlay ? emptyStateBlock() : null, emptyCommits(0), emptyStateFile(0), ctx.overlay ? emptyTriggers() : null), integrity: { violations: [] }, sessionMode: ctx.plan.sessionMode,
    overlay: ctx.overlay ? { sourceSha: ctx.overlay.sourceSha } : null, limits: limitsRecord(ctx.plan), limitHit: null,
    session: sessionRecord({ mode: run.mode, plainRun: ctx.plain?.[run.mode] ?? null, overlay: Boolean(ctx.overlay) && !isPlain(run.mode), parts: null, isolated: ctx.plan.isolated === true, standalone: ctx.plain?.[run.mode]?.standalone ?? null, instructionFiles: null }),
  };
  rec.session.permissions = permissionsOfRun(ctx, run, ctx.taskOf(run));
  return rec;
}

/** All attempts of one run. Returns the saved record. */
async function runOne(ctx, run) {
  const task = ctx.taskOf(run);
  const out = runPath(ctx.plan.resultsDir, ctx.opts.batch, run.runId);
  if (task.profile === "compaction" && !ctx.info.canCompact) {
    const rec = notExecutableRecord(ctx, run);
    writeJsonAtomic(out, rec);
    return rec;
  }
  const attempts = [];
  let rec = null;
  const maxAttempts = 1 + (ctx.plan.limits.run.retries ?? MAX_ATTEMPTS - 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if ((ctx.stopping || ctx.budgetStopped) && attempt > 1) break;
    const a = await runAttempt(ctx, run, task, attempt);
    ctx.tokensUsed += a.tokens ?? 0;
    attempts.push(redact({ attempt, status: a.status, failure: a.failure, durationMs: a.durationMs }, a.pairs));
    rec = redact(buildRecord(ctx, run, a, [...attempts]), a.pairs);
    writeJsonAtomic(out, rec);
    if (a.workspace) ctx.log(`  kept workspace ${a.workspace.dir} and data ${a.workspace.dataDir}`);
    // An isolation violation is a property of the host setup: a retry would hide it.
    const retriable = (a.status === "infra_failed" || a.status === "timeout") && a.failure?.kind !== "rate_limit" && a.failure?.kind !== "isolation_violation";
    if (!retriable) break;
  }
  return rec;
}

// ---------------------------------------------------------------- batch

function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "benchmarks/context-clock"], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  return { commit: r.status === 0 ? r.stdout.trim() : null, benchmarkDirty: dirty.status === 0 ? dirty.stdout.trim() !== "" : null };
}

async function loadHost(opts, injected, mockDir) {
  if (injected) return injected;
  if (opts.mock) return (await import("./hosts/mock.mjs")).createMockHost({ mockDir });
  return import(pathToFileURL(join(HERE, "hosts", `${opts.host}.mjs`)).href);
}

function invocationsPath(ctx) {
  return join(ctx.plan.resultsDir, ctx.opts.batch, "invocations.json");
}

function readInvocations(ctx) {
  const p = invocationsPath(ctx);
  const doc = existsSync(p) ? readJson(p) : {};
  return { invocations: doc.invocations ?? [], budget: doc.budget ?? null, budgetStopped: doc.budgetStopped ?? null };
}

function writeInvocations(ctx, invocation) {
  const prev = readInvocations(ctx);
  const pairs = [[REPO_ROOT, "<repo>"], ...redactionPairs({ workspace: null, dataDir: null, workRoot: ctx.plan.workRoot, overlay: ctx.overlay?.pluginDir ?? null })];
  invocation.tokens = ctx.tokensUsed;
  invocation.wallMs = Date.now() - ctx.t0;
  writeJsonAtomic(invocationsPath(ctx), redact({
    schema: 1, batch: ctx.opts.batch, budget: ctx.budget, budgetStopped: ctx.budgetMark ?? null,
    invocations: [...prev.invocations.filter((x) => x.id !== invocation.id), invocation],
  }, pairs));
}

function writeBatchFile(ctx, invocation) {
  const { opts, plan, info } = ctx;
  const p = join(plan.resultsDir, opts.batch, "batch.json");
  const runOrder = plan.runs.map((r) => r.runId);
  const prev = existsSync(p) ? readJson(p) : null;
  if (prev && JSON.stringify(prev.runOrder) !== JSON.stringify(runOrder)) {
    throw new Error(`batch ${opts.batch} exists with a different run list. Use a new --batch name, or the same options as before.`);
  }
  const git = gitCommit();
  const doc = {
    schema: 1,
    batch: opts.batch,
    host: plan.hostName,
    mock: opts.mock,
    suite: opts.suite,
    model: plan.model,
    seed: opts.seed,
    modes: plan.modes,
    reps: plan.reps,
    tasksDir: relPosix(plan.tasksDir),
    taskSeeds: Object.fromEntries(plan.tasks.map((t) => [t.taskId, t.seed ?? null])),
    cli: { name: plan.hostName, version: info.cliVersion },
    compactMechanism: info.compactMechanism,
    canCompact: info.canCompact,
    sessionMode: plan.sessionMode,
    overlay: ctx.overlay ? { pluginDir: ctx.overlay.pluginDir, sourceSha: ctx.overlay.sourceSha } : null,
    limits: plan.limits,
    order: plan.order,
    blocks: plan.order === "block" ? blocksOf(plan.runs) : null,
    // EXPERIMENT-V04.md: the comparisons of the suite (the analysis reads them), and the commit paragraph of modes E, F.
    comparisons: plan.comparisons ?? null,
    commitInstruction: plan.modes.some((m) => COMMIT_MODES.includes(m)) ? { file: "configs/commit-instruction.txt", sha256: commitInstructionSha() } : null,
    // EXPERIMENT-V05.md: the state file paragraph (mode H) and the compaction instruction (mode S), or null.
    ...instructionRecords(plan.modes),
    // EXPERIMENT-V07.md: the standing instruction (mode N), the reminder and its threshold (mode T), or null.
    ...triggerRecords(plan.modes, plan.remindThreshold ?? DEFAULT_REMIND_THRESHOLD),
    // EXPERIMENT-V08.md: the reminder of mode U with its mapping to stage messages, the PreCompact text of mode Q, or null.
    ...v08Records(plan.modes, plan.periodic ?? null),
    // EXPERIMENT-V09.md: the PreCompact text of mode R, and the automatic compaction mode of the suite.
    ...v09Records(plan.modes),
    // EXPERIMENT-V10.md: the PreCompact text of mode V, or null.
    ...v10Records(plan.modes),
    // Context Clock v0.3: the text that the product hook prints in mode M, or null.
    // Isolated sessions: the flags and the host environment that give the isolation, or null.
    isolated: plan.isolated === true,
    isolation: plan.isolated ? { settingSources: PLAIN_SETTING_SOURCES, strictMcpConfigOverlay: false, strictMcpConfigPlain: true, env: { ...ISOLATED_ENV } } : null,
    // EXPERIMENT-V11.md: the plain plugins (hooks, isolation flags) and the PreCompact text of mode I, or null.
    ...plainBatchRecord(ctx.plain, { file: `configs/${TRIGGER_ENV.I.CCB_PRECOMPACT_FILE}`, sha256: productCompactSha() }),
    precompactProductInstruction: plan.modes.includes("M") ? { file: `configs/${PRODUCT_COMPACT_TEXT_FILE}`, sha256: productCompactSha() } : null,
    autoCompact: plan.autoCompact === true,
    autoCompactWindow: plan.autoCompactWindow ?? null,
    promptVersion: PROMPT_VERSION,
    benchmarkCommit: git.commit,
    benchmarkDirty: git.benchmarkDirty,
    os: { platform: platform(), release: release(), arch: arch() },
    node: process.version,
    runOrder,
  };
  const pairs = [[REPO_ROOT, "<repo>"], ...redactionPairs({ workspace: null, dataDir: null, workRoot: plan.workRoot, overlay: ctx.overlay?.pluginDir ?? null })];
  writeJsonAtomic(p, redact(doc, pairs));
  // Wall times stay out of batch.json: the analysis prints batch.json in the report, and mock reports must not change.
  writeInvocations(ctx, invocation);
}

/**
 * Run a batch. `deps.host` injects a host module (tests); `deps.log` receives progress lines.
 * Returns { exitCode, done, skipped, pending, stopped, records }.
 */
export async function runBatch(opts, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(s + "\n"));
  const plan = buildPlan(opts, deps.configs);
  for (const n of plan.notes) log(`note: ${n}`);
  const host = await loadHost(opts, deps.host, plan.mockDir);
  const info = host.hostInfo();
  if (plan.sessionMode === "persistent" && typeof host.openSession !== "function") {
    throw new Error(`host ${plan.hostName} has no persistent session mode: use --session-mode resume`);
  }
  const ctx = { opts, plan, host, info, log, stopping: false, budgetStopped: false, tokensUsed: 0, t0: Date.now(), taskOf: (r) => plan.taskById.get(r.taskId) };
  const invocation = { id: randomUUID(), startedAt: new Date().toISOString(), endedAt: null, concurrency: opts.concurrency, ran: 0, skipped: 0, stopped: false, budgetStopped: false };

  // Batch budget across invocations (EXPERIMENT-V03.md). A budget_stopped mark blocks a new start without --raise-budget.
  const prevInv = readInvocations(ctx);
  const raises = (prevInv.budget?.raises ?? 0) + (opts.raiseBudget && prevInv.budgetStopped ? 1 : 0);
  ctx.budget = { ...effectiveBudget(plan.limits.batch, raises), raises };
  ctx.budgetMark = prevInv.budgetStopped;
  if (prevInv.budgetStopped && !opts.raiseBudget) {
    log(`STOP: batch ${opts.batch} is budget_stopped (${prevInv.budgetStopped.reason}). Run again with --raise-budget to continue.`);
    return { exitCode: EXIT.budgetStop, done: 0, skipped: 0, pending: plan.runs.filter((r) => !isFinal(readRun(plan.resultsDir, opts.batch, r.runId))).length, stopped: true, budgetStopped: true, records: [], plan };
  }
  if (opts.raiseBudget && prevInv.budgetStopped) {
    log(`note: --raise-budget: budget now ${ctx.budget.totalTokens} tokens, ${Math.round(ctx.budget.wallTimeMs / 3600000)} h`);
    ctx.budgetMark = null;
  }
  const prior = priorUsage(prevInv.invocations, invocation.id);
  const budgetCheck = () => {
    if (ctx.budgetStopped) return true;
    const used = { tokens: prior.tokens + ctx.tokensUsed, wallMs: prior.wallMs + (Date.now() - ctx.t0) };
    const reason = budgetReason(used, ctx.budget);
    if (!reason) return false;
    ctx.budgetStopped = true;
    ctx.budgetMark = { at: new Date().toISOString(), reason, tokens: used.tokens, wallMs: used.wallMs };
    log(`STOP: batch budget spent (${reason}). No new runs start. The batch is budget_stopped; run again with --raise-budget to continue.`);
    return true;
  };

  // One overlay for the batch (EXPERIMENT-V03.md).
  ctx.overlay = plan.overlay ? await prepareOverlay({ workRoot: plan.workRoot, batch: opts.batch, mock: opts.mock, module: deps.overlay ?? null, needProductPreCompact: plan.modes.includes("M") }) : null;
  if (ctx.overlay) log(`overlay ${ctx.overlay.pluginDir} (source ${ctx.overlay.sourceSha})`);
  // Isolated sessions: the name and hooks of the overlay plugin (the allowed plugin and the session record).
  ctx.overlayInfo = ctx.overlay ? overlayPluginInfo(ctx.overlay.pluginDir) : null;
  // EXPERIMENT-V11.md: one benchmark plugin for each plain mode of the batch.
  ctx.plain = preparePlain({ workRoot: plan.workRoot, batch: opts.batch, modes: plan.modes });
  for (const [m, p] of Object.entries(ctx.plain)) log(`plain plugin of mode ${m}: ${p.pluginDir}`);
  writeBatchFile(ctx, invocation);

  const todo = [];
  let skipped = 0;
  for (const run of plan.runs) {
    if (isFinal(readRun(plan.resultsDir, opts.batch, run.runId))) skipped++;
    else todo.push(run);
  }
  log(`batch ${opts.batch}: ${plan.runs.length} runs, ${skipped} already final, ${todo.length} to run (host ${plan.hostName}${opts.mock ? ", mock" : ""}, concurrency ${opts.concurrency})`);

  const records = [];
  let limitStreak = 0;
  let next = 0;
  const worker = async () => {
    while (!ctx.stopping && next < todo.length) {
      if (budgetCheck()) break;
      const run = todo[next++];
      log(`[${run.order}/${plan.runs.length}] start ${run.runId}`);
      const rec = await runOne(ctx, run);
      records.push(rec);
      log(`[${run.order}/${plan.runs.length}] ${rec.status}${rec.failure ? ` (${rec.failure.kind})` : ""} ${run.runId} attempts=${rec.attempts.length}`);
      writeInvocations(ctx, invocation);
      if (rec.failure?.kind === "rate_limit") {
        limitStreak++;
        if (limitStreak >= RATE_LIMIT_STOP && !ctx.stopping) {
          ctx.stopping = true;
          log(`STOP: ${RATE_LIMIT_STOP} runs in a row failed with a rate or usage limit. No new runs start. Run the same command later to resume the batch.`);
        }
      } else if (rec.status === "completed" || rec.status === "agent_failed") {
        limitStreak = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));

  const pending = plan.runs.filter((r) => !isFinal(readRun(plan.resultsDir, opts.batch, r.runId))).length;
  invocation.endedAt = new Date().toISOString();
  invocation.ran = records.length;
  invocation.skipped = skipped;
  invocation.stopped = ctx.stopping;
  if (!ctx.budgetStopped && pending > 0) budgetCheck();
  invocation.budgetStopped = ctx.budgetStopped;
  writeBatchFile(ctx, invocation);
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  log(`batch ${opts.batch}: ran ${records.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}), skipped ${skipped}, not final ${pending}`);
  const exitCode = ctx.stopping ? EXIT.rateLimitStop : ctx.budgetStopped && pending > 0 ? EXIT.budgetStop : pending > 0 ? EXIT.failed : EXIT.ok;
  return { exitCode, done: records.length, skipped, pending, stopped: ctx.stopping, budgetStopped: ctx.budgetStopped, records, plan };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exit(EXIT.usage);
  }
  if (opts.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  try {
    const r = await runBatch(opts);
    process.exitCode = r.exitCode;
  } catch (err) {
    process.stderr.write(`run.mjs: ${err.message}\n`);
    process.exitCode = EXIT.usage;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
