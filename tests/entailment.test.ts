import test from "node:test";
import assert from "node:assert/strict";
import { entailmentVerdict } from "../workers/worker_public/src/entailment.ts";

test("the entailment verdict maps scores to honest notes", () => {
  assert.equal(entailmentVerdict(1.0, 0.9, 0.5).support, "supported");
  assert.equal(entailmentVerdict(1.0, 0.9, 0.5).note, "");
  assert.equal(entailmentVerdict(0.9, 0.9, 0.5).support, "supported");
  const partial = entailmentVerdict(0.62, 0.9, 0.5);
  assert.equal(partial.support, "partial");
  assert.match(partial.note, /Partially grounded/);
  const bad = entailmentVerdict(0.2, 0.9, 0.5);
  assert.equal(bad.support, "unsupported");
  assert.match(bad.note, /WARNING/);
  assert.equal(entailmentVerdict(0.49, 0.9, 0.5).support, "unsupported");
});
