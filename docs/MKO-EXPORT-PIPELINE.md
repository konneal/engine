# MKO export pipeline — mn-samples-oiml → RAG

**Status: producer + consumer validated end to end on the real corpus
(2026-08-28).** This is the producer-native path that replaces HTML
scraping for the clean corpus. Wire contract: MN 116 (metanorma/docs PR
#9, sources/116).

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
bundle exec ruby -e '
  require "metanorma/document"
  require "metanorma/iso/document"
  require "metanorma/mko"
  %w[sources/r060/1 sources/r060/2 sources/r060/3].each do |src|
    xml  = File.read(ENV["HOME"] + "/src/mn/mn-samples-oiml/#{src}/document.xml")
    pres = File.read(ENV["HOME"] + "/src/mn/mn-samples-oiml/#{src}/document.presentation.xml")
    puts Metanorma::Mko.export(xml, to: "bundles", presentation_xml: pres)
  end
'
.venv/bin/python scripts/ingest_mko.py bundles/*.mko
```

When the umbrella wiring lands (metanorma PR #591) this becomes
`metanorma compile document.adoc -x mko` and the Ruby step disappears —
the ingest side does not change.

## Worked example: OIML R 60-1 (load cells)

`oiml-r-60-1.mko` → ingest output:

```
154 units (clause=71, term=59, table=6, figure=4, example=2, reference=12)
  → 135 chunks, 59 terms, 12 cited docs, 539 graph rows
canonical: OIML R 60-1 (edition 2)
```

- 59 Glossarist-native concepts (designations, definition, sources,
  `language_code: eng`) — the glossary-heavy load-cell vocabulary lands
  directly in the terminology lane, no scraping.
- 6 tables as typed payloads (columns/rows), atomic — G-ETSI-5.
- 539 graph rows: 147 `part_of` (section parthood — G-ETSI-2), 36
  `cites` (12 references + term sources — G-ETSI-3), 59 `defines`.
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
   `graph.py#norm_id`, so the graphs join). An OIML pubid flavor would
   make citation joins exact; worth an upstream ask.
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
