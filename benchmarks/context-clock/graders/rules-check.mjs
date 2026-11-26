// Static checks of the process rules of the v12 rule-retention tasks (tasks/v12-rules, PLAN-standalone.md step 2.8).
// Deterministic, Node built-ins only. These checks never run agent code: they read the text of the collected
// workspace copy. The rule "keepExports" needs the exported names of modules; graders/work-tests.mjs gets them in its
// child process and passes them in.
//
// Rule kinds (one hidden test group each, in keys/<taskId>.tests.json "rules"):
// - unchanged:   each original file under `prefixes` exists with the original text (line ends ignored); without
//                `allowNew`, no other file is under the prefixes.
// - noDependency: package.json lists the same packages as the original, and each code file imports only relative
//                paths, file: URLs and Node built-in modules.
// - noNetwork:   no code file imports a network module (http, https, net, ...) or calls fetch, XMLHttpRequest,
//                WebSocket, EventSource or sendBeacon.
// - noEnv:       no code file reads process.env (or env from node:process), loadEnvFile, Deno.env or Bun.env.
// - noConsole:   no code file under `scope` uses console, process.stdout, process.stderr or process.emitWarning.
// - noNewFiles:  the files under `scope` are the original files: none added, none removed.
// - keepExports: each module of `modules` still exports each original function name.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

export const RULE_KINDS = Object.freeze(["unchanged", "noDependency", "noNetwork", "noEnv", "noConsole", "noNewFiles", "keepExports"]);
const CODE_FILE = /\.(m|c)?(j|t)sx?$/i;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"];
const NET_MODULES = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises", "undici", "axios", "node-fetch", "got", "ws", "request", "superagent", "ky", "cross-fetch", "isomorphic-fetch", "needle", "phin"]);
const NET_CODE = [/(^|[^.\w$])fetch\s*\(/m, /\bglobalThis\s*(\.\s*fetch\b|\[\s*["'`]fetch)/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/];
const ENV_CODE = [
  /\bprocess\s*\.\s*env\b/,
  /\bprocess\s*\[\s*["'`]env["'`]\s*\]/,
  /\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/,
  /\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*["'](node:)?process["']/,
  /\bloadEnvFile\b/,
  /\b(Deno|Bun)\s*\.\s*env\b/,
];
const ENV_MODULES = new Set(["dotenv", "dotenv/config"]);
const CONSOLE_CODE = [
  /\bconsole\s*[.[]/,
  /\bprocess\s*\.\s*(stdout|stderr)\b/,
  /\bprocess\s*\[\s*["'`](stdout|stderr)["'`]\s*\]/,
  /\{[^}]*\b(stdout|stderr)\b[^}]*\}\s*(=\s*process\b|from\s*["'](node:)?process["'])/,
  /\bemitWarning\b/,
];
const CONSOLE_MODULES = new Set(["console", "node:console"]);

/** Text with CRLF line ends turned into LF. */
export function normText(text) {
  return String(text).replace(/\r\n/g, "\n");
}

/** The SHA-256 of a text with LF line ends: the identity of a file for the rule "unchanged". */
export function textHash(text) {
  return createHash("sha256").update(normText(text)).digest("hex");
}

/** Every file of a folder as Map(relative path with "/" -> text), without .git, node_modules and links. */
export function readTree(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e.toLowerCase())) continue;
      const p = join(dir, e);
      const r = rel === "" ? e : `${rel}/${e}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.set(r, readFileSync(p, "utf8"));
    }
  };
  walk(root, "");
  return out;
}

/**
 * The source without comments. Strings stay. A small lexer: it knows line comments, block comments and string and
 * template literals (a template is one literal, with its ${...} parts). It does not know regular expression literals.
 */
export function stripComments(src) {
  const s = String(src);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];
    if (ch === "/" && nx === "/") {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && nx === "*") {
      const e = s.indexOf("*/", i + 2);
      const end = e < 0 ? s.length : e + 2;
      out += s.slice(i, end).replace(/[^\n]/g, "") || " ";
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) {
        if (s[j] === "\\") j += 1;
        else if (ch !== "`" && s[j] === "\n") break;
        j += 1;
      }
      out += s.slice(i, Math.min(j + 1, s.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The module specifiers of a source without comments: static imports, re-exports, import() and require() with a literal. */
export function importSpecifiers(code) {
  const out = [];
  const res = [
    /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g,
    /\bexport\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\}\s*)from\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`\n]+)["'`]\s*[,)]/g,
    /\brequire\s*\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g,
  ];
  for (const re of res) for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

const BUILTINS = new Set(builtinModules);

/** True for a specifier that names no package: a relative or absolute path, a file: URL or a Node built-in module. */
export function isLocalOrBuiltin(spec) {
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec.startsWith("file:") || spec.startsWith("node:")) return true;
  return BUILTINS.has(spec);
}

function packagesOf(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  const names = new Set();
  for (const f of DEP_FIELDS) {
    const v = pkg?.[f];
    if (Array.isArray(v)) v.forEach((x) => names.add(String(x)));
    else if (v && typeof v === "object") Object.keys(v).forEach((x) => names.add(x));
  }
  return [...names].sort();
}

/** The packages that a package.json text names in its dependency fields, sorted, or null when it does not parse. */
export function manifestPackages(text) {
  return packagesOf(text);
}

function under(path, prefixes) {
  return prefixes.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

function codeFiles(files, scope) {
  return [...files].filter(([p]) => CODE_FILE.test(p) && (scope === undefined || under(p, scope)));
}

const kept = () => ({ kept: true, reason: null });
const broken = (reason) => ({ kept: false, reason });

/**
 * Decides one rule on the files of the collected workspace copy.
 * - `files`: Map(path -> text) of the copy (readTree).
 * - `original`: { path: textHash } of the original workspace files.
 * - `exportsOf`: { modulePath: sorted names | null } from the child process (keepExports only).
 */
export function checkRule(rule, files, original, exportsOf = {}) {
  switch (rule.kind) {
    case "unchanged": {
      for (const [p, h] of Object.entries(original)) {
        if (!under(p, rule.prefixes)) continue;
        if (!files.has(p)) return broken(`${p} is missing`);
        if (textHash(files.get(p)) !== h) return broken(`${p} changed`);
      }
      if (!rule.allowNew) for (const p of files.keys()) if (under(p, rule.prefixes) && !(p in original)) return broken(`${p} was added`);
      return kept();
    }
    case "noDependency": {
      if (files.has("package.json")) {
        const now = packagesOf(files.get("package.json"));
        if (now === null) return broken("package.json does not parse");
        const extra = now.filter((n) => !(rule.packages ?? []).includes(n));
        if (extra.length > 0) return broken(`package.json names ${extra.join(", ")}`);
      }
      for (const [p, text] of codeFiles(files)) {
        const bad = importSpecifiers(stripComments(text)).filter((s) => !isLocalOrBuiltin(s));
        if (bad.length > 0) return broken(`${p} imports ${bad.join(", ")}`);
      }
      return kept();
    }
    case "noNetwork": {
      for (const [p, text] of codeFiles(files)) {
        const code = stripComments(text);
        const mod = importSpecifiers(code).find((s) => NET_MODULES.has(s.replace(/^node:/, "")) || /^https?:/i.test(s));
        if (mod) return broken(`${p} imports ${mod}`);
        const re = NET_CODE.find((x) => x.test(code));
        if (re) return broken(`${p} matches ${re.source}`);
      }
      return kept();
    }
    case "noEnv": {
      for (const [p, text] of codeFiles(files)) {
        const code = stripComments(text);
        const mod = importSpecifiers(code).find((s) => ENV_MODULES.has(s));
        if (mod) return broken(`${p} imports ${mod}`);
        const re = ENV_CODE.find((x) => x.test(code));
        if (re) return broken(`${p} matches ${re.source}`);
      }
      return kept();
    }
    case "noConsole": {
      for (const [p, text] of codeFiles(files, rule.scope)) {
        const code = stripComments(text);
        const mod = importSpecifiers(code).find((s) => CONSOLE_MODULES.has(s));
        if (mod) return broken(`${p} imports ${mod}`);
        const re = CONSOLE_CODE.find((x) => x.test(code));
        if (re) return broken(`${p} matches ${re.source}`);
      }
      return kept();
    }
    case "noNewFiles": {
      const before = Object.keys(original).filter((p) => under(p, rule.scope)).sort();
      const after = [...files.keys()].filter((p) => under(p, rule.scope)).sort();
      const added = after.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !after.includes(p));
      if (added.length > 0) return broken(`added ${added.join(", ")}`);
      if (removed.length > 0) return broken(`removed ${removed.join(", ")}`);
      return kept();
    }
    case "keepExports": {
      for (const [m, names] of Object.entries(rule.modules)) {
        const now = exportsOf[m];
        if (!Array.isArray(now)) return broken(`${m} does not load`);
        const lost = names.filter((n) => !now.includes(n));
        if (lost.length > 0) return broken(`${m} no longer exports ${lost.join(", ")}`);
      }
      return kept();
    }
    default:
      return broken(`unknown rule kind ${rule.kind}`);
  }
}

// A line that states a prohibition. Together with the subject of a rule on the same line, it marks a note of the rule.
const PROHIBITION = /\b(never|must not|do not|don't|not allowed|forbidden|no)\b/i;

/** The lines of a text that look like a note of the rule (its `note` subject and a prohibition on one line). */
export function ruleNoteLines(rule, text) {
  const subject = new RegExp(rule.note, "i");
  return normText(text).split("\n").filter((l) => subject.test(l) && PROHIBITION.test(l));
}

/**
 * The files that the agent wrote (new, or changed against `original`) and that hold the text of a rule: a line with
 * the subject of the rule and a prohibition. Returns [{ path, rules: [ids] }]. A heuristic; it never changes the score.
 */
export function ruleNotesInFiles(rules, files, original) {
  const out = [];
  for (const [p, text] of files) {
    if (p in original && textHash(text) === original[p]) continue;
    const ids = rules.filter((r) => ruleNoteLines(r, text).length > 0).map((r) => r.id);
    if (ids.length > 0) out.push({ path: p, rules: ids });
  }
  return out;
}
