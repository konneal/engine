# OIML RAG Architecture — 2026-08-24

The complete serving pipeline, layer by layer. Every technique is
grounded in 2025/2026 research and running in production at
**ai.oimlsmart.org**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER (browser / API)                         │
│  chat UI (sessions, fork, edit, export, markdown copy, globe)       │
│  ↓ SSE (stream:true, stop, prev, history[8])                        │
├─────────────────────────────────────────────────────────────────────┤
│                        WORKER (rag-public)                          │
│                                                                     │
│  ┌─ 1. QUERY UNDERSTANDING (LLM) ─────────────────────────────────┐ │
│  │  qwen3-30b-a3b → strict JSON:                                   │ │
│  │  · docidentifier/docnumber  (any phrasing: "r60", "R 60-3")    │ │
│  │  · process_intent  (certify/apply → B-series, not R-series)    │ │
│  │  · term  ("what is a load cell" → "load cell")                 │ │
│  │  · standalone_query  (follow-ups folded with context)          │ │
│  │  · complexity  (simple vs complex → adaptive depth)            │ │
│  │  · query_variants[2-3]  (alternative phrasings for fusion)    │ │
│  │  · sub_queries[2-4]  (decomposition for complex questions)     │ │
│  │  UNISON with deterministic regexes (union, not either-or)     │ │
│  │  3.5s timeout + 1 retry; failure → vanilla retrieval           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 2. MULTI-QUERY RAG-FUSION ────────────────────────────────────┐ │
│  │  Primary query + each query_variant → own embedding            │ │
│  │  Each → Vectorize query (topK=50, metadata-filtered)          │ │
│  │  All rankings → Reciprocal Rank Fusion (k=60)                  │ │
│  │  Ref: RAG-Fusion paper; arXiv 2604.01733 (hybrid+RRF > alone) │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 3. MULTI-HOP DECOMPOSITION (complex only) ────────────────────┐ │
│  │  Each sub_query → own embedding + Vectorize (topK=15)          │ │
│  │  Results merged as complementary perspectives (union, 0.8×)   │ │
│  │  Ref: Agent-Orchestrated Adaptive RAG (arXiv 2606.05658)      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 4. OVERVIEW PENALTY + FAMILY BOOST ───────────────────────────┐ │
│  │  · Overview chunks ×0.85 (boilerplate drowns clause content)  │ │
│  │  · Family chunks → top (multi-part structure: "R 60 = 3       │ │
│  │    parts + 1 annex") when doc-scoped query                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 5. CROSS-ENCODER RERANKING ───────────────────────────────────┐ │
│  │  bge-reranker-base over all candidates                          │ │
│  │  Catches semantic relevance dense embeddings miss              │ │
│  │  Retry ×2 on transient failure; vector order as fallback       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 6. HYBRID SEARCH (BM25 + Dense + RRF) ────────────────────────┐ │
│  │  Keyword (lexical) scoring alongside rerank ranking            │ │
│  │  RRF fusion (k=60) — catches exact terms ("n_LC", "R 60-3")   │ │
│  │  Ref: arXiv 2604.01733; Denser.ai (RRF k=60 default)          │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 7. TERM BOOST + LANGUAGE NUDGE + EDITION RECENCY ─────────────┐ │
│  │  · Exact term match (clause_title/body starts with term) →    │ │
│  │    decisive boost (definition questions)                       │ │
│  │  · Query language → prefer matching chunks (scaled to spread) │ │
│  │  · Edition recency → tie-break (newer > older, scaled)        │ │
│  │  All boosts scaled to observed score spread                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 8. DIVERSITY (per-publication caps) ──────────────────────────┐ │
│  │  · Overview: max 2 globally (6 for doc-scoped queries)        │ │
│  │  · Clause: max 2 per docidentifier|language (3 for filtered)  │ │
│  │  · Family chunks bypass (always included when relevant)       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 9. CRAG GRADER ───────────────────────────────────────────────┐ │
│  │  deepseek-v4-flash grades passages good/weak/bad               │ │
│  │  · good → generate                                             │ │
│  │  · weak → ONE corrective re-retrieval (doc ident made          │ │
│  │    explicit); accepted only on strictly better grade           │ │
│  │  · bad → strict generation (refuses honestly)                  │ │
│  │  Ref: CRAG paper (arXiv 2401.15884)                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 10. GENERATION ───────────────────────────────────────────────┐ │
│  │  Anon: qwen3-30b-a3b-fp8 | Member: qwen3.8-27b                │ │
│  │  Streaming SSE (3072 max_tokens, reasoning_effort: low)        │ │
│  │  History turns as messages + retrieval note for process intent│ │
│  │  Strict grounding prompt + mandatory process-answer rule      │ │
│  │  Citations sorted: in-force → unknown → superseded/withdrawn  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 11. SELF-RAG REFLECTION ──────────────────────────────────────┐ │
│  │  Model critiques: is every claim grounded in the passages?     │ │
│  │  If not → re-retrieve targeting missing info → regenerate     │ │
│  │  (max one retry; better-grounded answer wins)                  │ │
│  │  Ref: selfrag.github.io; arXiv 2606.05658 (bounded reflection) │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 12. ANSWER CACHE (KV) ────────────────────────────────────────┐ │
│  │  Keyed on INDEX_VERSION + query + lang                         │ │
│  │  · Cache hit → SSE stream (must speak SSE)                    │ │
│  │  · Regenerate (fresh=true) → skip cache read                   │ │
│  │  · Contextual follow-ups → skip cache entirely                 │ │
│  │  INDEX_VERSION bumped on any retrieval/logic change            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        INDEX PIPELINE (ingest)                       │
│                                                                     │
│  ┌─ Source Corpora ────────────────────────────────────────────────┐│
│  │  Clean: mn-samples-oiml (29 curated Metanorma collections)     ││
│  │  Dirty: publications-private (880 OCR-derived docs)            ││
│  │  ISO: smartcab-refs (16 ISO/IEC, internal-only, pending)      ││
│  │  Precedence: clean wins over dirty on overlap                 ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Extraction ────────────────────────────────────────────────────┐│
│  │  HTML-first: BeautifulSoup over compiled Metanorma HTML        ││
│  │  · Rendered tables (caption + rows)                            ││
│  │  · Clause-number anchors from heading text                     ││
│  │  · Literal-tag stripping (OCR `<td>` artifacts)               ││
│  │  · GUID anchor dropping (machine-generated ids)               ││
│  │  · collection.yml manifest as identity authority               ││
│  │  English-only (user directive; language detection from        ││
│  │  slug suffixes + adoc attrs)                                  ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Family Chunks ─────────────────────────────────────────────────┐│
│  │  47 synthetic chunks encoding multi-part structure             ││
│  │  ("OIML R 60 comprises 3 parts and 1 annex")                  ││
│  │  Deterministic IDs (content-hashed for re-embedding on        ││
│  │  text change)                                                 ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Status Enrichment ─────────────────────────────────────────────┐│
│  │  relaton-data-oiml (5,707 YAML records) joined at ingest       ││
│  │  · status: in-force / superseded / withdrawn / joint          ││
│  │  · superseded_by: successor identifier                        ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Contextual EnrichMENT (running) ───────────────────────────────┐│
│  │  Anthropic contextual retrieval technique                      ││
│  │  qwen3-30b generates 1-2 sentence context per chunk            ││
│  │  Prepended before embedding (35-49% failure reduction)        ││
│  │  42k chunks, ~$1.30 one-time cost                             ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Embedding + Indexing ──────────────────────────────────────────┐│
│  │  @cf/qwen/qwen3-embedding-0.6b (1024-dim, 100+ languages)     ││
│  │  → Vectorize idx_oiml_public_v2 (cosine, 42k vectors)        ││
│  │  Metadata indexes: doctype, doc_number, edition, language     ││
│  │  Resumable embed (25/batch, per-item fallback)               ││
│  │  Resumable upsert (batch cursor, idempotent)                  ││
│  │  Orphan deletion (stale IDs purged on re-index)              ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        EVALUATION                                   │
│                                                                     │
│  ┌─ Golden Set (19 cases) ────────────────────────────────────────┐│
│  │  Doc-level, definitions, table values, edition filters,        ││
│  │  multilingual, refusals, leakage probes, process intent,      ││
│  │  family structure, test report forms                           ││
│  │  npm run test:golden (90% threshold, exit 1 on regression)   ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ Faithfulness (RAGAS-style) ────────────────────────────────────┐│
│  │  LLM-as-judge: every claim grounded in passages? (0-1)       ││
│  │  Reported per case + averaged in eval-report.json             ││
│  │  Ref: docs.ragas.io faithfulness metric                       ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ Live E2E (11 cases) ───────────────────────────────────────────┐│
│  │  Health, ask quality, citations, refusals, auth, quotas       ││
│  │  tests/e2e.mjs                                                  ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ Browser E2E ────────────────────────────────────────────────────┐│
│  │  Playwright: layout, sidebar, chips, globe spinner, live ask  ││
│  │  tests/browser.mjs                                              ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ UI (jsdom, 35 checks) ─────────────────────────────────────────┐│
│  │  Chat bundle in jsdom: sessions CRUD, XSS safety, markdown,   ││
│  │  fork, edit, export, regenerate, refusal                      ││
│  │  tests/ui.mjs                                                   ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        AUTH & TIERS                                 │
│                                                                     │
│  · OIDC RP on id.oimlsmart.org (authorization code + PKCE,        │
│    ES256 via JWKS, RFC 8414 discovery)                             │
│  · RAG-minted HMAC session cookie (7-day, sliding renewal)        │
│  · Anon: 20/day per IP (KV counter)                                │
│  · Member: 300/day, qwen3.8-27b model                              │
│  · API key: per-key limits, D1-backed                              │
│  · Operator IP exemption (env + KV override)                       │
│  · Role-gated datasets panel (ISO corpus: mc_member, etc.)        │
│  · Conversations D1 API (member-only, sub-keyed)                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        TECHNIQUE PROVENANCE                         │
│                                                                     │
│  ┌────────────────────────────┬───────────────────────────────────┐│
│  │ Technique                   │ Source                            ││
│  ├────────────────────────────┼───────────────────────────────────┤│
│  │ Query understanding (LLM)   │ Agentic RAG survey (2501.09136) ││
│  │ Multi-query RAG-Fusion      │ RAG-Fusion paper (Semantic      ││
│  │                             │ Scholar b4d1da74)                ││
│  │ Hybrid search (BM25+RRF)    │ arXiv 2604.01733; Denser.ai     ││
│  │ Cross-encoder reranking     │ Standard (bge-reranker-base)     ││
│  │ CRAG corrective grading     │ arXiv 2401.15884                 ││
│  │ Self-RAG reflection         │ selfrag.github.io                ││
│  │ Adaptive decomposition      │ arXiv 2606.05658                 ││
│  │ Contextual enrichment       │ anthropic.com/engineering/      ││
│  │                             │ contextual-retrieval              ││
│  │ Late chunking (alternative) │ arXiv 2409.04701                 ││
│  │ RAGAS faithfulness          │ docs.ragas.io                    ││
│  │ Family chunks               │ novel (metanorma/metanorma#592) ││
│  │ Publication status marking  │ novel (relaton join at ingest)  ││
│  └────────────────────────────┴───────────────────────────────────┘│
│                                                                     │
│                        NOT YET IMPLEMENTED                          │
│                                                                     │
│  · GraphRAG (knowledge graph over terms/documents) — vocab repo    │
│    has 6,031 concepts; relaton has 5,707 relations                │
│  · HyDE (hypothetical document embeddings) — query→mock doc→embed │
│  · FLARE (forward-looking active retrieval) — predict next        │
│    sentence to anticipate retrieval needs                         │
│  · Speculative RAG (parallel draft generation)                    │
│  · ISO internal tier (idx_iso_internal created but empty;         │
│    worker_internal federation pending)                            │
│  · Turnstile/WAF (needs dashboard sitekey)                        │
│  · Citation deep links to document renderings (R2)                │
│  · Shareable conversation permalinks                              │
└─────────────────────────────────────────────────────────────────────┘
```
