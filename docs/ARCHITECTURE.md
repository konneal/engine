# OIML RAG Architecture — 2026-08-26

The complete serving pipeline, layer by layer. Every technique is
grounded in 2025/2026 research and running in production at
**ai.oimlsmart.org**. The layers below map 1:1 onto the stage registry
(`workers/worker_public/src/stages/` — per-stage contracts, guards and
failure modes in `docs/spec-pipeline.md`; the HTTP surface in
`docs/spec-api.md`).

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER (browser / API)                         │
│  chat UI — Vue islands (Astro 7/Vite 8/Tailwind 4): sessions,      │
│  fork, edit, export, markdown copy, globe spinner; suggestions +   │
│  datasets panel render the API response verbatim (no hardcoded     │
│  client content)                                                    │
│  ↓ SSE (stream:true, stop, prev, history[20])                       │
├─────────────────────────────────────────────────────────────────────┤
│                        WORKER (rag-public)                          │
│                                                                     │
│  ┌─ 0. CONVERSATIONAL ROUTE (LLM-decided) ────────────────────────┐ │
│  │  understanding.intent: conversational | knowledge               │ │
│  │  · greetings, identity, capability, small talk (ANY language)  │ │
│  │    → answered directly from the DATASETS catalog facts         │ │
│  │    (prompts/conversational.md), no retrieval, never refused    │ │
│  │  · off-topic SUBJECT questions are knowledge (honest refusal   │ │
│  │    + redirect) — "conversational" never means off-topic        │ │
│  │  · asymmetric default: null/doubt → knowledge path             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌─ 1. QUERY UNDERSTANDING (LLM) ─────────────────────────────────┐ │
│  │  qwen3-30b-a3b → strict JSON (prompts/understanding.md):       │ │
│  │  · intent (see layer 0)  · docidentifier/docnumber             │ │
│  │  · process_intent  (certify/apply → B-series, not R-series)    │ │
│  │  · term  ("what is a load cell" → "load cell")                 │ │
│  │  · standalone_query  (follow-ups folded with context)          │ │
│  │  · complexity  (simple vs complex → adaptive depth)            │ │
│  │  · query_variants[2-3]  (alternative phrasings for fusion)    │ │
│  │  · sub_queries[2-4]  (decomposition for complex questions)     │ │
│  │  · hypothetical_answer  (→ HyDE embedding)                     │ │
│  │  UNISON with deterministic regexes (union, not either-or)     │ │
│  │  1200 max_tokens (reasoning shares the budget), fresh call     │ │
│  │  per retry, per-attempt timeouts 7s/4s; failure → vanilla      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  │  Concurrently: the folded query is embedded while understanding │
│  │  runs (warm embedding) — reused whenever the final retrieval    │
│  │  query is unchanged; understand→embed collapses to max()        │ │
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
│  │  System prompt is DATA (prompts/system.md, {{PLACEHOLDERS}}   │ │
│  │  filled from code; per-corpus notes travel with the DATASETS  │ │
│  │  catalog entry)                                                 │ │
│  │  CONTEXT BUDGET (16k tokens est., CJK/Arabic-aware):           │ │
│  │  · history 30% slice, newest-first, turns clipped 600 tok     │ │
│  │  · overflow turns SUMMARIZED into a continuity block          │ │
│  │    (prompts/summarize.md) — never silently dropped            │ │
│  │  · passages fill the rest, best-ranked first, 900 tok/chunk   │ │
│  │  · citations built from passages actually included            │ │
│  │  Streaming SSE (3072 max_tokens, reasoning_effort: low)        │ │
│  │  Strict grounding + mandatory process-answer rule; refusals   │ │
│  │  canonicalized to the exact contract sentence (model           │ │
│  │  paraphrases are normalized server-side)                       │ │
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
│  │  · Refusals are NEVER cached (they describe the moment, not    │ │
│  │    the question — a cached refusal poisons retries)            │ │
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
│  ┌─ Contextual Enrichment (RUNNING over 31k chunks) ───────────────┐│
│  │  Anthropic contextual retrieval technique                      ││
│  │  POST /admin/enrich (Bearer ADMIN_TOKEN): deepseek-v4-pro      ││
│  │  writes a 1-sentence situating context per chunk              ││
│  │  (prompts/enrichment.md; 1600 max_tokens — reasoning          ││
│  │  models starve below that), KV-cached 30d per chunk id;       ││
│  │  context+text re-embedded and upserted in place (ctx flag)    ││
│  │  Driver: ingest/enrich.py — paced (--rpm), rate-aware         ││
│  │  backoff on Workers AI 3021s, resumable state file;           ││
│  │  ~$0.0015/chunk → ≈$50 one-time (quality-first lane)          ││
│  └────────────────────────────────────────────────────────────────┘│
│                              ↓                                      │
│  ┌─ Embedding + Indexing ──────────────────────────────────────────┐│
│  │  @cf/qwen/qwen3-embedding-0.6b (1024-dim, 100+ languages)     ││
│  │  → Vectorize idx_oiml_public_v2 (cosine, 31k English vectors) ││
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
│  ┌─ Live E2E (13 cases) ───────────────────────────────────────────┐│
│  │  Health, ask quality, citations, refusals + redirect, meta     ││
│  │  turns (EN/FR/DE), 200-word questions, French, auth, quotas   ││
│  │  tests/e2e.mjs                                                  ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ Retrieval eval (hit@5) ─────────────────────────────────────────┐│
│  │  Golden cases + 8 vocabulary-mismatch PARAPHRASE probes        ││
│  │  (the contextual-enrichment failure mode) via /v1/search;     ││
│  │  snapshots to artifacts/eval/ for before/after lift          ││
│  │  tests/retrieval.mjs                                            ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ UI (Playwright, 30 checks, runs in CI) ─────────────────────────┐│
│  │  Real Chromium over the built site with stubbed APIs (SSE      ││
│  │  included): ask/stream/citations/superseded badges/sessions   ││
│  │  CRUD/filter/persistence/XSS safety. tests/ui.mjs; CI also    ││
│  │  builds the site for real (site-shell checked out)            ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌─ Browser E2E ────────────────────────────────────────────────────┐│
│  │  Production layout + console-error probe. tests/browser.mjs   ││
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
│  · FLARE (forward-looking active retrieval) — predict next        │
│    sentence to anticipate retrieval needs                         │
│  · Speculative RAG (parallel draft generation)                    │
│  · Turnstile/WAF (needs dashboard sitekey)                        │
│                                                                     │
│  Shipped since the 08-24 revision: HyDE (hypothetical-answer       │
│  embedding via understanding), ISO internal tier + federated       │
│  retrieval (worker_internal /retrieve + RRF), citation deep        │
│  links (R2 renderings), shareable permalinks, contextual           │
│  enrichment (running), conversational routing, context budget      │
│  + compaction, prompts-as-data, CI with real site build +          │
│  Playwright UI suite, retrieval eval harness                       │
└─────────────────────────────────────────────────────────────────────┘
```


## 2026-09 additions (delta over the 2026-08-26 map)

- **Multimodal generation**: figure units among the used passages attach
  their R2 pixels to the glm-5.3-flash call (`attachFigureImages`) — the
  model reads labels that exist only in the image. Users can attach a
  photo (`image` data URL on /v1/ask, validated, 6MB) — text still drives
  retrieval; image asks bypass both caches.
- **Edition steering**: family-relative demotion of superseded editions
  (cross-publication recency kept); edition pins corroborated by the
  corpus (<3 chunks → drop to doc-only). Fixed superseded-citation drift.
- **Citation labels**: model-facing passage headers and UI chips strip
  OIML language markers, dedupe editions, never show UUID anchors.
- **Lexical lane carries unit identity** (chunks.unit_id/block) — typed
  chunks arriving via BM25 keep their [[u:…]] contract.
- **Research loop**: keep-recent-10 context folding (older evidence as
  digests) + per-round focus folding.
- **Witness-span eval**: a hit requires ≥75% containment of the golden
  answer span (ETSI protocol); graph-lane probes.
- **Pipeline**: unit-level langid tags bilingual annexes; typed tables in
  the lexical lane; `fts --incremental`; per-doc ingest resilience.
