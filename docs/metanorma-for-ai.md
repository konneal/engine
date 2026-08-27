# Metanorma for AI — a feature proposal from the RAG trenches

**From:** the OIML RAG service (ai.oimlsmart.org — 875 Metanorma documents,
~42k indexed clause chunks, live citation-grounded Q&A).
**Claim:** every item below maps to a concrete cost we paid or a capability
we could not ship. This is not speculative — it is the wish list of a
production RAG consumer of Metanorma output.

## Evidence base (2025–26 primary literature)

Each proposal below is now grounded in peer-reviewed/preprint research on
RAG over standards and structured documents, not only in our production
experience:

- **[ETSI]** Al Masoud, Arazzi, Germani, Nocera. *Exploring Structural
  Complexity in Normative RAG with Graph-based approaches: A case study on
  the ETSI Standards.* arXiv:2604.09868 (2026). The only empirical RAG
  study on industrial standards (ETSI EN 301 489-X; 800+ Q&A). Findings
  used below: hierarchical section structure ↑precision/↑MRR;
  structure-preserving chunking is the "overall best compromise";
  tables are exempted from chunking (atomic); parthood (P) and citation
  (C) edges are the core information model; neighbor-expansion re-ranking
  *failed*; embedding *smoothing* is the lightweight recall lever. Their
  §II explicitly points at machine-readable standards (IEC Smart
  Standards) as the intended end state — this document is the Metanorma
  version of that end state.
- **[STC]** Guttal et al. *Structure-Aware Chunking for Tabular Data in
  RAG.* arXiv:2605.00318 (2026). Row-level key-value units, structural
  boundaries: hybrid MRR 0.36→0.59, BM25-only Recall@1 0.37→0.75,
  chunk count −40–56%. Quantifies P1-tables.
- **[RDR2]** Xu et al. *Equipping Retrieval-Augmented LLMs with Document
  Structure Awareness.* arXiv:2510.04293 (2025). Document structure trees
  as first-class retrieval input; flattened chunks are the named failure
  mode. Grounds P0-manifest.
- **[SF-RAG]** Yu et al. *SF-RAG: Structure-Fidelity RAG for Academic
  QA.* arXiv:2602.13647 (2026). Native hierarchy as a low-entropy
  retrieval prior; flattening "destroys the native hierarchical
  structure". Grounds P0-manifest + P2 stable ids.
- **[SPIRE]** *Structure-Preserving Interpretable Retrieval of Evidence.*
  arXiv:2604.20849 (2026). Linearization "obscures section structure,
  lists, and tables"; wants citation-ready subdocuments. Grounds P0/P1.
- **[MAHA]** Rashmi & Upadhya. *Modality-Aware Hybrid retrieval
  Architecture.* arXiv:2510.14592 (2025). Tables→HTML-structured,
  equations→LaTeX + text description, modality-aware knowledge graph.
  Grounds P1-tables/equations.
- **[ANTHROPIC]** Anthropic. *Contextual Retrieval* (2024): contextual
  preambles cut top-20 retrieval failures 35%→67% (with BM25+rerank).
  Grounds the manifest's role: preamble generation needs typed units,
  not scraped prose.
- **[LATE]** Günther et al. *Late Chunking.* arXiv:2409.04701 (2024);
  **[CMP]** Merola & Singh. *Reconstructing Context.*
  arXiv:2504.19754 (2025): contextual retrieval preserves coherence
  better; late chunking is cheaper. Both need long-context/typed units —
  neither works on GUID-anchored scraped HTML.

## The core problem

RAG consumers today scrape the **compiled HTML** — the least machine-shaped
artifact Metanorma emits. We parse heading text to recover clause numbers
(because element ids are GUIDs in OCR-derived docs), regex out boilerplate,
flatten tables into pipe-joined rows, skip equations entirely, and join
document status from an external bibliography. Every one of those workarounds
is a proposal in disguise. This is not just our experience: it is the exact
failure mode the structure-first literature names — flattened chunks lose
the hierarchy, tables, and cross-references that make a standard a standard
([ETSI] §I; [RDR2]; [SF-RAG]; [SPIRE]).

## P0 — the unit manifest (sidecar alongside every render)

Emit `document.rag.json` — an array of *addressable semantic units* the
renderer already understands while building the HTML:

```json
{
  "id": "oiml:r60-1:2021#3.9",
  "type": "term",              // clause | term | table | figure | equation | example | note | bibliography | annex
  "number": "3.9",
  "title": "load cell",
  "text": "measuring transducer which …",
  "status": "in-force",
  "parent": "oiml:r60-1:2021#3",
  "lang": "en",
  "spans": { "source": "sections/03-terms.adoc:104-112" }
}
```

What this replaces, item for item:

| Today (our pipeline) | With the manifest |
|---|---|
| BeautifulSoup over `document.html` | read JSON |
| clause numbers re-derived from heading text | `number` + canonical `id` |
| GUID anchors dropped by regex | stable canonical ids |
| boilerplate filtered by regex (© OIML, rue Turgot…) | boilerplate simply absent |
| OCR-escaped HTML tags stripped from text | clean source text |
| `type` unknown (tables/definitions found by shape) | `type` drives retrieval specialization (exact term lookup; table-value lookups) |
| no audit trail | `spans` point back to source |

The HTML remains for humans; the manifest is the machine truth. Embedding
one inside the HTML (`<script type="application/json" id="rag-manifest">`)
also works and keeps a single artifact.

**Evidence:** [ETSI] builds exactly this model (InfoUnits with title+body
in a parthood/citation graph) by *recovering* it from PDFs — ToC parsing,
section-code prefix geometry, reference-resolution heuristics — and shows
structure preservation improves precision and MRR. The manifest emits what
they recover, for free, from the model the renderer already holds.
[RDR2]'s structure trees and [SF-RAG]'s structure-fidelity index consume
the same shape. [SPIRE] shows the payoff is citation-ready evidence
subdocuments — which is what our answers cite.

## P0 — self-contained identity and status block

JSON front matter in every output:

```json
{
  "docidentifier": { "series": "OIML R", "number": "60", "part": "1", "year": "2021" },
  "edition": "2021",
  "status": "in-force",             // in-force | superseded | withdrawn | joint
  "successor": "oiml:r60-1:2021",   // from relaton relation hasSuccessor
  "relaton_ref": "r60-1_2021",
  "published": "2021-04", "withdrawn": null,
  "part_of": "oiml:r60", "translation_of": "oiml:r60-1:2021(E)"
}
```

Today we join status and successor from `relaton-data-oiml` at ingest
(5,707 YAML records; ~37% of editions are superseded or withdrawn). The
join works but is external state that can diverge — the render should
carry the bibliographic truth it was built from. Identity parsing is our
single largest source of dirty-corpus defects (identifiers without the
series letter, edition fields holding part numbers, slug/identifier
mismatches); a parsed, structured docid eliminates the whole class.

## P1 — tables as data, not prose

Normative values live in tables (MPE tables, accuracy-class limits). We
flatten them to `caption + " | "-joined rows` and hope the embedding
model copes. Instead, emit per table: caption, column headers **with
quantity and unit** (Metanorma already knows `[q]`uantities in many
flavors), rows as typed values, and the enclosing clause context. A JSON
or CSV serialization per table turns "what is the MPE for class III at
500 g?" from a fuzzy vector match into an exact lookup the serving layer
can execute and cite (`OIML R 76:2006, Table 3, row 4`).

**Evidence:** [ETSI] §II-A exempts tabular sections from chunking
entirely — atomic units, never split. [STC] quantifies the payoff of
row-level key-value structure: MRR +66% hybrid, Recall@1 +106% BM25-only,
chunk count −40–56%. [MAHA] parses tables into HTML structure and
equations into LaTeX as first-class modalities. Our own G1 prototype
(extracting 10,388 tables from adoc `|===` sources) reproduces the shape
by hand — e.g. R 76-1 §3.5's MPE table with rowspan-merged class columns
and clean `ClassⅢ = 0≤m≤500` rows — precisely what the manifest should
emit natively.

## P1 — the glossary layer as first-class output

Term entries (`term:: [preferred,definition]`) should also emit a
structured per-document glossary: term, grammar info, definition,
non-preferred terms, symbols, source citation. "What is a load cell?"
then becomes an exact-match against the glossary before any vector
search — the single highest-value retrieval specialization for standards
Q&A, and it aligns with the Glossarist model OIML already uses.

## P1 — equations that survive retrieval

`stem:[...]` (AsciiMath) is invisible to retrieval today; normative
formulas (MPE = 0.5·e …) are effectively unanswerable. Emit MathML plus a
generated plain-language fallback ("maximum permissible error equals half
the verification interval value") in the unit manifest. The fallback is
what gets indexed; the MathML is what gets rendered.

**Evidence:** [MAHA] treats equations as a distinct modality (LaTeX +
textual description) and shows retrieval gains from modality-aware
indexing; our METANORMA-AI-SERIALIZATION conformance rule already requires
≥2 of {asciimath, latex, described} for exactly this reason.

## P2 — stable unit ids across revisions

Content-hash-derived ids (or editor-stable anchors) so an editorial
change re-indexes only changed units. Today any text change re-embeds the
whole document; across a 900-document corpus with weekly revisions this
is the difference between incremental and full re-index cost.

**Evidence:** [SF-RAG] shows hierarchy-stable indexing is what makes
structure-fidelity cheap to maintain; [ETSI]'s InfoUnit ids are only as
stable as their recovered section codes — model-native anchors (what
Metanorma has) are strictly better. Stability is also prerequisite for
[ANTHROPIC] contextual preambles to be cacheable across revisions (our
enrichment cache is keyed by content-hashed unit ids).

## P2 — interlinear translation alignment

Same unit id, `lang` attribute — the renderer knows which French clause
corresponds to which English clause. That unlocks parallel corpora,
cross-language retrieval with source-language provenance, and
English-first indexes that can still cite the user's language edition.
(We currently ingest English-only because unaligned multilingual chunks
degrade retrieval; alignment would let us reverse that decision.)

## P2 — requirement metadata

Requirements are the product of legal metrology documents. Tag units
with obligation (`shall`/`should`/`may`) and subject where the markup
knows them → "list every requirement for load cell marking" becomes a
filter, not a prayer.

## P2 — a render profile for ingestion

`metanorma compile --profile rag`: boilerplate excluded (or typed as
such), notes/examples toggleable, source spans on, manifest emitted.
Consumers stop shipping regexes that guess at these boundaries.

## Anti-goals (keep the contract clean)

- No embeddings, no model output, no opinions inside Metanorma
  artifacts — deterministic renders only. AI-layer choices stay with
  consumers.
- Metanorma should not own chunking **policy**. Emit semantic units;
  consumers compose units into chunks for their model. What Metanorma
  owns is **addressability** (stable ids, types, clean text, spans).
  ([ETSI]'s own taxonomy supports this split: their "Structured +
  Chunks" winner is a *consumer-side* composition over
  producer-emitted structure — the producer's job is the structure.)

## Sequencing

1. Manifest + identity/status block (P0) — unblocks every RAG consumer,
   mostly exporter work in existing render code paths.
2. Tables + glossary (P1) — the two biggest answer-quality wins.
3. Equations, stable ids, alignment, requirement flags, profiles (P2).

## Beyond RAG — who else needs this

The unit manifest is not a chatbot feature; it is **addressability for
documents**, which unlocks a family of consumers:

- **Agentic conformity assessment.** Certification bodies and, soon,
  AI agents that draft type-evaluation reports: map measured test results
  to requirement unit-ids, auto-generate test plans from a Recommendation's
  requirements, and produce audit trails (result → requirement → source
  span). OIML R-series test-report annexes are already structured tables —
  a machine layer turns report preparation from copywork into assembly.
- **Regulatory transposition and comparison.** National bodies transpose
  OIML Recommendations into national law. Requirement-level units +
  superseded→successor chains make "what changed between the 2000 and
  2017 edition" and "which national clauses diverge" diffable questions
  instead of expert reading marathons.
- **Knowledge graphs / ontologies.** Terms × definitions × symbols ×
  requirements × documents, emitted per render, compose directly into the
  semantic layer legal metrology is already building — the glossary layer
  is the same graph in miniature.
- **LLM training and evaluation corpora.** Standards are high-quality,
  normatively precise domain text. Unit manifests make them citable
  training/eval material (grounded QA benchmarks for legal metrology,
  like legal benchmarks did for law) — with per-unit provenance.
- **Cross-publisher standards search.** Canonical unit ids (series,
  number, part, year, clause) federate search across OIML/ISO/IEC
  ecosystems instead of each publisher's PDF silo.
- **Translation QA.** Interlinear alignment turns "is the term set
  consistent across the E/F/A editions" into a diff.
- **Accessibility and plain language.** The semantic layer (structured
  definitions, requirement subjects) is the substrate for plain-language
  summaries and assistive reading — the same data, different renderer.

The common thread: today all of these consumers re-derive semantics from
prose. The renderer already holds these semantics in memory while it
builds the HTML. Emitting them is cheaper than every consumer
re-guessing them.
