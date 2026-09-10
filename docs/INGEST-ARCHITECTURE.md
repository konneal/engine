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
| Enrichment | ✅ 98.7% corpus (the residual ~400 are persistent empty enrichments), KV-cached, replayed from the durable record after full restores |
| Verification | unit suites + contract tests in CI (`npm run test:units`, pydantic↔TS wire contract, schema-union drift); the data-quality report loop = next build |
| Orchestration | manual commands today; one-command pipeline (`ingest run --doc X`) when the above land |

## Corpus operations (the wire loop, as of 2026-09-08)

```
parse            corpora → artifacts/chunks.jsonl (identifiers sanitized,
                 placeholders never win — language markers and :0000/:XXXX
                 fall to the slug-derived identity)
retrieval-plane  primmel export → artifacts/model_retrieval_chunks.jsonl
                 (retrieval text/facets); the projection derives
                 artifacts/model_typed_chunks.jsonl (the ONLY unit_id/
                 block source) — separate files: one shared name had the
                 two derivations overwriting each other
embed            content-aware resume: artifacts/embed_text_hashes.json
                 (id → text hash) — changed text re-embeds, untouched ids
                 never do (model chunk ids are content-independent hashes;
                 id-keyed resume alone would pair stale vectors with fresh
                 metadata)
upsert           the internal worker's /admin/sync binding route
                 (rag-internal.<account>.workers.dev — no REST token
                 needed); the CLI's REST path defaults to the production
                 index idx_oiml_public_v2
enrich-replay    scripts/replay_enrichment.py [--apply] — REQUIRED after
                 every full upsert: enrichment lives only in the index
                 (and the KV context cache), so a full upsert overwrites
                 it with raw text; the replay re-embeds context+text from
                 the durable record (artifacts/enriched-contexts.jsonl)
                 via the binding — zero model generation, ≈$0.30
reconcile        scripts/reconcile_index.py — enumerate the index (wrangler
                 list-vectors), diff against the canonical chunk set
                 (parse + retrieval-plane + projection — three
                 derivations), delete strays (--apply). Upserts never
                 delete; this closes the loop.
cache            scripts/invalidate_answer_cache.py (or wrangler kv put
                 sys:corpus_gen) after any corpus surgery
assets           scripts/fix_figure_assets.py [--apply] — unit assets must
                 stay vision-readable (black-on-transparent rasters read
                 as solid black after alpha flattening); detects and
                 re-uploads white-flattened
graph            ingest.cli graph (build) + graph --corpus apply (D1,
                 wrangler; absolute --file path)
gates            scripts/gates.sh — golden ×N + annealment ×M
```

The vector adapter (`ingest/vector_adapter.py`, contract in
`docs/vector-adapter.md`) remains the ONLY door from any producer to any
index: wire schema + target gating.

## PubID as the identity backbone

Node ids, registry keys, and chunk metadata all key on the canonical
identifier (`OIML R 60-1:2021`). Today graph.py normalizes identifiers with
its own regex; the target is the **pubid** gem's parser/generator as the
single authority (parse any spelling → canonical form → round-trip), so
`R60`, `OIML R60:2021 (E)`, and `r 60-1` all collapse to one identity
before they touch the registry. This is also an upstream piece of the
AI-serialization bundle: identifiers in the projection should BE pubid
objects serialized.
