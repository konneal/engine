// Unit tests for the answer-cache key shape, the fresh bypass and the
// corpus-generation stamp (oimlsmart/rag#72). Runs on plain node (type
// stripping, no build step): node --test tests/answercache.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CORPUS_GEN_KEY, cacheKeyMaterial, corpusGen, exactCacheKey, freshRequested, semanticCacheKey } from "../workers/worker_public/src/answercache.ts";

const fakeKv = (stored: Record<string, string>, throws = false) =>
  ({
    async get(key: string) {
      if (throws) throw new Error("kv down");
      return stored[key] ?? null;
    },
  }) as unknown as KVNamespace;

test("fresh: the JSON boolean bypasses", () => {
  assert.equal(freshRequested({ fresh: true }), true);
  assert.equal(freshRequested({ fresh: false }), false);
  assert.equal(freshRequested({}), false);
  assert.equal(freshRequested(null), false);
});

test("fresh: the serialized forms a JSON caller may send also bypass", () => {
  // the strict `body?.fresh === true` this replaces silently served the
  // cache to these — a fresh ask that did not regenerate
  assert.equal(freshRequested({ fresh: "true" }), true);
  assert.equal(freshRequested({ fresh: 1 }), true);
  assert.equal(freshRequested({ fresh: "1" }), true);
});

test("fresh: lookalikes are not a bypass request", () => {
  assert.equal(freshRequested({ fresh: "false" }), false);
  assert.equal(freshRequested({ fresh: 0 }), false);
  assert.equal(freshRequested({ fresh: "yes" }), false);
  assert.equal(freshRequested({ fresh: undefined }), false);
});

test("exact key: corpus generation and index version are key segments", () => {
  const k1 = exactCacheKey("v2.81", "0", "anon", "abc123");
  const k2 = exactCacheKey("v2.81", "20260904T120000Z", "anon", "abc123");
  assert.equal(k1, "a:v2.81:g0:anon:abc123");
  assert.notEqual(k1, k2); // a generation bump makes the old entry miss
  const k3 = exactCacheKey("v2.82", "0", "anon", "abc123");
  assert.notEqual(k1, k3); // a deploy bump still invalidates
  const k4 = exactCacheKey("v2.81", "0", "k:key1", "abc123");
  assert.notEqual(k1, k4); // the tier namespace stays a segment
});

test("key material: query normalization and lang/lang-less split survive", () => {
  assert.equal(cacheKeyMaterial("  What   is R 60? "), cacheKeyMaterial("what is r 60?"));
  assert.equal(cacheKeyMaterial("what is r 60?"), "what is r 60?|");
  assert.notEqual(cacheKeyMaterial("what is r 60?"), cacheKeyMaterial("what is r 60?", "en"));
});

test("semantic key: same corpus-generation namespacing", () => {
  const s1 = semanticCacheKey("v2.81", "0", "0.12,0.34");
  const s2 = semanticCacheKey("v2.81", "20260904T120000Z", "0.12,0.34");
  assert.equal(s1, "sc:v2.81:g0:0.12,0.34");
  assert.notEqual(s1, s2);
});

test("corpus generation: stored stamp, unset default, fail-open", async () => {
  assert.equal(await corpusGen(fakeKv({ [CORPUS_GEN_KEY]: "20260904T120000Z" })), "20260904T120000Z");
  assert.equal(await corpusGen(fakeKv({})), "0");
  assert.equal(await corpusGen(fakeKv({}, true)), "0");
});
