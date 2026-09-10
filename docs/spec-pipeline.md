# Pipeline stage contracts

The retrieval pipeline (`worker_public`) is a fixed-sequence registry of
stages (`src/stages/index.ts`), each a self-contained module
implementing the `Stage` interface (`src/stages/types.ts`). `retrieve()`
(`src/pipeline.ts`) is composition only: it builds the context (the
parallel embed/lexical prelude), runs the registry, and projects the
result.

## The contract vocabulary

- **Context** (`PipelineContext`) — the mutable state every stage reads
  and writes: `env`, `query` (the user's original wording), `rq` (the
  retrieval query), `u` (query understanding, nullable), `filters` /
  `filter` (the dense doc/edition scope), `vector`, `lexicalHits`,
  `matches` (the candidate pool, Vectorize-match shape), `hits` (the
  ranked pool), `finalHits` (the answer window), `glossary`, `opts`.
- **Guard** (`when`) — a pure read of the context; absent = always runs.
- **Failure mode** — `additive`: a throw is logged, the pipeline
  continues with the context as the previous stage left it (the lane's
  results were not written). `blocking` (default): the throw propagates
  to the caller of `retrieve()`.

Adding a stage = one file in `src/stages/` + one registry entry. No
edits to existing stages, the runner, or `retrieve()`. A stage that
needs a new context field declares it on `PipelineContext` (the field's
owner is the stage that writes it).

## Registry order and invariants

Order is load-bearing. The phase structure:

```
candidate lanes → pool open → pool-level merges → refinement → window assembly
```

| # | Stage | Guard | Failure | Writes | Contract |
|---|-------|-------|---------|--------|----------|
| 1 | `dense` | — | blocking | `matches`, may mutate `filters.edition` | The primary Vectorize query. Three shapes: optimistic reuse (identical query + no filter only), filtered (with guessed-edition-pin drop and sparse-filter widen — the widen APPENDS unfiltered hits behind the filtered set), plain. Never unions optimistic hits into a diverged query. |
| 2 | `hyde` | `u.hypothetical_answer && !filter` | additive | appends `matches` | Hypothetical-answer vector search; candidates enter at `hydeDiscount`. |
| 3 | `glossary` | `env.GLOSSARY && vector` | additive | `glossary` | Vocabulary link: dense glossary candidates + cross-encoder rerank; top-3 distinct concepts. MUST run before the concept-graph and steering stages — they consume `glossary`. |
| 4 | `concept-graph` | `glossary.length && env.DB && vector` | additive | appends `matches` | Linked terms → defining doc numbers (D1, parallel per-term) → metadata-filtered dense merge at `conceptGraphDiscount`. |
| 5 | `graph-lane` | `opts.graphDocNumbers && vector` | additive | appends `matches` | Caller-resolved family/successor doc numbers merged at `graphLaneDiscount`. |
| 6 | `multi-query` | `u.query_variants` | blocking (per-variant catches inside) | REPLACES `matches` | RRF-fuses the primary ranking with each variant's (k=60, top `retrieveK`). |
| 7 | `sub-query` | `u.complexity === "complex" && u.sub_queries` | blocking (per-sub catches inside) | appends `matches` | Complementary-perspective union at `subQueryDiscount` (no RRF). |
| 8 | `pool-open` | — | blocking | `hits` | Converts the candidate pool to the `Hit` shape. Last writer of `matches`; every later stage operates on `hits`. |
| 9 | `lexical-union` | `lexicalHits.length` | blocking | appends `hits` | Full-corpus BM25 hits dense missed (dense metadata wins on id collision). |
| 10 | `federate` | `opts.federate` | additive (callback catches transport) | appends `hits` | Internal ISO/IEC passages at `federateDiscount`. |
| 11 | `seal` | `opts.sealScope` | blocking | filters `hits` | The declared context's hard cut: nothing outside the declared family reaches rerank. (The lexical lane is sealed at the SOURCE, in the prelude — not here.) |
| 12 | `overview-demote` | — | blocking | mutates `hits[].score` | Overview boilerplate demotion (`overviewDemotion`). |
| 13 | `family-boost` | boost only under `filter.doc_number`; sort always | blocking | mutates `hits[].score`, sorts | Family chunks decisively boosted for doc-scoped queries; the sort establishes the rerank-failure fallback order. |
| 14 | `rerank` | `hits.length > 1` | additive | `hits[].rerank_score`, sorts, family pin | Cross-encoder scores; vector order is the designed fallback. Post-rerank family pin for doc-scoped queries. |
| 15 | `lexical-rrf` | `hits.length > 1 && lexicalHits.length` | blocking | REPLACES `hits` order | RRF fusion with the full-corpus lexical ranking. Runs even when rerank failed (additive semantics preserve this). |
| 16 | `corpus-scope` | `opts.datasetScope` | blocking | filters `hits` | Dataset scope (the sidebar toggles): drops hits whose corpus the request excludes. LAST of the pool-assembly stages — the lexical union above refills the pool after rerank, so filtering earlier let excluded corpora back in. Corpora the toggle model doesn't name pass untouched. |
| 17 | `term-nudge` | `u.term` | blocking | `hits[].rerank_score`, sorts | Clause whose head IS the asked term gets `termNudgeSpread × spread` (decisive). |
| 18 | `concept-steer` | `glossary.length && hits.length > 1` | blocking | `hits[].rerank_score`, sorts | Vocabulary-link families boosted (`conceptSteerSpread`). |
| 19 | `edition-steer` | `!filters.edition && hits.length > 1` | blocking | `hits[].rerank_score`, sorts | Cross-pub recency boost + family-relative superseded-edition demotion (spread-scaled). |
| 20 | `structural-propagate` | — | blocking | REPLACES `hits` | FABLE TreeExpansion: score blends along the clause tree. |
| 21 | `diversity` | — | blocking | `finalHits` (from `hits`) | Per-publication caps (1 overview / 2–3 clauses; global overview cap 2/6); window cut to `rerankKeep`. FIRST writer of `finalHits`. |
| 21 | `typed-pin` | pin families resolvable | blocking (inner parent-fetch additive) | `finalHits` | Answer-contract v2: one typed unit guaranteed a slot (+ small-to-big parent fetch at `smallToBigDiscount`). |
| 22 | `section-descent` | a ranked depth-1 summary has children | additive | `finalHits` | Summary node → top child clauses at `sectionDescentDiscount`; the summary retires when children answer. |
| 23 | `dedup` | — | blocking | `finalHits` | FABLE ancestor-descendant same-chain collapse (≥0.5 text overlap). |
| 24 | `window-floor` | — | blocking | filters `finalHits` | Evidence-budget cut at `windowFloorFraction` of top; typed/family/unscored exempt; never fewer than two. |

## Ordering dependencies (why the order is what it is)

- **Lanes before the pool opens** (1–7): every candidate lane competes in
  one pool; the pool is frozen at `pool-open`.
- **`glossary` before `concept-graph`/`concept-steer`/`typed-pin`**: all
  three consume the vocabulary link.
- **`dense` before any lane that merges**: lanes are additive to the
  primary ranking, never replacements (except `multi-query`, which
  REPLACES `matches` — deliberate: RRF-fused variants subsume the
  primary ranking).
- **`seal` before `overview-demote`/`rerank`**: the declared context is
  a hard scope, not a preference — steering and reranking happen WITHIN
  it.
- **`rerank` before every steering stage** (16–18): steering is
  spread-scaled over rerank scores; steering before rerank would be
  erased by the re-sort.
- **`structural-propagate` after steering, before `diversity`**:
  propagation re-scores the full ranked pool; diversity then reads the
  final order.
- **`diversity` is the FIRST writer of `finalHits`**: the window
  assembly stages (21–24) operate only on the window.
- **`window-floor` LAST**: it is the terminal budget cut; anything
  appended after it would escape the evidence-budget principle.

## Prefetch semantics (concurrent lane I/O)

A stage may declare `prefetch(c)`: kick its INDEPENDENT I/O off into
`c.lane[stage.name]` (a promise bag the stage owns). The runner invokes
every stage's prefetch — guard-checked — BEFORE running any stage, so
the independent lanes (hyde, glossary, graph-lane, multi-query,
sub-query) overlap with each other and with the dense lane instead of
serializing: ~5 summed round trips become ~1. `run()` awaits its own
promise and merges.

The invariants:

- **Only pre-pipeline state** — prefetch may read `u`, `vector`, `opts`,
  never another stage's output. concept-graph deliberately does NOT
  prefetch (its D1 lookup consumes glossary's results).
- **Merge order is registry order** — concurrency changes when I/O
  completes, never when merges apply. Retrieval determinism is
  untouched (the annealment gate re-verifies this).
- **Failure semantics unchanged** — a rejected prefetch promise throws
  at the await inside `run()`, where the stage's failure mode applies.

## The prelude (not stages, deliberately)

`retrieve()` resolves the query fold, runs the dense embed and the
full-corpus lexical prefilter **in parallel**, and seal-filters the
lexical lane at the source. This parallelism is load-bearing (Option C:
the optimistic vector may already be resolved; embed and lexical must
not serialize) — it stays in the composition layer, not in stages, so
no stage boundary can introduce a serial round-trip on the hot path.

## Verification

- `tests/pipeline.test.ts` — the registry composition and each stage's
  invariant over an in-memory fixture environment (no network).
- `tests/golden/` ×3 + annealment ×6 — the live gates (every threshold
  change re-runs them; see `config.ts` THRESHOLDS docstrings).
