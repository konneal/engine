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

test("the doubled u: prefix — the model copying the passage header verbatim — parses, sanitizes and NORMALIZES", () => {
  const doubled = "records the state [[u:u:_e3dc07ba-c68d-ef45-cb2b-d6020adc2492]], plus header";
  assert.deepEqual(parseRefs(doubled), ["u:_e3dc07ba-c68d-ef45-cb2b-d6020adc2492"]);
  const { text, dropped } = sanitizeRefs(doubled, new Set(["u:_e3dc07ba-c68d-ef45-cb2b-d6020adc2492"]));
  assert.equal(dropped.length, 0);
  // the SERVED token is the normalized single-prefix form — the client
  // parses it too, so the doubled shape must not survive
  assert.match(text, /\[\[u:_e3dc07ba-c68d-ef45-cb2b-d6020adc2492\]\]/);
  assert.doesNotMatch(text, /u:u:/);
});
