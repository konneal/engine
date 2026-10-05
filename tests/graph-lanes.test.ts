// The graph lanes resolve by identity: the family's query-relevant
// candidates rank by the corpus's own BM25 within the document set —
// never by Vectorize metadata filtering, which is dead on this index
// and merged nothing for these lanes' whole lives.

import assert from "node:assert/strict";
import { test } from "node:test";
import { graphLane } from "../workers/worker_public/src/stages/graphLane.ts";
import { conceptGraph } from "../workers/worker_public/src/stages/conceptGraph.ts";
import { THRESHOLDS } from "../workers/worker_public/src/config.ts";
import { runStages, type PipelineContext } from "../workers/worker_public/src/stages/types.ts";

const FAMILY_ROW = {
  id: "c620cc0652dc3945e", doc_id: "clean:r060/1", docidentifier: "OIML R 60-1", doctype: "R",
  doc_number: "60", edition: "2021", language: "en", clause_anchor: "5.2", clause_title: "MPE",
  status: "in-force", superseded_by: null, corpus: "oiml", tier: "curated",
  text: "the maximum permissible error limits for the load cell", rank: 2,
};
const CONCEPT_ROW = { ...FAMILY_ROW, id: "cconcept00000001", doc_number: "87", clause_title: "Definitions", text: "the actual quantity of prepackage" };

function envWith(ftsRows: any[]) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            all: async () => ({ results: sql.includes("chunks_fts") && sql.includes("doc_number IN") ? ftsRows : [] }),
          }),
        };
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

test("the graph lane merges the family's BM25-ranked candidates at the discount, text riding the metadata", async () => {
  const env = envWith([FAMILY_ROW]);
  const c = ctx(env, { opts: { graphDocNumbers: ["60"] } });
  await graphLane.prefetch!(c);
  await graphLane.run!(c);
  assert.equal(c.matches.length, 1);
  assert.equal(c.matches[0].id, FAMILY_ROW.id);
  assert.equal(c.matches[0].score, (1 / (1 + 2)) * THRESHOLDS.graphLaneDiscount * 0.5, "the narrowing halves the lane discount — the flood guard");
  assert.equal((c.matches[0].metadata as any).chunk_text, FAMILY_ROW.text, "toHits reads the text from here");
});

test("the concept graph lane resolves the linked documents' candidates through the same resolution", async () => {
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (..._a: unknown[]) => ({
            all: async () => ({ results: sql.includes("graph_edges") ? [{ doc: "doc:OIML-R-87-2004" }] : sql.includes("doc_number IN") ? [CONCEPT_ROW] : [] }),
          }),
        };
      },
    },
  };
  const c = ctx(env, { glossary: [{ term: "actual quantity", definition: "x", docidentifier: "R 87", doc_number: "87", score: 1 }] } as any);
  await conceptGraph.run!(c);
  assert.equal(c.matches.length, 1);
  assert.equal(c.matches[0].id, CONCEPT_ROW.id);
  assert.equal(c.matches[0].score, (1 / (1 + 2)) * THRESHOLDS.conceptGraphDiscount, "the same bm25 score shape as the graph lane");
});

test("the lanes never fire without their document sets", () => {
  const env = envWith([]);
  assert.equal(graphLane.when!(ctx(env)), false, "no doc numbers, no graph lane");
  assert.equal(conceptGraph.when!(ctx(env, { glossary: [] } as any)), false, "no glossary links, no concept lane");
});
