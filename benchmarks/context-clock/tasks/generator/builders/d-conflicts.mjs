// Category D: conflicting information with explicit precedence rules. Several sources state values; a precedence
// rule decides. A newer version of the same source overrides, an outdated document is withdrawn (its values stop
// counting, so older values can return), and a top-authority correction beats every later lower claim.
import { stagePlan } from "./common.mjs";

const PARAMS = [
  { id: "payload", label: "the maximum payload size in KB", type: "int", options: [256, 512, 1024, 2048, 4096] },
  { id: "currency", label: "the default currency", options: ["EUR", "USD", "GBP", "CHF", "SEK"] },
  { id: "tls", label: "the minimum TLS version", options: ["tls-1.1", "tls-1.2", "tls-1.3"] },
  { id: "session", label: "the session timeout in minutes", type: "int", options: [15, 30, 45, 60, 120] },
  { id: "retention", label: "the data retention in days", type: "int", options: [30, 90, 180, 365, 730] },
  { id: "format", label: "the export file format", options: ["csv", "json", "parquet", "xml", "ndjson"] },
  { id: "strict", label: "the strict validation mode", type: "bool", options: [true, false] },
  { id: "region", label: "the data residency region", options: ["eu-zone", "us-zone", "uk-zone", "ch-zone", "apac-zone"] },
  { id: "ratelimit", label: "the API rate limit per minute", type: "int", options: [100, 300, 600, 1200, 2400] },
  { id: "hash", label: "the password hash algorithm", options: ["argon2id", "bcrypt", "scrypt", "pbkdf2"] },
];

const THEMES = [
  { order: ["erratum", "spec", "vendor-sheet", "wiki", "email"], docs: { erratum: "ERR", spec: "SPEC", "vendor-sheet": "VS", wiki: "WIKI", email: "MAIL" } },
  { order: ["security-policy", "standard", "runbook", "wiki", "chat"], docs: { "security-policy": "SECPOL", standard: "STD", runbook: "RB", wiki: "WIKI", chat: "CHAT" } },
  { order: ["legal-notice", "contract", "vendor-sheet", "faq", "email"], docs: { "legal-notice": "LEGAL", contract: "CTR", "vendor-sheet": "VS", faq: "FAQ", email: "MAIL" } },
  { order: ["change-board", "design-doc", "readme", "wiki", "chat"], docs: { "change-board": "CAB", "design-doc": "DD", readme: "README", wiki: "WIKI", chat: "CHAT" } },
];

export function buildConflicts(story, p) {
  const { rng, stages } = story;
  const theme = p.pools?.theme ?? THEMES[p.theme % THEMES.length];
  const [TOP, SPEC, MID, LOW, LOWEST] = theme.order;
  const n = Math.min((p.pools?.params ?? PARAMS).length, Math.max(6, p.entities));
  const pool = rng.shuffle(p.pools?.params ?? PARAMS);
  const ints = pool.filter((x) => x.type === "int");
  const bools = pool.filter((x) => x.type === "bool");
  const strs = pool.filter((x) => !x.type);
  const chosen = [strs[0], strs[1], ints[0], strs[2], bools[0], ints[1], ...pool.filter((x) => ![strs[0], strs[1], ints[0], strs[2], bools[0], ints[1]].includes(x))].slice(0, n);
  const V = chosen.map((c) => story.var(c.id, { label: c.label, type: c.type ?? "scalar", options: c.options, mode: "claims" }));
  const opt = Object.fromEntries(chosen.map((c, i) => [V[i], c.options]));
  // Spec documents are named by their version (CTR-2). Every other document gets a running number; its version
  // rises with each new document of the same source, so two documents of one source never share a version.
  let docNo = 100;
  const lastVer = {};
  const doc = (src, version) => (src === SPEC ? `${theme.docs[src]}-${version}` : `${theme.docs[src]}-${(docNo += rng.int(3, 40))}`);
  const nextVer = (src, atLeast = 1) => (lastVer[src] = Math.max(atLeast, (lastVer[src] ?? 0) + rng.int(1, 2)));
  const claim = (stage, kind, v, value, source, version, d) => story.ev(stage, kind, { op: "claim", var: v, value, source, version, doc: d });
  const other = (v) => rng.pickOther(opt[v], story.cur[v]);

  // Intro: the precedence rule, the first spec version for all but the last parameter, a mid source for that one.
  story.ev(0, "rule", { op: "authority", order: theme.order });
  const spec1 = doc(SPEC, 1);
  for (const v of V.slice(0, -1)) claim(0, "state", v, rng.pick(opt[v]), SPEC, 1, spec1);
  const vLast = V[V.length - 1];
  const midVer = nextVer(MID);
  claim(0, "state", vLast, rng.pick(opt[vLast]), MID, midVer, doc(MID, midVer));

  const [v1, v2, v3, v4, vBool] = V;
  const specVals = {};
  for (const v of V.slice(0, -1)) specVals[v] = story.cur[v];
  const ms = [];
  let wikiDoc = null;
  ms.push((s) => {
    const ver = nextVer(LOW);
    wikiDoc = doc(LOW, ver);
    claim(s, "conflict", v1, rng.pickOther(opt[v1], specVals[v1]), LOW, ver, wikiDoc);
    claim(s, "conflict", vBool, !specVals[vBool], LOW, ver, wikiDoc);
  });
  const spec2 = doc(SPEC, 2);
  let spec2v1 = null;
  let spec3v4 = null;
  ms.push((s) => {
    spec2v1 = rng.pickOther(opt[v1], specVals[v1]);
    claim(s, "supersede", v1, spec2v1, SPEC, 2, spec2);
    claim(s, "supersede", v2, rng.pickOther(opt[v2], specVals[v2]), SPEC, 2, spec2);
  });
  ms.push((s) => {
    const ver = nextVer(LOWEST);
    claim(s, "conflict", v2, other(v2), LOWEST, ver, doc(LOWEST, ver));
  });
  ms.push((s) => {
    const ver = nextVer(TOP);
    claim(s, "supersede", v3, rng.pickOther(opt[v3], specVals[v3]), TOP, ver, doc(TOP, ver));
  });
  const spec3 = doc(SPEC, 3);
  ms.push((s) => {
    claim(s, "conflict", v3, rng.pick(opt[v3]), SPEC, 3, spec3); // loses to the top source
    spec3v4 = rng.pickOther(opt[v4], specVals[v4]);
    claim(s, "supersede", v4, spec3v4, SPEC, 3, spec3);
  });
  // Spec version 5 changes v4; a later stage withdraws it, so v4 falls back to spec version 3.
  const spec5 = doc(SPEC, 5);
  ms.push((s) => claim(s, "supersede", v4, rng.pickOther(opt[v4], spec3v4), SPEC, 5, spec5));
  ms.push((s) => {
    story.ev(s, "supersede", { op: "retract", doc: spec2 }); // v1 and v2 fall back to version 1
    // A lower source with a higher version: only the precedence rule keeps the spec value of v1.
    const ver = nextVer(LOWEST, 3);
    claim(s, "conflict", v1, rng.pick(opt[v1].filter((x) => x !== specVals[v1] && x !== spec2v1)), LOWEST, ver, doc(LOWEST, ver));
  });
  ms.push((s) => {
    story.ev(s, "supersede", { op: "retract", doc: wikiDoc });
    claim(s, "supersede", vLast, rng.pick(opt[vLast]), SPEC, 4, doc(SPEC, 4));
    const ver = nextVer(MID);
    claim(s, "conflict", vBool, !specVals[vBool], MID, ver, doc(MID, ver));
  });
  ms.push((s) => {
    const top = nextVer(TOP);
    claim(s, "supersede", v2, rng.pickOther(opt[v2], specVals[v2]), TOP, top, doc(TOP, top));
    const low = nextVer(LOW, 6);
    claim(s, "conflict", v4, rng.pickOther(opt[v4], spec3v4), LOW, low, doc(LOW, low));
  });
  ms.push((s) => story.ev(s, "supersede", { op: "retract", doc: spec5 }));

  const at = ms.map((_, i) => Math.min(stages, 1 + Math.floor((i * stages) / ms.length)));
  const filler = stagePlan(rng, Math.max(0, p.updates - 12), stages);
  let fi = 0;
  for (let s = 1; s <= stages; s += 1) {
    ms.forEach((m, i) => {
      if (at[i] === s) m(s);
    });
    while (fi < filler.length && filler[fi] === s) {
      const v = rng.pick(V);
      const src = rng.pick([MID, LOW, LOWEST]);
      const ver = nextVer(src);
      // Fillers never repeat the value that only the precedence rule protects (v1: spec version 1, v4: spec version 3).
      const keep = v === v1 ? specVals[v1] : v === v4 ? spec3v4 : null;
      const choices = opt[v].filter((x) => x !== story.cur[v] && x !== keep);
      claim(s, "conflict", v, choices.length > 0 ? rng.pick(choices) : other(v), src, ver, doc(src, ver));
      fi += 1;
    }
  }

  const qType = (i) => (chosen[i].type === "int" ? "int" : chosen[i].type === "bool" ? "bool" : "choice");
  const ask = (i, text) => story.q({ text, type: qType(i), aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "value", var: V[i] } });
  ask(0, `Under the precedence rule, what is ${chosen[0].label} now?`);
  ask(1, `Under the precedence rule, what is ${chosen[1].label} now?`);
  ask(2, `Under the precedence rule, what is ${chosen[2].label} now?${qType(2) === "int" ? " Answer with a number." : ""}`);
  story.q({ text: `Which source decides ${chosen[2].label} now?`, type: "choice", aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "source", var: v3 }, sourceOptions: theme.order });
  ask(4, `Under the precedence rule, is ${chosen[4].label} ON now? Answer true for ON, false for OFF.`);
  story.q({ text: `Which value did ${chosen[3].label} have under the very first specification?`, type: qType(3), aspect: "original_constraint", errorCategory: "forgotten_requirement", query: { q: "initial", var: v4 } });
  story.q({ text: `Under the precedence rule, what is ${chosen[3].label} now?`, type: qType(3), aspect: "current_state", errorCategory: "obsolete_decision", query: { q: "value", var: v4 } });

  if (p.compactAfter.length > 0) {
    story.cq({ text: `At this point, under the precedence rule, what is ${chosen[1].label}?`, type: qType(1), aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "value", var: v2 } });
    story.cq({ text: `At this point, under the precedence rule, what is ${chosen[0].label}?`, type: qType(0), aspect: "conflict_resolution", errorCategory: "contradiction", query: { q: "value", var: v1 } });
  }
  return {
    entities: V.length,
    depth: 3,
    rules: [
      `Sources, from highest to lowest authority: ${theme.order.join(", ")}. When two sources disagree, the higher one decides.`,
      "Inside one source, a higher version number overrides a lower one. A withdrawn document no longer counts at all.",
    ],
  };
}
