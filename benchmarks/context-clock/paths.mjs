// Shared folder resolution of the benchmark modules (generator, runner, mock host, grader, analysis).
// Order for each folder: an explicit option, then the environment variable, then the default under this folder.
//   CCB_RESULTS_DIR  replaces <bench>/results            (a batch is <root>/<batch>/)
//   CCB_TASKS_DIR    replaces <bench>/tasks              (tasks in <root>/generated, keys in <root>/keys)
//   CCB_MOCK_DIR     replaces <bench>/fixtures/mock/runs (recorded run transcripts of the mock host)
// An explicit benchmark `root` (the --root option of the grader and the analysis) means <root>/results and <root>/tasks.
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_ROOT = dirname(fileURLToPath(import.meta.url));

function fromEnv(env, name) {
  const v = env?.[name];
  return typeof v === "string" && v.trim() !== "" ? resolve(v) : null;
}

/**
 * @param {{ root?: string|null, resultsDir?: string|null, tasksDir?: string|null, mockDir?: string|null, env?: object }} [o]
 * @returns {{ resultsDir: string, tasksDir: string, generatedDir: string, keysDir: string, mockDir: string }}
 */
export function benchPaths(o = {}) {
  const env = o.env ?? process.env;
  const root = o.root ? resolve(o.root) : null;
  const resultsDir = o.resultsDir ? resolve(o.resultsDir) : root ? join(root, "results") : fromEnv(env, "CCB_RESULTS_DIR") ?? join(BENCH_ROOT, "results");
  const tasksDir = o.tasksDir ? resolve(o.tasksDir) : root ? join(root, "tasks") : fromEnv(env, "CCB_TASKS_DIR") ?? join(BENCH_ROOT, "tasks");
  const mockDir = o.mockDir ? resolve(o.mockDir) : fromEnv(env, "CCB_MOCK_DIR") ?? join(BENCH_ROOT, "fixtures", "mock", "runs");
  return { resultsDir, tasksDir, generatedDir: join(tasksDir, "generated"), keysDir: join(tasksDir, "keys"), mockDir };
}

/**
 * The task folder of a batch (holding generated/ and keys/), shared by the grader and the analysis. Order: the
 * explicit tasksDir option, CCB_TASKS_DIR (without --root), batch.json tasksDir (relative to the benchmark root or to
 * the repository root; a trailing "generated" is dropped), then the default tasks folder.
 */
export function resolveTasksDir({ root = null, tasksDir = null, batch = null, env = process.env }) {
  if (tasksDir) return resolve(tasksDir);
  if (!root && typeof env.CCB_TASKS_DIR === "string" && env.CCB_TASKS_DIR.trim() !== "") return benchPaths({ env }).tasksDir;
  const td = batch && typeof batch.tasksDir === "string" && batch.tasksDir !== "" ? batch.tasksDir : null;
  if (td !== null) {
    const base = root ? resolve(root) : BENCH_ROOT;
    const cands = isAbsolute(td) ? [td] : [join(base, td), join(base, "..", "..", td)];
    for (let c of cands) {
      if (basename(c) === "generated") c = dirname(c);
      if (existsSync(join(c, "generated"))) return resolve(c);
    }
  }
  return benchPaths({ root, env }).tasksDir;
}
