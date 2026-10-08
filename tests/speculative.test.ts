// Unit tests for the speculative draft-verify partition (TODO.sota/02
// row 2): diversified subsets over the answer window. The partition is
// the pure, deterministic core — the LLM legs fail additive and are the
// grid's business, not the unit suite's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionSubsets, SPECULATIVE_SUBSETS } from "../workers/worker_public/src/speculative.ts";
import type { Hit } from "../../workers/shared/chunk";

const hit = (doc: string, text: string): Hit =>
  ({
    score: 1,
    text,
    metadata: { docidentifier: doc, doc_id: doc.toLowerCase().replace(/\s+/g, "-"), chunk_id: `${doc}-${text.slice(0, 6)}` },
  }) as unknown as Hit;

test("fewer than two distinct documents: nothing to diversify — null", () => {
  assert.equal(partitionSubsets([hit("OIML R 60", "a"), hit("OIML R 60", "b")]), null);
  assert.equal(partitionSubsets([]), null);
});

test("subsets deal document-groups round-robin, reading order preserved", () => {
  const hits = [
    hit("OIML R 60", "r60-a"),
    hit("OIML D 11", "d11-a"),
    hit("OIML R 60", "r60-b"),
    hit("OIML B 18", "b18-a"),
    hit("OIML D 11", "d11-b"),
  ];
  const subsets = partitionSubsets(hits)!;
  assert.equal(subsets.length, SPECULATIVE_SUBSETS);
  // groups first-seen: R60, D11, B18 → subsets [R60], [D11], [B18]
  assert.deepEqual(subsets[0].map((h) => h.text), ["r60-a", "r60-b"]);
  assert.deepEqual(subsets[1].map((h) => h.text), ["d11-a", "d11-b"]);
  assert.deepEqual(subsets[2].map((h) => h.text), ["b18-a"]);
  // every hit lands exactly once
  const flat = subsets.flat();
  assert.equal(flat.length, hits.length);
});

test("more document groups than subsets: the extras fold in round-robin", () => {
  const hits = ["A", "B", "C", "D", "E"].map((d) => hit(`Doc ${d}`, d));
  const subsets = partitionSubsets(hits, 2)!;
  assert.equal(subsets.length, 2);
  assert.deepEqual(subsets[0].map((h) => h.text), ["A", "C", "E"]);
  assert.deepEqual(subsets[1].map((h) => h.text), ["B", "D"]);
});

test("deterministic: the same window partitions identically", () => {
  const hits = ["A", "B", "C", "A", "B", "C"].map((d, i) => hit(`Doc ${d}`, `${d}${i}`));
  const a = partitionSubsets(hits);
  const b = partitionSubsets(hits);
  assert.deepEqual(a, b);
});
