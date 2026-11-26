import { compareVersions } from "../vendor/semver-lite.mjs";

const titles = ["### Features", "### Fixes", "### Other"];

// A note line starts with a capital letter and does not end with a period.
const clean = (text) => {
  const t = text.replace(/\.$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// The issue reference at the end of a note line: "(#102: Export drops the last row)",
// or "(#999)" when the title is not known. Without an issue there is no reference.
const issueRef = (c) => {
  if (c.issue === undefined || c.issue === null) return "";
  return c.issueTitle ? " (#" + c.issue + ": " + c.issueTitle + ")" : " (#" + c.issue + ")";
};

const line = (c) => "- " + clean(c.text) + issueRef(c);

// The note lines of one version in groups: features, fixes, then all other changes.
// Empty groups are left out. The changes keep their order within each group.
const lineGroups = (changes, version) => {
  const own = changes.filter((c) => c.version === version);
  const rank = (c) => (c.type === "feature" ? 0 : c.type === "fix" ? 1 : 2);
  return [0, 1, 2]
    .map((r) => ({ r, group: own.filter((c) => rank(c) === r) }))
    .filter(({ group }) => group.length > 0)
    .map(({ r, group }) => ({ title: titles[r], lines: group.map(line) }));
};

// The note lines of one version with a title line per group. Groups are
// separated by one empty line.
export function notesFor(changes, version) {
  return lineGroups(changes, version)
    .map((g) => [g.title, ...g.lines].join("\n"))
    .join("\n\n");
}

// The same notes as notesFor, for markdown output.
export function markdownNotes(changes, version) {
  return notesFor(changes, version);
}

// The same note lines as notesFor, without titles and empty lines: one line per change.
export function plainNotes(changes, version) {
  return lineGroups(changes, version)
    .flatMap((g) => g.lines)
    .join("\n");
}

// The number of changes of each group: feature, fix, and other (all other types).
export function typeCounts(changes) {
  const counts = { feature: 0, fix: 0, other: 0 };
  for (const c of changes) {
    if (c.type === "feature") counts.feature++;
    else if (c.type === "fix") counts.fix++;
    else counts.other++;
  }
  return counts;
}

// Compares two versions that may have a "v" prefix and a pre-release part ("1.4.0-beta.2").
// The core "major.minor.patch" is compared by compareVersions. A pre-release is lower
// than its release; pre-release parts are compared one by one: numbers as numbers,
// other parts as text, and a shorter list of equal parts is lower.
function compareAny(a, b) {
  const split = (v) => {
    const s = v.startsWith("v") ? v.slice(1) : v;
    const dash = s.indexOf("-");
    return dash < 0 ? [s, null] : [s.slice(0, dash), s.slice(dash + 1).split(".")];
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  const core = compareVersions(coreA, coreB);
  if (core !== 0) return core;
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  const isNum = (p) => /^\d+$/.test(p);
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNum(x) && isNum(y)) return Number(x) < Number(y) ? -1 : 1;
    if (isNum(x)) return -1;
    if (isNum(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// The highest version of the changes.
export function latestVersion(changes) {
  let best = null;
  for (const c of changes) if (best === null || compareAny(c.version, best) > 0) best = c.version;
  return best;
}

// The changes with a version higher than the given version, in the order of the input.
export function changesSince(changes, version) {
  return changes.filter((c) => compareAny(c.version, version) > 0);
}

// The names of the authors, each name once, sorted from A to Z. Changes without an author are skipped.
export function authorsOf(changes) {
  const names = new Set(changes.filter((c) => c.author).map((c) => c.author));
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The changes whose type is not feature, fix or other (for example a typo such as "feture").
// notesFor puts them under Other. Each one is returned with its version and text, in input order.
export function unknownTypeChanges(changes) {
  const known = new Set(["feature", "fix", "other"]);
  return changes
    .filter((c) => !known.has(c.type))
    .map((c) => ({ version: c.version, type: c.type, text: c.text }));
}
