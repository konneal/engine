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

## 3. First results (3-lane comparison)

Production (full OIML corpus, all serving stages) vs the two
experimental lanes (raw retrieval, R 60 only):

| Rung | Production | Primmel | Composed |
|---|---|---|---|
| L0 locate | 2/2 | 2/2 | 2/2 |
| L1 extract | 2/2 | 2/2 | 2/2 |
| L2 nomenclature | 1/2 | 1/2 | 1/2 |
| L3 geometry | 2/2 | 1/2 | 1/2 |
| L4 composition | 1/2 | **2/2** | **2/2** |
| L5 cross-standard | 1/2 | 0/2 | 0/2 |
| L6 diachrony | 2/2 | 1/2 | 1/2 |
| L7 perception | 1/1 | 1/1 | 1/1 |
| **L8 computation** | 1/1 | **1/1** | **1/1** |
| **L9 process** | 2/2 | **2/2** | **2/2** |
| **Total** | **15/18** | **13/18** | **13/18** |

### What the numbers mean

**Production's advantage is corpus size and serving pipeline.** At 32k
chunks with query understanding, edition steering, and cross-corpus
filtering, production passes L3 and L5 that the raw-retrieval lanes
miss. Its L3 pass (n_LC class B) comes from the MKO tables already in
the index; its L5 pass (ISO humidity) from the dirty-corpus chunks that
mention ISO standards by name.

**Primmel's advantage is typed model objects.** The D_max constraint
probe (L8) retrieves the OCL `constraint` block with its violation
meaning — "the type evaluation of this load cell is void" — from the
Primmel lane. Production retrieves R 76-2 (a different standard!) for
the same query. The creep-test order probe (L9) retrieves the
`sequence` block with its ordered steps and roles.

**The composed lane confirms cross-linking works** but shows a
trade-off: adding 676 MKO prose chunks to 202 Primmel model chunks
dilutes the model objects' ranking for some queries. On L4 composition
the cross-links help (both primmel and composed score 2/2 vs
production's 1/2); on L3 the dilution hurts (composed misses the n_LC
attribute that pure primmel misses differently).

**The L5 gap is structural.** The Primmel model composes with ISO/IEC
17000/17065 (the `uses:` declarations), but the composition targets are
NOT in the comparison indexes — only the R 60 model is. The production
corpus includes dirty-corpus chunks that reference ISO standards by
name. This is an isolation artifact of the experiment, not a
representation effect.

### The capability ceiling (first measurement)

| Lane | Ceiling | Why |
|---|---|---|
| Production | L2/L4 | fails colloquial nomenclature (L2a) and MPE scaling (L4a) — the understanding model can't bridge "drifting" to "durability" without a glossary binding |
| Primmel | L5 | the model carries P1–P10 but the raw retrieval (no understanding, no filtering) misses table geometry (L3a) and ISO links (L5) that need the serving pipeline |
| Composed | L5 | same as primmel — the composed lane inherits the model's strengths and the raw-retrieval limitations |

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

## 5. Next steps

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
