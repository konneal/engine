# The Konneal extraction plan — packages, phases, end-state

> Status: PLAN v3 (2026-09-13) — the boundary is redrawn: **Konneal is
> the backend** — the build pipeline and the API plane — and nothing
> else. The user plane (interface, site shell, articles, branding)
> belongs wholly to the publisher. The shareable surface between them
> is the documented API plus one small package: `@konneal/client`, the
> API types, the streaming client and the contract-bound renderers
> (typed blocks, citations, the in-context document pane). v3 keeps the
> v2 guarantees — content build first-class (§2.1), real customization
> (§2.2, now by ownership rather than theming), publisher-owned
> Cloudflare topology (§2.3) — and simplifies the extraction
> accordingly. Extends docs/multi-sdo-architecture.md §7 (whose
> step 1, the profile extraction, is shipped) into the full package
> topology and the phased extraction. The discipline is the one this
> codebase already keeps: every phase lands with zero behavior change,
> the drift and contract tests green, and the promotion gates passing
> against production.

## 1. The principle that shapes everything

Two facts decide the package boundaries:

1. **The wire contract is two-sided and must never split.** The chunk
   wire type (`workers/shared/chunk.ts`) and the producer-side adapter
   (`ingest/vector_adapter.py`) are two expressions of one contract,
   held together today by a contract test. They live or break together,
   so the serving workers and the ingest CLI ship from ONE repository,
   versioned in lockstep.
2. **A deployment is configuration, branding and content — nothing
   else.** The end-state of `oimlsmart/ai` (the OIML deployment) is a
   profile, a theme, article content, deployment config, and pinned
   references to the content that already lives in its own repositories
   (the corpora, the bibliography, the terminology, the models). "Data
   elsewhere" is already true at the content level; the extraction
   finishes the job at the code level.

## 2. The package topology

```
konneal/engine                      (the monorepo — one version train)
├── packages/engine-workers/       @konneal/engine      (npm)
│     routes table, ask pipeline, stages, verdict engine, absence,
│     verify, research, auth relying-party, quota, admin ops
├── packages/client/               @konneal/client      (npm)
│     the API types, the SSE client, and the contract-bound
│     renderers (typed blocks, citations, the document pane)
├── packages/profile-schema/       @konneal/profile     (npm)
│     the profile schema, codegen, drift guard
├── ingest/                        konneal-ingest       (PyPI)
│     parse/chunk/embed/upsert/enrich/replay/reconcile/restore +
│     the wire adapter (reads profile/*.yaml directly)
├── harness/                                            (in-repo tooling)
│     the eval runners (grade/golden/annealment/variance/ui) —
│     content-neutral; suites come from a profile
└── docs/                                               
      spec-pipeline, spec-api, INGEST-ARCHITECTURE, sota-mechanisms,
      multi-sdo-architecture

konneal/konneal.github.io           the product site (exists)
konneal/create-publisher            template repo (later, phase D):
                                   npm create @konneal/publisher —
                                   profile skeleton + wrangler + CI

oimlsmart/ai                        becomes publisher-oiml (reference)
├── profile/        publisher.yaml, datasets.yaml, corpora.yaml,
│                   sources.yaml (pinned refs to the content repos),
│                   evals/ (golden + annealment suites — OIML content),
│                   prompts.yaml (voice vars + rare overrides),
│                   codec: oiml-pubid
├── theme/          logo, colors, fonts, nav labels
├── site/           the ENTIRE user plane, unchanged: the chat app,
│                   the articles (MDX), the annealment panel, branding,
│                   the site shell — consuming @konneal/client for the
│                   contract components
├── deploy/         wrangler.toml(s) — bindings, vars, INDEX_VERSION —
│                   and the thin deploy wrapper
├── whitepaper/     OIML's academic artifact (content, stays)
├── .github/        CI: profile validation + engine-pinned gates
└── workers/src/    ENTRY ONLY (~10 lines: createWorker({ profile }))
```

### 2.1 The content build path (Metanorma and Primmel stay first-class)

The build that turns a publisher's Metanorma corpus and Primmel
packages into a serving index is engine machinery driven by
profile-declared sources. The engine CLI gains one orchestration
command:

```
konneal build --profile profile/
```

It reads `profile/sources.yaml` — the pinned references to the
publisher's Metanorma corpora (clean and recovered), relaton
bibliography, Glossarist terminology, and Primmel packages checkout —
and runs the derivation in the order the incidents taught, as
structure rather than memory: parse (clean-beats-dirty precedence,
shell flagging, language policy from the profile) → typed units from
the Metanorma documents → the model plane from the Primmel projection
(the freshness gate: a package's source hash moves, the build fails
until re-indexed) → terminology and graph ingestion → embed → upsert →
restore gaps → enrichment replay → reconcile against the canonical
declaration → unit assets → rendered documents → the answer-cache
generation stamp. The sequence mistakes that caused the 2026-09-09/10/11
incidents become impossible for every SDO, not just this one.

The build stamps the index with a wire version alongside the existing
index version, so a deployment never serves an index built by an
ingest version its serving engine cannot read — the freshness
mechanism extended from content drift to engine drift.

### 2.2 The interface (owned by the publisher, served by contract)

The publisher owns the entire user plane: the chat application, the
article pages, the site shell of their choosing, the branding, the
annealment panel, the whitepaper surface. Nothing about their frontend
waits on an engine release, and nothing about the engine carries their
taste. OIML's site stays exactly where it is, in the deployment
repository, including the site-shell dependency it already uses.

Two things cross the boundary, and only two:

1. **The documented API** (spec-api.md): ask and search, absence and
   verification, research, sessions, projects and memory files,
   datasets, auth, administration, and the MCP servers. The UI already
   speaks it over HTTP and server-sent events, and the UI test suite
   already runs against stubbed APIs — the seam exists and is proven.
   The memory and project features are backend features: the engine
   owns the D1 schema and CRUD; the publisher's frontend renders them.
2. **`@konneal/client`** — a small npm package extracted from the
   current site: the API types, the streaming client, and the
   contract-bound renderers (formula/table/figure/verdict blocks,
   citation chips, the in-context document pane). Renderers of the
   answer contract ship with the contract, so block rendering cannot
   fork and drift from the wire types; pages, layout and everything
   else stay publisher code consuming them.

For the second SDO, the Konneal org ships a **forkable UI starter** —
`konneal/ui-starter`, seeded from OIML's site at extraction and kept
as a template to copy, not a dependency to pin. Fork-not-depend is the
honest model for frontends.

Backend customization still composes, because publisher logic is not
only frontend: the OIML-CS application-draft acts are ask-path
behavior. The worker entry stays composable —

```ts
createWorker({ profile, hooks: { acts: oimlDraftActs }, extraRoutes })
```

— with custom routes reusing the engine's handlers and auth, and the
draft-act branch moving out of the engine's ask path into OIML's hook.

### 2.3 The Cloudflare topology (bindings are the publisher's facts)

Wrangler configuration, bindings, secrets and accounts stay in the
deployment repository untouched — Vectorize indexes, D1, KV, R2,
Queues, the OIDC issuer are per-publisher facts declared by the
profile's audiences (the two-index isolation pattern generalizes: one
index per audience, and the binding lint enforces it against the
profile's declarations, not a hardcoded list). The engine provides two
thin commands the deployment wraps: `konneal bootstrap` (create the
declared indexes/buckets/namespaces, patch ids into wrangler) and
`konneal deploy` (today's guarded deploy — branch and tree checks,
version bump, settle, profile-sourced smoke) so the operational
discipline ships with the engine instead of being re-implemented per
SDO.

**The development loop while both repos live:** the deployment pins
exact engine versions in its lockfile, with a `file:` override for
local engine work — the same pattern this repo already uses for the
site shell. Engine PRs run the engine's fixture matrix; the deployment
CI runs its own gates on the pinned version; neither blocks the other
until a release is deliberately adopted.

**Versioning.** The engine releases semver from `konneal/engine`; a
deployment pins exact versions (the same deliberateness as any
dependency). The wire contract, the UI and the workers share the
monorepo's version because they share its review. Content drift is
already governed by the freshness gate (`source_hash`); engine drift
joins it in the deployment's lockfile.

**Why npm/PyPI rather than submodules or a template-only engine.**
Cloudflare Workers bundle from `node_modules` as a matter of course; a
real package gives SDOs version pinning, changelogs and upgrade
paths — the governance the architecture doc named as an open question,
answered mechanically.

## 3. The remaining publisher facts (the audit delta)

Found since the architecture doc; each moves in the phase shown:

| Fact | Today | Moves to | Phase |
|---|---|---|---|
| Identifier grammar | OIML patterns in `upload_documents.py` + site `docSlug` | profile `codec: oiml-pubid`; engine carries the codec registry | A |
| Prompt voice | `prompts/system.md` names OIML and the corpus shape | template vars + `profile/prompts.yaml` | A |
| Eval suites | `tests/golden/*` (OIML questions) | `profile/evals/`; harness reads the profile path | A |
| Annealment panel data | `site/src/chat/annealmentLadder.ts` | `profile/evals/` (it IS the measured ladder) | A |
| Process expansion terms | `THRESHOLDS.processExpansion` (OIML-CS/CASCO words) | profile dataset note / expansion list | A |
| Smoke queries | OIML questions in `deploy.sh` | `profile/evals/smoke` | A |
| Models table (site) | hardcoded in how-it-works | profile (publisher's model policy disclosure) | A |
| Glossary/relaton/graph sources | ingest config paths | `profile/sources.yaml` (pinned refs) | A |

## 4. The phases (each independently shippable, gates green)

**Phase A — generalize in place** (in `oimlsmart/ai`, zero behavior
change): everything in §3, the codec registry (the OIML codec wraps the
pubid library; a plain-slug codec proves genericity), prompt
templates, evals-to-profile with the harness reading the declared path,
the profile codegen extended to feed the site. The repo is now
*conceptually* a profile + engine, with the engine still physically
inside it.

**Phase B — the engine is born** (`konneal/engine`): move the code with
its history (`git filter-repo` per subtree, so archaeology survives —
blame for the 40017 fix must still point at the 40017 incident);
establish the monorepo workspaces, the npm/PyPI packaging, the engine's
own CI running the harness against a fixture corpus. `oimlsmart/ai`
keeps running unchanged in parallel.

**Phase C — the consumer flip**: `oimlsmart/ai` depends on
`@konneal/engine@x.y.z`; `workers/` shrinks to the entry; `ingest/` and
the heavy `scripts/` become dependencies and thin wrappers; CI re-points;
the full promotion gate runs against production before the flip is
declared done. Nothing about the deployment's operations changes —
same wrangler, same bindings, same deploy flow.

**Phase D — the ecosystem**: the forkable `konneal/ui-starter` seeded
from OIML's site, `create-publisher` scaffolding, the reference matrix
in engine CI (this profile as fixture #1, a second fixture from
another Metanorma flavor), the product site build in
`konneal.github.io`, and the public flip of the repos at launch.

The backend-only boundary shrinks the extraction itself: Phase B moves
the workers, ingest, harness and docs — never the site; the client
package is extracted from the site in Phase C, with the site's
remaining local copies deleted behind a one-release deprecation so the
flip is a lockfile change, not a rewrite. The UI test suite stays in
the deployment repo (it tests the deployment's frontend); the engine's
CI tests the API plane, which the golden and annealment runners
already exercise over HTTP.

## 5. Invariants that make each phase safe

- The profile drift test (YAML ≡ codegen) — exists.
- The TS↔py wire contract test — exists, moves with the contract.
- The promotion gates (golden ×3 + annealment ×6) — run at every phase
  boundary against production.
- The deploy version guard and smoke (now retry-hardened) — unchanged.
- The binding-isolation lint — moves with the workers, runs in engine
  CI against the fixture profile.

## 6. Honest risks, named

- **Workers-from-npm ergonomics**: standard wrangler bundling; verified
  in phase B before the flip, with the current repo as fallback the
  whole time.
- **Contract-renderer drift**: eliminated where it matters — the
  block renderers ship in `@konneal/client` with the types; the
  publisher's pages cannot fork the contract even though they own the
  frontend. The residual risk is an SDO ignoring the client package in
  a bespoke frontend; the API docs and the MCP surface keep the wire
  honest regardless.
- **History preservation**: filter-repo per subtree; the reference
  READMEs cross-link so the archaeology stays reachable from both
  repos.
- **The whitepaper and articles are OIML's**, not the engine's — they
  stay in the publisher repo; the engine's docs describe mechanisms,
  never this publisher.
- **Trademark screening** remains the gating step before any public
  Konneal marketing; the repos stay private until it clears.
