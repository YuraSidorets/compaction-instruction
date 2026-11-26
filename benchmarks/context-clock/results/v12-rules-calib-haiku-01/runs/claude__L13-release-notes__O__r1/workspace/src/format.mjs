import { notesFor } from "./notes.mjs";

// The heading of the notes of one version. A release date, when given, is
// added in brackets: "## 1.2.0 (2026-03-01)".
export function heading(version, date) {
  return "## " + version + (date ? " (" + date + ")" : "");
}

// The complete release notes of one version: the heading, one empty line,
// then the notes of the version (see notesFor).
export function releaseNotes(changes, version, date) {
  return heading(version, date) + "\n\n" + notesFor(changes, version);
}
