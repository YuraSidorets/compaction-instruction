// Parse the agent's answer block. Order: the last fenced ```json block that parses, then the last fenced block of any
// language that parses, then the first balanced {...} object in the text that parses. The object holds "answers", or is
// itself the answer map when its keys are question ids. Values are normalized to the question type when that is safe.

const FENCE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s.trim()) };
  } catch {
    return { ok: false };
  }
}

/** Every balanced {...} substring in order of its start, string-aware. */
function* balancedObjects(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          break;
        }
      }
    }
  }
}

function answerMap(obj, ids) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  if (typeof obj.answers === "object" && obj.answers !== null && !Array.isArray(obj.answers)) return obj.answers;
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every((k) => ids.includes(k))) return obj;
  return null;
}

/** Normalize one value to the question type. Unconvertible values stay as given (the grader marks them wrong). */
export function normalizeValue(q, v) {
  if (v === undefined) return undefined;
  switch (q?.type) {
    case "int":
      if (typeof v === "string" && /^\s*-?\d+\s*$/.test(v)) return Number(v.trim());
      return v;
    case "bool":
      if (typeof v === "string" && /^\s*(true|false)\s*$/i.test(v)) return v.trim().toLowerCase() === "true";
      return v;
    case "set":
      if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
      return v;
    case "choice":
      if (Array.isArray(v) && v.length === 1) return v[0];
      return v;
    default:
      return v;
  }
}

/**
 * @param {string} text the agent's reply
 * @param {{id:string,type:string}[]} questions
 * @returns {{answers: Record<string, unknown>|null, error: string|null, source: string|null}}
 */
export function parseAnswers(text, questions) {
  const ids = questions.map((q) => q.id);
  if (typeof text !== "string" || text.trim() === "") return { answers: null, error: "empty reply", source: null };
  const fences = [...text.matchAll(FENCE)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const candidates = [
    ...fences.filter((f) => f.lang === "json").reverse().map((f) => ({ body: f.body, source: "fenced json" })),
    ...fences.filter((f) => f.lang !== "json").reverse().map((f) => ({ body: f.body, source: "fenced block" })),
  ];
  let found = null;
  for (const c of candidates) {
    const p = tryParse(c.body);
    const map = p.ok ? answerMap(p.value, ids) : null;
    if (map) {
      found = { map, source: c.source };
      break;
    }
  }
  if (!found) {
    for (const s of balancedObjects(text)) {
      const p = tryParse(s);
      const map = p.ok ? answerMap(p.value, ids) : null;
      if (map) {
        found = { map, source: "balanced object" };
        break;
      }
    }
  }
  if (!found) return { answers: null, error: "no parsable answers object in the reply", source: null };
  const answers = {};
  for (const q of questions) {
    if (Object.prototype.hasOwnProperty.call(found.map, q.id)) answers[q.id] = normalizeValue(q, found.map[q.id]);
  }
  if (Object.keys(answers).length === 0) return { answers: null, error: "the answers object holds none of the question ids", source: found.source };
  return { answers, error: null, source: found.source };
}
