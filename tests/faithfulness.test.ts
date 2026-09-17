// The judge verdict parser: reasoning models emit drafts, fenced blocks,
// prose and several objects before the verdict; claim strings can carry
// braces. These are the shapes the old flat-object regex missed live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../workers/worker_public/src/verdict-parse.ts";

test("plain verdict object", () => {
  const v = parseVerdict('{"score": 1.0, "ungrounded_claims": []}');
  assert.deepEqual(v, { score: 1, ungrounded_claims: [] });
});

test("verdict fenced as markdown json", () => {
  const v = parseVerdict('```json\n{"score": 0.75, "ungrounded_claims": ["one"]}\n```');
  assert.equal(v?.score, 0.75);
  assert.deepEqual(v?.ungrounded_claims, ["one"]);
});

test("claims containing braces survive the scan", () => {
  const v = parseVerdict('{"score": 0.5, "ungrounded_claims": ["uses {x} notation", "the set {a, b} is complete"]}');
  assert.equal(v?.score, 0.5);
  assert.equal(v?.ungrounded_claims.length, 2);
});

test("last well-formed object wins over reasoning drafts", () => {
  const text = 'thinking... {"score": 0.2, "ungrounded_claims": ["draft"]} more text {"score": 0.9, "ungrounded_claims": []} done';
  const v = parseVerdict(text);
  assert.equal(v?.score, 0.9);
  assert.deepEqual(v?.ungrounded_claims, []);
});

test("nested objects do not hide the verdict", () => {
  const text = '{"analysis": {"claims": 3, "grounded": 2}} {"score": 0.667, "ungrounded_claims": ["the third"]}';
  const v = parseVerdict(text);
  assert.equal(v?.score, 0.667);
  assert.deepEqual(v?.ungrounded_claims, ["the third"]);
});

test("score clamped into [0,1]; string scores coerced", () => {
  assert.equal(parseVerdict('{"score": 1.7, "ungrounded_claims": []}')?.score, 1);
  assert.equal(parseVerdict('{"score": -0.3, "ungrounded_claims": []}')?.score, 0);
  assert.equal(parseVerdict('{"score": "0.8", "ungrounded_claims": []}')?.score, 0.8);
});

test("truncated JSON yields null, not a wrong fragment", () => {
  assert.equal(parseVerdict('{"score": 0.9, "ungrounded_claims": ["truncat'), null);
});

test("no object at all yields null", () => {
  assert.equal(parseVerdict("The answer is fully grounded."), null);
  assert.equal(parseVerdict(""), null);
});

test("escaped quotes inside claims do not derail string tracking", () => {
  const v = parseVerdict(String.raw`{"score": 0.4, "ungrounded_claims": ["the \"quoted\" {claim}"]}`);
  assert.equal(v?.score, 0.4);
  assert.equal(v?.ungrounded_claims[0], 'the "quoted" {claim}');
});
