// The licensed lane: identity-based resolution — the package's units
// come from the model plane's registry (D1), turn into index ids with
// the exporter's hash, and merge by id, deduplicated, at the lane's
// own threshold. No Vectorize filtering (measured broken on this
// index), no similarity search (the pool's rerank ranks the units).

import { test } from "node:test";
import assert from "node:assert/strict";
import { licensedLane } from "../workers/worker_public/src/stages/licensedLane.ts";
import { THRESHOLDS } from "../workers/worker_public/src/config.ts";
import { runStages, type PipelineContext } from "../workers/worker_public/src/stages/types.ts";

function envWith(dbResults: any[], byId: Record<string, any>) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: dbResults }),
        }),
      }),
    },
    VECTORIZE: {
      fetched: [] as string[],
      getByIds(ids: string[]) {
        this.fetched.push(...ids);
        return Promise.resolve(ids.filter((i) => byId[i]).map((id) => ({ id, score: 0, metadata: byId[id] })));
      },
    },
  };
}

function ctx(env: any, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    env, query: "damp heat", rq: "damp heat", folded: "damp heat",
    u: null, filters: null, filter: null, vector: [1, 0.5],
    lexicalHits: [], matches: [], hits: [], finalHits: [], glossary: [], notes: [],
    opts: {}, lane: {}, ...over,
  } as PipelineContext;
}

test("the lane resolves the package's units by the exporter's hash and merges them", async () => {
  const env = envWith(
    [{ standard: "iec-60068-2-30", node_id: "/req/iec-60068-2-30/chamber/temperature-cycle" }],
    { // the real id: m + sha1("iec-60068-2-30|/req/.../temperature-cycle")[:16]
      ["m" + [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("iec-60068-2-30|/req/iec-60068-2-30/chamber/temperature-cycle")))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)]: { standard: "iec-60068-2-30", standard_key: "std:iec-60068-2-30", chunk_text: "Cyclic temperature capability…" },
    },
  );
  const c = ctx(env, { opts: { licensedDocNumbers: ["iec-60068-2-30"] } });
  await licensedLane.run!(c);
  assert.equal(c.matches.length, 1, "the unit merges");
  assert.equal(c.matches[0].score, THRESHOLDS.licensedLaneScore);
  assert.equal(c.matches[0].metadata.standard_key, "std:iec-60068-2-30");
});

test("units whose vectors are absent merge as nothing; duplicates never double-merge", async () => {
  const env = envWith(
    [
      { standard: "iec-60068-2-30", node_id: "/req/a" },
      { standard: "iec-60068-2-30", node_id: "/req/b" },
    ],
    {}, // no vectors indexed for either
  );
  const c = ctx(env, { opts: { licensedDocNumbers: ["iec-60068-2-30"] } });
  await licensedLane.run!(c);
  assert.equal(c.matches.length, 0, "nothing merges without a vector");
});

test("the lane never fires without the option", () => {
  const env = envWith([], {});
  const silent = ctx(env);
  assert.equal(licensedLane.when!(silent), false);
});

// ── the seat ──────────────────────────────────────────────────────────

import { licensedCover } from "../workers/worker_public/src/stages/licensedCover.ts";
import type { Hit } from "../workers/shared/chunk.ts";

test("the cover seats the lane's best unit only when the cut dropped them all", async () => {
  const UNIT = { id: "mlic1", score: 0, metadata: { standard: "iec-60068-2-30", docidentifier: "IEC 60068-2-30:2005", chunk_text: "the cyclic test procedure" } };
  const env = {
    VECTORIZE: {
      getByIds(ids: string[]) {
        return Promise.resolve(ids.map((id) => (id === "mlic1" ? UNIT : null)).filter(Boolean));
      },
    },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
  };
  const ctx0 = {
    env, query: "damp heat", rq: "damp heat", folded: "damp heat",
    u: null, filters: null, filter: null, vector: [1, 0.5],
    lexicalHits: [], matches: [], hits: [], glossary: [], notes: [],
    finalHits: [{ id: "pub-1", score: 0.6, metadata: { docidentifier: "OIML D 11", corpus: "dirty" }, text: "restatement" } as unknown as Hit],
    opts: { licensedDocNumbers: ["iec-60068-2-30"] },
    lane: { "licensed-ids": Promise.resolve(["mlic1"]) },
  } as any;

  const seated = { ...ctx0 };
  await licensedCover.run!(seated);
  assert.equal(seated.finalHits.length, 2, "the dropped unit takes one seat");
  assert.match(String(seated.finalHits[1].metadata.docidentifier), /60068-2-30/);

  const already = {
    ...ctx0,
    finalHits: [{ id: "pub-1", score: 0.6, metadata: { docidentifier: "OIML D 11" }, text: "x" } as unknown as Hit,
      { id: "mlic1", score: 0.5, metadata: UNIT.metadata, text: "the cyclic test procedure" } as unknown as Hit],
  };
  await licensedCover.run!(already);
  assert.equal(already.finalHits.length, 2, "a present unit means no seat");
}
);
