# MKO export pipeline — mn-samples-oiml → RAG

**Status: producer + consumer validated end to end on the real corpus
(2026-08-28).** This is the producer-native path that replaces HTML
scraping for the clean corpus. Wire contract: MN 116 (metanorma/docs PR
#9, sources/116).

This pipeline is the first concrete realization of the ETSI-informed
redesign gaps ([REDESIGN-NORMATIVE-RAG-ETSI.md](REDESIGN-NORMATIVE-RAG-ETSI.md)):
native section `part_of` (G-ETSI-2), native `cites` edges (G-ETSI-3),
atomic typed tables (G-ETSI-5) — from the producer, with no recovery
heuristics.

## What MKO is

One Metanorma document → one `<short>.mko/` bundle of typed,
addressable knowledge objects:

| Component | Content |
|---|---|
| `manifest.json` | schema id, per-component SHA-256 hashes (verified at ingest) |
| `document.json` | identity (parsed docids, doctype, edition, status, languages), relations, numbered structure tree |
| `units.jsonl` | typed units — clause/annex/term/table/figure/formula/note/example/sourcecode/requirement/reference — each with anchor, number, breadcrumb, plain text, typed payload, content hash |
| `edges.jsonl` | the graph: `part_of` containment, `cites` (reference **and** term units), `defines` (term→concept), `class_of`, document-level relations (`doc:<short> → ext:<id>`, Relaton type verbatim: obsoletes/hasPart/…) |
| `bibdata.json` | the document's own record as **native Relaton JSON** |
| `bibliography.jsonl` | every **cited document** as native objects: Relaton item + native pubid parse + pubid render |
| `glossary.json` | term entries as **native Glossarist concepts** |
| `identifiers.json` | the document's identifiers with **native pubid parses** |

Semantic anchors over GUIDs, content-hash-stable unit ids, byte-identical
determinism, zero flavor knowledge in the walk.

## Pipeline for mn-samples-oiml

The samples already carry compiled `document.xml` +
`document.presentation.xml` in-tree (OIML compiles through the iso
backend: `flavor="iso"`), so today the export is a one-liner per
document (from the metanorma-document checkout, branch
`feat/model-validation-l1-declarations`, PR #45):

```bash
# one command, gated (live since 2026-08-29):
.venv/bin/python -m ingest.cli mko              # export → ingest → enrich → verify-gate → wire → fts → graph
.venv/bin/python -m ingest.cli mko --dry        # counts + coverage check only
```

The pipeline enforces the stage order this path proved matters: the
`verify` gate refuses to wire chunks that lack contextual preambles
(the 2026-08-28 regression — un-enriched upserts dropped retrieval
R@5 from 95% to 90%), and it stops before shipping (INDEX_VERSION
bump + deploy stay human). Stage 5 (wire) needs
`CLOUDFLARE_API_TOKEN` in the environment; enrichment upserts
enriched vectors live as it runs, so wiring is idempotent
bookkeeping afterwards. The underlying per-stage commands (for
reference / partial runs):

When the umbrella wiring lands (metanorma PR #591) this becomes
`metanorma compile document.adoc -x mko` and the Ruby step disappears —
the ingest side does not change.

## Worked example: OIML R 60-1 (load cells)

`oiml-r-60-1.mko` → ingest output (producer @e6918cb):

```
155 units (clause=72, term=59, table=6, figure=4, example=2, reference=12)
  → 136 chunks, 59 terms, 12 cited docs, 541 graph rows
canonical: OIML R 60-1 (edition 2)
```

**Full-corpus run (2026-08-29, live):** 36 documents → 3,020 enriched
chunks (clause 1,913 / table 371 / term 113 / note 77 / formula 37 /
annex 32 / example 8), 113 glossary concepts, 342 cited docs, 3,561
section nodes + cites/defines edges in D1. Retrieval held at baseline
(R@5 95%, AP 0.875, MRR 0.893) after widening the rerank window to 10
for the enlarged clean lane.

## Full-corpus validation (2026-08-28)

All **37** compiled sample documents (R/D/B/G/E + OIML-CS admin + parts
+ amendments) export and ingest:

```
37/37 bundles → 3053 chunks, 113 native Glossarist concepts,
342 cited documents (native Relaton + pubid), ~11k graph rows
```

Includes the amendment cases: R 60/A1 keeps its 17 terms in an annex
(recovered into the glossary), and the OIML-CS admin documents keep
their whole body in `<preface>` (walked as clauses). Clause text now
carries list content in document order, not just paragraphs.

*Counting notes (verified against the artifacts): the 539 graph rows are
242 edges (147 `part_of`, 36 `cites`, 59 `defines`) + 297 node inserts;
figures and references become bibliography/graph objects, not chunks, so
135 chunks = clause 68 + term 59 + table 6 + example 2 (3 clause units
merge/empty; the source XML carries 63 raw `<term>` tags, 4 of them
nested/boilerplate).*

- 59 Glossarist-native concepts (designations, definition, sources,
  `language_code: eng`) — the glossary-heavy load-cell vocabulary lands
  directly in the terminology lane, no scraping.
- 6 tables as typed payloads (columns/rows), atomic — G-ETSI-5.
- 539 graph rows: 147 `part_of` (section parthood — G-ETSI-2), 36
  `cites` (12 references + term sources — G-ETSI-3), 59 `defines`
  (edges total 242; the remaining rows are node inserts).
- 12 cited documents (OIML V 1:2013, R 111, …) as native Relaton items —
  the citation targets are addressable objects, not strings.

## How the artifacts feed the existing stages

`artifacts/mko_chunks.jsonl` uses the **same chunk schema** the
parse/enrich/embed stages already consume (`chunk_text`, `doc_id`,
`docidentifier`, `clause_anchor`, `clause_title`, `tier`, `corpus`,
`status`, `superseded_by`, `text_ref`) plus new keys: `block` (unit
type), `unit_id`/`unit_hash` (incremental re-index keys), and typed
payloads (`metadata.table` with columns/rows, `metadata.formula` with
description/asciimath, `metadata.term`, `metadata.requirement`).
`artifacts/mko_graph.sql` targets the same D1 `graph_nodes`/`graph_edges`
tables as `ingest/graph.py`. `mko_glossary.json` and
`mko_bibliography.json` are new lanes (terminology exact-match; cited-doc
registry).

## Gaps / next steps

1. **CLI**: `-x mko` is wired in metanorma PR #591 (unreleased). Until
   it ships, use the Ruby export above (works against the in-tree
   compiled XML).
2. **pubid has no OIML flavor**: OIML identifiers ("OIML R 60-1:2017")
   are not pubid-parsed → `pubid: null` in bibliography lines. Doc node
   ids still normalize (`doc:OIML-R-60-1-2017` — same shape as
   `graph.py#norm_id`, so the graphs join). Upstream ask filed:
   pubid/pubid#342.
3. **Document-level relations**: the samples' semantic XML embeds no
   relaton `<relation>` elements, so `doc:` edges are empty for them;
   the relaton-data-oiml join stays authoritative for
   status/supersession until flavors embed relations at compile time.
4. **Collections** (r060, r129, r138: parts + amendments via
   `collection.yml`): export is per document today; a collection-level
   manifest with cross-document edges is future MN 116 work.
5. **Multilingual editions** (FR/AR/…): units carry `lang`; interlinear
   alignment (same unit id across languages) is specified in MN 116 but
   needs producer work on translated sources.
