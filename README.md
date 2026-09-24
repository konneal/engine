# Konneal Engine

**New here?** Read [docs/ADOPTION.md](docs/ADOPTION.md) — adopt Konneal for your own standards and your own identity service.

The publisher-agnostic serving layer for standards intelligence: hybrid
retrieval over clause-structured corpora, citation-grounded answers,
typed tables/formulas/figures, conformance checking by execution, and
the measurement gates that keep it honest. Konneal builds the databases
and serves the API; publishers own their content, profile and frontend.

```
npm install @konneal/engine
```

BSD-3-Clause. The reference deployment is
[OIML SMART AI](https://ai.oimlsmart.org).

## What a deployment looks like

A publisher's worker is ten lines:

```ts
// workers/worker_public/src/index.ts — the deployment entry
import worker, { setProfile } from "@konneal/engine";
import { PROFILE } from "./profile.gen.ts";

setProfile(PROFILE);

export default worker;
```

Everything the publisher owns lives in `profile/*.yaml` — identity,
datasets, corpora, prompts, thresholds, eval cases. The codegen
(`gen_profile.mjs`, included) turns the YAML into a committed
TypeScript module; a drift test keeps both sides honest. The engine
reads the profile at request time; no publisher fact is hardcoded.

The engine also ships the ingest CLI (Python): parse → embed → upsert,
reading the same profile for its corpora declarations.

## The three packages

| Package | What it is |
|---|---|
| `@konneal/engine` | The serving Worker + the ingest CLI (this package) |
| `@konneal/client` | The publisher-site contract: wire types, SSE client, citation chips, typed blocks |
| `@konneal/create-publisher` | `npm create @konneal/publisher` — scaffolds the whole deployment |

Start with the scaffolder: `npm create @konneal/publisher my-sdo
-- --with-site` writes the profile, the worker entry, the Cloudflare
wiring, the profile codegen, and (with `--with-site`) a minimal
Astro+Vue frontend consuming `@konneal/client`.

## The profile (the publisher's single edit surface)

| File | Declares |
|---|---|
| `publisher.yaml` | id, name, domains, identity issuer, codec, session cookie, features |
| `datasets.yaml` | what users can scope to (public vs session-gated), per-corpus prompt notes |
| `corpora.yaml` | the corpus registry — which corpora exist, which indexes serve them |
| `sources.yaml` | upstream repos the tooling reads (clean corpus, bibliography, terminology, models) |
| `ui.yaml` | suggestions, model disclosure, smoke probes |
| `retrieval.yaml` | steering vocabulary, process-intent notes |
| `prompts.yaml` | the publisher's prompt voice (identity, refusal, examples) |
| `evals/` | golden cases, annealment probes, ladder — the promotion-gate data |

## Serving architecture

- **Retrieval** is a stage registry; the ask path owns composition only
- **HTTP** is a route table dispatched by both workers
- Every steering number lives in `THRESHOLDS`; the chunk wire type is
  shared with the Python producer by a contract test
- **Ports** (`ports/`): ModelRunner, VectorIndex, Kv, Blobs, Runtime —
  the Cloudflare adapters are the only provider-typed module; a purity
  lint enforces it in CI
- **Publisher purity**: a CI lint fails any publisher string in
  `workers/` outside the codec registry (the identifier grammars)
- **Feature gates**: `drafts` and `model_plane` are profile-declared,
  off by default

## The ingest CLI

```bash
pip install git+https://github.com/konneal/engine.git
python -m ingest.cli parse     # corpora → chunks.jsonl + manifest
python -m ingest.cli embed     # embed via the binding's model
python -m ingest.cli upsert    # push vectors + metadata to Vectorize
```

## MCP server

The package exports `./mcp` — a ten-line entry per deployment serves
the publisher's public corpus to MCP clients (agent ecosystems).
Auth is required: the MCP client presents one of the deployment's API
keys; the same token rides outbound so spend and quota charge that
key.

## Promotion gates

The gate belongs to the deployment: its golden cases, annealment
probes and the runners (gates, eval, variance, e2e) live in the
deployment repository and run against that deployment's production.
The engine provides what the gate exercises — the answer contract,
the typed blocks and the model plane — and its own CI proves the
fixture profiles end to end.

## Repository

- `workers/worker_public/` — the public-facing Worker
- `workers/worker_mcp/` — the MCP server Worker
- `workers/shared/` — the router, chunk wire type, session
- `ports/` — the provider seam (interfaces + Cloudflare adapters)
- `profile/` — the engine's fixture profile (a real deployment carries
  its own; this one exists so tests run against declared data)
- `profile2/` — the reference matrix's second fixture (a different
  publisher shape; CI proves the engine serves declared profiles)
- `ingest/` — the Python ingest CLI
- `tests/` — unit suites (plain node, no network)
