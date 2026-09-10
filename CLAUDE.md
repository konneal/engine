# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

Retrieval-augmented generation (RAG) system over OIML publications (~900 documents, ~9.3M words, multilingual: EN/FR/AR/ES/DE/FA/ZH/UK/SR/PL). **Public service.** **Deployment is purely Cloudflare** (user constraint: minimal accounts): Workers (public + internal), Vectorize ×2, D1, KV, R2 ×3, Queues, Workflows (durable research runs), Cron Triggers, Turnstile, AI Gateway. Modal is NOT provisioned — it exists only as a documented fallback if Workers AI catalog gaps prove material on the golden set. The system must be SOTA-grade: hybrid-style retrieval (dense + self-query metadata filters), reranking, citation-grounded answers, graph-augmented retrieval, continuous evaluation.

This repo is the orchestrator: ingestion → enrichment → indexing → serving → evaluation. It is a consumer of sibling repos and owns no source-of-truth content.

## Commands

- `npm install` — install worker dependencies
- `npm run typecheck` — tsc for `worker_public`
- `npm run lint:wrangler` — binding-isolation lint (public worker must never reference internal-tier resources)
- `npm run dev:public` — local dev (needs `npx wrangler login` for remote AI/Vectorize bindings)
- `scripts/bootstrap_cloudflare.sh` — create Vectorize/KV/D1, patch ids into `wrangler.toml`, apply D1 schema, deploy (requires `npx wrangler login`)
- `npm run deploy:public` — deploy `worker_public`
- `npm run site:build` / `npm run site:dev` — build/serve the Astro site on `@oimlsmart/site-shell` (sibling repo `../site-shell`, file: symlink); the worker serves `site/dist` as its assets
- `npm run test:e2e` — live golden suite (13 cases: doc-level, definitions, table values, refusal, meta/identity, long-question, French, filters, auth) against `BASE_URL` (default https://ai.oimlsmart.org) using the API key in `.env` (`KEY=…`)
- `node tests/ui.mjs` — Playwright UI suite against the BUILT site (`npm run site:build` first) with stubbed APIs: ask/stream/citations/sessions/persistence/XSS (also runs in CI)
- Unit suites (plain node, no network): `npm run test:units` — the glob IS the list (13 `.test.ts` suites: stage composition, ChunkMeta↔pydantic contract, session roundtrip, schema-union drift, …). CI's worker job and `scripts/deploy.sh` run the same script
- Serving architecture: retrieval is a stage registry (`workers/worker_public/src/stages/` — contracts in `docs/spec-pipeline.md`; `retrieve()` is composition only; independent lanes prefetch concurrently); HTTP is a route table (`ROUTES` via `workers/shared/router.ts`, dispatched by BOTH workers — inventory in `docs/spec-api.md`); the ask path owns `src/ask.ts` (index.ts is routes + wiring only); every steering number lives in `THRESHOLDS` (`src/config.ts`); the chunk wire type is `workers/shared/chunk.ts` (runtime `toHits` included), kept in sync with `ingest/vector_adapter.py` by the contract test; the session module is `workers/shared/session.ts`; grading vocabulary shared by all runners lives in `tests/grade.mjs`
- `scripts/gates.sh [--golden N --annealment M|--quick]` — the promotion gate as one command (default: golden ×3 + annealment ×6 against production); per-run logs are EVIDENCE under `artifacts/gate-runs/` (durable — /tmp wipes destroyed a completed gate once)
- `.venv/bin/python -m pytest tests/python -q` — the ingest unit suites (language verification + the EN-only exclusion list, issue #72; model-plane repo resolution) — CI runs them in the ingest job
- `.venv/bin/python -m ingest.cli enrich [--limit N --rpm R --concurrency C]` — contextual enrichment driver: batches chunks to the deployed `POST /admin/enrich` (Bearer `ADMIN_TOKEN` from `.env`); resumable via `artifacts/enrich-state.json`; per-chunk contexts KV-cached 30d on the worker so re-runs are free
- Ingest (one-time venv: `python3 -m venv .venv && .venv/bin/pip install -r ingest/requirements.txt`):
  - `.venv/bin/python -m ingest.cli parse` — corpora → `artifacts/chunks.jsonl` + `manifest.json` (clean-beats-dirty precedence; shells flagged)
  - `.venv/bin/python -m ingest.cli embed` — embed via Workers AI, resumable (`artifacts/embeddings.jsonl`)
  - `.venv/bin/python -m ingest.cli upsert` — push vectors + metadata into Vectorize
  - `.venv/bin/python -m ingest.cli probe` — connectivity, embedding dims, sample query
  - The model plane (TODO.ai-platform/05): the CHUNK source is the retrieval-plane export (`scripts/export_retrieval.sh` from the smart packages → `ingest.cli retrieval-plane` → `artifacts/model_chunks.jsonl`, rides embed/upsert); the D1 NODE store comes from `SMART_REPO=… .venv/bin/python -m ingest.cli model-plane` (`--apply` loads D1 `model_nodes`/`model_plane_meta`; `--check` is the FRESHNESS GATE — a package change moves a bundle's `source_hash`, the gate fails, the index re-indexes; CI: the ingest job). Two derivations by design: chunks from the versioned retrieval serialization, nodes from the projection.
  - Index reconciliation (TODO.impl/40): `.venv/bin/python scripts/reconcile_index.py [--apply]` — enumerate the production index, diff against the canonical chunk set, delete strays (upserts never delete).
  - Enrichment replay (2026-09-09): `.venv/bin/python scripts/replay_enrichment.py [--apply]` — REQUIRED after every full index upsert: enrichment lives only in the index/KV, a full upsert overwrites it with raw text (the 2026-09-09 regression: 0% enriched, d29-guide65 failing); the replay re-embeds context+text from the durable record via the binding (zero generation).
  - Unit-asset readability (2026-09-09): `.venv/bin/python scripts/fix_figure_assets.py [--apply]` — figure assets under `/assets/u:*` must be VISION-readable (vector-sourced rasters carry black strokes on transparent alpha; vision endpoints flatten onto black and see nothing). Scans `unit_payloads` URIs, detects black-alpha, re-uploads white-flattened (originals to `artifacts/asset-backups/`).
- Whitepaper (#175): `node scripts/whitepaper_pdf.mjs` builds the academic whitepaper (docs/whitepaper-oiml-smart-ai.html, cim-2027 house style) to screen+print HTML and the PDF served at `/whitepaper.pdf` — rerun after editing the HTML source.
- Personalized memory files (#171): D1 `memories` (member-scoped, ≤10 × 8k), `/api/memories` CRUD, ask-path `memories: [id…]` injection as one bounded note; the selection (with the dataset scope) salts the answer cache (`cacheKeyMaterial`/`scSignature` — never add request-scoped context without salting).
- Secrets: `npx wrangler secret put ADMIN_TOKEN -c workers/worker_public/wrangler.toml` — guards `POST /v1/admin/keys` (API key creation)
- Generated artifacts live in `artifacts/` (gitignored); never commit them
- The vector adapter (`ingest/vector_adapter.py`, contract in `docs/vector-adapter.md`) is the ONLY door from producer chunks to any Vectorize index: pydantic wire schema (registry, size caps, anchor sanity) + target gating (lane corpora structurally cannot enter production — 2026-09-02 incident). Every new producer/upsert path goes through `normalize_chunk(...).upsert(..., target=…)`, never a hand-rolled metadata dict. `/admin/enrich` default mode writes to the production index; callers that only want contexts pass `mode:"context"`.

## Model policy (open-source, cost-first, minimal accounts)

Open-weight Chinese models only; **zero new accounts** — all model serving on
Cloudflare Workers AI (user-confirmed catalog 2026-08-23: glm-5.2,
glm-4.7-flash, qwen3.8-27b, deepseek-v4-flash-0731, deepseek-v4-pro-0813,
kimi-k3 — live but undocumented: $3.00 in / $0.30 cached / $15.00 out per
M, 1M ctx, always-on reasoning; **benched — too expensive, glm-5.2 preferred
everywhere; eval-gated exception only**).
Catalog gates closed with real pricing (2026-08-18 sheet): neurons $0.011/1k,
10k free/day ≈ 380 anon answers. **Two lanes: serving path = cost-first**
(per-query spend compounds); **one-time/rare tasks = quality-first, BEST
model regardless of price** (embedding, contextual enrichment, graph build,
figure captions, golden-set drafting, promotion-gate judging, re-OCR) —
one-time spend is bounded by corpus size (≈$40–100 total) and its quality
persists into every future answer. Pin exact hosted model ids in the router
config:

| Role | Model | Notes |
|------|-------|-------|
| Embeddings (index + query) | `@cf/qwen/qwen3-embedding-0.6b` ($0.012/M, 100+ languages) | same model both sides (mandatory); fallback `@cf/baai/bge-m3` (same price); whole-corpus embed ≈ $0.15 |
| Reranker | `@cf/baai/bge-reranker-base` ($0.003/M) | ≈$0.00003/query; fallback: skip, vector order; GLM listwise rerank for the deep internal pool |
| Standard QA (ALL tiers, default since 2026-08-29) | glm-5.3-flash ($0.15/$0.03-cached/$0.50 per M; 320B/18B active, natively multimodal) | ≈$0.0012/answer — cheaper than the old member model; unified answer model incl. future vision image-parts; understanding stays qwen3-30b-a3b; fallback qwen3-30b-a3b |
| Anon tier / cheap / judge | qwen3-30b-a3b-fp8 ($0.051/$0.335 per M — MoE, 3B active) | the "cheap Qwen"; A/B alternates glm-4.7-flash ($0.06/$0.40), granite-4.0-h-micro ($0.017/$0.112); deepseek-v4-flash is NOT cheap on CF ($0.44/$1.32 — hot-path CRAG grader only, cached $0.014); promotion-gate judge = deepseek-v4-pro (quality-first lane); ≈$0.0003/answer |
| Research / agents | glm-5.2 primary ($1.40/$0.26-cached/$4.40); kimi-k2.6 alternate ($0.95/$0.16/$4.00); deepseek-v4-flash-0731 doc-as-context (1.31M ctx, $0.44/$0.014-cached/$1.32; deepseek-v4-pro-0813 for hard reasoning); kimi-k3 benched ($3/$15 — too expensive) | prompt caching mandatory for dossier loops — cached input 5–15× cheaper |
| Index-time enrichment / graph (quality-first lane) | deepseek-v4-pro-0813 default; **glm-5.2** for hardest slices (kimi-k3 benched — too expensive) | one-time ≈$40–100 total, prompt-cache doc prefixes |
| Figure captions / vision / re-OCR | **z.ai GLM vision (existing account)** — user-preferred over Workers AI qwen vision; GLM-OCR (existing Zhipu account) for re-OCR | cache-first OCR protocol |

Fallback ladder (eval-triggered only): Workers AI model weak for a role →
other Workers AI model → z.ai GLM via AI Gateway (existing key) → only then
provision Modal to self-host. Thinking-mode gotcha: kimi-k3/glm models on
Workers AI cannot disable thinking — use low reasoning effort for
latency-sensitive calls.

## Ecosystem map (all upstreams are READ-ONLY from here)

| Repo | Role | Contents |
|------|------|----------|
| `~/src/mn/mn-samples-oiml/` | clean corpus | 29 hand-curated Metanorma docs (`sources/<id>/document.adoc`) |
| `~/src/oimlsmart/publications-private/` | dirty corpus | 880 OCR-derived docs (`sources/<slug>/{metanorma/,images/,glossarist/,verify/}`, `.pipeline-state.json` per doc) |
| `~/src/relaton/relaton-data-oiml/` | bibliography | 5707 YAML records; GLM-OCR chunk cache (`backfill/cache/`) |
| `~/src/oimlsmart/vocab/` | terminology | 13 Glossarist datasets; `oiml-complete` = 6031 concepts; VIM/VIML editions |
| `~/src/primmel/smartcab-refs/` | internal corpus | 16 ISO/IEC 17xxx (CASCO) standards, Metanorma, multi-edition; **copyrighted, internal-only — never expose to unauthenticated users** |
| `~/src/oimlsmart/smart/` | identity provider + API consumer + the model plane's SSOT | OIML-CS platform (Astro SPA + Hono API); its oimlsmart.org Identity service is RAG's auth front door; role model at `browser/src/auth/roles.ts` (applicant, ia_officer, tl_operator, biml_officer, cs_admin, mc_member, rc_member, executive_secretary, admin, viewer). The primmel packages (`primmel-packages/`) are the Recommendation models' single source of truth; the model plane (TODO.ai-platform/05) consumes their committed projection (`browser/public/data/model-plane/*.json`) — read-only, `SMART_REPO`-declared |

Precedence when the same document exists in both corpora: **clean wins over dirty**. Every chunk must carry provenance (source repo, doc slug, edition, language, quality tier).

## Access control (mandatory)

Two audiences, **two separate Vectorize indexes — isolation is structural, not filter-enforced**:

- `idx_oiml_public` — OIML chunks only (clean + dirty corpora).
- `idx_iso_internal` — ISO/IEC smartcab-refs chunks only.

The public worker holds **no binding, token, or route** to the internal index. Internal retrieval federates both indexes (two queries + RRF merge in `worker_internal`). R2 mirrors the split: public bucket (OIML HTML renderings) and internal bucket (ISO renderings), separate bindings. D1 is shared but public-facing queries filter metadata by scope. KV caches are namespaced per audience. The graph keeps a public projection (OIML nodes and OIML↔OIML edges only; bare citation strings — never ISO titles).

Enforcement belt-and-braces: a CI config lint fails if internal bindings/keys appear in `worker_public` config/env; leakage probes (public-endpoint questions answerable only from ISO content must return "no information") still gate every promotion — they now test implementation bugs, since the architecture cannot leak. Auth: RAG is an OIDC relying party of the estate OP `https://id.oimlsmart.org` (authorization code + PKCE, ES256, RFC 8414 discovery, JWKS; contract snapshot in `docs/identity-service.md` — canonical copy lives in the smart repo; reference RP: `browser/server/auth/oidc.ts`, zero-dep, edge-ready — port it). The ID token is sign-in evidence, not a session: RAG mints its own session cookie; enforcement happens inside `worker_internal` (edge checks are UX, not the gate). No client_credentials on the OP yet — machine callers use RAG-issued API keys. Public DNS: `*.oimlsmart.org` on Cloudflare.

Never write to the upstream repos. Generated artifacts (chunk JSONL, vector indexes, graphs) go to R2/Cloudflare storage, never into git.

## Corpus facts learned from audit

- Dirty corpus: 801 of 880 docs have >1000 words; 19 are empty shells (OCR failures, mostly non-Latin scripts). Filter or flag shells at ingest.
- The `:docidentifier:` in a dirty doc's `document.adoc` header is authoritative over the directory slug (mismatches exist, e.g. `sources/r120-1996-ara/` contains OIML D 117:2003).
- Doctypes: R (Recommendation, 656), D (Document, 84), B (Basic publication, 77), G (Guide, 38), E (Expert report, 15).
- Sections are already split into `metanorma/sections/*.adoc` with clause titles — chunk along these boundaries, not arbitrary token windows.
- Equations are `stem:[...]` (AsciiMath), tables are AsciiDoc tables, images live in `images/extracted/` with `manifest.json`. Treat all three as first-class retrievable objects.

## Expected stack

TypeScript Workers for serving (`worker_public`, `worker_internal`, `workflow_research`); Python for the ingest CLI (runs locally / GitHub Actions; pydantic models). No Modal, no FastAPI, no Postgres — app state in D1, caches in KV, artifacts in R2, vectors in Vectorize ×2. Retrieval: dense + self-query metadata filters (Vectorize has no sparse vectors — metadata filters cover the exact-identifier query class), RRF for cross-index federation in the internal path, Workers AI reranker. Techniques: clause-boundary chunking + contextual enrichment; structural retrieval over the clause tree (propagation, reading-order presentation, same-chain dedup — FABLE/BEAR adaptations, arXiv:2601.18116); section-summary units (depth-1 multi-granularity, `/admin/section`); vocabulary binding (glossary lane: 8.8k concept entries, dense+rerank candidates, answer-model adjudication); edition steering + family-union typed pin; answer contract v2 (verbatim quote anchors, `[[u:…]]` typed objects, deterministic enforcement incl. table-reference); the verdict engine (`src/verdict.ts`: OCL/threshold evaluation of model-plane nodes, server-built verdict blocks, void-with-missing-parameters); provable absence (`/v1/absence`); answer verification (`/v1/verify`); CRAG-style self-correction; RAGAS-style eval with curated golden set. Full mechanism reference: `docs/sota-mechanisms.md`. Rendered HTML in R2 for clause-anchored deep links (OIML docs only — never publish smartcab-refs renderings publicly). MCP servers for agent ecosystem (two servers, one per audience). Auth: OIDC relying party of `https://id.oimlsmart.org`; RAG mints its own sessions and maps estate roles to audiences/features.

## Standards (non-negotiable, ecosystem-wide)

- Never delete source files; never `git add -A` — stage by explicit path and verify `git diff --cached --name-only`.
- Never commit/push to main, never push tags; all changes via PR.
- No AI attribution in commits, PRs, or code.
- Serialization via framework (lutaml-model in Ruby; pydantic in Python) — no hand-rolled `to_h`/`to_json`.
- Ruby `lib/`: autoload only, no `require_relative`. No `double()` in specs. No `send` to private methods, no `instance_variable_get/set`.
- Library code has no side effects: output is explicit, deterministic, written to the consumer's working directory — never into the package/repo source tree.

## Model call-site rules (learned 2026-08-30/31, all from live incidents)

Read the model card FIRST for: reasoning-mode controls and defaults,
recommended sampling, output-budget guidance. Every call site states its
reasoning mode, sampling and a budget the reasoning cannot starve.

- GLM-5 family: `reasoning_effort` defaults to MAX when absent — always
  explicit; budgets ≥3072 or reasoning starves the content.
- Qwen3 thinking mode: temp 0.6 / top_p 0.95 / top_k 20, NEVER greedy
  (repetition loops ate the understanding budget → the 10s/5s nulls).
- DeepSeek-V4: non-think mode severely degraded; keep reasoning on,
  3072+ budgets, temp 1.0 / top_p 1.0.
- Answer generation (glm-5.3-flash): temp 0.6 / top_p 0.95 (parity with
  default on the golden probe, tighter determinism).
- `roleModel(env, role)` reads `<ROLE>_MODEL` wrangler vars — live A/B
  without code changes; always gate a swap with golden ×3.
- Multimodal through the binding (glm-5.3-flash): image parts ride their
  OWN short trailing user message — long passage text + image parts in
  ONE message triggers nondeterministic 8005s that scale with payload
  (probed 2026-09-09); attach only figures the question WANTS (intent or
  the answering clause — a plain definition question gains nothing from
  pixels); strip image parts AND the attach note before handing messages
  to a text-only fallback (a text model answers the note otherwise —
  observed live); the response's `model` field names the primary
  regardless of which model actually generated.
- Workers AI admin getBys: Vectorize getByIds returns EMPTY above ~20
  ids (silent, 200 OK) — the admin route chunks by 20; any direct
  batching must too.
- Catalog watchlist (grep `wrangler ai models list`): qwen3.8-flash-next,
  hosted hy4 — neither available as of 2026-09-01. deepseek-v4.1-flash
  (tech report 2026-09-10: 552B MoE, 8B prefill/16B decode active, 1M
  ctx, KV 890 B/token, native multimodal, agentic scores leapfrog
  v4-flash) — not on the catalog as of 2026-09-10; when it lands, the
  swap candidate is the doc-as-context/research lane, NOT the answer
  model (glm-5.3-flash stays); gate any swap with golden ×3 +
  annealment ×6; its flagged weak spots (sparse retrieval over long
  contexts, SWA state reconstruction at cache-resumption boundaries)
  are exactly our prefix-cache paths, so variance/cached probes must
  cover them before promotion.
- Reasoning-effort frontier (DeepSeek-V4.1-Flash report, Fig. 9): effort
  60–80 recovers most of max accuracy at under half the token cost; the
  last step to 100 costs 1.6–1.8× trajectory length for marginal gain.
  Serving path pins low (latency); one-time quality-first lanes
  (enrichment, gate judging, golden drafting) are where higher effort
  pays — A/B it measured, never assume.

## Deploy & ops automation

- `npm run deploy` (requires `CLOUDFLARE_ACCOUNT_ID` in the environment) → `scripts/deploy.sh`: guards (main == origin/main,
  clean tree, typecheck, unit), site build, INDEX_VERSION auto-bump,
  90s settle, 3-query smoke. NEVER deploy from a stale/diverged main.
- Wire-stage ops without REST tokens: embed+upsert via `/admin/enrich`
  (binding, contexts KV-cached), deletions via wrangler OAuth
  `vectorize delete-vectors`, reads via `/admin/vectors`.
- Answer-cache invalidation after corpus surgery (issue #72): both answer
  caches (exact `a:` + semantic `sc:` in KV) are namespaced by
  INDEX_VERSION + a corpus-generation stamp (`sys:corpus_gen`). After a
  live deletion or re-index, bump it:
  `RAG_PUBLIC_KV=1 .venv/bin/python scripts/invalidate_answer_cache.py` (the CACHE namespace id resolves from the worker's wrangler.toml)
  (old-generation entries miss and TTL out; ~60s KV edge propagation).
- Eval: golden ×3 with witness-span containment (tests/retrieval.mjs);
  `node scripts/variance.mjs` (determinism), `node scripts/feedback-triage.mjs`
  (thumbs-down clustering — hashes only, by privacy design).
