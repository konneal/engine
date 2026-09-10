---
title: "OIML SMART AI — A Grounded Question-Answering Service over Legal-Metrology Publications"
subtitle: "How an open-weight, Cloudflare-native RAG system answers from 900 OIML documents with citations, typed objects, and computed verdicts"
---

# OIML SMART AI

*A grounded question-answering service over legal-metrology publications.*

**Abstract.** OIML publishes the Recommendations, Documents and Basic
publications that define legal metrology worldwide — roughly 900
documents and 9.3 million words across ten languages. Finding the clause
that governs a question has historically meant knowing the document
already. OIML SMART AI (*ai.oimlsmart.org*) is a public question-answering
service over that corpus: every answer cites the exact publication,
edition and clause; normative values are quoted verbatim; tables,
equations and figures render as the producer's typed objects; and
conformance questions about machine-checkable model objects are answered
by execution. The system runs entirely on Cloudflare's edge platform
with open-weight models, at a marginal cost near one tenth of a US cent
per answer.

## 1. The problem

A practitioner asks *"what is the minimum number of verification
intervals for a class B load cell?"* The answer lives in a table in
OIML R 60. The question does not name R 60, the table, or the row. A
conventional keyword search fails unless the question echoes the
document's wording; a conventional LLM answers confidently from memory,
which is worse. Legal metrology adds constraints that generic systems
do not carry: **editions supersede each other** (the 2021 parts of
R 60 replaced the 2017 consolidated edition), **normative values must
be quoted exactly** ("5 000" verification intervals, not "about five
thousand"), **tables carry the values** (flattening them into prose
destroys the row×column geometry that makes a cell answerable), and
**the authoritative answer to "is this configuration acceptable?" is a
verdict computed from the standard's own rules**, not a paragraph.

## 2. The knowledge staircase

The system's central finding is that **the representation of a corpus
determines the ceiling of what can be answered**. Measured across six
representations of the same content with 18 witness-graded capability
probes:

```
plain text → clause-anchored prose → typed units (MKO) → machine models (Primmel) → execution
   2/18           3/18                    6/18              13/18                computed verdicts
```

- **Plain text** cannot even cite reliably (half its chunks carry no
  clause reference).
- **Clause anchoring** buys locate-with-citation.
- **Typed units** (Metanorma Knowledge Objects) buy tables, formulas and
  figures as objects.
- **Machine models** (the Primmel packages) buy constraints,
  calculations and test sequences.
- **Execution** buys verdicts: *"is D_max 26 000 v valid for E_max
  30 000 v?"* → **INVALID, computed**, with the arithmetic shown.

The serving stack (hybrid retrieval, structural ranking, vocabulary
binding, contract enforcement) is worth a further +3 rungs over the best
single representation: **17–18 of 18**, answering nearly every probe
class the corpus can support.

## 3. How answers are built

An answer passes through a pipeline of composable stages:

1. **Query understanding** — one small model reads every question for
   language, named publication, edition, process intent, and
   decomposition. A document named in the question scopes retrieval
   deterministically, read from the question text.
2. **Hybrid retrieval** — dense vectors alongside a full-corpus BM25
   scan, RRF-fused, with a terminology graph and hypothetical-answer
   lanes; contextual enrichment (a model-written preamble stating where
   each chunk sits in its document) persists index-time quality into
   every retrieval.
3. **Structural ranking** — the corpus *is* a tree; a hit's score
   blends its ancestors' and descendants'; evidence is presented in
   document reading order; superseded editions demote family-relative
   while staying citable when only they carry content.
4. **Vocabulary binding** — everyday words ("my output keeps drifting")
   bridge to defined terms (durability, VIML 5.15) via the glossary of
   8.8k concepts; the answer leads with the corpus's own term.
5. **The answer contract** — inline citations on every claim; normative
   values verbatim; tables/formulas/figures as symbolic references
   (`[[u:…]]`) resolved server-side to the producer's payload — the
   model never re-types normative data, so generation cannot corrupt
   it. A deterministic post-check enforces it with one corrected retry.
6. **Execution** — questions naming machine-checkable objects get them
   *evaluated*: pass, or the standard's own violation wording, or void
   naming the missing parameters. Counterfactuals are free.
7. **Multimodal reading** — a pinned figure's pixels ride the
   generation call, so labels that exist only in the drawing are read
   from the drawing.

Members with the `ai-preview` permission additionally search the
ISO/IEC conformity-assessment corpus, federated into the same pipeline;
users select which databases (OIML publications, OIML SMART models,
ISO/IEC) participate in each question.

## 4. Trust as mechanics, not vibes

- **Provable absence** — "does R 60 constrain packaging?" enumerates the
  standard's entire model plane and returns a certificate (N nodes
  enumerated, 0 matches), never a bare "I found nothing".
- **Answer verification** — any answer is checkable against the corpus
  (quote containment, object-reference resolution, judged faithfulness).
- **Measurement gates** — every change ships through one command:
  the 38-case golden suite ×3 (witness-span grading) plus an 18-probe
  capability battery ×6; any failed run fails the gate. Current
  standing: golden 37–38/38, capability mode 18/18.
- **Corpus integrity as operations** — the index is reconciled against
  the canonical chunk set (one census found 18,041 stray vectors from
  prior re-chunkings); enrichment replays from a durable record after
  restores; figure assets are verified readable by vision pipelines.

## 5. Deployment and economics

Everything runs on Cloudflare: Workers (serving), Vectorize ×2
(structurally isolated public/internal indexes), D1 (state), KV
(caches), R2 (assets). Models are open-weight Chinese models served on
Workers AI — a ~320B-parameter natively multimodal model answers for
approximately **$0.0012 per answer**; a 3B-active MoE covers the
anonymous tier. No proprietary model APIs; no data leaves the estate.
Personalized memory files (per-member context documents) and
per-conversation database scoping are first-class.

## 6. What this enables

For the metrology community: the corpus becomes *queryable* — a
regulator drafts against the current edition with the delta to the
prior one a clause-lookup away; a lab checks a configuration by
execution instead of reading; a committee asks impact questions ("if
this limit changes, which requirements change?"). For standards
publishers, the staircase is the lesson: **anneal knowledge into
structure a machine can traverse, and the questions a corpus can answer
expand structurally** — from lookup, through geometry, to computation.

---

*Live: <https://ai.oimlsmart.org> · mechanism reference: `docs/sota-mechanisms.md` · measurement study: `docs/paper-annealment-comparison.md`*
