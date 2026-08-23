# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

Retrieval-augmented generation (RAG) system over OIML publications (~900 documents, ~9.3M words, multilingual: EN/FR/AR/ES/DE/FA/ZH/UK/SR/PL). **Public service.** **Deployment is purely Cloudflare** (user constraint: minimal accounts): Workers (public + internal), Vectorize ×2, D1, KV, R2 ×3, Queues, Workflows (durable research runs), Cron Triggers, Turnstile, AI Gateway. Modal is NOT provisioned — it exists only as a documented fallback if Workers AI catalog gaps prove material on the golden set. The system must be SOTA-grade: hybrid-style retrieval (dense + self-query metadata filters), reranking, citation-grounded answers, graph-augmented retrieval, continuous evaluation.

This repo is the orchestrator: ingestion → enrichment → indexing → serving → evaluation. It is a consumer of sibling repos and owns no source-of-truth content.

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
| Standard QA (members) | qwen3.8-27b ($0.45/$3.20 per M) | ≈$0.004/answer; thinking off/low for latency |
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
| `~/src/oimlsmart/smart/` | identity provider + API consumer | OIML-CS platform (Astro SPA + Hono API); its oimlsmart.org Identity service is RAG's auth front door; role model at `browser/src/auth/roles.ts` (applicant, ia_officer, tl_operator, biml_officer, cs_admin, mc_member, rc_member, executive_secretary, admin, viewer) |

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

TypeScript Workers for serving (`worker_public`, `worker_internal`, `workflow_research`); Python for the ingest CLI (runs locally / GitHub Actions; pydantic models). No Modal, no FastAPI, no Postgres — app state in D1, caches in KV, artifacts in R2, vectors in Vectorize ×2. Retrieval: dense + self-query metadata filters (Vectorize has no sparse vectors — metadata filters cover the exact-identifier query class), RRF for cross-index federation in the internal path, Workers AI reranker. Techniques: clause-boundary chunking + GLM contextual enrichment; doc-as-context via GLM-5.3 long context; CRAG-style self-correction; RAGAS eval with curated golden set. Rendered HTML in R2 for clause-anchored deep links (OIML docs only — never publish smartcab-refs renderings publicly). MCP servers for agent ecosystem (two servers, one per audience). Auth: OIDC relying party of `https://id.oimlsmart.org`; RAG mints its own sessions and maps estate roles to audiences/features.

## Standards (non-negotiable, ecosystem-wide)

- Never delete source files; never `git add -A` — stage by explicit path and verify `git diff --cached --name-only`.
- Never commit/push to main, never push tags; all changes via PR.
- No AI attribution in commits, PRs, or code.
- Serialization via framework (lutaml-model in Ruby; pydantic in Python) — no hand-rolled `to_h`/`to_json`.
- Ruby `lib/`: autoload only, no `require_relative`. No `double()` in specs. No `send` to private methods, no `instance_variable_get/set`.
- Library code has no side effects: output is explicit, deterministic, written to the consumer's working directory — never into the package/repo source tree.
