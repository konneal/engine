# Ingest Architecture — Object Input Interface → RAG Data Preprocessor → RAG Worker

*Formalizes the pipeline shape (2026-08-27). Companion pieces:
`SOTA-STAGE-SPECS.md` (schemas), `METANORMA-AI-SERIALIZATION.md` (upstream
serialization contract), `ROADMAP-SOTA.md` (phasing).*

---

## The principle: facts in source data, derivations in the preprocessor

The relaton audit made this concrete. Relaton's `status` FIELD lies in 58
records (claims in-force while carrying a successor edge) — because it is a
**derived fact stored as data**, the classic copy-drift bug. The
preprocessor therefore DERIVES status from successor edges and ignores the
field; nothing needed "fixing" for serving to be correct.

What derivation cannot invent: **missing edges**. 36 of 224 families have no
active edition because a successor edge was never recorded (e.g. `B 18:2016`
and `B 18:2017` both terminal). Those are genuine upstream gaps — they must
be fixed in relaton-data-oiml; the preprocessor's job is to SURFACE them
(the registry's no-active families are the worklist), not hide them.

| Data problem | Fix where | Mechanism |
|---|---|---|
| Status field contradicts edges (58) | nowhere — derive | preprocessor: `derived_status` |
| Language instances carry primaries | nowhere — collapse | preprocessor: canonical-id dedup |
| Non-publication records (Bulletins) | nowhere — filter | preprocessor: series filter |
| Missing successor edges (36 families) | **relaton-data-oiml** | registry worklist → upstream PRs |
| Wrong/missing citation edges | **relaton-data-oiml** | graph build report → upstream PRs |

The loop: preprocessor emits a data-quality report every build; the report
drives upstream fixes; upstream fixes flow back on the next build. Data
gets better because serving keeps score, not because anyone audits YAML by
hand.

## The three layers

```
┌──────────────────────────────────────────────────────────────────┐
│ OBJECT INPUT INTERFACE (OII)                                     │
│   The typed object contract. Four NATIVE object systems, each    │
│   serialized from its own lutaml-model gem — never renderings:   │
│     • Metanorma  — document content model  (metanorma-document)  │
│     • Relaton    — bibliographic records   (relaton)             │
│     • Glossarist — terminology concepts    (glossarist)          │
│     • PubID      — canonical identifiers   (pubid)               │
│   Contract: the AI-serialization node projection (documents +     │
│   typed nodes + edges), schema_versioned, validated at entry.     │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ RAG DATA PREPROCESSOR (RDP) — ingest/*, invariant-gated          │
│   identity      pubid-canonical DocumentRecord → D1 registry     │
│                 (derived status, active flags — the SSOT)         │
│   structure     typed nodes → ChunkRecordV2 (per block type)      │
│   derivation    registry + graph projection (relaton edges +      │
│                 glossarist defines edges)                         │
│   enrichment    contextual contexts (quality-first lane, KV-      │
│                 cached, content-hash invalidated)                 │
│   embedding     per-type embed_input → Vectorize (public/internal │
│                 split — isolation is structural)                  │
│   verification  invariants per stage + data-quality report →      │
│                 upstream worklist                                 │
│   orchestration INDEX_VERSION bump → cache flush protocol         │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│ RAG WORKERS — serving only, never parse source data              │
│   rag-public   ask/search pipeline + registry notes + graph lane  │
│   rag-internal ISO federation (isolation-enforced)                │
│   rag-mcp      MCP tools for the agent ecosystem                  │
│   They consume: Vectorize + D1 (registry, graph) + KV (caches)    │
└──────────────────────────────────────────────────────────────────┘
```

## Current state vs the target

| Component | State |
|---|---|
| OII | de-facto: parse.py (HTML-first) + graph.py (relaton/glossarist). Target: consume the four native object serializations; the AI-serialization proposal (metanorma#592) is the upstream contract |
| Identity SSOT | ✅ documents registry in D1 (derived status, active flags, supersession chains) |
| Registry serving | ✅ edition notes injected into doc-scoped asks; `GET /api/documents?family=` public API |
| Graph projection | ✅ 7,128 nodes / 6,486 edges in D1; query lane live (defined_terms → defines → candidates) |
| Chunking | prose-only today; ChunkRecordV2 typed blocks = next build (tables/equations/requirements) |
| Enrichment | ✅ 99.4% corpus, KV-cached, content-hash invalidation designed |
| Verification | ad-hoc (build counts); the invariant-gated VERIFY stage + data-quality report = next build |
| Orchestration | manual commands today; one-command pipeline (`ingest run --doc X`) when the above land |

## PubID as the identity backbone

Node ids, registry keys, and chunk metadata all key on the canonical
identifier (`OIML R 60-1:2021`). Today graph.py normalizes identifiers with
its own regex; the target is the **pubid** gem's parser/generator as the
single authority (parse any spelling → canonical form → round-trip), so
`R60`, `OIML R60:2021 (E)`, and `r 60-1` all collapse to one identity
before they touch the registry. This is also an upstream piece of the
AI-serialization bundle: identifiers in the projection should BE pubid
objects serialized.
