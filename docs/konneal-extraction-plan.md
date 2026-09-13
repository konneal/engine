# The Konneal extraction plan — packages, phases, end-state

> Status: PLAN (2026-09-13) — presented for approval before
> implementation. Extends docs/multi-sdo-architecture.md §7 (whose
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
├── packages/ui/                   @konneal/ui          (npm)
│     the Astro+Vue site template: chat app, article/MDX system,
│     DocPane, sidebar, annealment panel (data fed from the profile)
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
├── site/           the OIML articles (MDX) + branding/layout overrides;
│                   the chat app and shells come from @konneal/ui
├── deploy/         wrangler.toml(s) — bindings, vars, INDEX_VERSION —
│                   and the thin deploy wrapper
├── whitepaper/     OIML's academic artifact (content, stays)
├── .github/        CI: profile validation + engine-pinned gates
└── workers/src/    ENTRY ONLY (~10 lines: createWorker({ profile }))
```

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

**Phase D — the ecosystem**: `create-publisher` scaffolding, the
reference matrix in engine CI (this profile as fixture #1, a second
fixture from another Metanorma flavor), the product site build in
`konneal.github.io`, and the public flip of the repos at launch.

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
- **UI↔API shape drift**: eliminated by construction — the UI ships in
  the engine's monorepo, versioned with the workers.
- **History preservation**: filter-repo per subtree; the reference
  READMEs cross-link so the archaeology stays reachable from both
  repos.
- **The whitepaper and articles are OIML's**, not the engine's — they
  stay in the publisher repo; the engine's docs describe mechanisms,
  never this publisher.
- **Trademark screening** remains the gating step before any public
  Konneal marketing; the repos stay private until it clears.
