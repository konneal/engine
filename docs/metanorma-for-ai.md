# Metanorma for AI — a feature proposal from the RAG trenches

**From:** the OIML RAG service (ai.oimlsmart.org — 875 Metanorma documents,
~42k indexed clause chunks, live citation-grounded Q&A).
**Claim:** every item below maps to a concrete cost we paid or a capability
we could not ship. This is not speculative — it is the wish list of a
production RAG consumer of Metanorma output.

## The core problem

RAG consumers today scrape the **compiled HTML** — the least machine-shaped
artifact Metanorma emits. We parse heading text to recover clause numbers
(because element ids are GUIDs in OCR-derived docs), regex out boilerplate,
flatten tables into pipe-joined rows, skip equations entirely, and join
document status from an external bibliography. Every one of those workarounds
is a proposal in disguise.

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

## P2 — stable unit ids across revisions

Content-hash-derived ids (or editor-stable anchors) so an editorial
change re-indexes only changed units. Today any text change re-embeds the
whole document; across a 900-document corpus with weekly revisions this
is the difference between incremental and full re-index cost.

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
