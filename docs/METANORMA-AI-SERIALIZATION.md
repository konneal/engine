# Metanorma AI Serialization — Adapter Format Proposal

*Proposed output flavor for `metanorma-document` (and the concrete answer to
[metanorma/metanorma#592](https://github.com/metanorma/metanorma/issues/592)):
a machine serialization of a Metanorma document designed for RAG ingestion
and AI training corpora. Draft v1.0.0-proposal, 2026-08-26.*

---

## 1. Positioning

Metanorma already has the right substrate: `metanorma-document`
deserializes semantic XML into typed lutaml-model classes and serializes
them to XML/YAML/JSON natively. This proposal does NOT invent a new
document model — it defines a **projection flavor**: a stable, typed,
chunk-ready node graph derived from the existing model.

```
adoc source ──compile──▶ semantic XML ──Root.from_xml──▶ metanorma-document MODEL
                                                          │
                          ┌───────────────────────────────┤──▶ HTML / PDF (renderers)
                          └──▶ AiSerialization::Root.to_json / .to_yaml / .to_xml   ◀── THIS PROPOSAL
```

Properties:

- **Derived output** (like renderings): lossy by design, never a source
  format; the model and semantic XML remain canonical.
- **Encoding-agnostic**: implemented as lutaml-model classes with
  `mapping` blocks — JSON, YAML, and XML serializations of ONE schema.
  No hand-rolled `to_h`/`to_json` anywhere (house rule).
- **Chunk-ready**: every node is self-contained (document identity +
  breadcrumb + typed payload), so RAG consumers embed nodes without
  re-deriving structure.
- **Graph-preserving**: a flat edge list exposes structure and semantics
  (containment, requirements→conformance tests, term links, citations).
- **Training-corpus friendly**: provenance, license fields, and stable
  node hashes make the same export usable as a curated AI-training
  corpus (the #592 ask).

## 2. Envelope

```jsonc
{
  "schema": "metanorma.ai-serialization",       // const identifier
  "schema_version": "1.0.0",                     // semver
  "generated": {
    "tool": "metanorma-document",
    "model_version": "x.y.z",                    // gem version
    "flavor": "oiml",                            // document flavor used
    "timestamp": "2026-08-26T00:00:00Z"
  },
  "document": { /* DocumentIdentity, §3 */ },
  "nodes":  [ /* typed nodes, §4 */ ],
  "edges":  [ /* flat edge list, §5 */ ],
  "datasets": { /* optional Glossarist/Relaton embeds, §6 */ },
  "rights": { "license": "...", "copyright": "..." }   // corpus-safe provenance
}
```

## 3. Document identity node

```jsonc
"document": {
  "docidentifier": "OIML R 60-1",     // authoritative, never slug-derived
  "part": "1",                         // or "annex": "A"
  "edition": "2017",
  "language": "en",
  "doctype": "R",
  "status": "in-force",                // in-force | superseded | withdrawn | joint
  "superseded_by": null,
  "title": "Metrological regulation for load cells — Part 1",
  "family": "R-60",                    // series node for part graphs
  "source": { "file": "document.xml", "hash": "sha256:…" },
  "canonical_id": "OIML R 60-1:2017:en"
}
```

## 4. Typed nodes

Node classes map 1:1 onto existing model classes (right column = source in
`metanorma-document`):

| Node type | Source model class | Notes |
|---|---|---|
| `clause` | `BasicDocument::Blocks::BasicBlock` (+subclasses) | carries `anchor`, `obligation`, breadcrumb |
| `table` | `BasicDocument::Tables::TableBlock` | columns/units/rows payload |
| `formula` | `BasicDocument::AncillaryBlocks::FormulaBlock` + `StemElement` | asciimath/latex/description |
| `figure` | `BasicDocument::Figure` | alt text, image ref |
| `term` | `StandardDocument` term entries | links to Glossarist concept |
| `requirement` | `Document::Components::Blocks::RequirementModel` | ModSpec projection |
| `permission` | `…/PermissionModel` | ModSpec projection |
| `recommendation` | requirement variants | ModSpec projection |
| `conformance_class` / `conformance_test` | ModSpec classes | `modspec-ruby` objects |
| `reference` | `BibData`/bibitem entries | Relaton key |
| `amendment`/`change` | `BasicDocument::Change` | editorial vs technical |

**Common fields (all nodes):**
```jsonc
{
  "id": "n:tbl-4.1.2-1",         // stable: "n:" + model anchor/id
  "type": "table",
  "parent": "n:cl-4.1.2",        // containment (also in edges)
  "anchor": "tbl-4.1.2-1",
  "breadcrumb": ["4 Metrological requirements", "4.1 Classification"],
  "obligation": "normative",     // when the model carries it
  "hash": "sha256:…",            // content hash — enrichment invalidation
  "text": "…"                    // human-readable display text
}
```

**Typed payloads:**
```jsonc
// table
{ "columns": [{ "label": "Load m", "unit": "e", "scope": "per verification interval" }],
  "rows": [["0 ≤ m ≤ 5·10³", "0.5e"]],
  "caption": "Maximum permissible errors",
  "embed_text": "Table: Maximum permissible errors; columns: Load m [e], MPE; row: 0 ≤ m ≤ 5·10³ | 0.5e" }

// formula
{ "asciimath": "n_LC <= …", "latex": "n_{LC} \\leq …",
  "described": "limit on the number of verification intervals" }

// term
{ "concept": "load-cell", "designation": "load cell",
  "definition": "…", "vocab": "oiml-complete", "glossarist_id": "…" }

// requirement (ModSpec projection)
{ "identifier": "/req/oiml-r60-1/classification/nlc-limit",
  "class": "/req/oiml-r60-1/classification",
  "obligation": "requirement",
  "statement": "The number of load cell verification intervals n_LC shall be within…",
  "inherits": [], "subject": "load cell", "inherits:": [] }

// conformance_test
{ "identifier": "/conf/oiml-r60-1/classification/nlc-limit",
  "class": "/conf/oiml-r60-1/classification",
  "tests": "/req/oiml-r60-1/classification/nlc-limit",
  "method": "Inspect the marking and the accompanying documents…" }

// reference
{ "key": "IEC61000-4-2", "cited": "IEC 61000-4-2:2008", "relaton_id": "…" }
```

`embed_text` is a PRODUCED convenience (deterministic serialization of the
payload for embedding); consumers may ignore it and serialize their own way.

## 5. Edges

```jsonc
{ "from": "n:tbl-4.1.2-1", "to": "n:cl-4.1.2", "kind": "part_of" }
```
Kinds: `part_of` (containment), `cites` (reference node → external docid),
`supersedes`, `defines` (term → concept), `tested_by` /
`requirement_of` (requirement ↔ conformance test), `class_of`,
`amends`, `variant_of` (language/edition variants).

## 6. Dataset embeds (optional)

```jsonc
"datasets": {
  "glossarist": { "id": "oiml-complete", "concepts": 6031, "embedded": false, "ref": "…" },
  "relaton":    { "id": "relaton-data-oiml", "records": 5707, "embedded": false, "ref": "…" }
}
```
Embedding the full datasets inline is OPTIONAL (size); the fields declare
which datasets the document's edges/terms resolve against.

## 7. Serializations

One lutaml-model class set; three mappings (idiomatic examples):

- **JSON / YAML**: attribute names as above (`Metanorma::AiSerialization::Root.to_json`)
- **XML**: elements for complex parts, attributes for scalars —
  `<node type="table" id="n:tbl-4.1.2-1" anchor="tbl-4.1.2-1"><caption>…</caption>…`

Consumers pick an encoding; the schema is the contract.

## 8. Conformance (producers MUST)

1. Emit `schema`, `schema_version`, full document identity, and node
   `id`/`type`/`anchor` for every node.
2. Node ids stable across regenerations for unchanged content (anchor +
   content hash basis).
3. Tables carry columns+rows (never linearized strings only); formulas
   carry at least two of {asciimath, latex, described}.
4. Edges only reference present node ids or declared external keys.
5. `rights` present when the source declares license/copyright.
Consumers SHOULD treat unknown node types as opaque text nodes
(forward compatibility).

## 9. Our consumer mapping (rag ingest)

| AI Serialization | ChunkRecordV2 (Stage 2 spec) |
|---|---|
| `document` | `DocumentRecord` |
| `nodes[type=clause]` | chunk `block: clause` |
| `nodes[type=table]` | chunk `block: table` + `table` payload |
| `nodes[type=formula]` | `block: equation` |
| `nodes[type=term]` | `block: definition` |
| `requirement`/`conformance_test` | `block: requirement` |
| `edges` (cites/supersedes/part_of/tested_by) | D1 graph projection |

## 10. Implementation sketch (upstream)

A `metanorma-document` flavor module — class set + a walk:

```ruby
module Metanorma
  module AiSerialization
    class Root < Lutaml::Model::Serializable
      attribute :schema, :string
      attribute :schema_version, :string
      attribute :document, DocumentIdentity
      attribute :nodes, Node, collection: true
      attribute :edges, Edge, collection: true
      json do |m| m.map "schema", to: :schema # … end
      xml do |m| m.root "ai-serialization" # … end
    end
    module Project                     # the walk: model → nodes/edges
      def self.call(doc_model) = …     # visits typed model classes only
    end
  end
end
```
CLI: `metanorma compile doc.adoc -x ai-serialization,json` (a new output
format alongside html/pdf/… — the #592 ask reduced to one flavor entry).

## 11. Open questions for upstream

1. Version stability contract for the projection (semver gates?).
2. Whether `embed_text` serializations belong in the spec or a separate
   "AI profile".
3. Multi-document collections (per-document envelopes vs collection
   envelope with cross-doc edges).
4. License signaling for training-corpus redistribution.
