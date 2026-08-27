// Unit tests for the deterministic quote-anchor verifier. Runs on plain
// node (type stripping, no build step): node --test tests/anchors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuoteAnchors } from "../workers/worker_public/src/anchors.ts";

const passages = [
  "For class III, the maximum permissible error shall not exceed 0.5e at zero load and at any load between the minimum and maximum capacity.",
  "La cellule de pesée doit satisfaire aux exigences métrologiques.",
];

test("verbatim quote passes", () => {
  const answer = 'The limit is set out as [OIML R 76-1:2006 §3.2: "the maximum permissible error shall not exceed 0.5e"].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 1);
  assert.equal(check.violations.length, 0);
});

test("fabricated quote fails", () => {
  const answer = 'The limit is [OIML R 76-1:2006 §3.2: "the mpe must never exceed 1.0e in any circumstance"].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 1);
  assert.equal(check.violations.length, 1);
});

test("plain citation without a quote is not checked", () => {
  const answer = "See [OIML R 60-1:2021 §4.4.2] for the requirement.";
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 0);
  assert.equal(check.violations.length, 0);
});

test("normalization: whitespace, case", () => {
  const answer = 'Cited as [OIML R 76:2004 §3.2: "The Maximum   Permissible Error shall not exceed 0.5e"].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 1);
  assert.equal(check.violations.length, 0);
});

test("curly-quote delimiters are recognized", () => {
  const answer = 'Cited as [OIML R 76-1:2006 §3.2: “the maximum permissible error shall not exceed 0.5e”].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 1);
  assert.equal(check.violations.length, 0);
});

test("guillemets quotes are checked too", () => {
  const answer = "Selon [OIML R 60-1:2021 §4.4.2: «la cellule de pesée doit satisfaire»].";
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 1);
  assert.equal(check.violations.length, 0);
});

test("partial quote of a passage still passes (substring)", () => {
  const answer = 'See [OIML R 76-1:2006 §3.2: "at zero load and at any load"].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.violations.length, 0);
});

test("mixed anchors: only the bad one is reported", () => {
  const answer = 'A [OIML R 76-1:2006 §3.2: "the maximum permissible error shall not exceed 0.5e"] and B [OIML R 76:2004 §3.5: "a fabricated quote entirely"].';
  const check = checkQuoteAnchors(answer, passages);
  assert.equal(check.total, 2);
  assert.equal(check.violations.length, 1);
  assert.ok(check.violations[0].includes("fabricated"));
});
