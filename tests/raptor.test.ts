// Unit tests for the two-level section descent (TODO.sota/06, catalog
// row 3 — the RAPTOR extension): level 1 unchanged (the filtered
// same-query search), level 2 walking document summary → section units
// (by id, the ≤20 law) → clauses (the D1 corpus directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionDescent } from "../workers/worker_public/src/stages/sectionDescent.ts";
import type { PipelineContext } from "../workers/worker_public/src/stages/types.ts";
import type { Hit } from "../../workers/shared/chunk";

const hit = (over: Partial<Hit> & { id: string }): Hit =>
  ({
    score: 1,
    text: "",
    metadata: {},
    ...over,
  }) as unknown as Hit;

function ctx(finalHits: Hit[], env: unknown): PipelineContext {
  return { finalHits, env, vector: [0.1, 0.2] } as unknown as PipelineContext;
}

const DOC_SUMMARY = hit({
  id: "docs-family:R-60",
  score: 0.9,
  metadata: {
    section_summary: "1",
    summary_level: "2",
    docidentifier: "OIML R 60",
    doc_id: "family:R-60",
    child_anchors: "sec-family:R-60-3,sec-family:R-60-5",
  },
});

const level2Env = {
  VECTORIZE: {
    async getByIds(ids: string[]) {
      return ids.map((id) => ({
        id,
        values: [],
        metadata: {
          section_summary: "1",
          doc_id: "family:R-60",
          docidentifier: "OIML R 60",
          clause_anchor: id === "sec-family:R-60-3" ? "3" : "5",
          clause_title: id === "sec-family:R-60-3" ? "Metrology" : "Metrological requirements",
          chunk_text: `summary of §${id}`,
          child_anchors: id === "sec-family:R-60-3" ? "3.1,3.2" : "5.1",
        },
      }));
    },
  },
  DB: {
    prepare(_sql: string) {
      return {
        bind(...values: unknown[]) {
          const docId = values[0];
          const anchors = values.slice(1) as string[];
          return {
            async all() {
              const rows = anchors.map((a, i) => ({
                id: `chunk-${a}`,
                doc_id: docId,
                docidentifier: "OIML R 60",
                doctype: "R",
                doc_number: "60",
                edition: "2021",
                language: "en",
                clause_anchor: a,
                clause_title: `clause ${a}`,
                status: "in-force",
                superseded_by: "",
                corpus: "clean",
                tier: "curated",
                text: `text of clause ${a} (${i})`,
                unit_id: "",
                block: "",
              }));
              return { results: docId === "family:R-60" ? rows : [] };
            },
          };
        },
      };
    },
  },
};

test("level-2: the document summary descends to its sections' clauses and retires", async () => {
  const c = ctx([DOC_SUMMARY], level2Env);
  await sectionDescent.run(c);
  assert.ok(!c.finalHits.includes(DOC_SUMMARY), "the synthetic doc summary retires");
  const anchors = c.finalHits.map((h) => h.metadata.clause_anchor);
  // reading order: §3's clauses before §5's
  assert.deepEqual(anchors, ["3.1", "3.2", "5.1"]);
  for (const h of c.finalHits) {
    assert.ok(h.score > 0 && h.score < 1, `discounted score ${h.score}`);
    assert.equal(h.metadata.section_summary, undefined, "clauses, never summaries");
  }
});

test("level-2: no sections in the index — the summary stays (the doc's sole representative)", async () => {
  const emptyIndex = { ...level2Env, VECTORIZE: { async getByIds() { return []; } } };
  const c = ctx([DOC_SUMMARY], emptyIndex);
  await sectionDescent.run(c);
  assert.equal(c.finalHits.length, 1);
  assert.ok(c.finalHits.includes(DOC_SUMMARY));
});

test("level-2: clauses already in the window are not duplicated", async () => {
  const dup = hit({ id: "chunk-3.1", score: 0.8, metadata: { clause_anchor: "3.1" } });
  const c = ctx([DOC_SUMMARY, dup], level2Env);
  await sectionDescent.run(c);
  const anchors = c.finalHits.map((h) => h.metadata.clause_anchor);
  assert.equal(anchors.filter((a) => a === "3.1").length, 1);
  assert.ok(!c.finalHits.includes(DOC_SUMMARY));
});

test("level-1: the filtered same-query search still descends (unchanged behavior)", async () => {
  const sec = hit({
    id: "sec-r60-3",
    score: 0.9,
    metadata: {
      section_summary: "1",
      doc_id: "family:R-60",
      docidentifier: "OIML R 60",
      clause_anchor: "3",
      child_anchors: "3.1,3.2,3.3",
    },
  });
  const level1Env = {
    VECTORIZE: {
      async query(_v: number[], _o: unknown) {
        return {
          matches: [
            { id: "chunk-3.2", score: 0.8, metadata: { clause_anchor: "3.2", doc_id: "family:R-60", chunk_text: "t" } },
            { id: "chunk-3.3", score: 0.7, metadata: { clause_anchor: "3.3", doc_id: "family:R-60", chunk_text: "t" } },
            { id: "sec-r60-4", score: 0.6, metadata: { clause_anchor: "4", section_summary: "1", chunk_text: "s" } },
          ],
        };
      },
    },
  };
  const c = ctx([sec], level1Env);
  await sectionDescent.run(c);
  assert.ok(!c.finalHits.includes(sec), "the summary retires");
  assert.deepEqual(c.finalHits.map((h) => h.id), ["chunk-3.2", "chunk-3.3"]);
});

test("the guard: no ranked summary, no descent", async () => {
  const c = ctx([hit({ id: "x", score: 0.9, metadata: { clause_anchor: "1" } })], level2Env);
  assert.equal(sectionDescent.when!(c), false);
});
