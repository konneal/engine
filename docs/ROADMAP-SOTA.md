# Roadmap to SOTA — OIML SMART AI

*Gap analysis and phased plan derived from `RESEARCH-SOTA-2026.md`
(2026-08-26). Constraints honored: Cloudflare-only, minimal accounts,
Workers AI open-weight models, cost-first serving lane / quality-first
one-time lane, public+internal corpus isolation.*

---

## Where we stand

Serving is a 12-layer modular-RAG pipeline with LLM query understanding
(intent routing, filters, HyDE, decomposition), multi-query fusion, hybrid
reranking, CRAG grading, self-RAG reflection, prompts-as-data, context
budgeting with history compaction, canonical refusal contracts, and an eval
stack (golden, live e2e, retrieval hit@5 + paraphrase probes, faithfulness
judge). Contextual enrichment (31k chunks, deepseek-v4-pro) is completing
in-flight. That places us solidly in 2025-SOTA territory. The gaps below
are what separates us from 2026 frontier systems.

## Gap register

| # | Layer | Gap | SOTA reference | Impact | Cost |
|---|---|---|---|---|---|
| G1 | Data prep | Tables/equations flattened into text chunks | TableRAG / TabRAG | normative-value queries (our core use case) | med |
| G2 | Data prep | No re-OCR of worst dirty docs | GLM-OCR protocol exists | recall on OCR-noisy docs | med |
| G3 | Vector ops | No sparse/lexical index (Vectorize limit); keyword layer scores only retrieved candidates | hybrid sparse+dense | exact-term recall | low (in-worker) |
| G4 | Vector ops | Single embedding model, no MRL/quantization knobs | Matryoshka + quantization | latency at scale | n/a on Vectorize; revisit |
| G5 | Chat processing | No cross-turn entity memory (only summary compaction) | entity graphs (CAsT) | follow-up accuracy | low |
| G6 | Chat processing | No semantic cache (exact-text KV only) | embedding-similarity cache | latency/cost on near-dupes | low |
| G7 | Chat UX | No generated follow-up suggestions; clarifying question allowed but rare | mixed-initiative | engagement | low |
| G8 | Retrieval | No graph lane (vocab 6,031 concepts + relaton 5,707 relations unused) | GraphRAG / KG2RAG | relationship queries ("what references R 60?") | med-high |
| G9 | Retrieval | No LLM-listwise rerank tier over top-12 | cascade reranking | precision on hard queries | low |
| G10 | Retrieval | No agentic loop / deep-research mode | Agentic RAG, Plan*RAG | multi-hop research questions | high |
| G11 | Answers | Passage-level citations, not span/quote-level | fine-grained attribution | verifiability (normative corpus!) | low |
| G12 | Answers | Single-pass generation (no sample-and-verify) | test-time compute | answer quality on hard queries | low-med |
| G13 | Eval | Missing answer-relevancy + context-precision metrics; no derived dashboards | RAGAS suite | regression visibility | low |
| G14 | Memory | Session-only; no persistent member memory | Mem0-style | personalization | med |
| G15 | Ecosystem | No MCP servers (planned in architecture) | MCP standard | agent-ecosystem reach | med |
| G16 | Long-context lane | Doc-as-context mode unbuilt | LC+RAG complementarity | "explain THIS edition" queries | med |
| G17 | Ops | No Turnstile on anon ask | bot economics | abuse resistance | low |

## Phased roadmap

### Phase 0 — in flight (complete before measuring anything else)
1. **Finish contextual enrichment** (running; ~$50 total) → catch-up pass for
   rate-limit stragglers → bump `INDEX_VERSION` → re-run e2e + retrieval
   eval. **Success metric: paraphrase-probe hit@5 ≥ baseline 19/21, target
   21/21**, and golden e2e 13/13 (G3's contextual-BM25 effect lands here —
   keyword layer now scores enriched text).

### Phase 1 — cheap, high-leverage (days; all low cost)
2. **Complete the RAGAS metric set (G13):** add answer-relevancy and
   context-precision scorers next to the existing faithfulness judge
   (same judge model, prompts as data); wire into a nightly eval snapshot
   in `artifacts/eval/`. *Metric: full metric battery on every deploy.*
3. **Span-level quote anchors (G11):** system prompt requires quoting the
   exact normative phrase before paraphrasing it, cited inline
   (`"MPE shall not exceed 0.5e" [3]`); eval asserts quotes exist on
   table-value goldens. *Metric: quote-presence on value questions = 100%.*
4. **Listwise rerank tier (G9):** for member/hard queries only, after
   bge-reranking, one glm-4.7-flash listwise call reorders the top 12
   (prompt as data; ~$0.0002/query). *Metric: hit@1 on paraphrase probes.*
5. **Semantic answer cache (G6):** KV store of (embedding-quantized query →
   answer) with similarity threshold; checked before understanding runs.
   *Metric: p50 latency on repeat/near-dup queries.*
6. **Follow-up suggestions (G7):** understanding output gains
   `follow_ups[2]` — rendered as tappable chips after each answer
   (API-driven, config-free). *Metric: follow-up CTR in telemetry.*
7. **Turnstile on anon ask (G17).**

### Phase 2 — structural upgrades (1–3 weeks each; medium cost)
8. **Graph lane (G8):** project relaton citation edges + vocab concept
   relations into D1 (nodes/edges tables); at query time, understanding
   emits named entities → graph expansion feeds candidate doc_numbers into
   the existing filter/fusion path (no new index; fusion in-worker).
   Public projection only from OIML data. *Metric: relationship-query
   golden cases (new probe set).*
9. **Agentic deep-research mode (G10):** Cloudflare Workflows (durable,
   already in the architecture doc) — bounded loop: retrieve → read →
   sufficiency judge → re-retrieve (≤3 iterations, spend-capped), glm-5.2
   with prompt caching; surfaced as a "Research this" action for members.
   *Metric: multi-hop golden cases; cost/query ceiling.*
10. **Table-aware chunks (G1):** re-parse MPE/accuracy-class tables into
    structured chunk objects (header map + row tuples, JSON-serialized for
    embedding, original rendered for display); retrieval treats them as a
    distinct chunk type with table-aware boosting. *Metric: table-value
    golden accuracy, esp. row-precise answers.*
11. **MCP servers (G15):** one per audience (public OIML / internal
    OIML+ISO), exposing search+ask as MCP tools with the same auth tiers.
    *Metric: external MCP client can query grounded answers.*
12. **Cross-turn entity memory (G5):** conversation table gains an entity
    map (doc ids, terms, editions mentioned); understanding consumes it so
    "it / that standard / the 2017 one" resolve without full re-derivation.
    *Metric: MTRAG-style follow-up probes.*

### Phase 3 — frontier (selective; quality-gated)
13. **Sample-and-verify answers (G12):** hard-query lane generates 2
    candidates; faithfulness+relevancy judges select. Eval-gated rollout.
14. **Doc-as-context lane (G16):** deepseek-v4 1.31M ctx for
    edition-scoped questions; chunk retrieval nominates the document,
    full doc goes to context. Members-first, budget-capped.
15. **Persistent member memory (G14):** explicit, user-visible, deletable
    (privacy by design); informs terminology and preferred editions only.
16. **Re-OCR the worst 5% dirty docs (G2)** via the GLM-OCR cache-first
    protocol; re-ingest those slates only.
17. **Multilingual index decision:** currently English-only by directive;
    revisit when multilingual usage telemetry justifies FR/AR/SR lanes
    (embedding model already supports 100+ languages).

## Sequencing rationale

Phase 1 items are all prompt/worker-level and independently shippable;
each carries its own metric so regressions are attributable. Phase 2 items
change index shape or add subsystems — each lands with its own eval probes
first. Phase 3 is quality-gated: nothing ships without a measured win on
the golden + probe suites. Everything remains inside the two-lane cost
model (serving = cheap models; one-time/rare = best model).

## Definition of "SOTA standards chatbot" (2026 bar)

1. Every answer **quote-anchored and clause-linked** (G11 ✓ after Phase 1)
2. **Relationship and multi-hop questions** answered via graph + agentic
   loops (G8, G10 — Phase 2)
3. **Normative tables answered row-precisely** (G1 — Phase 2)
4. **Full RAGAS battery green** with drift dashboards (G13 — Phase 1)
5. **Follow-ups that feel human** — entity memory + suggested next steps
   (G5, G7)
6. **Agent-native** — OIML knowledge reachable via MCP (G15)
7. **Eval-gated everything** — no change ships without the probe suites
