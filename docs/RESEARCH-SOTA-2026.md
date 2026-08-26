# SOTA Research Digest — RAG & Chatbot Techniques, 2023→2026

*Compiled 2026-08-26 for the OIML SMART AI service. Sources are live web
research (arXiv, ACL/ACM/NeurIPS/SIGIR 2025–2026, vendor engineering blogs).
Companion document: `ROADMAP-SOTA.md` (gap analysis + phased plan).*

---

## 1. The paradigm timeline

| Era | Paradigm | Defining techniques |
|---|---|---|
| 2023 | **Naive RAG** | chunk → embed → top-k → generate. "PDFs into a vector DB" |
| 2023–24 | **Advanced RAG** | pre/post-retrieval optimization: query rewriting, HyDE, multi-query fusion, reranking, CRAG/Self-RAG correction |
| 2024–25 | **Modular RAG** | composable routing, adaptive retrieval depth, specialized indexes (graph, table), eval-driven components |
| 2025–26 | **Agentic RAG** | iterative retrieve→read→decide loops, planning, reflection, tool use; "deep research" workflows |

Surveys anchoring the arc: [Gao et al. 2312.10997](https://arxiv.org/abs/2312.10997) (Naive→Advanced), [2410.12837](https://www.alphaxiv.org/abs/2410.12837), [2506.00054](https://arxiv.org/abs/2506.00054) (comprehensive, June 2025), and the [Agentic RAG survey 2501.09136](https://arxiv.org/html/2501.09136v4). The 2026 field consensus: the "Hello World" RAG is dead ([AI with Aish](https://aishwaryasrinivasan.substack.com/p/all-you-need-to-know-about-rag-in)); production systems are multi-layer, adaptive, and eval-instrumented.

**Where we are:** our serving pipeline is squarely *Modular RAG* with one-shot agentic elements (CRAG corrective re-retrieval, self-RAG reflection). The main structural gap to 2026 SOTA is the **agentic loop** (§5) and the **graph lane** (§6).

---

## 2. Data preparation, chunking, contextual enrichment

**SOTA recipe (Anthropic Contextual Retrieval, verified in production widely):**
prepend an LLM-written situating context to each chunk before embedding.
Measured failure-rate reductions: contextual embedding **35%**, + contextual
BM25 **49%**, + reranking **67%**
([Anthropic](https://www.anthropic.com/engineering/contextual-retrieval),
[Claude Cookbook](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide),
[Tectonic breakdown](https://gettectonic.com/anthropics-new-approach-to-rag/)).
Follow-up analysis ([Reconstructing Context, 2504.19754](https://arxiv.org/html/2504.19754v1))
also validates **late chunking** (embed the full doc, pool per-chunk token
vectors) as a cheaper alternative with comparable gains on some corpora.

**Key subtlety:** the recipe has THREE parts — we historically did embedding
+ reranking but lexical scoring over *raw* text. Once contextual enrichment
completes, our in-worker keyword layer scores enriched `chunk_text`, giving
us contextual BM25 for free (verify in the post-enrichment eval).

**2026 additions:** Matryoshka (MRL) embeddings — one embedding, multiple
truncatable dimensionalities, enabling coarse-to-fine search up to 5× faster
combined with quantization
([Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/),
[MRL × quantization](https://medium.com/data-science-collective/matryoshka-embeddings-how-to-make-vector-search-5x-faster-f9fdc54d5ffd)).

---

## 3. Vector database operations

2026 feature baseline across Qdrant/Milvus/Weaviate/Redis
([2026 comparison](https://www.firecrawl.dev/blog/best-vector-databases),
[Redis 2026 guide](https://redis.io/blog/vector-search-database-news-2026-guide/)):

- **Hybrid sparse+dense** as a first-class query: dense vectors + SPLADE/BM25 sparse vectors fused server-side
- **Quantization** (scalar/binary/product) for memory and speed
- **Matryoshka coarse-to-fine** retrieval
- **Multi-vector objects** and server-side reranking hooks
- Rich **metadata filtering** with index-backed predicates

**Cloudflare Vectorize (our platform) today:** dense-only, **no native sparse
vectors**, no exposed quantization knobs; 10M vectors/index; metadata indexes
required per filtered field; AutoRAG shipped for managed use cases
([Anjin Digital 2026 review](https://www.anjin.digital/blog-posts/cloudflare-vectorize-v2-edge-rag-revolution),
[Firecrawl comparison notes the hybrid gap](https://www.firecrawl.dev/blog/best-vector-databases)).

**Implication:** our hybrid behavior must live in the worker — which it does
(in-worker keyword RRF) — and any sparse-index ambitions mean either waiting
for Vectorize or re-implementing lexical recall over a cheap store (D1/KV
inverted index). Constraint, not blocker; CLAUDE.md's metadata-filter
strategy already covers the exact-identifier query class.

---

## 4. Query understanding, intent, multi-turn handling

- **LLM query understanding** (routing, filters, rewriting, decomposition,
  HyDE) is the accepted pre-retrieval core — [Agentic RAG survey](https://arxiv.org/html/2501.09136v4);
  NVIDIA's blueprint, IBM granite, and dedicated LoRA rewriters
  ([ModelScope granite-3.2 query-rewrite LoRA](https://modelscope.cn/models/AI-ModelScope/granite-3.2-8b-lora-rag-query-rewrite))
  treat **decontextualization of the latest utterance** as its own model task.
- **Multi-turn SOTA:** standalone-query rewriting (we have), plus
  **multi-turn entity graphs / entity memory** tracking referents across
  turns ([CMU-LTI TREC CAsT](https://trec.nist.gov/pubs/trec30/papers/CMU-LTI-CAsT.pdf)),
  and history-aware rewriting benchmarks — MTRAG, SemEval-2026 Task 8
  ([UTRAG](https://aclanthology.org/2026.semeval-1.237.pdf),
  [Sifei](https://arxiv.org/html/2606.28352v1)).
- **Semantic caching** of queries/answers by embedding similarity is a
  recognized latency/cost lever ([HF discussion pattern](https://discuss.huggingface.co/t/multi-turn-rag-for-technical-documentation-using-context-aware-query-rewriting-semantic-caching-is-this-a-sound-approach/172433)).
- **Mixed-initiative / clarifying questions:** systems that proactively ask
  ONE clarifying question under ambiguity, and *suggest* follow-ups
  ([ACM 3814610](https://dl.acm.org/doi/10.1145/3814610),
  [WWW 2024](https://arxiv.org/abs/2402.07742),
  [ACL 2023 controllable mixed-initiative](https://aclanthology.org/2023.acl-short.82.pdf)).
  Our system prompt permits a clarifying question but never generates
  follow-up suggestions — a UX-level gap.

---

## 5. Retrieval accuracy: reranking, agentic loops, test-time compute

**Reranking (2025–26 consensus — cascades):**
cheap recall (BM25+dense, hundreds) → **cross-encoder** to top-50 → optional
**LLM listwise** rerank of the final 5–15 with joint list reasoning
([ZeroEntropy deep dive](https://zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders/),
[Redis 2026 reranking roundup](https://redis.io/blog/top-reranking-models-rag-accuracy/),
[comparative analysis 2602.22219](https://arxiv.org/html/2602.22219v1)).
Listwise accelerators: [FIRST single-token decoding](https://github.com/gangiswag/llm-reranker),
RankZephyr, [self-calibrated listwise (SIGIR 2025)](https://dl.acm.org/doi/10.1145/3696410.3714658).
We run bge-reranker-base (cross-encoder) ✓; the missing rung is LLM-listwise
refinement of our top-12 for hard queries (already noted in CLAUDE.md for
the internal deep pool).

**Agentic loops / deep research:** retrieve → read → judge sufficiency →
retrieve again until evidence is enough
([Agentic RAG survey](https://arxiv.org/html/2501.09136v4),
[FutureAGI patterns](https://futureagi.com/blog/agentic-rag-systems-2025/),
[Milvus DeepSearcher](https://milvus.io/zh/blog/stop-use-outdated-rag-deepsearcher-agentic-rag-approaches-changes-everything.md)).
Our CRAG + reflection are single-shot; a bounded loop (≤3 iterations, budget-
gated) is the SOTA shape. Cloudflare Workflows (durable, in our architecture
docs already) is the natural substrate for a long-form "research mode".

**Reasoning models × retrieval:** test-time compute scaling — parallel
retrieval over reasoning graphs ([MIRAGE 2508.18260](https://arxiv.org/html/2508.18260v1)),
plan-then-retrieve ([Plan\*RAG](https://openreview.net/pdf?id=gi9aqlYdBk)),
and sample-and-verify selection ([inference-time scaling list](https://github.com/ThreeSR/Awesome-Inference-Time-Scaling)).
Practical translation for us: generate 2 candidate answers for hard queries
and let the faithfulness judge pick — cheap on Workers AI reasoning models.

**Long-context vs RAG (2026 verdict: complementary):** RAG is ~1,250× cheaper
per query, faster, and citation-grounded; long context wins for focused
single-document analysis
([Wire data](https://usewire.io/blog/long-context-vs-rag-what-the-data-shows/),
[2501.01880](https://arxiv.org/html/2501.01880v1),
[production decision framework](https://www.sabaoon.dev/blog/rag-vs-long-context-production-2026)).
Our planned doc-as-context lane (deepseek-v4 1.31M ctx) is exactly the right
complement — worth building for "explain clause 4.2 of THIS edition" queries.

---

## 6. Structured knowledge: graphs, tables, equations

- **GraphRAG** matured through 2025 into production
  ([Microsoft GraphRAG](https://microsoft.github.io/graphrag/),
  [KG2RAG, NAACL 2025](https://aclanthology.org/2025.naacl-long.449/),
  [GraphRAG survey 2501.13958](https://arxiv.org/pdf/2501.13958),
  [ACM CSUR survey](https://dl.acm.org/doi/10.1145/3777378)). Wins where
  queries traverse relationships ("which standards reference R 60?").
  **Our advantage: the graph data already exists** — vocab repo (6,031
  Glossarist concepts) + relaton (5,707 citation relations) need no LLM
  entity extraction, only projection + fusion.
- **Table RAG:** preserve 2D structure instead of flattening
  ([TableRAG 2506.10380](https://arxiv.org/html/2506.10380v1),
  [TabRAG 2511.06582](https://www.alphaxiv.org/abs/2511.06582)). Our parse.py
  linearizes caption+rows; MPE tables and accuracy-class tables are exactly
  the normative content users query. Structured table chunks (JSON
  serialization + table-aware retrieval) are a differentiated win for a
  standards corpus.
- Equations (`stem:[...]` AsciiMath): same principle — first-class retrievable
  objects, currently chunk-embedded as text.

---

## 7. Answer formulation, attribution, verification

- **Span-level attribution** is the 2025–26 bar: every claim carries a
  citation to a quoted span, verifiable against the retrieval log
  ([survey: 134 papers / 300 metrics](https://www.semanticscholar.org/paper/8a921bf4a04336dfd78ec57765faa0477f51f07b),
  [fine-grained grounded citations](https://openreview.net/forum?id=7atXKldh-r),
  [LAQuer, ACL 2025](https://aclanthology.org/2025.acl-long.746/),
  [G-Cite vs P-Cite 2509.21557](https://arxiv.org/html/2509.21557v2),
  [FutureAGI 2026 attribution audit rules](https://futureagi.com/blog/evaluating-llm-citation-attribution-2026/)).
  Our citations are passage-level with clause anchors — good, not span-level.
  For a *normative* corpus, per-claim quote anchors ("MPE = 0.5e …" [3]) are
  the trust feature.
- **Generation-time citation** (marker emitted with the sentence) beats
  post-hoc citation on attribution accuracy — our prompt already does
  inline [labels]; tightening to quote-span style is a prompt+eval change.

---

## 8. Evaluation

- **RAGAS metric suite** is the canonical battery: faithfulness, answer
  relevancy, context precision, context recall
  ([RAGAS docs](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/),
  [2309.15217](https://arxiv.org/html/2309.15217v1),
  [2026 guide](https://qaskills.sh/blog/ragas-rag-evaluation-metrics-complete-guide)).
  We have faithfulness (judge) + hit@5 (≈ context recall). Missing: answer
  relevancy and context precision — both computable with our existing judge
  infrastructure.
- **Out-of-scope/unanswerable calibration:** ELOQ, UAEval4RAG (from our
  earlier research) remain the reference for refusal behavior.
- **Production monitoring:** drift dashboards, feedback loops
  ([DeepEval/Ragas comparison](https://medium.com/@sjha979/ragas-vs-deepeval-measuring-faithfulness-and-response-relevancy-in-rag-evaluation-2b3a9984bc77)) — we have D1 telemetry + spend ledger; no derived dashboards yet.

---

## 9. Memory & personalization

Session memory (we have via history+compaction) → **persistent memory**
(user facts across sessions, Mem0-style
([Mem0](https://mem0.ai/blog/ai-chatbot-development-with-persistent-memory),
[Supermemory architecture guide](https://supermemory.ai/blog/how-to-make-ai-remember-user-preferences-across-conversations/),
[arXiv 2510.07925](https://arxiv.org/html/2510.07925v1)) → **user profiles**.
For a standards body: member-tier memory of "works with weighing instruments,
prefers French, follows R 76 revisions" is a legit differentiator with a
privacy surface to design deliberately (user-visible, deletable).

---

## 10. Agent ecosystem: MCP

MCP became the de-facto standard for agent↔knowledge access in 2026
([official docs](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro),
[IBM](https://www.ibm.com/think/topics/model-context-protocol),
[Red Hat developers](https://developers.redhat.com/articles/2026/01/08/building-effective-agents-mcp)).
Exposing our retrieval as an MCP server (one per audience, as our
architecture already plans) turns every MCP client (Claude, IDEs, member
tooling) into a consumer of OIML-grounded answers — the standards-arena
equivalent of being citable by the agent ecosystem.

---

## 11. What we already match (honest scoreboard)

| SOTA element | Us |
|---|---|
| Contextual embeddings + reranking | ✅ running (2/3 of the Anthropic recipe) |
| Contextual BM25 | 🟡 free once enrichment lands (verify) |
| LLM query understanding (routing/filters/HyDE/decomposition) | ✅ |
| Multi-query fusion + RRF hybrid | ✅ (lexical recall in-worker, Vectorize has no sparse) |
| CRAG + Self-RAG correction | ✅ single-shot |
| Prompt-as-data, context budget + compaction | ✅ (beyond most public systems) |
| Faithfulness judging + golden/e2e/retrieval evals | ✅ partial metric set |
| Graph lane, table-aware RAG | ❌ |
| Agentic loop / deep-research mode | ❌ (planned via Workflows) |
| LLM listwise rerank tier | ❌ |
| Span-level quote attribution | ❌ (passage-level) |
| Memory / personalization | ❌ (session only) |
| MCP servers | ❌ (planned) |
| Sample-and-verify answer selection | ❌ |
