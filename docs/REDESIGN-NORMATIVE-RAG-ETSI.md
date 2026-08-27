# Normative RAG Redesign — Learning from the ETSI Experience

*Primary source: Al Masoud, Arazzi, Germani, Nocera (Univ. Pavia + CEI),
"Exploring Structural Complexity in Normative RAG with Graph-based approaches:
A case study on the ETSI Standards", arXiv:2604.09868, Jan 2026.
Secondary primaries only where they corroborate a specific claim (cited inline).
This supersedes the structure/graph sections of RESEARCH-SOTA-2026.md and
ROADMAP-SOTA.md for retrieval design. 2026-08-27.*

---

## 0. Why this paper is the authority for us

It is the only published empirical study of RAG **on industrial standards**
(ETSI EN 301 489-X, ≈50 documents, ≈3000 pages, 800+ synthetic Q&A with
witness-string golden chunks). Co-authored with CEI (Italian Electrotechnical
Committee) — a standards body, not a vendor lab. Their problem statement is
ours word-for-word:

> standards are highly cross-referential, semi-structured, and make use of
> specialized formal vocabulary… dense text embeddings… overlook [precise
> keywords] in favor of fuzzier semantic similarity… parent-child (and
> sibling-to-sibling) dynamics between chunks [are] a relevant factor.

They evaluate **lightweight, low-latency** modules only — no GNN training,
no agentic loops in the measured stack. That matches our Cloudflare /
cost-first constraint. Their conclusions are measured, not hyped. We treat
them as load-bearing.

---

## 1. Their Information Model (the contract we must match)

```
IG = (IU, E)          InfoUnits + Edges
IU node = {title, body}
E = P ∪ C             Parthood ∪ Citation
```

| Relation | Semantics | Cardinality |
|---|---|---|
| **P (parthood)** | document→section, section→subsection; section code prefix (`4.1` parent of `4.1.2`) | tree (≤1 parent) |
| **C (citation)** | internal (same doc, section-only mention) or external (doc name ± section) | many-to-many |
| Ancestry | transitive closure of P; same publication ⇔ share common ancestor | derived |

Construction rules that matter:

1. **ToC → ordered InfoUnits**, then P from section-code prefix geometry.
2. **Oversized sections may split** — children of the original section
   (Structured + Chunks). Flat chunking alone is the baseline they beat.
3. **Tabular sections are exempted from being chunked.** Atomic units.
4. **Empty-body InfoUnits are valid** (a section title that immediately
   opens a subsection; a top-level document node).
5. **Citation resolve heuristic:** section-only → internal; doc-name-only →
   document; both → that section of that document.
6. They explicitly flag the **IEC Smart Standards** machine-readable
   framework as the upgrade path when content is no longer PDF-scraped —
   i.e. our Metanorma/#592 direction, named from the standards world.

---

## 2. Their modules and measured outcomes (the only numbers that matter)

Eight configurations × three K values. Variants: Vanilla (flat 300-word
chunks) vs Structured (official section hierarchy) vs Structured+Chunks
(hierarchy, split when oversized). Modules stacked on top.

| Module | What it does | Measured effect on ETSI corpus |
|---|---|---|
| **Structure preservation** (P in the index) | section hierarchy as the chunk boundary | **↑ precision, ↑ MRR; recall ≈ flat (not significant)** |
| **Structured + Chunks** | hierarchy + split oversized sections | **overall best compromise** |
| **BM25 prefilter → dense rerank → RRF** | sparse first (exact jargon), dense for meaning, fuse | **↑ precision, ↑ MRR; recall unchanged** (expected — fusion reorders, doesn't recover) |
| **Embedding smoothing** `em ← α·em + (1-α)·mean(N(u))` | blend each node embedding with parent/children/siblings/citation neighbors; lightweight alternative to GNN graph-embeddings | **slight ↑ recall** — the only module that moved recall |
| **Neighbor expansion + graph re-rank** (seed → neighbors, hub penalty) | post-retrieval graph walk | **not effective** — scoring function inadequate for the domain |

Their conclusion, verbatim force:

> the methods we have tested mostly improve the **precision** of retrieval,
> and **structure-preservation with chunking** seems to be the overall best
> compromise.
>
> Neighbor expansion… does not seem to be effective, indicating that more
> work is needed…
>
> Smoothing slightly improves recall… promising way of embedding relational
> information into the index.

Future work they name: multi-hop synthesis across distant passages / across
documents; hybrid solutions for that class; evaluation on broader Q&A with
more complex link structure.

---

## 3. Audit of OIML SMART AI against the ETSI stack

### 3.1 What we already get right (keep, do not rebuild)

| ETSI requirement | Our status | Evidence |
|---|---|---|
| Structure-preserving chunk boundaries | ✅ clause-boundary sections from Metanorma HTML/adoc | `ingest/parse.py`, `chunk.py` |
| Structured + Chunks (split oversized) | ✅ `split_long` on section text | `chunk.py` |
| Dense + lexical RRF | ⚠️ partial — see 3.2 | `hybrid.ts` + `pipeline.ts` post-rerank RRF |
| Cross-encoder rerank | ✅ bge-reranker-base | beyond their Granite-only dense |
| Document-level citation / supersession graph | ✅ successor, part_of (doc↔family), defines | `ingest/graph.py`, D1 registry |
| Edition/authority steering | ✅ derived active edition (status field lies) | beyond ETSI scope; matches 2026 freshness scoring |
| Contextual enrichment | ✅ 99.4% corpus | Anthropic recipe; they have none — we are ahead on context-in-embedding |
| Machine-readable source path | 🟡 hand-rolled; #592 is the contract | they name IEC Smart Standards; we have Metanorma |
| Generation-side grounding | ✅ quote anchors, CRAG, reflection, faithfulness judges | out of their retrieval-only scope |
| Don't over-invest neighbor expansion | ✅ graph lane is terminology-only (`defined_terms→defines→doc_numbers`) | aligns with their negative result |

### 3.2 Gaps the ETSI evidence says are material (ordered by measured impact)

#### G-ETSI-1 — Lexical retrieval is a post-filter, not a prefilter  【CRITICAL】

**ETSI:** BM25 is the *first* query-time stage — high-recall, low-latency
prune of the full corpus on exact keywords (standards jargon), *then* dense
rerank, *then* RRF.

**Us:** `keywordRank` + `rrfFuse` run **only over the dense top-K already
retrieved** (`pipeline.ts` after Vectorize). If dense never recalled the
chunk, lexical cannot recover it. We re-order; we do not recall.

Vectorize has no sparse vectors (platform fact). The fix is not "wait for
Vectorize" — it is a **corpus-wide inverted index we own**:

- D1 FTS5 over `chunk_id + text` (or a dedicated terms table), OR
- build posting lists at ingest into KV/R2, query in-worker.

BM25 (or BM25-ish with real IDF from corpus stats) returns top-N ids → fetch
vectors/metadata → union with dense top-K → RRF → cross-encoder. This is
exactly their II-B5→6→7 cascade, and it is the single highest-leverage
gap their numbers identify for a standards corpus.

#### G-ETSI-2 — No section-level parthood in the retrieval graph  【HIGH】

**ETSI InfoModel:** every InfoUnit participates in P; ancestry is
queryable; siblings and parents are first-class neighbors for smoothing
and (attempted) expansion.

**Us:** `clause_anchor` is a **string on chunk metadata**. The D1 graph has
doc↔family `part_of` and concept `defines`, but **not**
`clause:R-60-1:2021:4.1 —part_of→ clause:R-60-1:2021:4`. Parent/sibling
geometry is not traversable at query time and cannot feed smoothing.

Fix at ingest: for every chunk with anchor `A.B.C`, emit
`part_of` edges up the anchor tree + a `section` node per unique anchor.
Empty-body section nodes (title-only parents) are valid per ETSI.

#### G-ETSI-3 — No internal citation edges  【HIGH】

**ETSI:** C is half the edge set. "§4.1 (see also §6.3)" and "as required
by OIML R 76-1:2006 §3.5" are first-class. Resolve heuristic is simple and
domain-correct.

**Us:** relaton gives *document-level* bibliographic edges. Clause-body
mentions of other clauses/documents are not extracted into C. The graph
cannot answer "what does this clause require me to also read?"

Fix at ingest: citation mention parser over chunk text (section-id /
docidentifier patterns we already normalize via pubid-ish regexes) →
resolve against the section-node index from G-ETSI-2 → `cites` edges.
External unresolved mentions stay as string-valued edge targets (public
projection rule already forbids leaking ISO titles).

#### G-ETSI-4 — No embedding smoothing  【HIGH — only measured recall lever】

**ETSI eq. (10):**
`em_j ← α·em_j + (1-α)·mean({em_n : n ∈ N(j)})`
where N = parent ∪ children ∪ siblings ∪ in/out citations.

This is the **only module that moved recall**. It is offline (index-time),
O(|E|) once per build, no GNN, no query latency. It is a drop-in after
G-ETSI-2/3 give us real neighbors.

Implementation: after embed, one or two smoothing iterations over the
section graph, write smoothed vectors to Vectorize (or a parallel index
for A/B). α ≈ 0.7–0.85 (keep self-dominant). Do **not** smooth across
family boundaries or superseded editions.

#### G-ETSI-5 — Tables still flattened  【HIGH — they exempt them】

**ETSI:** "Tabular sections are exempted from being chunked." Atomic.

**Us:** G1 prototype extracts 10k typed tables (adoc-first) into
`artifacts/table-chunks.jsonl` — **not in the live index**. Prose pipeline
still linearizes tables into clause text.

Ship G1: upsert `chunk_type=table` rows as first-class InfoUnits with
parthood to their parent clause. Do not split table rows across chunks.
Re-enrichment cost ≈$50 is the gate, not the design.

#### G-ETSI-6 — Precision-first retrieval metrics under-weighted  【MED】

**ETSI primary charts:** AP@K, MRR@K, R@K — and their wins are on **AP and
MRR**, not recall.

**Us:** `retrieval.mjs` hit@5 (recall-ish), golden citation_any, RAGAS
faithfulness/relevancy/precision (generation-side). We under-measure the
axis their methods actually move.

Add AP@K / MRR@K on the retrieval suite with witness-style golden spans
(we can derive from golden cases' expected citations). Report them on
every retrieval change. Stop treating recall@5 as the only retrieval KPI.

#### G-ETSI-7 — Neighbor expansion scoring  【LOW — do not chase】

**ETSI:** expander + graph re-rank **failed**. Our terminology-only graph
lane is the correct restrained form. Do not build a general "expand to all
neighbors" path until a domain-adequate neighbor score is validated on
our golden set. Smoothing (G-ETSI-4) is the proven way to push relational
signal *into the vectors* instead.

---

## 4. Redesigned pipeline (target architecture)

### 4.1 Offline (RDP) — once per index build

```
OII (Metanorma model / adoc / HTML fallback)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ PARSE                                                     │
│  sections → InfoUnits {id, title, body, anchor, doc_id} │
│  tables   → InfoUnits chunk_type=table (ATOMIC)           │
│  formulas → InfoUnits chunk_type=equation (when typed)    │
│  empty-body section nodes kept                            │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ GRAPH                                                     │
│  P: anchor-tree part_of (clause↔clause, clause↔doc)       │
│  C: internal + external cites (mention resolve)           │
│  existing: successor, family part_of, defines             │
│  documents registry (derived active) unchanged            │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ ENRICH (contextual preamble, quality-first lane) — keep   │
└──────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ EMBED → SMOOTH (α-blend over N(u) for 1–2 iterations)     │
│         → UPSERT Vectorize (smoothed)                     │
│  + BUILD inverted index (D1 FTS5 / postings) for BM25     │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Online (worker) — every question

```
query
  │
  ├─ understanding (LLM) ────────── filters, terms, complexity, …
  │
  ├─ BM25 prefilter (FULL corpus inverted index) ── top N_bm25
  │
  ├─ dense Vectorize (smoothed vectors) ± metadata filter
  │     + multi-query / HyDE fusion (keep)
  │     + terminology graph lane (keep; restrained)
  │
  ├─ UNION candidate ids
  │
  ├─ RRF(dense-rank, bm25-rank)          ← now true hybrid recall
  │
  ├─ cross-encoder rerank → listwise (member/complex)
  │
  ├─ family pin / term boost / edition steer (keep)
  │
  ├─ CRAG grade → optional corrective re-retrieve (keep)
  │
  └─ generate + quote-anchor verify + reflect (keep)
         citations follow usedHits (keep)
```

**Deliberately absent:** general neighbor-expansion re-ranker (ETSI
negative). Agentic multi-hop remains Phase-3 for the synthesis class they
flag as future work — not a substitute for the precision stack above.

### 4.3 Mapping to #592 / Metanorma

ETSI §II: the InfoModel is dictated by PDF extraction limits; they
"envision that this simple Information Model can be extended/swapped…
when dealing with normative content that is already available in a
machine-readable format, such as is foreseen by the IEC Smart Standards
framework."

Our equivalent is the AI-serialization projection
(`docs/METANORMA-AI-SERIALIZATION.md`):

| ETSI InfoModel | #592 / ChunkRecordV2 |
|---|---|
| InfoUnit {title, body} | typed `nodes[]` (clause/table/formula/term/requirement/…) |
| P parthood | `edges[]` kind=`part_of` + breadcrumb |
| C citation | `edges[]` kind=`cites` + Relaton keys |
| section code geometry | model anchors (stable, not OCR-guessed) |
| tables atomic | `type=table` with columns/rows payload (conformance rule §8.3) |

**Hand-rolled G-ETSI-2/3/5 now is the reference implementation that #592
must emit.** We do not wait on upstream to close the retrieval gaps; we
close them with the sources we have, and the projection is the durable
contract.

---

## 5. Phased execution (eval-gated, ETSI-ordered)

Every phase ships only if AP@K and MRR@K on the retrieval suite move the
right direction on the golden + paraphrase probes. Recall@K is reported
but is not the gate (ETSI: structure/RRF don't move it; only smoothing
does, slightly).

### Phase E0 — Measurement hygiene (1–2 days, no index change)
1. Add AP@K, MRR@K, R@K to `tests/retrieval.mjs` with citation-span
   matching (≥75% golden span containment — their protocol).
2. Snapshot baselines on current production index.
3. Stop treating hit@5 as the sole retrieval KPI in roadmap language.

### Phase E1 — True hybrid lexical recall (G-ETSI-1) (3–5 days)
1. Ingest: write `chunks_fts` (D1 FTS5) or posting lists from
   `artifacts/chunks.jsonl` (enriched text).
2. Query: BM25 top-N → union dense top-K → existing RRF → rerank.
3. Gate: AP@K / MRR@K up on jargon-heavy cases (`n_LC`, part numbers,
   "maximum permissible error", French/German term forms). Exact-term
   paraphrase probes must not regress.

### Phase E2 — Section graph + smoothing (G-ETSI-2/3/4) (1–2 weeks)
1. Emit clause-level `part_of` + `cites` at graph build.
2. Offline smooth embeddings (α sweep {0.7, 0.8, 0.9} × 1–2 iterations)
   into a side index; A/B against current.
3. Gate: recall@K up or flat with AP/MRR non-worse (smoothing is the
   recall lever; do not accept AP regression).
4. Do **not** enable neighbor-expansion re-rank in this phase.

### Phase E3 — Atomic tables (G-ETSI-5) (re-ingest window, ≈$50)
1. Upsert G1 table chunks; `chunk_type=table`; parent `part_of` to clause.
2. Re-enrich + re-embed + smooth.
3. Gate: table-value golden cases (R 60 n_LC, R 76 MPE, R 111 E2) AP/MRR
   and answer correctness; no regression on prose cases.

### Phase E4 — #592 producer path (upstream, parallel)
1. Keep AI-serialization proposal aligned with the InfoModel above.
2. Hand-rolled adapters remain the consumer of record until
   metanorma-document emits the projection.
3. When available: swap parse source, delete HTML/adoc recovery paths for
   covered doctypes (OCP: new source = new adapter, not pipeline branches).

### Phase E5 — Multi-hop synthesis (their future work = our G10)
Only after E1–E3 are green. Deep-research / agentic loop for questions
that need distant passages or cross-document assembly. Not a retrieval
substitute.

### Explicitly deferred / rejected by ETSI evidence
- GNN graph embeddings (smoothing is the lightweight substitute they
  validated).
- General seed-neighbor expansion re-ranker (failed on ETSI).
- Embedding-model upgrade as the primary lever (their stack used Granite;
  wins came from structure + hybrid + smoothing).
- Overlap chunking (not in their design; independent 2026 evidence also
  weak — not reopened here).

---

## 6. What changes in our public claims

- Retrieval quality story shifts from "dense + rerank + graph lane" to
  **"structure-preserving index + full-corpus lexical prefilter + smoothed
  dense + RRF + rerank"**, which is the ETSI-validated cascade for
  standards.
- Graph story shifts from "expand at query time" to **"parthood and
  citation live in the index; relational signal is baked into vectors via
  smoothing; query-time expansion stays restrained (terminology)"**.
- Tables story is no longer optional polish — **atomic tables are a
  normative-RAG requirement** (ETSI exempts them from chunking; STC
  arXiv:2605.00318 independently shows MRR 0.36→0.59 / R@1 0.37→0.75 on
  tabular structure, corroborating).
- #592 is not a nice-to-have serialization — it is the **IEC-Smart-Standards
  equivalent** their methodology section already assumes as the end state.

---

## 7. Sources (primary only)

1. Al Masoud, Arazzi, Germani, Nocera. *Exploring Structural Complexity in
   Normative RAG with Graph-based approaches: A case study on the ETSI
   Standards.* arXiv:2604.09868, 2026-01.
   https://arxiv.org/abs/2604.09868
2. Guttal et al. *Structure-Aware Chunking for Tabular Data in RAG* (STC).
   arXiv:2605.00318, 2026-05. (tables atomic / row structure — corroborates
   G-ETSI-5 magnitude.) https://arxiv.org/abs/2605.00318
3. Rayo, de la Rosa, Garrido. *A hybrid approach to information retrieval
   and answer generation for regulatory texts.* 2025. (dense+sparse for
   regulatory IR — ETSI's cited prior for RRF.)
4. Cormack, Clarke, Buettcher. *Reciprocal rank fusion outperforms
   condorcet and individual rank learning methods.* SIGIR 2009. (RRF.)
5. IEC. *Smart Standards – from a market and industry perspective.* 2024.
   (machine-readable standards end-state ETSI points at; our #592 analogue.)

Corroborating structure-first work (not standards-specific, not used as
primary authority here): Xu et al. RDR² arXiv:2510.04293; Yu et al. SF-RAG
arXiv:2602.13647; SPIRE arXiv:2604.20849; Günther et al. late chunking
arXiv:2409.04701; Merola & Singh contextual vs late arXiv:2504.19754.

---

## 8. Immediate next action

Phase E0 + E1 start now. No re-ingest required for E0/E1 (FTS can be built
from existing `artifacts/chunks.jsonl` / live chunk texts). E2/E3 need an
index rebuild window and explicit go on the ≈$50 re-enrichment for E3.
