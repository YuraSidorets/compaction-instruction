// Child process control for host CLIs: PATH resolution (including Windows .cmd shims), the prompt on stdin, the raw
// stdout saved to a file, and a per-turn timeout that kills the whole process tree.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

const IS_WIN = process.platform === "win32";

/** The executable path for a command name. Windows: PATH x PATHEXT. null when not found. */
export function resolveCommand(cmd, env = process.env) {
  if (isAbsolute(cmd) && existsSync(cmd)) return cmd;
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = IS_WIN ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const hasExt = IS_WIN && extname(cmd) !== "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const ext of hasExt ? [""] : exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // next
      }
    }
  }
  return null;
}

/** Quote one argument for cmd.exe /s /c "<line>" with MSVCRT parsing in the target. */
function cmdQuote(a) {
  if (a !== "" && !/[\s"&|<>^%()!,;=]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}

/** [file, args] that spawn() can run without a shell. A .cmd or .bat shim goes through cmd.exe. */
export function spawnPlan(exe, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const line = [cmdQuote(exe), ...args.map(cmdQuote)].join(" ");
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", '"' + line + '"'], verbatim: true };
  }
  return { file: exe, args, verbatim: false };
}

/** Kill a process and all its children. */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
}

/**
 * Run one command. Never throws for a process failure.
 * @returns {Promise<{exitCode:number|null, timedOut:boolean, durationMs:number, stdout:string, stderr:string, spawnError:string|null}>}
 */
export function runProcess({ cmd, args = [], cwd, env, input = "", timeoutMs = 600_000, stdoutPath, stderrPath, onLine, signal }) {
  const start = Date.now();
  return new Promise((resolveP) => {
    const exe = resolveCommand(cmd, env);
    if (exe === null) {
      resolveP({ exitCode: null, timedOut: false, aborted: false, durationMs: 0, stdout: "", stderr: "", spawnError: `command not found on PATH: ${cmd}` });
      return;
    }
    const plan = spawnPlan(exe, args);
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !IS_WIN, windowsVerbatimArguments: plan.verbatim,
      });
    } catch (err) {
      resolveP({ exitCode: null, timedOut: false, aborted: false, durationMs: Date.now() - start, stdout: "", stderr: "", spawnError: String(err?.message ?? err) });
      return;
    }
    const outFile = stdoutPath ? createWriteStream(stdoutPath) : null;
    const errFile = stderrPath ? createWriteStream(stderrPath) : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      outFile?.write(d);
      if (onLine) {
        partial += d;
        let i;
        while ((i = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, i).replace(/\r$/, "");
          partial = partial.slice(i + 1);
          if (line) onLine(line);
        }
      }
    });
    // The runner aborts a turn when a run limit trips: kill the tree, keep the stream written so far.
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (d) => {
      stderr += d;
      errFile?.write(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (exitCode, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const done = () => resolveP({ exitCode, timedOut, aborted, durationMs: Date.now() - start, stdout, stderr, spawnError });
      let open = (outFile ? 1 : 0) + (errFile ? 1 : 0);
      if (open === 0) return done();
      const closeOne = () => {
        open -= 1;
        if (open === 0) done();
      };
      outFile?.end(closeOne);
      errFile?.end(closeOne);
    };
    child.on("error", (err) => finish(null, String(err?.message ?? err)));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** One short synchronous call, for version strings. "" on failure. */
export function quickOutput(cmd, args, env = process.env) {
  const exe = resolveCommand(cmd, env);
  if (exe === null) return "";
  const plan = spawnPlan(exe, args);
  const r = spawnSync(plan.file, plan.args, { encoding: "utf8", timeout: 30_000, windowsHide: true, windowsVerbatimArguments: plan.verbatim, env });
  return String(r.stdout ?? "").trim();
}

/**
 * Start one long-lived process with piped stdin. stdout is split into lines for `onLine`; stderr goes to a file and a
 * bounded tail. Never throws: a spawn failure resolves `exited` with spawnError.
 * @returns {{ pid: number|null, onLine(fn): void, write(text): boolean, endInput(): void, kill(): void,
 *   exited: Promise<{exitCode: number|null, spawnError: string|null}>, isExited(): boolean, stderrTail(): string }}
 */
export function startProcess({ cmd, args = [], cwd, env, stderrPath }) {
  const listeners = [];
  let exitedFlag = false;
  let tail = "";
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  const finish = (exitCode, spawnError = null) => {
    if (exitedFlag) return;
    exitedFlag = true;
    resolveExit({ exitCode, spawnError });
  };
  const api = {
    pid: null,
    onLine: (fn) => listeners.push(fn),
    write: () => false,
    endInput: () => {},
    kill: () => {},
    exited,
    isExited: () => exitedFlag,
    stderrTail: () => tail,
  };
  const exe = resolveCommand(cmd, env);
  if (exe === null) {
    finish(null, `command not found on PATH: ${cmd}`);
    return api;
  }
  const plan = spawnPlan(exe, args);
  let child;
  try {
    child = spawn(plan.file, plan.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !IS_WIN, windowsVerbatimArguments: plan.verbatim });
  } catch (err) {
    finish(null, String(err?.message ?? err));
    return api;
  }
  api.pid = child.pid ?? null;
  const errFile = stderrPath ? createWriteStream(stderrPath, { flags: "a" }) : null;
  let partial = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    partial += d;
    let i = partial.indexOf("\n");
    while (i >= 0) {
      const line = partial.slice(0, i).replace(/\r$/, "");
      partial = partial.slice(i + 1);
      if (line.trim() !== "") for (const fn of listeners) fn(line);
      i = partial.indexOf("\n");
    }
  });
  child.stderr.on("data", (d) => {
    tail = (tail + d).slice(-4000);
    errFile?.write(d);
  });
  child.stdin.on("error", () => {});
  child.on("error", (err) => finish(null, String(err?.message ?? err)));
  child.on("close", (code) => {
    if (partial.trim() !== "") for (const fn of listeners) fn(partial);
    partial = "";
    errFile?.end();
    finish(code);
  });
  api.write = (text) => {
    if (exitedFlag || child.stdin.destroyed) return false;
    return child.stdin.write(text);
  };
  api.endInput = () => {
    if (!child.stdin.destroyed) child.stdin.end();
  };
  api.kill = () => killTree(child.pid);
  return api;
}
