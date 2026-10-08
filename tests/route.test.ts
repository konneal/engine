// Unit tests for the adaptive router (TODO.sota/05): the feature rules
// that pick fast or deep, and the fast route's stage projection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFor, fastRouteStages, ROUTE_FAST_DROPS, ROUTE_FAST_WORD_CAP } from "../workers/worker_public/src/route.ts";
import { STAGE_NAMES } from "../workers/worker_public/src/stages/index.ts";

const SHORT = "What is the maximum permissible error?"; // 5 words

test("deep features: complexity, sub-queries, process intent, long questions", () => {
  assert.equal(routeFor({ complexity: "complex" }, SHORT).route, "deep");
  assert.deepEqual(routeFor({ complexity: "complex" }, SHORT).features, ["complex"]);
  assert.equal(routeFor({ sub_queries: ["a", "b"] }, SHORT).route, "deep");
  assert.equal(routeFor({ process_intent: true }, SHORT).route, "deep");
  assert.equal(routeFor(null, "word ".repeat(ROUTE_FAST_WORD_CAP + 1)).route, "deep");
  assert.ok(routeFor(null, "word ".repeat(ROUTE_FAST_WORD_CAP + 1)).features.includes("long-question"));
});

test("a document scope rides deep: the narrowed pool keeps every lane", () => {
  // the 2026-10-08 gate: a chip-declared scope routed fast refused
  // intermittently — the sealed pool starved without the variant lanes
  const r = routeFor({ doc_number: "60", complexity: "simple" }, SHORT);
  assert.equal(r.route, "deep");
  assert.ok(r.features.includes("doc-scoped"));
});

test("fast features: definitional, terminology, short", () => {
  assert.ok(routeFor({ term: "creep" }, SHORT).features.includes("definitional"));
  assert.ok(routeFor({ defined_terms: ["drift"] }, SHORT).features.includes("terminology"));
  assert.ok(routeFor(null, SHORT).features.includes("short-question"));
  assert.equal(routeFor(null, SHORT).route, "fast");
});

test("every question routes: short without deep features is fast, long is deep", () => {
  // the word cap is the only length rule — no unreachable middle
  assert.equal(routeFor({ complexity: "simple" }, "word ".repeat(ROUTE_FAST_WORD_CAP).trim()).route, "fast");
  assert.equal(routeFor(null, "word ".repeat(ROUTE_FAST_WORD_CAP + 1).trim()).route, "deep");
});

test("deep features outrank fast ones — one deep feature decides", () => {
  const r = routeFor({ complexity: "complex", doc_number: "60", term: "creep" }, SHORT);
  assert.equal(r.route, "deep");
});

test("the fast route drops exactly the expansion lanes, in registry order", () => {
  const fast = fastRouteStages(STAGE_NAMES);
  assert.equal(fast.length, STAGE_NAMES.length - ROUTE_FAST_DROPS.length);
  for (const drop of ROUTE_FAST_DROPS) assert.ok(!fast.includes(drop));
  const idx = fast.map((s) => STAGE_NAMES.indexOf(s));
  assert.deepEqual(idx, idx.slice().sort((a, b) => a - b));
  assert.ok(fast.includes("pool-open") && fast.includes("diversity") && fast.includes("dense"));
});
