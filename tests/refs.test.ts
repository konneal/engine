import { test } from "node:test";
import assert from "node:assert/strict";
import { availableUnitIds, parseRefs, sanitizeRefs } from "../workers/worker_public/src/refs.ts";

test("available unit ids from used hits", () => {
  const ids = availableUnitIds([{ metadata: { unit_id: "u:abc" } }, { metadata: {} }, { metadata: { unit_id: "u:def" } }]);
  assert.deepEqual([...ids].sort(), ["u:abc", "u:def"]);
});

test("parse refs", () => {
  assert.deepEqual(parseRefs("see [[u:abc]] and [[u:def]] but not [[v:x]]"), ["u:abc", "u:def"]);
});

test("valid refs survive, invalid dropped and stripped", () => {
  const { text, dropped } = sanitizeRefs("keep [[u:abc]] drop [[u:ghost]]", new Set(["u:abc"]));
  assert.equal(text, "keep [[u:abc]] drop ");
  assert.deepEqual(dropped, ["u:ghost"]);
});

test("no refs → unchanged", () => {
  const { text, dropped } = sanitizeRefs("plain answer [ACME AB 99 §1]", new Set());
  assert.equal(text, "plain answer [ACME AB 99 §1]");
  assert.equal(dropped.length, 0);
});

import { tableRetyped } from "../workers/worker_public/src/refs.ts";

test("markdown table + typed unit available → retyped", () => {
  const md = "Here:\n\n| Class | A | B |\n|---|---|---|\n| x | 1 | 2 |\n| y | 3 | 4 |";
  assert.ok(tableRetyped(md, true));
});

test("prose with pipes but no table → not retyped", () => {
  assert.ok(!tableRetyped("a | b | c in prose and one | two", true));
});

test("no typed unit available → never flagged", () => {
  assert.ok(!tableRetyped("| a | b |\n|---|---|\n| 1 | 2 |", false));
});
