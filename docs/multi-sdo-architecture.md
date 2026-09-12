# Multi-SDO architecture — one engine, many publishers

> Status: design (2026-09-12). The question this document answers: how does
> this RAG / Metanorma / Primmel pipeline serve other standards developers,
> with clean encapsulation, so that each SDO manages its own content and its
> own deployment? The short answer: the engine becomes publisher-agnostic by
> construction, every publisher-specific fact moves into a declarative
> **publisher profile** owned by that SDO, and the engine consumes profiles
> the same way it already consumes prompts and datasets — as data.

## 1. The principle

The system already learned this principle the hard way, several times:

- Corpus behavior travels with the dataset declaration, not with pipeline
  code (the `DATASETS` notes injected into prompts).
- Prompts are data files, never inline strings.
- The vector adapter is the single door where a **registry**, not an `if`
  chain, decides which corpora may enter which index.
- The model plane consumes each publisher's own package repository at a
  pinned reference, with a freshness gate that detects content drift.

The multi-SDO design extends the same principle to its conclusion: nothing
in the engine may know which publisher it serves. Every fact that is
currently true because "this is OIML" becomes a field in a profile.

## 2. The honest audit — what is publisher-specific today

| Surface | Current state | Where it must live |
|---|---|---|
| Dataset declarations | `DATASETS` in `config.ts` (ids, labels, permission codes, prompt notes) | profile: `datasets` |
| Corpus registry | `PRODUCTION_CORPORA` / lane registries in `vector_adapter.py` | profile: `corpora` (registered names + target gates) |
| System prompt voice | `prompts/system.md` mentions OIML publications and the corpus shape | profile: prompt template variables |
| Identifier grammar | `OIML R/D/B/G/E` patterns in slugs, the PubID parser, mirror upload | profile: an identifier codec (per-SDO PubID module) |
| Terminology source | 13 Glossarist datasets under the OIML vocab repo | profile: vocabulary sources |
| Bibliography | `relaton-data-oiml` (5,707 records) | profile: relaton source (relaton is already one dataset per SDO across the ecosystem — direct leverage) |
| Document models | `primmel-packages` (oiml-r60, oiml-cs, …) | per-SDO packages repo at a pinned ref (the pattern already exists) |
| Rendered documents | mirror upload from the clean corpus; public-OIML-only rule | profile: rendering sources + the copyright policy flag per corpus |
| Access policy | two physically separate indexes; `ai-preview` estate permission | profile: audiences and their index bindings; permission codes map to the SDO's identity provider |
| Evaluation sets | golden 38 + annealment 18 (OIML content) | profile: per-SDO eval suites; the harness is shared |
| Branding and nav | OIML branding, the site shell | profile: theme, logo, labels, domain |
| Identity | RAG is an OIDC relying party of id.oimlsmart.org | profile: the OP per deployment; the role→permission mapping per estate |

The engine-side list — the stages, the retrieval mechanics, the answer
contract, the verdict engine, the gate harness, the quota and cache
machinery — is publisher-agnostic today and must stay that way. Where a
stage reads OIML-shaped assumptions (for example, edition steering's
family semantics), the assumption is metadata-driven already and travels
with the corpus.

## 3. The publisher profile

One declarative unit, owned by the SDO, versioned with their content:

```
publisher/
  profile.yaml          # id, names, branding, domains, identifier codec id
  datasets.yaml         # dataset declarations + permission codes + notes
  corpora.yaml          # corpus registry entries + audience bindings
  prompts/              # template variables + overrides (rare)
  evals/                # golden + annealment suites over THEIR corpus
  sources.yaml          # pinned refs: metanorma repos, relaton, glossarist,
                        # primmel packages repo, renderings bucket
  identity.yaml         # the estate OP, role → permission mapping
  theme/                # logo, colors, nav labels
```

The engine consumes exactly this at build and deploy time. A deployment
instance is then `engine@version + profile + content repos`, and the
profile repository is the only thing an SDO edits in the normal course
of business. Content repositories (Metanorma sources, relaton data,
Glossarist datasets, Primmel packages) stay under the SDO's own control
on their own infrastructure; the pipeline reads them at pinned
references and never writes to them — the same contract this system
already keeps with its upstreams.

## 4. Deployment topology

Each SDO runs its own deployment, in its own Cloudflare account, under
its own domain:

- **Structural isolation per publisher.** One SDO's corpus, indexes,
  caches and keys physically cannot reach another's, because they are
  separate accounts with no shared bindings. This is the same
  two-index isolation discipline applied one level up.
- **No cross-publisher federation by default.** If an SDO legitimately
  holds another's content (as this deployment holds ISO/IEC material
  internally), that relationship is declared in the SDO's own profile
  with an explicit audience and copyright policy, and it inherits the
  same structural separation between public and internal indexes.
- **One engine release train.** The engine is versioned as a package
  (workers + stages + site shell + ingest CLI + gate harness).
  Publisher deployments pin a version and upgrade deliberately, the way
  they would adopt any dependency. Breaking changes carry migration
  notes for profiles.

## 5. What already generalizes (the leverage list)

The ecosystem was multi-SDO before this system was:

- **Metanorma** renders documents for many SDO flavors; the rendering
  input and clause-anchor structure are common.
- **Relaton** bibliographies are one dataset per SDO; the registry
  logic (families, editions, supersession-derived currency) is generic.
- **Glossarist** terminology datasets carry the same shape for any SDO;
  the vocabulary lane is dataset-agnostic.
- **Primmel** packages are per-publisher repositories by design; the
  model plane and verdict engine consume them through the projection,
  not through OIML names.
- **The site shell** is already a package (`@oimlsmart/site-shell`)
  consumed by this site — the same boundary serves other themes.
- **The evaluation harness** grades declarative expectations; only the
  cases are content.

## 6. Content governance per SDO

- **Single source of truth.** Each SDO's authoritative content lives in
  their own repositories. The pipeline derives chunks, indexes, models
  and renderings from them, and the derivation is reproducible from
  pinned refs.
- **The freshness gate.** The model plane already fails its gate when a
  package's source hash moves (CI re-indexes on content change). The
  same mechanism watches every profile-declared source, so an SDO's
  content update flows to their deployment through their own CI, with
  their own gates.
- **Their own evaluation bar.** The promotion gate (golden ×N +
  annealment ×M against their deployment) runs on the SDO's cases. An
  SDO cannot ship a regression against their own corpus silently, and
  the engine cannot ship one against any profile in a reference matrix
  (engine CI runs the reference profiles' suites against fixture
  corpora).

## 7. Migration path (incremental, no rewrite)

1. **Profile extraction, no behavior change.** Move the OIML-specific
   tables (`DATASETS`, corpus registries, prompt voice variables) into
   `profile/` in this repository, consumed at build time. The OIML
   deployment becomes the first profile; every test stays green because
   nothing observable changes.
2. **Identifier codec.** Generalize the slug/PubID surface into a
   per-profile codec module (this repo already depends on a PubID
   library for OIML). The mirror upload and the citation deep-link path
   consume the codec.
3. **Prompt templates.** Interpolate publisher variables in
   `prompts/system.md`; overrides live in the profile and are rare.
4. **Eval suites per profile.** Move the golden and annealment cases
   under `profile/evals/`; the harness reads them from the declared
   path. This repo's suites become the OIML profile's suites.
5. **Engine packaging.** Extract the workers, stages, site shell, CLI
   and harness into the engine package; keep this repository as
   `publisher-oiml` — a profile plus deployment configuration — which
   becomes the reference implementation and the template other SDOs
   copy.
6. **Reference matrix.** Engine CI grows a second fixture profile (a
   small public corpus from another flavor) to prove no OIML assumption
   leaks into the engine.

Each step ships independently and keeps the production gates green.

## 8. Open questions (named, not hidden)

- **Versioning discipline.** How quickly do SDOs want to track engine
  releases — pinned with scheduled upgrades, or floating with gates?
  The gate machinery supports both; the governance choice is theirs.
- **Shared evaluation of the engine itself.** Content quality is
  per-SDO, but retrieval mechanics regressions should be caught once,
  centrally, on the reference matrix rather than re-measured by every
  SDO.
- **Localization policy.** The index is English-only today by explicit
  decision; other SDOs may decide differently, and the language gate
  (`ingest/langid.py`) is already profile-shaped (a declared language
  set plus exclusions).
- **Commercial and licensing terms.** Who may run the engine, under
  what license, and what support looks like — an organizational
  question that precedes any technical packaging.

## 9. What this buys each SDO

A publisher with Metanorma-authored documents gets, for the cost of a
profile and their existing content: hybrid retrieval with clause-level
citations, contextual enrichment, typed tables and formulas, terminology
binding, edition-aware answers over their bibliography, conformance
checking by execution over their Primmel models, citation deep links
into their own renderings, and a promotion gate that measures the
result on their own questions — on infrastructure they control, with no
dependency on any other publisher's deployment.
