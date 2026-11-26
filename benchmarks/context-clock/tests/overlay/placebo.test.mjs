import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OVERLAY_DIR, FULL_BLOCK, FULL_BLOCK_UTF8, LINE_FORM, LINE_FORM_STALE, bytesOf } from "./helpers.mjs";

const P = await import(pathToFileURL(path.join(OVERLAY_DIR, "placebo.mjs")).href);

const lineBytes = (s) => s.split("\n").map(bytesOf);
const words = (s) => s.toLowerCase().match(/[a-z]{2,}/g) ?? [];
const digitRuns = (s) => s.match(/[0-9]+/g) ?? [];

function assertShape(original, placebo) {
  assert.equal(bytesOf(placebo), bytesOf(original), "same byte length");
  assert.equal(placebo.split("\n").length, original.split("\n").length, "same line count");
  assert.deepEqual(lineBytes(placebo), lineBytes(original), "same byte length per line");
}

function assertNoLeak(original, placebo) {
  assert.deepEqual(digitRuns(placebo), [], "no digit in the placebo");
  const allowed = new Set([...P.PLACEBO_LABELS, "context", "note"]);
  const orig = new Set(words(original));
  for (const w of words(placebo)) {
    if (allowed.has(w)) continue;
    assert.ok(!orig.has(w), `placebo word ${w} comes from the original`);
  }
  assert.equal(P.hasResidualClockText(placebo), false);
}

test("full block: same bytes, lines and line lengths; no digit or word leaks", () => {
  const r = P.substitutePlacebo(FULL_BLOCK);
  assert.equal(r.replaced, 1);
  assertShape(FULL_BLOCK, r.text);
  assertNoLeak(FULL_BLOCK, r.text);
  assert.equal(r.originalBytes, bytesOf(FULL_BLOCK));
  assert.equal(r.placeboBytes, r.originalBytes);
  const lines = r.text.split("\n");
  assert.ok(lines[0].startsWith(P.PLACEBO_OPEN));
  assert.equal(lines.at(-1), P.PLACEBO_CLOSE_PADDED);
  for (const l of lines.slice(1, -1)) assert.match(l, /^(ref|note|pad|item): [a-z ]+$/);
});

test("one-line form: same bytes, one line, no leak", () => {
  for (const line of [LINE_FORM, LINE_FORM_STALE]) {
    const r = P.substitutePlacebo(line);
    assert.equal(r.replaced, 1);
    assertShape(line, r.text);
    assertNoLeak(line, r.text);
    assert.ok(r.text.startsWith(P.PLACEBO_OPEN));
  }
});

test("UTF-8 block keeps byte lengths per line", () => {
  const r = P.substitutePlacebo(FULL_BLOCK_UTF8);
  assertShape(FULL_BLOCK_UTF8, r.text);
  assert.match(r.text, /^[\x20-\x7e\n]+$/, "placebo is ASCII");
});

test("snapshot inside a hook additionalContext: the text around it stays", () => {
  const before = "context-mode: output indexed (4.1 KB).";
  const ctx = before + "\n" + FULL_BLOCK;
  const r = P.substitutePlacebo(ctx);
  assert.ok(r.text.startsWith(before + "\n"));
  assertShape(ctx, r.text);
  const crlf = "a\r\n" + LINE_FORM + "\r\nb";
  const r2 = P.substitutePlacebo(crlf);
  assert.equal(bytesOf(r2.text), bytesOf(crlf));
  assert.ok(r2.text.startsWith("a\r\n") && r2.text.endsWith("\r\nb"));
});

test("two snapshots in one text are both replaced", () => {
  const t = LINE_FORM + "\nmiddle\n" + FULL_BLOCK;
  const r = P.substitutePlacebo(t);
  assert.equal(r.replaced, 2);
  assertShape(t, r.text);
  assert.ok(r.text.includes("\nmiddle\n"));
});

test("determinism: the same line lengths give the same placebo; content does not matter", () => {
  assert.equal(P.substitutePlacebo(FULL_BLOCK).text, P.substitutePlacebo(FULL_BLOCK).text);
  // same line lengths, different digits: same placebo
  const other = FULL_BLOCK.replace("tick=7 seq=42", "tick=8 seq=43").replace("62% of 1840", "71% of 9999");
  assert.deepEqual(lineBytes(other), lineBytes(FULL_BLOCK));
  assert.equal(P.substitutePlacebo(other).text, P.substitutePlacebo(FULL_BLOCK).text);
  assert.equal(P.placeboFor([20, 30], "block"), P.placeboFor([20, 30], "block"));
});

test("text with no snapshot is returned unchanged", () => {
  for (const t of ["", "plain tool output\nline 2", "[context-note] already a placebo", "a [context-clock] mention in prose", 42, null]) {
    const r = P.substitutePlacebo(t);
    assert.equal(r.text, t);
    assert.equal(r.replaced, 0);
  }
  assert.equal(P.hasClockFeedback("plain"), false);
  assert.equal(P.hasClockFeedback(FULL_BLOCK), true);
  assert.equal(P.hasClockFeedback(LINE_FORM), true);
});

test("an unclosed or oversized block is not replaced but is reported as residual", () => {
  const open = FULL_BLOCK.split("\n").slice(0, -1).join("\n");
  assert.equal(P.substitutePlacebo(open).replaced, 0);
  assert.equal(P.hasResidualClockText(open), true);
  const big = FULL_BLOCK.replace("session=", "session=" + "x".repeat(700));
  assert.equal(P.substitutePlacebo(big).replaced, 0);
  assert.equal(P.hasResidualClockText(big), true);
});

test("padded placebo tags match the real tag lengths", () => {
  assert.equal(bytesOf(P.PLACEBO_OPEN_PADDED), bytesOf(P.CLOCK_OPEN));
  assert.equal(bytesOf(P.PLACEBO_CLOSE_PADDED), bytesOf(P.CLOCK_CLOSE));
  assert.equal(P.PLACEBO_OPEN, "[context-note]");
});
