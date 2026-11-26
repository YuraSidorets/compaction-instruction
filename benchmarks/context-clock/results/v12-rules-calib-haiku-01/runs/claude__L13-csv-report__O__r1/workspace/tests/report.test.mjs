import { test } from "node:test";
import assert from "node:assert/strict";
import { columnSum, parseCsv } from "../src/report.mjs";

test("parseCsv reads the header and the rows", () => {
  assert.deepEqual(parseCsv("name,qty\napple,3\npear,5"), [{ name: "apple", qty: "3" }, { name: "pear", qty: "5" }]);
});

test("columnSum adds a column", () => {
  assert.equal(columnSum(parseCsv("qty\n3\n5"), "qty"), 8);
});
