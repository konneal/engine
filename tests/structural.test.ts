// Unit tests for structural retrieval (FABLE/BEAR adaptations). Runs on
// plain node (type stripping, no build step): node --test tests/structural.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnchor,
  isAncestorOf,
  anchorCompare,
  structuralPropagation,
  positionOrder,
  ancestorDescendantDedup,
} from "../workers/worker_public/src/structural.ts";
import type { Hit } from "../workers/worker_public/src/pipeline.ts";

const hit = (over: Partial<Hit> & { id: string }): Hit => ({
  score: 0.5,
  metadata: {
    doc_id: "d1",
    docidentifier: "OIML R 76-1",
    doctype: "R",
    doc_number: "R 76-1",
    edition: "2006",
    language: "en",
    clause_anchor: "",
    clause_title: "",
    tier: "dirty",
    corpus: "oiml",
    text_ref: "",
  },
  text: "",
  ...over,
} as Hit);

test("parseAnchor: dotted numerics only", () => {
  assert.deepEqual(parseAnchor("3.1.2"), [3, 1, 2]);
  assert.deepEqual(parseAnchor("4."), [4]);
  assert.equal(parseAnchor("overview"), null);
  assert.equal(parseAnchor("_c631773b-1234"), null);
  assert.equal(parseAnchor(""), null);
  assert.equal(parseAnchor("Annex A"), null);
});

test("ancestor and document order", () => {
  assert.ok(isAncestorOf([3, 1], [3, 1, 2]));
  assert.ok(!isAncestorOf([3, 1], [3, 1]));
  assert.ok(!isAncestorOf([3, 1, 2], [3, 1]));
  assert.ok(anchorCompare([3], [3, 1]) < 0);
  assert.ok(anchorCompare([3, 1], [3, 1, 2]) < 0);
  assert.ok(anchorCompare([3, 2], [3, 10]) < 0);
  assert.ok(anchorCompare([3, 10], [4]) < 0);
});

test("propagation lifts a section whose clauses are hot", () => {
  const cold = hit({ id: "a", score: 0.20, metadata: { clause_anchor: "3.1" } as any });
  const h1 = hit({ id: "b", score: 0.90, metadata: { clause_anchor: "3.2.1" } as any });
  const h2 = hit({ id: "c", score: 0.85, metadata: { clause_anchor: "3.2.2" } as any });
  const hot = hit({ id: "d", score: 0.60, metadata: { clause_anchor: "3.2" } as any });
  const out = structuralPropagation([cold, h1, h2, hot]);
  // 3.2's structural score (avg of hot children) exceeds its own → rises
  assert.ok(out.indexOf(hot) < out.indexOf(cold), `hot section should outrank cold: ${out.map((h) => h.id)}`);
  // and its strong children inherit from it — ordering among them holds
  assert.ok(out.indexOf(h1) < out.indexOf(cold));
});

test("propagation is a no-op without numeric anchors", () => {
  const a = hit({ id: "a", score: 0.9, metadata: { clause_anchor: "overview" } as any });
  const b = hit({ id: "b", score: 0.1, metadata: { clause_anchor: "" } as any });
  const c = hit({ id: "c", score: 0.5, metadata: { clause_anchor: "" } as any });
  const out = structuralPropagation([a, b, c]);
  // no numeric anchors → no propagation, no re-sort: order untouched
  assert.deepEqual(out.map((h) => h.id), ["a", "b", "c"]);
});

test("positionOrder: doc groups by best rank, clauses in document order", () => {
  const d2 = hit({ id: "x1", score: 0.9, metadata: { doc_id: "d2", clause_anchor: "5.2" } as any });
  const d1a = hit({ id: "y1", score: 0.85, metadata: { doc_id: "d1", clause_anchor: "3.2" } as any });
  const ov = hit({ id: "y0", score: 0.30, metadata: { doc_id: "d1", clause_anchor: "overview" } as any });
  const d1b = hit({ id: "y2", score: 0.80, metadata: { doc_id: "d1", clause_anchor: "3.1" } as any });
  const d1c = hit({ id: "y3", score: 0.70, metadata: { doc_id: "d1", clause_anchor: "3.10" } as any });
  const out = positionOrder([d2, d1a, ov, d1b, d1c]);
  // d2's best outranks d1's best → d2 group first
  // d1 group: overview leads, then 3.1 < 3.2 < 3.10 numerically
  assert.deepEqual(out.map((h) => h.id), ["x1", "y0", "y2", "y1", "y3"]);
});

test("dedup collapses same-chain near-duplicates, keeps distinct content", () => {
  const dupText =
    "3.1 Metrological requirements: the maximum permissible error of an automatic weighing instrument shall not exceed the values in table 1";
  const parent = hit({ id: "p", score: 0.9, text: dupText, metadata: { clause_anchor: "3.1" } as any });
  const child = hit({ id: "c", score: 0.5, text: dupText + " (restated)", metadata: { clause_anchor: "3.1.1" } as any });
  const distinct = hit({
    id: "k",
    score: 0.4,
    text: "Humidity limits for the instrument environment and condensation tests",
    metadata: { clause_anchor: "3.1.2" } as any,
  });
  const out = ancestorDescendantDedup([parent, child, distinct]);
  assert.deepEqual(out.map((h) => h.id), ["p", "k"]);
});

test("dedup never crosses documents", () => {
  const t = "Identical heading text about maximum permissible errors in weighing";
  const a = hit({ id: "a", score: 0.9, text: t, metadata: { doc_id: "d1", clause_anchor: "3.1" } as any });
  const b = hit({ id: "b", score: 0.5, text: t, metadata: { doc_id: "d2", clause_anchor: "3.1.1" } as any });
  const out = ancestorDescendantDedup([a, b]);
  assert.equal(out.length, 2);
});
