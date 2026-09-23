# Adopting Konneal: your own standards-intelligence site

Konneal is a publisher-agnostic engine: clause-cited, verifiable answers
over your own Metanorma documents and Primmel models — deployed on your
own infrastructure, with licensed third-party content (IEC, ISO and
peers) gated behind your identity service.

## Start

    npm create @konneal/publisher my-sdo

The scaffolder interviews you for your publisher's facts — id, name,
domains, identity issuer, first dataset — and writes the whole
deployment skeleton: the worker, the site, the profile, the ingest
pipeline, CI. Every generated file is ordinary reviewable code.

Then the four declarations:

1. **Your profile** (`profile/*.yaml`): publisher identity, domains,
   datasets, the corpora registry, the licensed-standards catalog,
   prompt variables, smoke probes. Everything the serving surface knows
   about you is this data, never engine code.
2. **Your corpus** (`sources/`): your Metanorma documents. The ingest
   pipeline chunks along the documents' own clause boundaries, embeds,
   and upserts into your indexes.
3. **Your models** (Primmel packages): the machine-readable layer —
   requirements, constraints with threshold expressions, severity
   condition sets — so answers can carry server-computed verdicts, not
   paraphrases.
4. **Your identity**: any discovery-compliant OIDC provider. Register
   the site (authorization code + PKCE), map roles to datasets and
   groups to licensed keys in the provider's configuration — revoking a
   role removes access on the next request, no deploy.

## Licensed content, gated

Licensed standards are fail-closed by construction: each licensed
package carries a license key; the deployment's profile declares the
whitelist; a request without an entitled scope never sees the licensed
text — it is filtered before the model reads anything. An anonymous
request cannot reach internal indexes at all: the public surface holds
no binding to them, and the internal worker re-verifies every session
itself.

## Grounded in the literature

The execution pattern (a deterministic evaluator computes; the model
narrates) adopts the program-aided line — PAL (arXiv:2211.10435) and
Program of Thoughts (arXiv:2211.12588) — and the structured-numeric
retrieval lessons of TableRAG (arXiv:2410.04739, arXiv:2506.10380).
The deployment's research notes map every technique to its source and
to the code path that implements it.

## The proof

Your golden suite gates every promotion: content witnesses, refusal
legs, licensed pairs in both directions (entitled content serves;
unentitled never appears), context-utilization and verdict legs. The
nightly runs unattended against production and fails loudly on drift.

## Ask it from your terminal

The konneal CLI ships with the client package: npm i -g @konneal/client, then KONNEAL_BASE and KONNEAL_KEY in the environment give you konneal ask, konneal search and konneal keys list — streaming answers with citations and verdict blocks, the same API the site uses behind the same tiering.

## The path

`npm create @konneal/publisher` → declare the profile → ingest your
corpus → author one model package and one golden leg → map identity →
promote through the gate. Adoption is done when your team runs the
nightly and reads the gate without help.
