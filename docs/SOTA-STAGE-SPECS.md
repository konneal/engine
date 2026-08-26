# SOTA Architecture — Detailed Stage-by-Stage Gaps and Target Specifications

*Companion to `RESEARCH-SOTA-2026.md` (technique survey) and
`ROADMAP-SOTA.md` (phasing). This document is the ENGINEERING SPEC: for
every stage — source documents, ingestion, structuring, index management,
query processing, retrieval, answer formulation, follow-up handling,
evaluation — it states what we have, the precise gaps, and the TARGET SHAPE
(schemas, policies, thresholds, models) with migration steps. 2026-08-26.*

---

## Stage 0 — Source contract: the desired Metanorma document shape

### Current
We consume two shapes: clean collections (`sources/<id>/document.adoc` +
`collection.yml` + per-clause `metanorma/sections/*.adoc`, 29 docs) and
dirty OCR slates (880 docs: adoc + `images/extracted` + manifest). Parsing
is **HTML-first** (BeautifulSoup over compiled Metanorma HTML): we recover
clause anchors from heading text, tables as caption+rows, drop GUID
anchors and OCR artifacts. Identity comes from a precedence ladder
(readable `:docidentifier:` → title-declared annex volume → slug).

### Gaps
- Identity fields live in prose-ish adoc attributes with no schema
  enforcement; every consumer re-derives structure from HTML scraping.
- Tables arrive as display HTML; column semantics (units, header
  hierarchy, row scope) are lost or mangled by OCR.
- Equations are `stem:[...]` AsciiMath strings embedded in prose — no
  MathML/LaTeX dual form, no description.
- Terms/bibliography are untyped text (Glossarist + relaton data exist in
  sibling repos but are joined post-hoc, not at source).
- No per-document quality signals (OCR confidence, completeness) beyond
  shell flags.

### Target source contract — consume the metanorma-document MODEL HUB

Metanorma is model-driven, and the toolchain already provides the right
substrate: **`metanorma-document`** deserializes semantic XML into typed
lutaml-model classes (`Metanorma::IsoDocument::Root.from_xml`,
`basic_document` → `standard_document` → `iso_document` hierarchies,
collections, mirror round-trips) — and, being lutaml-model based, the
same model serializes natively to **XML, YAML, or JSON**. Requirements,
permissions, and recommendations are ALREADY first-class block classes
(`RequirementModel`, `PermissionModel`). The upstream sibling
**`modspec-ruby`** models normative statements and conformance tests as
addressable objects (`/req/<class>/<name>` URIs, obligation, inheritance,
suites) with YAML/JSON round-trips; **Glossarist** and **Relaton**
exports provide the terminology and citation datasets.

The ingest contract is therefore NOT a file format — it is a **projection
over the model**:

1. Deserialize: semantic XML (or YAML/JSON) → metanorma-document model.
2. Project: a small adapter walks typed model nodes and emits the
   canonical node JSON below (the adapter can live upstream as a
   metanorma-document serialization flavor, or in our ingest as a Ruby
   step). ChunkRecordV2 (Stage 2) is filled mechanically from nodes.
3. Requirement/conformance nodes additionally project through the ModSpec
   model (identifier, obligation, class, linked conformance tests).
4. Glossarist/Relaton dataset exports feed definition chunks and graph
   edges directly (no side-repo joins).
5. Adoc model elements are parsed directly when no compiled model exists;
   compiled HTML remains the OCR-slate fallback ONLY.

Renderings (HTML/PDF/DOCX) are never ingestion inputs outside the OCR
fallback. Encoding is irrelevant — the node schema is the contract.

For reference, the node projection shape:

**1. Semantic XML (primary, clean corpus; ask upstream in #592 to emit it
as a first-class build artifact):**
```xml
<standard-document>
  <bibdata>
    <docidentifier type="oiml">OIML R 60-1</docidentifier>
    <edition>2017</edition> <language>en</language>
  </bibdata>
  <sections>
    <clause id="cl-4.1.2" obligation="normative">
      <title>Maximum number of verification intervals</title>
      <p>…</p>
      <table id="tbl-4.1.2-1">
        <name>Maximum permissible errors</name>
        <thead><th>Load m (in units of e)</th><th>MPE</th></thead>
        <tbody><tr><td>0 ≤ m ≤ 5·10³</td><td>0.5e</td></tr></tbody>
      </table>
      <formula id="frm-1"><stem type="AsciiMath">n_LC &lt;= ...</stem></formula>
    </clause>
  </sections>
  <terms>
    <term id="term-load-cell"><preferred>load cell</preferred>
      <definition>…</definition></term>
  </terms>
  <bibliography>
    <bibitem id="IEC61000-4-2">…</bibitem>
  </bibliography>
</standard-document>
```

**2. Canonical AI-friendly JSON projection (what RAG actually wants;
derived from the model, upstream or at ingest):**
```jsonc
{
  "doc": { "docidentifier": "OIML R 60-1", "part": "1", "edition": "2017",
           "language": "en", "doctype": "R", "status": "in-force",
           "family": "R-60", "superseded_by": null },
  "nodes": [
    { "type": "clause",    "anchor": "4.1.2", "obligation": "normative",
      "breadcrumb": ["4 Testing", "4.1 Classification"], "text": "…" },
    { "type": "table",     "anchor": "tbl-4.1.2-1",
      "caption": "Maximum permissible errors",
      "columns": [{ "label": "Load m (in units of e)", "unit": "e" },
                  { "label": "MPE" }],
      "rows": [["0 ≤ m ≤ 5·10³", "0.5e"]] },
    { "type": "formula",   "anchor": "frm-1", "asciimath": "n_LC <= ...",
      "latex": "n_{LC} \leq …", "described": "limit on verification intervals" },
    { "type": "term",      "anchor": "term-load-cell", "concept": "load-cell",
      "definition": "…" },
    { "type": "reference", "anchor": "IEC61000-4-2",
      "cited": "IEC 61000-4-2:2008" }
  ]
}
```
This projection maps 1:1 onto `ChunkRecordV2` (Stage 2) — ingest becomes a
mechanical walk of typed model nodes, with zero scraping and zero
structure guessing. If a specific serialization (e.g. TOML or another
AI-oriented form) is preferred upstream, the projection schema is the
contract; the encoding is swappable.

**3. Adoc model elements parsed directly** — where semantic XML is not
available, the adoc source IS model-bearing (`stem:[]`, adoc tables,
terms sections); parse the model, not a rendering.

**4. HTML only as OCR-slate fallback** — the dirty corpus's compiled HTML
remains the last-resort input for slates whose adoc is too degraded;
everything else moves off renderings entirely.

**Migration:** clean corpus first (compile → semantic XML → JSON
projection → existing chunker consumes nodes); dirty corpus stays on the
HTML-first parser until per-slate re-OCR/re-compile upgrades it. Upstream
ask (#592): ship the semantic XML (and ideally the JSON projection) as an
official output flavor so AI consumers never parse renderings.

---

## Stage 1 — Canonical document model (`DocumentRecord`)

### Current
No explicit document record — identity is reconstructed per chunk at parse
time and denormalized into chunk metadata. Relaton join adds
`status`/`superseded_by` per doc.

### Gaps
- Identity resolution runs inline in the parser; no persisted, verifiable
  document registry (we found identifier corruption the hard way — R 60-A).
- No edition/part graph (which parts belong to which family, which edition
  supersedes which) outside relaton YAMLs we don't control.

### Target
```ts
interface DocumentRecord {
  id: string;                 // "OIML R 60-1:2017:en" (canonical identity)
  docidentifier: string;      // "OIML R 60-1"
  family: string;             // "R-60"  (graph node)
  part: string | null;        // "1" | "A" | "annexes"
  edition: string;            // "2017"
  language: string;           // "en"
  doctype: "R"|"D"|"B"|"G"|"E"|"V";
  status: "in-force"|"superseded"|"withdrawn"|"joint";
  superseded_by: string | null;   // canonical id
  title: string;
  source: { repo: string; slug: string; tier: "clean"|"dirty"|"synthetic" };
  quality: { ocr_confidence?: number; shell: boolean; word_count: number };
  clause_tree: Array<{ anchor: string; title: string; path: string[] }>;
  content_hash: string;       // re-ingest dedup / enrichment invalidation
}
```
Persisted to D1 (`documents` table) at ingest; chunk metadata is JOINED
from it, never hand-assembled. **This is the SSOT for identity** — the
R 60-A class of bug becomes a one-row fix with a re-chunk of one doc.

---

## Stage 2 — Chunk model v2: typed blocks, not just prose

### Current
`ChunkRecord = { id, doc_id, chunk_ref, text, metadata }` where metadata
carries identity + `chunk_text` (context-enriched after Phase 0). All
blocks — prose, tables, equations, definitions, references — are stringified
into `text`. Tables are linearized caption+rows; equations stay AsciiMath
inside prose.

### Gaps (G1, G11)
- Table values (our most-queried content: MPE tables, accuracy classes)
  are flattened: header/units/row semantics lost; the model reads
  linearized rows and can transcribe wrong cells.
- Equations are retrievable only via surrounding prose.
- Definitions and normative references aren't typed, so no dedicated
  retrieval lane or display treatment.

### Target — one chunk schema, typed payloads
```ts
type BlockType = "clause" | "table" | "equation" | "definition" | "reference"
               | "requirement" | "conformance_test" | "family";

interface ChunkRecordV2 {
  id: string;                        // content-hash (stable across re-chunk)
  doc: DocumentRecord["id"];         // FK, joined at upsert
  block: BlockType;
  anchor: string;                    // "4.1.2" | "t4.1.2-1" | "term:load-cell"
  breadcrumb: string[];              // ["4 Testing", "4.1 Classification"]
  text: string;                      // DISPLAY text (human-readable)
  embed_input: string;               // EMBEDDING input = context + display/serialization
  context?: string;                  // LLM situating context (Phase 0)
  table?: {                          // block === "table"
    caption: string;
    columns: Array<{ label: string; unit?: string; scope?: string }>;
    rows: string[][];                // exact cell values, verbatim
  };
  equation?: { asciimath: string; latex: string; described: string };
  term?: { concept: string; definition: string; source_vocab: string };
  requirement?: {                   // ModSpec projection (metanorma-document
    identifier: string;             // RequirementModel → modspec-ruby)
    class: string;                  // "/req/oiml-r60-1/classification"
    obligation: "requirement" | "recommendation" | "permission";
    statement: string;              // the normative statement, verbatim
    inherits: string[];             // parent statement URIs
  };
  conformance_test?: {
    identifier: string;             // "/conf/oiml-r60-1/nlc-limit"
    class: string;
    requirement: string;            // URI of the tested statement
    method: string;                 // verification method text
  };
  reference?: { cited: string; relaton_key: string | null };
  quality: { ocr_confidence?: number };
}
```
- **Derivation:** `ChunkRecordV2` fields come from the Stage 0 model
  projection (semantic XML → JSON), not from HTML scraping — the parser
  walks typed model nodes and fills payloads mechanically.
- **Embedding input per type:** tables embed as `context + caption +
  header map + row tuples serialized` (structure-preserving, TabRAG
  lesson); equations embed as `described + latex`; definitions embed the
  verbatim definition.
- **Display text stays human-form** — the UI renders tables as tables.
- **Generation prompt gets the table JSON** for row-precise answers and
  quote-anchoring (Stage 7).

---

## Stage 3 — Ingestion pipeline

### Current (worked, proven)
parse (HTML-first, identity ladder, English-only) → family chunks →
relaton status join → chunks.jsonl → embed (resumable, 25/batch) → upsert
(idempotent, orphan-deleted) → contextual enrichment (running, in-place
upsert + KV context cache).

### Gaps
- Chunking policy is prose-only; no per-block typing (Stage 2).
- No ingest VERIFICATION stage: we ship counts, not invariants (e.g.,
  "every table chunk has ≥1 row", "every doc has an overview chunk").
- Re-ingest of one document is manual (full-corpus muscle).
- Enrichment re-run invalidation is manual (`content_hash` unused).

### Target pipeline (each stage gated by invariants)
```
parse → identity (DocumentRecord, D1) → structure (clause tree, typed blocks)
  → chunk (policy per BlockType) → enrich (quality-first model, KV-cached)
  → embed (per-type embed_input) → graph project (Stage 6 lanes)
  → upsert (public|internal by corpus) → VERIFY → INDEX_VERSION bump
```
**Verify stage (new):** per-doc chunk counts vs clause tree; table chunks
carry `table` payload; definition chunks resolvable to vocab concepts;
no orphan ids; embed_input ≤ model max; report to D1 `ingest_runs` table.
**Partial re-ingest:** `ingest one --doc OIML-R-60-1-2017-en` deletes that
doc's chunk ids, re-runs stages 3–7 for one document. **Enrichment
invalidation:** content_hash changes → KV context key evicted, re-enrich
paid only for changed chunks.

---

## Stage 4 — Index management (Vectorize)

### Current
`idx_oiml_public_v2` (31k vectors) + `idx_iso_internal` (structural
isolation). Metadata indexes exist for `doctype, doc_number, edition,
language`. topK ≤ 50 with `returnMetadata: "all"`. `INDEX_VERSION` gates
the KV answer cache; deletes/upserts ride `/admin/*` endpoints.

### Gaps (G3, G4)
- No sparse lane in Vectorize; lexical recall only over already-retrieved
  candidates (in-worker keywordRank) — exact-term recall depends on dense
  top-50 having caught the term.
- No dimension/quantization control (Vectorize limitation).
- Index rebuild story is "re-run ingest" (acceptable at 31k, must stay
  scripted and tested).

### Target
- **In-worker lexical index (the practical sparse lane):** D1 inverted
  index (`term → chunk_ids`) over enriched `embed_input` built during
  ingest; query-side: understanding-extracted key terms → top-200 lexical
  candidates → RRF with dense candidates (today's keywordRank, but
  corpus-wide rather than post-hoc). Cost: one D1 table, one build pass.
- **Metadata indexes:** add `block` (Stage 2 typing) for
  lane-selective retrieval (`block = table` boosts on value questions).
- **Keep hard rules written down:** filter-first query pattern, fallback
  unfiltered merge (already implemented); per-field metadata index
  requirement; INDEX_VERSION bump protocol on any content/logic change.

---

## Stage 5 — Chat-side processing: intent, state, caches

### Current
LLM understanding per ask (JSON: intent, docidentifier/number, edition,
language, process_intent, term, standalone_query, complexity,
query_variants, sub_queries, hypothetical_answer), 1200 max_tokens, 7s/4s
timeouts, warm embedding parallel, conversational route (identity/greeting
— any language), 16k context budget with history compaction (summarized
overflow), exact-match KV answer cache.

### Gaps (G5, G6, G7)
- No cross-turn entity state — each turn re-derives referents from raw
  history text only.
- Cache is exact-text; near-duplicate queries re-pay the whole pipeline.
- No follow-up suggestions; clarifying questions permitted but never
  driven by an explicit ambiguity signal.

### Target
**Understanding v2 output (additive):**
```jsonc
{
  ...existing fields...,
  "entities": [ { "type": "document"|"term"|"edition"|"unit", "value": "R 60", "resolved": "OIML R 60:2017" } ],
  "ambiguity": { "flag": true, "reason": "edition unspecified; R 60 has 2 in-force editions", "clarify": "Which edition — 2000 or 2017?" },
  "follow_ups": [ "What are the accuracy classes?", "How is n_LC limited?" ]
}
```
- **Conversation entity map (D1 per conversation):** entities upserted per
  turn; understanding consumes the map so "the 2017 one / it / that table"
  resolve O(1). Privacy: conversation-scoped, dies with the conversation.
- **Semantic cache:** KV `sc:<quantized-query-embedding> → answer+ts`;
  cosine ≥ 0.96 and same corpus tier → serve with "similar question"
  badge; write-through after generation. Eviction via INDEX_VERSION.
- **Follow-up chips:** rendered from `follow_ups` (API-driven, per Stage-1
  suggestion pattern); logged CTR in telemetry.
- **Clarification flow:** when `ambiguity.flag` and knowledge-intent, ask
  the generated clarify question INSTEAD of answering (one level deep,
  no loops).

---

## Stage 6 — Retrieval accuracy

### Current
Dense (query + variants + HyDE + sub-queries) → RRF fusion → filter-first
+ unfiltered merge → overview penalty / family boost → bge cross-encoder
rerank → in-worker keyword RRF → term/language/edition-recency boosts →
diversity caps → CRAG grade → corrective re-retrieval (one shot).

### Gaps (G8, G9, G10, G3)
- No graph lane; relationship queries ("what references R 60?") depend on
  bibliographic chunks happening to surface.
- No LLM-listwise tier for the final ordering.
- Correction is single-shot, not a loop.
- Lexical recall is post-hoc (Stage 4 fixes the index side).

### Target — retrieval as LANES + CASCADE
```
lanes (parallel, budget-capped):
  dense        q + variants + HyDE + sub-queries        (existing)
  lexical      inverted-index top-200 on key terms       (Stage 4 build)
  graph        entities → D1 graph edges → candidate doc_numbers
               (relaton citation edges + vocab concept relations; PUBLIC
                projection = OIML nodes/edges only, enforced at build)
  table        block=table filtered dense search when value-question
cascade:
  fuse (RRF k=60) → cross-encoder to top-50 → LLM listwise over top-12
  (member/hard queries only, glm-4.7-flash, ~$0.0002/q) → diversity caps
loop (agentic, Workflows "research mode", spend-capped ≤3 iterations):
  retrieve → sufficiency judge (grader model) → re-retrieve with gap
  terms → answer
```
**Graph projection schema (D1):**
```sql
CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, kind TEXT, label TEXT);   -- doc|concept|term
CREATE TABLE graph_edges (src TEXT, dst TEXT, kind TEXT, meta TEXT);
-- kinds: cites|supersedes|part_of|defines|related_to|
--         tested_by|requirement_of (from ModSpec projection)
-- seeded from relaton (cites/supersedes/part_of) + vocab glossarist
-- (defines/related_to); PUBLIC projection excludes ISO labels entirely
```

---

## Stage 7 — Answer formulation

### Current
Data-file system prompt; verbatim normative values required; inline
passage-level citations `[OIML R 60-1:2017 §4.1.2]`; canonical refusal
sentence + redirect; streaming SSE; CRAG + self-RAG reflection (one shot);
feedback buttons; deep links to R2 renderings.

### Gaps (G11, G12, G1)
- Citations are passage-level; no required quote anchor.
- Tables answered from linearized text (Stage 2 fixes the input).
- Single candidate; no sample-and-verify.

### Target — quote-anchor protocol (the normative-corpus trust feature)
System prompt (data file) requires, for every normative claim:
```
…MPE is 0.5e for 0 ≤ m ≤ 5·10³ [3: "the maximum permissible error shall
not exceed 0.5e"]…
```
i.e. `[passage#: "verbatim source phrase ≤12 words"]`. Verification
(evals + optional runtime check): the quoted string is a substring of the
cited passage's text — mechanically checkable, zero LLM cost. Table
answers render the `table` payload as a real table with the cited cells.
**Sample-and-verify lane (hard queries):** 2 candidates, faithfulness +
answer-relevancy judges select; rollout eval-gated.

---

## Stage 8 — Follow-up handling

### Current
Standalone-query rewriting (understanding), structural ≤8-word fold for
warm embed, history compaction (summarized overflow), latest-message
discipline in the prompt.

### Gaps
Covered by Stage 5 targets (entity map, follow-up chips, clarification
flow). Add: **follow-up eval probes** — MTRAG-style multi-turn scripts in
the retrieval eval (turn 2 uses "and for class III?", turn 3 "what about
the 2000 edition?") so conversation quality is measured, not assumed.

---

## Stage 9 — Evaluation and operations

### Current
Golden set (19 answer-level), live e2e (13), retrieval eval hit@5 +
8 paraphrase probes, faithfulness judge, D1 telemetry + spend ledger,
feedback buttons.

### Gaps (G13)
- Missing answer-relevancy + context-precision metrics.
- No derived dashboards (win rates over time, latency percentiles, cache
  hit rate, refusal rate).
- No promotion gate automation (golden threshold check as deploy gate).

### Target
- `tests/eval-suite.mjs`: RAGAS-style battery over golden cases —
  faithfulness ✓, answer relevancy (judge scores answer↔question),
  context precision (judge ranks relevance of each retrieved passage),
  quote-anchor coverage (mechanical). Nightly snapshot to
  `artifacts/eval/`; fail-threshold in CI for the mechanical parts.
- `/v1/admin/stats` extensions: latency p50/p95, cache-hit rate, refusal
  rate, feedback ratios, eval-latest summary (single JSON).
- Promotion gate: `npm run eval:gate` exits non-zero if mechanical
  metrics regress — wired as the deploy pre-step for index-affecting
  changes.

---

## Migration order (dependency-aware)

1. Stage 2 chunk typing + Stage 3 verify (index shape changes first)
2. Stage 1 document registry (D1) — identity SSOT
3. Stage 4 lexical index + `block` metadata index
4. Stage 5 understanding v2 (entities/ambiguity/follow-ups) + semantic cache
5. Stage 6 graph projection + listwise cascade + research mode
6. Stage 7 quote anchors + table rendering + sample-and-verify
7. Stage 9 metric battery + dashboards + gate
Each step ships with its own probes; no step requires the previous step's
deploy to be simultaneous (schemas are additive).


---

## Metanorma as semantic publisher — the forward play

What the toolchain already supports changes the upstream ask
(metanorma/metanorma#592) from "please emit AI-friendly output" to
"please PACKAGE what you already have":

1. **Model serializations are done** — metanorma-document (lutaml-model)
   round-trips semantic XML/YAML/JSON. The missing piece is only a
   curated *node projection* flavor (the schema in this document) so AI
   consumers don't each re-invent their own walk of the model.
2. **Requirements/conformance as data** — ModSpec projection makes every
   "shall" statement addressable (`/req/<class>/<name>`), with conformance
   tests linked. For standards bodies this turns compliance questions
   ("what does R 60-1 require? how is it verified?") from prose retrieval
   into OBJECT retrieval — the single biggest structural win available to
   a standards-domain RAG.
3. **Glossarist + Relaton exports as first-class ingestion lanes** —
   terminology and citation graphs ship WITH the document instead of
   being joined from downstream repos.
4. **The bundle ask:** one document source → human renderings (HTML/PDF)
   AND machine serializations (node projection JSON, ModSpec requirement
   export, Glossarist/Relaton datasets). Metanorma becomes the semantic
   publisher for the AI ecosystem, exactly as it is the rendering
   publisher today.

Our side: ingest v2 (roadmap Phase 2) implements the projection adapter
and the requirement/conformance retrieval lane against this contract.
