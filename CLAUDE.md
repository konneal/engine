# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The **Konneal engine**: the publisher-agnostic build pipeline and API plane for standards intelligence — retrieval, the answer contract, verdicts, evaluation. A deployment (the reference is oimlsmart/ai, OIML SMART AI) is a ten-line worker entry that injects its profile via `setProfile(PROFILE)` and re-exports the engine worker. **This repo carries no publisher facts** — those live in each deployment's `profile/`. The fixture profile under `profile/` (codec `plain-slug`) exists so every test runs against declared data; `profile2/` exercises a second shape (codegen renders both). Extraction history and architecture: `docs/konneal-extraction-plan.md`; the multi-SDO direction: `docs/multi-sdo-architecture.md`.

## Commands

- `npm install` — install dependencies (workspaces: `workers/*`)
- `npm run typecheck` — tsc for `worker_public`
- `npm run test:units` — the TS suites (plain node, no network; the glob IS the list — stage composition, codecs, citation graph, ports, profile drift, session roundtrip, schema-union, …)
- `.venv/bin/python -m pytest tests/python -q` — the ingest python suites (borrow a deployment's venv or `pip install -r ingest/requirements.txt`)
- `npm run lint:publisher` — **publisher purity**: no publisher strings in `workers/` outside the codec registry (the allowlist ledger lives in the lint script)
- `npm run lint:ports` — **port purity**: provider-typed bindings only inside `ports/` (the migration allowlist tracks the rest)
- `npm run gen:profile` — profile codegen: `profile/*.yaml` → the committed `profile.gen.ts` modules; the drift test fails CI when one side moves without the other
- `npm run build` — esbuild + tsc → `dist/`; **`dist/` is committed and CI's dist-freshness check fails if it drifts from source** — run `npm run build` and commit the dist output with every worker-source change
- `node tests/ui.mjs` — the UI suite against the built fixture site with stubbed APIs
- Deployment commands (`deploy:public`, `deploy`, gates) belong to the DEPLOYMENT repositories — they deploy; the engine ships code

## Architecture

- **Serving = a stage registry** (`workers/worker_public/src/stages/`, contracts in `docs/spec-pipeline.md`): `retrieve()` is composition only; independent lanes prefetch concurrently; `PipelineContext.notes` is the structured-facts channel (the GraphRAG seam — the citation probe writes the per-edition `cites` note through it). HTTP is a route table (`workers/shared/router.ts`; inventory in `docs/spec-api.md`). The ask path owns `src/ask.ts`; `index.ts` is routes + wiring only. Every steering number lives in `THRESHOLDS` (`src/config.ts`).
- **Identifier codecs** (`src/codecs.ts` ↔ `ingest/codecs.py`, kept in lockstep): each publisher's identifier grammar — question scanning, graph node shapes, citation extraction — lives in the codec the profile declares (`plain-slug` floor, `oiml-pubid` reference). The grammars are pubid-shaped on purpose: when pubid-ts lands, they become parser calls behind the same interfaces. Never parse an identifier outside the codec.
- **Ports & adapters**: provider-typed I/O behind the ports (`ModelRunner`, `VectorIndex`, `Kv`, `Blobs`, …); the Cloudflare adapters are the only provider-typed module.
- **The graph**: `ingest/graph.py` builds the D1 projection (registry, families, concepts, `cites` edges extracted from the indexed bibliographies with the codec's citation grammar). Serving reads it through the graph lane and the citation probe.
- **The MCP worker** (`workers/worker_mcp`) exports its OWN `setProfile` — importing the main bundle's would create a second module instance.
- **Prompts are data** (`prompts/*.md` with `{{TOKENS}}` resolved from profile vars): `tests/prompts.test.ts` fails on a token that resolves neither from the profile nor at a call site (an unknown token silently interpolates to empty and deletes instructional text from a live prompt).
- **The vector adapter** (`ingest/vector_adapter.py`, contract in `docs/vector-adapter.md`) is the only door from producer chunks to any index: pydantic wire schema + target gating; the canonical chunk set is declared once in `ingest/config.py`.

## Repo discipline

- All changes via PR; never push to main or tags; no AI attribution; stage by explicit path and verify `git diff --cached --name-only`.
- The deployment repositories keep the operational facts (corpora, model policy, deploys, gates, incidents). When a fact smells like a publisher's, it belongs THERE, behind profile data — here it belongs behind a codec, a port, or a profile token.
