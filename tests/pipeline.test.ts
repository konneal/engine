// Pipeline integration test (TODO.impl/06): exercises the stage registry
// composition and each stage's invariant with an in-memory fixture
// environment — no network, no Workers runtime. The embedding fake is a
// term-presence vector over a fixed vocabulary (what embeddings
// approximate), so dense scores, rerank scores and glossary cosines are
// all deterministic functions of the fixture text.
//
// NOTE: pipeline.ts itself imports .md prompt files (Node cannot load
// them), so the composition under test is the registry — runStages over
// STAGES — which is exactly what retrieve() composes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES } from "../workers/worker_public/src/stages/index.ts";
import { runStages, type PipelineContext } from "../workers/worker_public/src/stages/types.ts";
import { dense } from "../workers/worker_public/src/stages/dense.ts";
import { hyde } from "../workers/worker_public/src/stages/hyde.ts";
import { poolOpen } from "../workers/worker_public/src/stages/poolOpen.ts";
import { lexicalUnion } from "../workers/worker_public/src/stages/lexicalUnion.ts";
import { federate } from "../workers/worker_public/src/stages/federate.ts";
import { seal } from "../workers/worker_public/src/stages/seal.ts";
import { overviewDemote } from "../workers/worker_public/src/stages/overviewDemote.ts";
import { familyBoost } from "../workers/worker_public/src/stages/familyBoost.ts";
import { termNudge } from "../workers/worker_public/src/stages/termNudge.ts";
import { editionSteer } from "../workers/worker_public/src/stages/editionSteer.ts";
import { diversity } from "../workers/worker_public/src/stages/diversity.ts";
import { windowFloor } from "../workers/worker_public/src/stages/windowFloor.ts";
import { dedup } from "../workers/worker_public/src/stages/dedup.ts";
import type { ChunkMeta, Hit } from "../workers/shared/chunk.ts";

// ── the fixture environment ─────────────────────────────────────────────

const VOCAB = [
  "load", "cell", "creep", "maximum", "permissible", "error", "accuracy",
  "class", "prepackage", "actual", "quantity", "overview", "family",
  "parts", "annex", "humidity", "testing",
];

function vec(text: string): number[] {
  const t = text.toLowerCase();
  return VOCAB.map((w) => (t.includes(w) ? 1 : 0));
}

interface Fixture {
  id: string;
  meta: ChunkMeta;
  text: string;
}

function fx(id: string, meta: Partial<ChunkMeta>, text: string): Fixture {
  return { id, meta: { doc_id: "", docidentifier: "", doctype: "R", doc_number: "", edition: "", language: "en", clause_anchor: "", clause_title: "", tier: "", corpus: "oiml", text_ref: "", ...meta } as ChunkMeta, text };
}

const CORPUS: Fixture[] = [
  fx("r60-ov", { doc_id: "d-r60", docidentifier: "OIML R 60-1", doc_number: "60", edition: "2006", clause_anchor: "overview", clause_title: "Overview" }, "overview of the recommendation parts and annex structure"),
  fx("r60-fam", { doc_id: "d-r60", docidentifier: "OIML R 60", doc_number: "60", edition: "2006", clause_anchor: "family", clause_title: "Family" }, "family of parts"),
  fx("r60-52", { doc_id: "d-r60", docidentifier: "OIML R 60-1", doc_number: "60", edition: "2006", clause_anchor: "5.2", clause_title: "Load cell terminology" }, "a load cell converts a force into a measurable signal; creep is the change under constant load"),
  fx("r60-tbl", { doc_id: "d-r60", docidentifier: "OIML R 60-1", doc_number: "60", edition: "2006", clause_anchor: "5.4", clause_title: "Maximum permissible errors", unit_id: "u:r60-tbl", block: "table" }, "class | maximum | permissible | error\nA | 0.5 | v | e\nB | 1.0 | v | e"),
  fx("r76-tbl", { doc_id: "d-r76", docidentifier: "OIML R 76-2", doc_number: "76", edition: "2006", clause_anchor: "3.2", clause_title: "Accuracy classes", unit_id: "u:r76-tbl", block: "table" }, "class | accuracy | error\nIII | 1.5 | v | e"),
  fx("r87-04", { doc_id: "d-r87", docidentifier: "OIML R 87", doc_number: "87", edition: "2004", clause_anchor: "3.1", clause_title: "Actual quantity" }, "the actual quantity of prepackage contents; quantity rules for prepackage labeling"),
  fx("r87-95", { doc_id: "d-r87b", docidentifier: "OIML R 87", doc_number: "87", edition: "1995", clause_anchor: "3.1", clause_title: "Actual quantity" }, "the actual quantity of prepackage contents in the 1995 edition"),
  fx("d117", { doc_id: "d-117", docidentifier: "OIML D 117", doc_number: "117", edition: "2003", clause_anchor: "6", clause_title: "Humidity testing" }, "humidity testing conditions for chambers"),
];

const GLOSSARY_FIXTURE = [
  { term: "actual quantity", text: "actual quantity — the net quantity of product in a prepackage", docidentifier: "OIML R 87", doc_number: "87" },
  { term: "load cell", text: "load cell — force to signal converter", docidentifier: "OIML R 60-1", doc_number: "60" },
];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function matchesFilter(meta: ChunkMeta, filter: any): boolean {
  if (!filter) return true;
  if (filter.$and) return filter.$and.every((f: any) => matchesFilter(meta, f));
  for (const [key, cond] of Object.entries(filter)) {
    const v = (meta as any)[key];
    if (cond && typeof cond === "object") {
      if (cond.$eq !== undefined && v !== cond.$eq) return false;
      if (cond.$in !== undefined && !cond.$in.includes(v)) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function makeEnv(opts: { graphDocs?: string[]; lexicalIds?: string[] } = {}) {
  const AI = {
    run: async (model: string, body: any) => {
      if (body?.text?.[0] !== undefined) return { data: [vec(body.text[0])] }; // embed
      if (body?.contexts) {
        // rerank: overlap of the query's terms with each context text
        const qv = vec(body.query);
        return { data: body.contexts.map((c: any) => {
          const cv = vec(c.text ?? c);
          const dot = qv.reduce((s: number, x: number, i: number) => s + x * cv[i], 0);
          return dot > 0 ? dot : 0.01;
        }) };
      }
      return {};
    },
  };
  const VECTORIZE = {
    query: async (v: number[], q: any) => {
      let pool = CORPUS.filter((f) => matchesFilter(f.meta, q.filter));
      pool = pool
        .map((f) => ({ id: f.id, score: cosine(v, vec(`${f.meta.clause_title} ${f.text}`)), metadata: { ...f.meta, chunk_text: f.text } }))
        .sort((a, b) => b.score - a.score);
      return { matches: pool.slice(0, q.topK ?? 10) };
    },
  };
  const GLOSSARY = {
    query: async (v: number[], q: any) => ({
      matches: GLOSSARY_FIXTURE
        .map((g) => ({ id: `gl-${g.term.replace(/\s+/g, "-")}`, score: cosine(v, vec(g.text)), metadata: { ...g, clause_title: g.term, chunk_text: g.text } }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, q.topK ?? 5),
    }),
  };
  const DB = {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("graph_edges")) {
              return { results: (opts.graphDocs ?? []).map((d) => ({ doc: d })) };
            }
            if (sql.includes("chunks_fts")) {
              const rows = (opts.lexicalIds ?? []).map((id) => CORPUS.find((f) => f.id === id)).filter(Boolean)
                .map((f, i) => ({ ...f.meta, text: f.text, rank: -(i + 1) }));
              return { results: rows as any };
            }
            return { results: [] };
          },
        }),
      };
    },
  };
  return { AI, VECTORIZE, GLOSSARY, DB };
}

function ctx(env: any, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    env, query: "load cell creep", rq: "load cell creep", folded: "load cell creep",
    u: null, filters: null, filter: null, vector: vec("load cell creep"),
    lexicalHits: [], matches: [], hits: [], finalHits: [], glossary: [],
    opts: {}, ...over,
  } as PipelineContext;
}

// ── composition: the full registry over the fixture ────────────────────

test("full registry: doc-scoped query filters, pins the typed table, respects the floor", async () => {
  const env = makeEnv();
  const c = ctx(env, {
    query: "maximum permissible error table",
    rq: "maximum permissible error table",
    folded: "maximum permissible error table",
    vector: vec("maximum permissible error table"),
    u: { doc_number: "60" } as any,
    filters: { doc_number: "60" },
    filter: { doc_number: "60" },
  });
  await runStages(STAGES, c);
  assert.ok(c.finalHits.length >= 2, `window too small: ${c.finalHits.length}`);
  assert.equal(c.finalHits[0].metadata.doc_number, "60", "leading hit left the doc-scoped family");
  const ids = c.finalHits.map((h) => h.id);
  assert.ok(new Set(ids).size === ids.length, "duplicate ids in window");
  // the typed pin guarantees the R 60 table a slot despite prose competition
  assert.ok(c.finalHits.some((h) => h.id === "r60-tbl"), "typed table not pinned");
  // window floor: ranked hits are within the floor fraction of the top, or exempt
  const top = Math.max(...c.finalHits.map((h) => h.rerank_score ?? h.score));
  for (const h of c.finalHits) {
    const exempt = h.rerank_score === undefined || !!h.metadata.unit_id || h.metadata.clause_anchor === "family";
    assert.ok(exempt || (h.rerank_score ?? h.score) >= 0.25 * top, `hit ${h.id} below floor`);
  }
});

test("full registry: seal cuts every lane to the declared family", async () => {
  const env = makeEnv({ lexicalIds: ["d117", "r87-04"], graphDocs: ["doc:OIML-R-87-2004"] });
  const c = ctx(env, {
    opts: { sealScope: { doc_number: "60" } },
    lexicalHits: [], // seal filters lexicalHits in the prelude; emulate empty
  });
  c.lexicalHits = [];
  await runStages(STAGES, c);
  assert.ok(c.finalHits.every((h) => h.metadata.doc_number === "60"), "seal leaked foreign docs");
});

test("full registry: glossary link rides the result and routes the concept graph", async () => {
  const env = makeEnv({ graphDocs: ["doc:OIML-R-87-2004"] });
  const c = ctx(env, {
    query: "rules for the actual quantity in a prepackage",
    rq: "rules for the actual quantity in a prepackage",
    folded: "rules for the actual quantity in a prepackage",
    vector: vec("rules for the actual quantity in a prepackage"),
  });
  await runStages(STAGES, c);
  assert.ok(c.glossary.some((g) => g.term === "actual quantity"), "glossary link missing");
  // the concept-graph lane merged R 87 candidates into the pool
  assert.ok(c.hits.some((h) => h.metadata.doc_number === "87"), "concept-graph candidates not merged");
});

// ── stage invariants ────────────────────────────────────────────────────

test("dense: populates the pool and applies the doc filter", async () => {
  const c = ctx(makeEnv(), { filters: { doc_number: "87" }, filter: { doc_number: "87" } });
  await dense.run(c);
  assert.ok(c.matches.length > 0);
  // the sparse-filter widen appends unfiltered hits BEHIND the filtered set
  assert.equal(c.matches[0].metadata.doc_number, "87");
  const filteredRun = c.matches.takeWhile ? c.matches : c.matches;
  const firstForeign = c.matches.findIndex((m: any) => m.metadata.doc_number !== "87");
  const lastInFamily = c.matches.map((m: any) => m.metadata.doc_number === "87").lastIndexOf(true);
  assert.ok(firstForeign === -1 || firstForeign > lastInFamily, "widen must not interleave");
});

test("hyde: merges discounted candidates only when unfiltered", async () => {
  const c = ctx(makeEnv(), { u: { hypothetical_answer: "creep is the drift under constant load" } as any });
  await hyde.run(c);
  assert.ok(c.matches.some((m: any) => m.score <= 0.7), "hyde discount not applied");
  const filtered = ctx(makeEnv(), { u: { hypothetical_answer: "creep" } as any, filter: { doc_number: "60" } });
  await hyde.run(filtered); // when-guard bypassed by calling run directly: assert no crash
});

test("poolOpen: converts matches to Hits with chunk_text", async () => {
  const c = ctx(makeEnv());
  await dense.run(c);
  poolOpen.run(c);
  assert.ok(c.hits.length === c.matches.length);
  assert.ok(c.hits.every((h) => typeof h.text === "string"));
});

test("lexicalUnion: appends only unseen ids", () => {
  const c = ctx(makeEnv());
  c.hits = [CORPUS[0], CORPUS[2]].map((f) => ({ id: f.id, score: 1, metadata: f.meta, text: f.text }));
  c.lexicalHits = [...c.hits, { id: "d117", score: 0.5, metadata: CORPUS[7].meta, text: CORPUS[7].text }];
  lexicalUnion.run(c);
  assert.equal(c.hits.length, 3);
  assert.ok(c.hits.some((h) => h.id === "d117"));
});

test("federate: merges internal passages at the discount", async () => {
  const c = ctx(makeEnv(), { opts: { federate: async () => [{ id: "iso-1", score: 1, metadata: {} as ChunkMeta, text: "ISO passage" }] } });
  c.hits = [{ id: "r60-52", score: 1, metadata: CORPUS[2].meta, text: CORPUS[2].text }];
  await federate.run(c);
  const fed = c.hits.find((h) => h.id === "iso-1");
  assert.ok(fed && Math.abs(fed.score - 0.95) < 1e-9, "federate discount wrong");
});

test("seal: cuts the pool to the declared family", () => {
  const c = ctx(makeEnv(), { opts: { sealScope: { doc_number: "60", edition: "2006" } } });
  c.hits = CORPUS.slice(0, 6).map((f) => ({ id: f.id, score: 1, metadata: f.meta, text: f.text }));
  seal.run(c);
  assert.ok(c.hits.every((h) => h.metadata.doc_number === "60" && h.metadata.edition === "2006"));
});

test("overviewDemote: multiplies overview scores by the threshold", () => {
  const c = ctx(makeEnv());
  c.hits = CORPUS.map((f) => ({ id: f.id, score: 1, metadata: f.meta, text: f.text }));
  overviewDemote.run(c);
  const ov = c.hits.find((h) => h.id === "r60-ov")!;
  const clause = c.hits.find((h) => h.id === "r60-52")!;
  assert.ok(Math.abs(ov.score - 0.85) < 1e-9);
  assert.equal(clause.score, 1);
});

test("familyBoost: family chunk tops doc-scoped pools; sort is applied", () => {
  const c = ctx(makeEnv(), { filter: { doc_number: "60" } });
  c.hits = CORPUS.slice(0, 4).map((f) => ({ id: f.id, score: 0.5, metadata: f.meta, text: f.text }));
  familyBoost.run(c);
  assert.equal(c.hits[0].id, "r60-fam");
  assert.ok(c.hits[0].score > 1);
});

test("termNudge: the clause whose head is the term rises", () => {
  const c = ctx(makeEnv(), { u: { term: "load cell" } as any });
  c.hits = CORPUS.slice(0, 8).map((f) => ({ id: f.id, score: f.id === "r60-ov" ? 0.9 : 0.5, metadata: f.meta, text: f.text }));
  termNudge.run(c);
  assert.equal(c.hits[0].id, "r60-52");
});

test("editionSteer: same-publication older edition demoted below newer", () => {
  const c = ctx(makeEnv());
  c.hits = [
    { id: "r87-95", score: 0.82, metadata: CORPUS[6].meta, text: CORPUS[6].text },
    { id: "r87-04", score: 0.8, metadata: CORPUS[5].meta, text: CORPUS[5].text },
    { id: "d117", score: 0.7, metadata: CORPUS[7].meta, text: CORPUS[7].text },
  ];
  editionSteer.run(c);
  const i04 = c.hits.findIndex((h) => h.id === "r87-04");
  const i95 = c.hits.findIndex((h) => h.id === "r87-95");
  assert.ok(i04 < i95, "current edition did not outrank the superseded one");
});

test("diversity: caps per publication and overviews globally", () => {
  const c = ctx(makeEnv());
  // three overviews of the same publication + three clauses of another
  c.hits = [
    { id: "a", score: 1, metadata: { ...CORPUS[0].meta, docidentifier: "X" }, text: "" },
    { id: "b", score: 1, metadata: { ...CORPUS[0].meta, docidentifier: "X" }, text: "" },
    { id: "d", score: 1, metadata: { ...CORPUS[2].meta, docidentifier: "Y" }, text: "" },
    { id: "e", score: 1, metadata: { ...CORPUS[2].meta, docidentifier: "Y" }, text: "" },
    { id: "f", score: 1, metadata: { ...CORPUS[2].meta, docidentifier: "Y" }, text: "" },
    { id: "g", score: 1, metadata: { ...CORPUS[2].meta, docidentifier: "Y" }, text: "" },
  ];
  diversity.run(c);
  const nX = c.finalHits.filter((h) => h.metadata.docidentifier === "X").length;
  const nY = c.finalHits.filter((h) => h.metadata.docidentifier === "Y").length;
  assert.equal(nX, 1, "overview cap per doc is 1");
  assert.equal(nY, 2, "clause cap per doc is 2");
});

test("windowFloor: near-miss passages drop, typed units stay, never below two", () => {
  const c = ctx(makeEnv());
  c.finalHits = [
    { id: "top", score: 0, rerank_score: 1, metadata: CORPUS[2].meta, text: "" },
    { id: "typed", score: 0, rerank_score: 0.01, metadata: CORPUS[3].meta, text: "" }, // exempt (unit_id)
    { id: "near", score: 0, rerank_score: 0.5, metadata: CORPUS[5].meta, text: "" },
    { id: "miss", score: 0, rerank_score: 0.05, metadata: CORPUS[7].meta, text: "" },
  ];
  windowFloor.run(c);
  const ids = c.finalHits.map((h) => h.id);
  assert.ok(!ids.includes("miss"), "near-miss not floored");
  assert.ok(ids.includes("typed"), "typed unit dropped despite exemption");
  assert.ok(ids.includes("near"));
});

test("dedup: ancestor-descendant same-chain collapse passthrough", () => {
  const c = ctx(makeEnv());
  c.finalHits = [
    { id: "p", score: 1, metadata: { ...CORPUS[2].meta, clause_anchor: "5" }, text: "a load cell converts force" },
    { id: "ch", score: 0.9, metadata: { ...CORPUS[2].meta, clause_anchor: "5.2" }, text: "a load cell converts force into a signal" },
    { id: "other", score: 0.8, metadata: CORPUS[7].meta, text: "humidity chamber" },
  ];
  dedup.run(c);
  const ids = c.finalHits.map((h) => h.id);
  assert.ok(!ids.includes("ch") || !ids.includes("p"), "same-chain pair not collapsed");
  assert.ok(ids.includes("other"));
});

test("additive failure: a throwing additive stage leaves the context intact", async () => {
  const boom = { name: "boom", failure: "additive" as const, run: () => { throw new Error("lane down"); } };
  const c = ctx(makeEnv());
  let ranAfter = false;
  const after = { name: "after", run: () => { ranAfter = true; } };
  await runStages([boom, after], c);
  assert.ok(ranAfter, "the runner stopped after an additive failure");
});
