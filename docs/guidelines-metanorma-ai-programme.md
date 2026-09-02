# Metanorma AI — Building a Grounded RAG Service from Metanorma Sources

*Programme guidelines: how any standards body or Metanorma user builds a
citation-grounded question-answering service over their own corpus,
from scratch, using the Metanorma document model as the source of
truth. Companion to the OIML Bulletin article (2026-08-30). Everything
below is extracted from a production deployment — the OIML SMART AI
service — and is reproducible.*

---

## Who this is for

You have documents authored in Metanorma (or convertible to it) and you
want people to *ask questions* and get *verifiable, cited answers* —
not a search box over PDFs. The path below assumes no prior RAG
experience; every stage names the decision, the cost, and the
measurement that proves it works.

## Principles (the short list)

1. **Grounding is the product.** Fluency is free; trust is engineered.
   Every claim cites the exact publication, edition and clause. When
   the corpus doesn't contain the answer, the system says so — one
   canonical refusal sentence, never cached.
2. **Facts from the source model, never from renderings.** Metanorma
   documents are typed object models; consuming the model (via MKO)
   beats scraping HTML or PDF on every axis that matters.
3. **Input = full fidelity; output = references.** The model *reads*
   tables, equations, figures; it *never re-types* them. It writes a
   symbolic reference; your renderer draws the producer's payload.
4. **Measure everything, ship nothing unmeasured.** A golden question
   set with witness citations, retrieval metrics over repeated runs,
   and a faithfulness judge that sees the passages the answer was
   actually built from. CI runs the suites; a change without a number
   is a guess.
5. **Cost-first on the hot path, quality-first on one-time work.**
   Every question pays the serving model; enrichment, captioning and
   evaluation are one-time costs whose quality persists.

---

## Stage 0 — Decide your corpus and its identity backbone

**What:** the documents you will index, and the canonical identifier
that makes two spellings of the same publication collapse into one.

- Establish a registry: publication families → editions → status
  (current / superseded / withdrawn). **Derive status from
  supersession links, never from a status field** — fields lie; edges
  are structure.
- Surface the gaps: families with no derivable current edition are your
  upstream bibliographic worklist, not something to hide.
- Record language and edition metadata on every document *before*
  chunking; it becomes the filter your retrieval uses.

**Cost:** $0. **Measurement:** registry completeness (families with a
derivable current edition / total families).

## Stage 1 — Ingest the Metanorma model (MKO), not renderings

**What:** export each document as a Metanorma Knowledge Objects bundle
(MN 116): typed units (clauses, tables, terms, equations, figures,
requirements), a section graph (part_of, cites, defines edges), a
native glossary, and native bibliographic objects.

```
metanorma compile document.adoc -x mko    # (or the Ruby exporter today)
```

**Key decisions:**
- Chunks follow **clause boundaries** — the unit a human cites — never
  token windows. Tables, equations and figures are **atomic units**
  (never split; cite their parent clause).
- Each chunk carries: docidentifier, edition, language, clause anchor,
  status, and its **unit id** (stable content hash) for incremental
  re-ingest.
- Write a **data-quality report** on every build: counts by type,
  missing anchors, oversized payloads. Serving keeps score; upstream
  fixes follow.

**Cost:** $0 (local compute). **Measurement:** unit counts per document
against a hand-check; zero empty chunks for preface-only documents
(a real producer bug we hit).

## Stage 2 — Contextual enrichment (the highest-ROI one-time spend)

**What:** a one-time pass where a strong model writes a 2–3 sentence
preamble situating each chunk in its document ("This clause defines the
accuracy-class limits for load cells in R 60-1:2017 §4.1.2"), then you
embed **preamble + chunk text** and index that.

- Cache preambles by chunk id (KV or object store); unchanged chunks
  are free on re-runs. Invalidate by content hash.
- Budget: ~260 in / ~210 out tokens per chunk. At our models that is
  ≈$0.0017 per chunk; a 40,000-chunk corpus is ≈$70 one-time.
- Expect a measurable retrieval lift and, more visibly, the recovery of
  paraphrased questions that share no vocabulary with the corpus.

**Cost:** ≈$0.002 per chunk, one-time. **Measurement:** retrieval
recall@5 before/after on a paraphrase probe set.

## Stage 3 — Hybrid retrieval (dense + full-corpus lexical)

**What:** two retrieval lanes run in parallel on every question:

1. **Dense** — the question is embedded (same embedding model as the
   index; this is mandatory) and queried against the vector index.
2. **Lexical** — a full-corpus BM25/FTS index over the *enriched* chunk
   text, catching exact identifiers, part numbers and defined terms
   that dense similarity misses.

Fuse with reciprocal rank fusion (RRF, k=60). Then a cross-encoder
reranks the fused candidates; optionally a stronger listwise pass for
complex questions.

**The lesson that cost us a baseline:** lexical retrieval must scan the
*whole corpus* as a first stage. Re-scoring only what dense already
found cannot recover what dense missed. On our corpus this single
change lifted recall@5 from 86% to 95%.

**Cost:** embedding ≈$0.00001 per query; lexical ≈free (D1/FTS5).
**Measurement:** recall@5, AP@5, MRR@5 on the golden set, **mean over
≥3 runs** (single runs are noise).

## Stage 4 — Query understanding (LLM-decided, zero rules)

**What:** a small model reads the question first: language, named
publication, edition, defined terms, complexity, whether it's
conversational. There are no keyword rules and no regex on user input —
the same model judges every question, in every language.

- Its output drives **metadata filters** (doc number, edition) on the
  dense query — the exact-identifier query class embeddings handle
  poorly.
- A **terminology graph** (defined term → defining documents) resolves
  colloquial phrasing to the corpus's own vocabulary.
- Run the understanding call **in parallel** with the query embedding;
  they have no dependency when no filter is emitted.

**Cost:** ≈$0.0002 per question. **Measurement:** filter precision
(named publication → correct doc_number).

## Stage 5 — The answer contract

**What:** the model generates from the retrieved passages only, under a
data-file prompt contract:

- **Inline citations** on every claim: `[OIML R 60-1:2021 §4.4.2]`
- **Verbatim quote anchors** for normative values — the quoted phrase
  must exist, character-for-character, in a cited passage
- **Symbolic unit references** (`[[u:table-1]]`) when presenting a
  whole table/equation/figure — the model *points*, your renderer
  draws the producer's payload
- **One canonical refusal sentence** for off-corpus questions

**Verification (all mechanical, all post-generation):**

| Check | Method | On failure |
|---|---|---|
| Quote anchors | deterministic text match against used passages | one corrective regeneration; never cache the unverified answer |
| Unit references | every `[[u:…]]` must exist in the used passages | dropped, never rendered |
| Table retyping | markdown table in output while a typed unit was available | corrective regeneration with a targeted note |
| Faithfulness | independent judge scores claims vs the passages used | answer withheld or regenerated |

The crucial correctness rule: **the faithfulness judge sees the
passages the answer was actually built from** (return them in the
response), not a fresh retrieval — otherwise you are measuring a
different question's evidence.

**Cost:** judge ≈$0.0003 per answer. **Measurement:** faithfulness
score distribution; corrective-regen rate; zero cached violations.

## Stage 6 — Serving, caching, and cost control

- **Exact answer cache** (keyed by query hash + index version) and a
  **semantic cache** (leading-dimension signature, cosine ≥0.97) serve
  near-duplicate questions instantly. Refusals and conversational turns
  are never cached. `fresh=true` bypasses *every* cache (we shipped a
  bug where it missed the semantic one — test this).
- **Cache versioning:** bump the version on every retrieval or prompt
  change; old answers expire by key.
- **Model policy:** all tiers can share one good model if it's cheap
  enough (ours: ≈$0.001/answer). Hot-path understanding stays on a
  smaller model; only the *answer* needs the quality.

## Stage 7 — Evaluation as a CI gate

Build these suites **before** you need them:

1. **Golden set** — 20–30 questions with expected citations (regex over
   docidentifier) and witness values for table questions. Run on every
   change; report R/AP/MRR means over ≥3 runs.
2. **Paraphrase probes** — the same question asked 8 ways must hit the
   same sources.
3. **End-to-end behavioural cases** — refusal correctness, language
   fidelity, edition steering, block rendering, auth tiers.
4. **Faithfulness battery** — judged scores over the golden set,
   re-run after any generation-model change.

Our suites caught: a corpus lane invisible to filtered retrieval (an
identity-parse bug), a mangled CSS rule that blanked dark mode, a cache
path that served stale answers to regeneration requests, and a
diversity cap that structurally evicted typed tables. None were visible
in code review; all were visible in a suite.

## Stage 8 — The typed-block pipeline (tables, equations, figures)

This is the stage that separates a chatbot from a *standards*
assistant:

1. **Typed payloads in a serving store** (D1/KV table: unit_id →
   payload), written at ingest, validated against the MN 116 schemas.
2. **Passage headers declare their units** so the model can reference
   them: `[3] OIML R 60-1:2021 §5.1.2 unit u:table-1 (table) — …`
3. **Server-side reference resolution**: validate against used
   passages, fetch the payload, return a `blocks` array alongside the
   prose.
4. **Client rendering**: real `<table>` from columns/rows, KaTeX from
   LaTeX, `<img>` from the asset store, term cards from designations +
   definition. Unknown block types render nothing (forward
   compatibility).
5. **Figures**: upload image assets to immutable URLs; a vision-capable
   model describes each from pixels (one-time, ≈cents per figure);
   store the description so text-only tiers can explain figures too.

## Stage 9 — Operations

- **Incremental re-ingest:** diff bundles by (document, unit_id) +
  content hash; a wording change re-processes only the affected chunks.
  Our corpus-proven case: a synonym change diffed exactly 34 of 3,053
  chunks; a no-change re-ingest reports zero.
- **Spend ledger:** log per-request model spend to a queryable table;
  review weekly against the model policy.
- **Upstream loop:** every corpus defect the service surfaces (missing
  successor links, malformed table serializations, preface-only
  documents) goes back as an upstream PR or issue — the corpus gets
  better because serving keeps score.

---

## Reference stack (as deployed)

| Component | Choice | Notes |
|---|---|---|
| Platform | Cloudflare Workers only | minimal accounts, no proprietary model providers |
| Answer model | GLM-5.3 Flash (open-weight, multimodal) | ≈$0.001/answer, all tiers |
| Understanding | Qwen3-30B-A3B | cost-first hot path |
| Embeddings | Qwen3-Embedding-0.6B | same model both sides (mandatory) |
| Reranker | bge-reranker-base | ≈$0.00003/query |
| Vector index | Cloudflare Vectorize | dense lane |
| Lexical index | D1 + FTS5 (porter) | full-corpus BM25 |
| Registry + graph | D1 (documents, graph_nodes/edges) | derived status |
| Caches | KV (answer + semantic) | versioned by index |
| Typed payloads | D1 (unit_payloads) | MN 116 schemas |
| Assets | R2 (unit-keyed, immutable) | /assets/u:<id>.<ext> |
| Ingest | Python (pydantic models) | MKO → chunks → enrich → embed → upsert |
| Eval | Node (golden, paraphrase, e2e, RAGAS-style) | CI-gated |

## What not to do (each one cost us a measurement)

- Don't scrape rendered HTML when the document model exists.
- Don't let the model re-type tables; it will, and the values will be
  wrong in ways that pass review.
- Don't trust a status field over the record's own edges.
- Don't judge faithfulness against a fresh retrieval.
- Don't report single-run metrics; the noise band is ±5pp.
- Don't run your heavy eval/enrichment traffic against the same account
  that serves users — you'll throttle yourself and mis-measure
  everything.
- Don't skip the refusal path in your test suite; it's the contract
  users trust most.

---

*Production reference: ai.oimlsmart.org — OIML SMART AI. Format spec:
Metanorma MN 116 (Metanorma Knowledge Objects). This guide is extracted
from the system's own documentation set and can be adapted per corpus;
the measurement discipline transfers unchanged.*
