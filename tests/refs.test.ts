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
  const { text, dropped } = sanitizeRefs("plain answer [OIML R 60 §1]", new Set());
  assert.equal(text, "plain answer [OIML R 60 §1]");
  assert.equal(dropped.length, 0);
});
