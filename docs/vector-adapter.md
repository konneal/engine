# The vector adapter — producer formats → Vectorize, through one door

`ingest/vector_adapter.py` is the single boundary every chunk crosses to
become a vector. Producer projectors (`ingest/primmel.py`, `ingest/mko.py`,
`ingest/parse.py`) turn producer formats into dicts; the adapter turns
those dicts into the wire shape — validated, target-checked, and
schema-locked.

## Why (the incident this prevents)

On 2026-09-02 the lane builders were found to have hand-rolled metadata
per script with no tie between a chunk and its TARGET index. Consequences,
all observed in production:

- **1,126 lane vectors inside the production index** (200 primmel, 648
  exp_composed, 278 exp_mko) — a lane chunk enriched through
  `/admin/enrich`'s embed+upsert side effect landed in `env.VECTORIZE`
  and was cited in live answers. Purged via wrangler delete-vectors;
  inventory archived at `artifacts/production-strays-20260902.json`.
- **Corpus vocabulary drift** — `primmel` vs `exp_primmel`, edition
  `"2021"` vs `"2"` between builds of one lane.
- **Producer UUID anchors reaching citations** (`§_eb46a3a3-…`) — hidden
  at citation time in serving, never fixed at the source.
- **Wire-time size failures** — VECTOR_UPSERT_ERROR 40016/40017 (metadata
  > 10KB, oversized chunk_text) discovered only at the upsert call.

## The contract

### ChunkMetaModel — the wire schema

Mirrors the serving contract (`workers/worker_public/src/pipeline.ts`
`ChunkMeta`). Pydantic (the ecosystem serialization rule: framework, not
hand-rolled `to_json`). `extra="forbid"` — an unknown field from a
producer is a SCHEMA CHANGE, decided here, never an accident at the wire.

Fields: `doc_id, docidentifier, doctype, doc_number, edition, language,
clause_anchor, clause_title, tier, corpus, text_ref, status,
superseded_by, unit_id, block, unit_hash, producer, source_lane,
linked_clause, linked_document, section_summary, child_anchors, ctx,
chunk_text`.

Validators (build-time, before any wire call):

- **corpus registry** — the value must be registered (`PRODUCTION_CORPORA`
  ∪ `LANE_CORPORA`). New corpora are added HERE, never ad hoc in a script.
- **clause_anchor sanity** — producer UUID anchors are stripped to `""`
  (they are unciteable; serving treats them as garbage — this stops them
  at the source).
- **chunk_text cap** — 2,800 chars (the 40016 lesson).
- **wire size** — serialized metadata ≤ 9,000 bytes (Vectorize hard limit
  10KB).

### Target gating — the structural incident guard

`TARGET_CORPORA` maps every index to the corpora it may hold:

| Target | Legal corpora |
|---|---|
| `production` (`idx_oiml_public_v2`) | oiml, dirty, clean, synthetic, smart-model |
| `exp_plain` / `exp_adoc` / `exp_mko` / `exp_composed` | the same-named lane corpus |
| `primmel` | primmel |
| `primmel_flat` | primmel (the ablation indexes the same corpus, unlinked) |

`normalize_chunk(raw, target=…)` refuses a chunk foreign to its target at
ADAPT time; `chunk.upsert(vector, target)` refuses again at payload-build
time. A lane corpus can no longer enter production through any code path
that builds payloads through the adapter.

### Producer remaps live here, not in scripts

The production MKO flow remaps `corpus mko → oiml` (+`producer: mko`,
`tier: curated`) inside `normalize_chunk(target="production")`; the lane
MKO flow keeps its `exp_mko` namespace. Previously this remap lived in
`ingest/enrich.py` — buried in a driver, duplicated by hand elsewhere.

## Serving mirror

The TypeScript `ChunkMeta` interface in `pipeline.ts` is the serving-side
read of the same contract (plus its own optional fields). Change either
side deliberately: adapter schema → wire shape → serving interface.

## Call sites

- `scripts/index_comparison_lanes.py` — every lane upsert builds its
  payload through `normalize_chunk(...).upsert(..., target=ADAPTER_TARGET[lane])`.
- Future producers (and the metanorma-ai deployment package's
  document→vectors pipeline component) adopt the same door: project to
  dicts, adapt through this module, never hand-roll a metadata dict again.
