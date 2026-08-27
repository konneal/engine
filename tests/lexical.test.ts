import { test } from "node:test";
import assert from "node:assert/strict";
import { ftsMatchQuery } from "../workers/worker_public/src/lexical.ts";

test("drops stopwords, keeps jargon", () => {
  const q = ftsMatchQuery("What is the maximum permissible error for class III?");
  assert.ok(q);
  assert.ok(q!.includes('"maximum"'));
  assert.ok(q!.includes('"permissible"'));
  assert.ok(q!.includes('"error"'));
  assert.ok(!q!.includes('"the"'));
  assert.ok(!q!.includes('"what"'));
});

test("empty after stopwords → null", () => {
  assert.equal(ftsMatchQuery("what is the"), null);
});

test("part numbers and n_LC survive", () => {
  const q = ftsMatchQuery("n_LC limits R 60-1");
  assert.ok(q!.includes('"n_lc"') || q!.includes('"n_LC"') || q!.toLowerCase().includes("n_lc"));
});
