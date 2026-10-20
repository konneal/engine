// The enrichment route's decision policy (enrichPolicy.ts) — the table
// that decides a chunk's outcome from the cache read and the generation.
// The serve-raw branch is the 2026-10-20 class: real corpus content
// must not vanish from the index because its enrichment has nothing to
// say; the builder modes want the signal instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, enrichOutcome } from "../workers/worker_public/src/enrichPolicy.ts";

test("normalizeContext trims, unwraps quotes, caps at 400", () => {
  assert.equal(normalizeContext('  "The load cell converts force into a signal."  '), "The load cell converts force into a signal.");
  assert.equal(normalizeContext(undefined), "");
  assert.equal(normalizeContext(42), "");
  assert.equal(normalizeContext("x".repeat(500)).length, 400);
});

test("a cached or generated context serves enriched", () => {
  const cached = enrichOutcome({ cached: "from cache", generated: "", contextOnly: false, abMode: false });
  assert.deepEqual(cached, { action: "serve", context: "from cache", cached: true });
  const generated = enrichOutcome({ cached: null, generated: "fresh", contextOnly: false, abMode: false });
  assert.deepEqual(generated, { action: "serve", context: "fresh", cached: false });
});

test("an empty generation in the production flow serves RAW", () => {
  const outcome = enrichOutcome({ cached: null, generated: "", contextOnly: false, abMode: false });
  assert.deepEqual(outcome, { action: "serve-raw" });
});

test("an empty generation in the builder modes fails instead of writing", () => {
  for (const mode of [{ contextOnly: true, abMode: false }, { contextOnly: false, abMode: true }]) {
    const outcome = enrichOutcome({ cached: null, generated: "", ...mode });
    assert.deepEqual(outcome, { action: "fail", error: "empty enrichment" });
  }
});

test("a cached context wins over the generation, and force reads as no-cache", () => {
  const both = enrichOutcome({ cached: "cached text", generated: "fresh text", contextOnly: false, abMode: false });
  assert.equal(both.action, "serve");
  assert.equal((both as any).context, "cached text");
  // the handler expresses force as cached=null — the policy sees only
  // what the cache returned
  const forced = enrichOutcome({ cached: null, generated: "", contextOnly: false, abMode: false });
  assert.equal(forced.action, "serve-raw");
});
