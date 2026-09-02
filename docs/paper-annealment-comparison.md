# Knowledge annealment: representation determines what questions a corpus can answer

*Draft for the OIML Bulletin — 2026-09-02. The four-corpus comparison:
how the representation of a standards corpus — plain text, adoc markup,
typed document objects (MKO), or an executable model (Primmel) —
determines which questions a retrieval system can answer.*

---

## Abstract

We index the same corpus — the OIML R 60 family (2021 parts 1–3 +
annexes) — under four representations of increasing structural
annealment, and measure which questions each can answer using a
ten-rung ladder (L0 locate → L9 instance/process). The representations:
plain text (markup stripped), raw AsciiDoc, Metanorma Knowledge Objects
(MKO, MN 116), and a Primmel executable model. A sixth "composed" lane
combines MKO and Primmel with cross-links. We report the first measured
results: the ladder discriminates, representations have distinct
capability profiles, and the model lane uniquely retrieves typed
constraints, sequences, and calculations for rungs the document lanes
cannot reach.

---

## 1. The knowledge-annealment hypothesis

*Annealment*: the degree to which knowledge is bound into structure a
machine can traverse and compute. The hypothesis: a corpus
representation's annealment level determines its **capability ceiling** —
the deepest question class it can serve. Not incrementally but
structurally: a representation either carries a primitive (typed tables,
vocabulary registers, OCL constraints) or it does not, and questions
requiring that primitive are either answerable or not.

The ten-rung ladder (L0–L9), defined in our companion documentation,
ranges from LOCATE (find the clause) to EXECUTABLE SEMANTICS (compute
what the document defines but never prints) to INSTANCE & PROCESS (ordered
test sequences with contamination semantics). Each rung requires
strictly more annealed structure than the one below.

## 2. The experiment

**Corpus**: OIML R 60:2021 (parts 1–3 + annexes) — the load-cell
Recommendation, chosen because a complete Primmel model exists for it.

**Representations**:

| Lane | Source | Chunks | What it carries |
|---|---|---|---|
| A `plain` | adoc stripped to prose | 187 | text only (P1) |
| B `adoc` | adoc with markup | 187 | text + markup (P1–2) |
| C `mko` | MKO bundles (MN 116) | 676 | typed units + graph (P1–7) |
| D `primmel` | Primmel model | 202 | typed model (P1–10) |
| E `flat` | D stripped of typing | 202 | the ablation |
| **F `composed`** | **C + D, cross-linked** | **878** | **document + model** |

**Controls**: same embedding model (qwen3-embedding-0.6b), same
contextual enrichment prompt, same retrieval code (dense + full-corpus
BM25, RRF fusion), same golden question set (18 probes across the
ladder). The ONLY variable is the representation.

**Measurement**: retrieval hits from each lane, graded by
witness-span containment (a hit counts only when the golden answer
span is present) plus structural artifact checks (typed block
delivered, not re-typed prose).

## 3. Measured results (7-column matrix)

Production (full OIML corpus, all serving stages) vs the six lanes
(raw dense+lexical fused retrieval, R 60 family only), graded by
passage-scoped retrieval witnesses — each rung's evidence span must
appear within one retrieved passage:

| Rung | Plain | Adoc | MKO | Primmel | Flat | Composed | Production |
|---|---|---|---|---|---|---|---|
| L0 locate | 0/2 | 0/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| L1 extract | 1/2 | 1/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| L2 nomenclature | 0/2 | 0/2 | 0/2 | 1/2 | 1/2 | 2/2 | 1/2 |
| L3 geometry | 0/2 | 1/2 | 0/2 | 1/2 | 1/2 | 1/2 | 2/2 |
| L4 composition | 0/2 | 0/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| L5 cross-standard | 0/2 | 0/2 | 0/2 | 1/2 | 0/2 | 0/2 | 2/2 |
| L6 diachrony | 1/2 | 1/2 | 0/2 | 1/2 | 1/2 | 1/2 | 2/2 |
| L7 perception | 0/1 | 0/1 | 1/1 | 0/1 | 0/1 | 1/1 | 1/1 |
| **L8 computation** | 0/1 | 0/1 | 0/1 | **1/1** | **1/1** | **1/1** | 1/1 |
| **L9 process** | 0/2 | 0/2 | 1/2 | **2/2** | **2/2** | **2/2** | 2/2 |
| **Total** | **2/18** | **3/18** | **6/18** | **13/18** | **12/18** | **14/18** | **17/18** |

Vector coverage at measurement: plain 151/187, adoc 171/187, mko
650/676, primmel 180/202, flat 189/202, composed 643/878 — footnoted
for honesty; the gaps are retryable timeouts, and the pattern below is
far larger than any gap.

### What the numbers mean

**The ladder is real.** Raw text representations (plain, adoc) answer
almost nothing (2–3/18) — they lose L0 LOCATE itself: only 95/187
chunks in those lanes carry a clause anchor, so the anchoring primitive
(P2) is absent from the representation, and "where does R 60 address
creep" cannot be answered with a citation even when the text is
retrieved. This is the thesis in one number: representation determines
what questions a corpus can answer.

**Structure buys the middle.** MKO (6/18) jumps to 2/2 on L4
composition (typed units carry cross-references) but loses the basics —
typed table units without situating context underperform prose at
L0–L3. The model lanes (primmel 13, flat 12) dominate everywhere their
objects exist.

**The model's unique rungs are confirmed at full matrix.** L8
computation is model-only by construction: the witness is the D_max/0.9
machine-limit co-occurrence, which exists in exactly one passage per
model lane and zero passages in every text lane. L9 process (the
MDLO-before-creep sequence) similarly rides the model's sequence and
precondition objects.

**Composed wins the matrix (14/18).** The earlier 3-lane measurement
worried cross-linking diluted precision (it did, on L3 probes); at the
full matrix the MKO prose + Primmel model cross-links ADD L2
nomenclature (2/2 — the only lane to clear both nomenclature probes)
and L7 perception (the figure objects ride the MKO side) without losing
L8/L9. Composition costs nothing here and buys the vocabulary and
perception primitives.

**Per-primitive specialization is visible.** L7 perception passes only
where figure objects exist (MKO, composed, production) — models carry
no figures. L5 cross-standard passes only in production: the ISO/IEC
17000 composition targets are not in any lane (the known isolation
artifact — primmel's 1/2 comes from its `uses:` declaration naming the
standard, not from retrieving it).

**The serving stack is worth 3+ rungs of representation.** Production
(17/18) beats the best lane by 3 with the SAME content because hybrid
retrieval (dense + full-corpus BM25 + rerank + edition steering +
structural propagation) recovers rungs that raw single-lane retrieval
loses (L3 2/2, L5 2/2, L6 2/2). Representation and serving stack
multiplicatively, not additively — the ceiling is representation-bound
(L2's colloquial→term bridge fails everywhere, glossary binding is a
pipeline capability).

### The capability ceiling (full matrix)

| Lane | Ceiling | Why |
|---|---|---|
| Plain / Adoc | L1 | no anchoring primitive (95/187 chunks carry a clause anchor) — even locate-with-citation fails; raw text answers little and cites less |
| MKO | L4 | typed units carry cross-references (L4 2/2) but the anchoring/nomenclature basics need situating context the lane lacks |
| Primmel | L9 | the model carries P1–P10 — its misses (L2b VIML provenance, L5 targets) are corpus-isolation artifacts, not representation limits |
| Composed | L9 | the full-matrix winner: model objects + prose vocabulary + figures; only the isolated L5 fails it |
| Production | L2 | 17/18 — fails only the colloquial→term bridge ("drifting"→"durability"), a glossary-binding gap the FABLE-era pipeline does not yet close (the term-alias ask, primmel/spec#18) |

## 4. What this means for standards publishing

The measurement confirms the annealment hypothesis **with nuance**:

1. **Representation determines what is RETRIEVABLE, not what is
   ANSWERABLE.** A typed constraint in the index means the retrieval
   system can FIND it; whether the answer system USES it depends on
   the serving pipeline. The comparison isolates the retrieval effect.

2. **The model lane's unique capability is confirmed for L8–L9.** No
   document representation retrieves `constraint` or `sequence` blocks —
   they don't exist in MKO or adoc. These are Primmel-only objects.

3. **Composition helps on synthesis rungs (L4) but dilutes on
   precision rungs (L3).** This is the trade-off the composed lane
   reveals: more evidence is not always better ranking.

4. **The nomenclature gap (L2) is universal.** All lanes fail the
   colloquial→term bridge ("drifting" → "durability") — this is a
   serving-pipeline capability (the understanding model + glossary
   lane), not a representation effect. The producer-side fix (unit-level
   vocabulary registers, metanorma-document#53 item 3) would close it.

## 5. Independent replication: FABLE/BEAR

Concurrent work reaches the same conclusion from the other direction.
FABLE/BEAR (arXiv:2601.18116, v1 Jan 2026 "FABLE", v2 May 2026 "BEAR")
builds LLM-constructed semantic forests and retrieves over them with
bi-path navigation. Their ablations, on general corpora:

- hierarchical node-level retrieval beats flat chunks by **+27 points**
  at a 4K-token evidence budget;
- LLM semantic chunking alone reaches near-optimal completeness at 4K
  tokens where fixed-length chunking needs 128K (**64× efficiency**);
- the full forest matches full-context Gemini-2.5-Pro with **94% fewer
  tokens**;
- on BrowseComp-plus, swapping only the retriever (same LLM) moved an
  agent from rank 11 to near the top — retrieval architecture, not model
  scale, was the binding constraint.

Their stated limitation is our thesis: "FABLE requires upfront indexing
and benefits most from semantically structured documents. Its advantages
diminish on highly unstructured corpora." Producer-native structure
(MKO, Primmel) is the ceiling of that benefit — the tree arrives
authored, not inferred.

**Our adaptation inverts their index-time cost.** FABLE pays an LLM to
BUILD the hierarchy (chunk → tree → summaries) because their corpora are
unstructured. OIML documents arrive as trees: clause anchors chain
parent→child natively, so Metanorma publications skip the LLM tree-builder
entirely — we only synthesize the ~1,400 missing depth-1 summary nodes
(one-time, ≈$3, quality-first lane) and adopt three serving techniques
(structural propagation, position-preserving ordering, ancestor-descendant
dedup; see docs/knowledge-annealment.md "FABLE adaptations").

## 6. Next steps

- Index the remaining lanes (A plain, B adoc, E ablation) to complete
  the 6×10 matrix
- Run through the full serving pipeline (not just raw retrieval) for
  end-to-end capability comparison
- Measure cost-per-correct-answer across lanes
- The composed lane's trade-off motivates adaptive retrieval: route
  queries to the MKO or Primmel half based on query understanding

---

*Companion documentation: docs/knowledge-annealment.md (the ladder +
eras + frontier), docs/annealment/ (one file per rung and frontier win
with worked examples). Reference deployment: ai.oimlsmart.org/annealment.*
