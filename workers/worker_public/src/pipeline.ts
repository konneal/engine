import { embed, rerank } from "./ai";
import { LIMITS, MODELS, DATASETS } from "./config";
import systemPromptText from "../prompts/system.md";
import conversationalPromptText from "../prompts/conversational.md";
import listwisePromptText from "../prompts/listwise.md";
import { tableContext } from "./tablecontext";

// the pinned refusal sentence lives with the canonicalizer in ./refusal
// (refusals are never cached: a refusal says "retrieval found nothing",
// which is a property of the moment, not of the question); re-exported
// here so the existing import surface keeps working
export { REFUSAL_ANSWER } from "./refusal";

/** Fill {{TOKEN}} placeholders in a prompt data file. Unknown/empty tokens
 *  resolve to "" so optional lines vanish cleanly. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : ""));
}
import { QueryFilters, toVectorizeFilter } from "./selfquery";
import { rrfFuse } from "./hybrid";
import { lexicalPrefilter } from "./lexical";
import { toHits } from "./lib/hit";
import { QueryUnderstanding } from "./understand";
import { structuralPropagation, positionOrder, ancestorDescendantDedup } from "./structural";

export interface ChunkMeta {
  doc_id: string;
  docidentifier: string;
  doctype: string;
  doc_number: string;
  edition: string;
  language: string;
  clause_anchor: string;
  clause_title: string;
  tier: string;
  corpus: string;
  text_ref: string;
  status?: string;
  superseded_by?: string;
  /** answer contract v2: typed MKO units carry their unit id + block type */
  unit_id?: string;
  block?: string;
  /** section-summary unit (FABLE multi-granularity, arXiv:2601.18116): a
   *  depth-1 clause summary vector — a navigation node whose children
   *  (child_anchors CSV) are quotable leaf clauses. The corpus's real
   *  chunks start at depth 2, so these nodes cannot collide with them. */
  section_summary?: string;
  child_anchors?: string;
}

export interface Hit {
  id: string;
  score: number;
  rerank_score?: number;
  metadata: ChunkMeta;
  text: string;
}

export interface Retrieved {
  hits: Hit[];
  filters: QueryFilters;
  /** vocabulary link (the L2 nomenclature bridge): top defined-term
   *  candidates for the question's subject — the answer model adjudicates
   *  among them (dense retrieval alone binds everyday words to the wrong
   *  term: measured "keeps drifting" → creep 0.69 vs durability 0.54) */
  glossary?: { term: string; definition: string; docidentifier: string; doc_number: string; score: number }[];
}

// Short follow-ups are usually elliptical ("and the limits?") — fold the
// previous question into the RETRIEVAL query (generation still sees the
// original wording). Purely structural (word count): whether a question
// is elliptical is a semantic judgment, and semantics belong to the
// understanding model, whose standalone_query takes precedence anyway.
export function retrievalQuery(query: string, prev?: string): string {
  if (!prev || !prev.trim()) return query;
  const words = query.trim().split(/\s+/).length;
  if (words <= 8) return `${prev.trim()} — ${query.trim()}`;
  return query;
}

/** Typed-chunk selection for the pin: among a doc's typed units pick the
 *  one whose text best overlaps the QUERY (the first candidate is wrong as
 *  often as right — annex example tables outrank nothing). Lexical-overlap
 *  heuristic over title + serialized rows; tables, figures and formulas
 *  compete on the same score so a figure question can pin the figure
 *  (which then feeds multimodal generation), while table-value questions
 *  still pin their table on overlap. */
function pickTypedChunk(query: string, candidates: Hit[], ranked: Hit[]): Hit | null {
  if (!candidates.length) return null;
  const pool = candidates;
  const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2);
  // the top-ranked PROSE passage usually sits in the answer clause: a
  // typed chunk from that same clause is the answering object, not a
  // same-topic example from an annex
  const topProse = ranked.find((h) => !h.metadata.unit_id);
  const topAnchor = topProse?.metadata.clause_anchor ?? "";
  let best: Hit | null = null;
  let bestScore = -1;
  for (const h of pool) {
    const hay = `${h.metadata.clause_title ?? ""} ${h.text}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    if (topAnchor && h.metadata.clause_anchor === topAnchor) score += terms.length; // dominates
    // blank annex FORMS (empty value cells) are not answer tables
    const cells = h.text.split("|").map((c) => c.trim());
    const filled = cells.filter((c) => c.length > 0).length;
    const density = cells.length ? filled / cells.length : 0;
    score += density * 2;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best ?? pool[0];
}

// colloquial process questions ("how do I get a device certified to R 60")
// share almost no vocabulary with the B-series prose that answers them —
// expand the retrieval query with the corpus's own terms so the window
// contains the certification-system documents at all
const PROCESS_EXPANSION = " OIML Certification System OIML-CS issuing authority application type evaluation certificate";

export async function retrieve(
  env: any,
  query: string,
  opts: {
    prev?: string;
    understanding?: QueryUnderstanding | null;
    queryOverride?: string;
    federate?: (query: string) => Promise<Hit[]>;
    warmEmbed?: Promise<number[] | null>;
    graphDocNumbers?: string[];
    /** The declared context's HARD seal (TODO.ai-platform/02): when the
     *  panel's chip declares a document scope, the CANDIDATE POOL is cut
     *  to the publication family before rerank + the top-N cut — the
     *  soft-steer widenings below (the full-corpus lexical union, the
     *  sparse-filter widen, the sub-query lanes) can otherwise outscore
     *  the filtered dense lane under the cross-encoder and push every
     *  in-family passage out of the final hits, sealing the answer to
     *  zero despite a healthy in-family pool. */
    sealScope?: { doc_number: string; edition?: string } | null;
    /** Option C: dense-lane results computed concurrently with
     *  understanding (same folded-query vector, retrieve's exact query
     *  parameters). With no filter they REPLACE the primary dense query;
     *  with a filter they union in as discounted filter-miss cover. */
    optimisticHits?: Hit[];
    optimisticVec?: number[] | null;
  } = {},
): Promise<Retrieved> {
  const u = opts.understanding ?? null;
  // Filters and process-intent come ONLY from query understanding — no
  // regex floor, no union. When understanding is unavailable the query
  // runs unfiltered and unexpanded (vanilla retrieval); meaning is never
  // decided by string matching.
  const filters: QueryFilters | null =
    u && !u.process_intent && u.doc_number
      ? { doc_number: u.doc_number, ...(u.edition ? { edition: u.edition } : {}) }
      : null;
  const filter = filters ? toVectorizeFilter(filters) : null;
  const folded = retrievalQuery(query, opts.prev);
  let rq = opts.queryOverride?.trim() || u?.standalone_query?.trim() || folded;
  if (u?.process_intent) rq += PROCESS_EXPANSION;
  // Dense embed + full-corpus BM25 prefilter in parallel (G-ETSI-1 /
  // arXiv:2604.09868 §II-B5). Lexical must scan the whole corpus — the
  // old keywordRank only re-ordered dense hits and could not recover
  // exact-jargon misses. Fail-open: empty lexical list leaves dense alone.
  // Option C: when the query is unchanged (rq === folded) the optimistic
  // vector is already resolved — never await a fresh embed for it.
  const vectorP =
    rq === folded && opts.optimisticVec
      ? Promise.resolve(opts.optimisticVec)
      : rq === folded && opts.warmEmbed
        ? opts.warmEmbed.then((w) => w ?? embed(env.AI, MODELS.embed, rq))
        : embed(env.AI, MODELS.embed, rq);
  const lexicalP = lexicalPrefilter(env, rq).catch(() => [] as Hit[]);
  const [vector, lexicalHits0] = await Promise.all([vectorP, lexicalP]);
  // The declared context's seal binds the lexical lane at the SOURCE: the
  // RRF fusion below mixes the full-corpus lexical ranking straight into
  // the final hits — past the pool-level seal — so under a seal the
  // lexical lane is the FAMILY's lexical hits only.
  const lexicalHits = opts.sealScope
    ? lexicalHits0.filter((h) => h.metadata.doc_number === opts.sealScope!.doc_number && (!opts.sealScope!.edition || h.metadata.edition === opts.sealScope!.edition))
    : lexicalHits0;
  if (lexicalHits.length) console.log("lexical prefilter:", lexicalHits.length, "hits");
  const q: any = { topK: LIMITS.retrieveK, returnMetadata: "all" };
  if (filter) q.filter = filter;

  const optimistic = opts.optimisticHits ?? [];
  const sameLane = rq === folded; // optimistic vector === this lane's vector
  let matches: any[] = [];
  if (!filter && sameLane && optimistic.length) {
    // Option C fast path: the unfiltered dense query already ran
    // concurrently with understanding — same vector, same topK, no
    // filter. Reusing it skips one serial Vectorize round-trip with a
    // bit-for-bit identical candidate set.
    matches = optimistic.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }));
    console.log("optimistic lane: reused", matches.length, "dense hits (no re-query)");
  } else if (filter) {
    const filtered = await env.VECTORIZE.query(vector, q);
    matches = filtered.matches ?? [];
    // an edition pin corroborated by (almost) nothing means the pin was a
    // guess — understanding emits editions for families it mixes up
    // (observed: R 76 pinned @2021, an R 60 year; the corpus holds
    // 1988/1992/2006). The index is the ground truth for which editions
    // EXIST: a wrong pin starves the doc filter and the widen then floods
    // the pool with superseded editions. Drop to the doc-only filter and
    // let family-relative steering rank editions downstream. A pin the
    // user actually asked for survives — its edition exists in the corpus.
    if (filters && filters.edition && matches.length < 3) {
      const docOnly = await env.VECTORIZE.query(vector, {
        topK: LIMITS.retrieveK,
        returnMetadata: "all",
        filter: toVectorizeFilter({ doc_number: filters.doc_number }),
      });
      if ((docOnly.matches ?? []).length > matches.length) {
        console.log("edition pin dropped:", filters.doc_number, "@", filters.edition, "→", docOnly.matches?.length ?? 0, "doc-scoped hits (edition not in corpus)");
        matches = docOnly.matches ?? [];
        filters.edition = undefined;
      }
    }
    if (matches.length < LIMITS.rerankKeep) {
      // sparse doc filter → widen with the unfiltered ranking. Same lane:
      // the optimistic results ARE that ranking (identical vector, no
      // filter) — reuse them; otherwise re-query with this lane's vector.
      const unfiltered = sameLane && optimistic.length
        ? optimistic.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }))
        : (await env.VECTORIZE.query(vector, { topK: LIMITS.retrieveK, returnMetadata: "all" })).matches ?? [];
      const seen = new Set(matches.map((m: any) => m.id));
      matches = [...matches, ...unfiltered.filter((m: any) => !seen.has(m.id))];
    }
  } else {
    const res = await env.VECTORIZE.query(vector, q);
    matches = res.matches ?? [];
  }
  // NOTE: when rq diverged (standalone_query / override) the optimistic
  // hits are deliberately NOT unioned. Measured 2026-08-30: injecting the
  // raw question's top-50 into a rewritten query's pool let topically
  // close but wrong documents outscore the correct ones under the
  // cross-encoder — recall@5 fell 94.3% → 89.7% (golden ×3). The
  // optimistic lane may only REPLACE an identical query, never dilute a
  // better one.

  // ── HyDE (Hypothetical Document Embeddings) ──
  // Embed the hypothetical answer and search with it — its vocabulary
  // matches the corpus better than the question's. Only for non-filtered
  // queries (a filter would nullify the benefit).
  // Ref: arXiv 2212.10496; arXiv 2507.16754 (adaptive HyDE)
  if (u?.hypothetical_answer && !filter) {
    try {
      const hv = await embed(env.AI, MODELS.embed, u.hypothetical_answer);
      const hres = await env.VECTORIZE.query(hv, { topK: 20, returnMetadata: "all" });
      const seenIds = new Set(matches.map((m: any) => m.id));
      for (const m of (hres.matches ?? []).slice(0, 10)) {
        if (!seenIds.has(m.id)) {
          matches.push({ id: m.id, score: m.score * 0.7, metadata: m.metadata });
          seenIds.add(m.id);
        }
      }
    } catch {
      // HyDE is additive; primary results stand
    }
  }

  // ── Graph lane ──
  // The D1 projection (relaton structure + Glossarist defines edges)
  // resolves what the query's WORDS map to in the corpus's own structure:
  // a defined term → the documents that define it; a named publication →
  // its family/successors. Same query vector, graph-filtered candidates —
  // vocabulary mismatch stops mattering when the graph carries the link.
  if (opts.graphDocNumbers?.length && vector) {
    try {
      const g = await env.VECTORIZE.query(vector, {
        topK: 15,
        returnMetadata: "all",
        filter: { doc_number: { $in: opts.graphDocNumbers } },
      });
      const seenIds = new Set(matches.map((m: any) => m.id));
      let merged = 0;
      for (const m of (g.matches ?? []).slice(0, 10)) {
        if (!seenIds.has(m.id)) {
          matches.push({ id: m.id, score: m.score * 0.75, metadata: m.metadata });
          seenIds.add(m.id);
          merged++;
        }
      }
      console.log("graph lane:", g.matches?.length ?? 0, "hits,", merged, "merged");
    } catch {
      // graph lane is additive; primary results stand
    }
  }

  // ── Multi-Query RAG-Fusion ──
  // Generate 2-3 alternative phrasings, retrieve for each, fuse via RRF.
  // Different phrasings surface documents the original query misses.
  // Ref: RAG-Fusion paper (Semantic Scholar b4d1da74); dev.to 2026 blueprint
  if (u?.query_variants?.length) {
    // the variants are independent queries — embed + search them in
    // PARALLEL; a serial loop paid 2 x (embed + query) round trips on
    // the hot path for zero quality difference (same candidate set)
    const variantResults = (
      await Promise.all(
        u.query_variants.slice(0, 3).map(async (variant) => {
          try {
            const vv = await embed(env.AI, MODELS.embed, variant);
            const vres = await env.VECTORIZE.query(vv, { topK: 20, returnMetadata: "all", ...(filter ? { filter } : {}) });
            return (vres.matches ?? []).map((m: any) => ({
              id: m.id,
              score: m.score,
              metadata: (m.metadata ?? {}) as ChunkMeta,
              text: (m.metadata?.chunk_text as string) ?? "",
            })) as Hit[];
          } catch {
            return [] as Hit[]; // variant retrieval failure — primary results stand
          }
        }),
      )
    ).filter((r) => r.length > 0);
    // RRF fuse: primary ranking + each variant ranking
    if (variantResults.length > 0) {
      const allRankings: Hit[][] = [
        matches.map((m: any) => ({
          id: m.id,
          score: m.score,
          metadata: (m.metadata ?? {}) as ChunkMeta,
          text: (m.metadata?.chunk_text as string) ?? "",
        })),
        ...variantResults,
      ];
      // simple RRF across all rankings
      const scores = new Map<string, number>();
      const byId = new Map<string, Hit>();
      allRankings.forEach((ranking) => {
        ranking.forEach((h, i) => {
          scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (60 + i + 1));
          byId.set(h.id, h);
        });
      });
      const fused = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, LIMITS.retrieveK)
        .map(([id]) => byId.get(id)!)
        .filter(Boolean);
      if (fused.length > 0) {
        matches = fused.map((h) => ({ id: h.id, score: h.score, metadata: h.metadata }));
      }
    }
  }

  // ── Multi-hop decomposition for complex questions ──
  // Retrieve for each sub-question and merge the top results.
  // Ref: Agent-Orchestrated Adaptive RAG (arXiv 2606.05658)
  if (u?.complexity === "complex" && u.sub_queries?.length) {
    // sub-questions are independent — parallel rounds, same as variants
    const subResults = (
      await Promise.all(
        u.sub_queries.slice(0, 4).map(async (sub) => {
          try {
            const sv = await embed(env.AI, MODELS.embed, sub);
            const sres = await env.VECTORIZE.query(sv, { topK: 15, returnMetadata: "all" });
            return (sres.matches ?? []).map((m: any) => ({
              id: m.id,
              score: m.score,
              metadata: (m.metadata ?? {}) as ChunkMeta,
              text: (m.metadata?.chunk_text as string) ?? "",
            })) as Hit[];
          } catch {
            return [] as Hit[]; // sub-query failure — primary results stand
          }
        }),
      )
    ).filter((r) => r.length > 0);
    // merge sub-results into the candidate pool (union, no RRF — these
    // are complementary perspectives, not alternatives)
    const seenIds = new Set(matches.map((m: any) => m.id));
    for (const sr of subResults) {
      for (const h of sr.slice(0, 8)) {
        if (!seenIds.has(h.id)) {
          matches.push({ id: h.id, score: h.score * 0.8, metadata: h.metadata });
          seenIds.add(h.id);
        }
      }
    }
  }

  let hits: Hit[] = matches.map((m) => ({
    id: m.id,
    score: m.score,
    metadata: (m.metadata ?? {}) as ChunkMeta,
    text: (m.metadata?.chunk_text as string) ?? "",
  }));

  // Union full-corpus lexical hits that dense missed (G-ETSI-1). Prefer
  // dense metadata/text when both sources return the same id.
  if (lexicalHits.length) {
    const seen = new Set(hits.map((h) => h.id));
    let added = 0;
    for (const h of lexicalHits) {
      if (!seen.has(h.id)) {
        hits.push(h);
        seen.add(h.id);
        added++;
      }
    }
    if (added) console.log("lexical union:", added, "new candidates");
  }

  // ── Federated ISO/IEC tier ──
  // Members get passages from the internal index (service binding) merged
  // into the same candidate pool; the shared reranker + fusion below sort
  // it out. Slight discount: the public corpus answers by default.
  if (opts.federate) {
    const fed = await opts.federate(rq).catch(() => [] as Hit[]);
    const seen = new Set(hits.map((h) => h.id));
    for (const h of fed) {
      if (!seen.has(h.id)) {
        hits.push({ ...h, score: h.score * 0.95 });
        seen.add(h.id);
      }
    }
  }

  // The declared context's hard seal (TODO.ai-platform/02) — pool-level,
  // after every lane has merged, before rerank + the top-N cut. Nothing
  // outside the declared family competes for the window; everything
  // inside it does.
  if (opts.sealScope) {
    const before = hits.length;
    hits = hits.filter((h) => h.metadata.doc_number === opts.sealScope!.doc_number && (!opts.sealScope!.edition || h.metadata.edition === opts.sealScope!.edition));
    console.log("context seal:", before, "→", hits.length, "candidates within", `doc#${opts.sealScope.doc_number}${opts.sealScope.edition ? "@" + opts.sealScope.edition : ""}`);
  }

  // overview chunks repeat the title/doctype boilerplate and embed strongly
  // for name-like queries, crowding clause chunks out of the rerank window
  for (const h of hits) {
    if (h.metadata.clause_anchor === "overview") h.score *= 0.85;
  }
  // family chunks carry the multi-part structure (which parts/annexes
  // exist) — they must reach the model for 'what is R 60' / 'how many
  // parts' queries. Vector similarity alone won't rank them because
  // they're short structural summaries competing with content-heavy
  // clause text. Boost them decisively for doc-scoped queries.
  if (filter?.doc_number) {
    for (const h of hits) {
      if (h.metadata.clause_anchor === "family") {
        h.score = Math.max(h.score, ...hits.map((x) => x.score)) + 1;
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const tRerank = Date.now();

  if (hits.length > 1) {
    // 1. cross-encoder rerank (semantic precision)
    try {
      const scores = await rerank(env.AI, MODELS.rerank, query, hits.map((h) => h.text));
      console.log("stage: rerank", Date.now() - tRerank, "ms over", hits.length, "candidates");
      if (scores) {
        hits.forEach((h, i) => (h.rerank_score = scores[i]));
        hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
        // the pre-rerank family boost does not survive re-sorting — short
        // structural summaries always lose to content-heavy clauses under
        // a cross-encoder. For doc-scoped queries pin family chunks AFTER
        // rerank: 'what is R 60' must lead with the family summary, not
        // an annex definition that happens to match the words.
        if (filter?.doc_number) {
          const families = hits.filter((h) => h.metadata.clause_anchor === "family");
          if (families.length) {
            hits = [...families, ...hits.filter((h) => h.metadata.clause_anchor !== "family")];
          }
        }

      }
    } catch {
      // vector order is the fallback, by design
    }

    // 2. RRF with the FULL-CORPUS lexical ranking (not a re-score of the
    //    dense shortlist). ETSI §II-B7: dense+sparse fusion lifts precision
    //    and MRR on standards jargon without changing recall.
    if (lexicalHits.length > 0) {
      hits = rrfFuse(hits, lexicalHits, LIMITS.retrieveK);
    }
  }

  // Exact term lookup: the understanding names the term; clause chunks
  // whose head IS the term get a decisive nudge (publication headers
  // contain the title words, so the reranker alone is unreliable here)
  if (u?.term) {
    const scored = hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      const esc = u.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const termRe = new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, "i");
      for (const h of hits) {
        const body = h.text.split("\n").slice(1).join(" ").slice(0, 200);
        const hay = `${h.metadata.clause_title || ""} ${body}`.toLowerCase();
        if (termRe.test(hay)) h.rerank_score = (h.rerank_score ?? h.score) + spread * 1.5;
      }
      hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
    }
  }

// Edition steering, family-relative: when the query does not pin an
  // edition, chunks from an OLDER edition of a publication are demoted
  // whenever a NEWER edition of the SAME publication is in the pool.
  // Superseded editions match archaic phrasing strongly (their wording is
  // what the question echoes) and the per-doc diversity cap then fills the
  // publication's slots with them — observed: R 76-1:1992/1988 passages
  // displacing the current R 76-1:2006 on complex unfiltered queries.
  // Cross-publication recency is deliberately NOT touched: a 1992
  // publication that is still current must not be demoted because some
  // unrelated 2024 document exists. Scaled to the live rerank spread —
  // the scores cluster within ~0.001.
  if (!filters?.edition && hits.length > 1) {
    const year = (s?: string) => (/^(19|20)\d{2}$/.test(s ?? "") ? Number(s) : null);
    const scored = hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      const newest = new Map<string, number>();
      let anyYear = 0;
      for (const h of hits) {
        const y = year(h.metadata.edition);
        if (!y || y < 1990) continue;
        const k = `${h.metadata.docidentifier}|${h.metadata.language}`;
        newest.set(k, Math.max(newest.get(k) ?? 0, y));
        anyYear = Math.max(anyYear, y);
      }
      // cross-publication tie-break: a current-edition publication ranks
      // over stale ones (load-bearing — par-prepackaged: R 87:2004 must
      // outrank 1990s texts); composed WITH the family-relative demotion
      // below, which dominates for same-publication duplicates
      if (anyYear > 1990) {
        for (const h of hits) {
          const y = year(h.metadata.edition);
          if (y && y >= 1990) {
            h.rerank_score = (h.rerank_score ?? h.score) + spread * 0.1 * ((y - 1990) / (anyYear - 1990));
          }
        }
      }
      let demoted = 0;
      for (const h of hits) {
        const y = year(h.metadata.edition);
        const max = newest.get(`${h.metadata.docidentifier}|${h.metadata.language}`);
        if (y && max && y < max) {
          // the older the edition relative to the family's newest, the
          // stronger the demotion; a sibling exactly one revision back
          // still competes when its clause is the only source (§5 of the
          // paper: superseded editions stay citable when current ones
          // lack the content)
          h.rerank_score = (h.rerank_score ?? h.score) - spread * 0.4 * ((max - y) / Math.max(1, max - 1990));
          demoted++;
        }
      }
      if (demoted) {
        console.log("edition steering: demoted", demoted, "superseded-edition chunks (family-relative)");
        hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      } else if (anyYear > 1990) {
        hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      }
    }
  }

  // ── Structural propagation (FABLE TreeExpansion, arXiv:2601.18116) ──
  // The corpus IS a tree: clause anchors chain parent→child, so a hit's
  // score blends with its ancestors' (topic continuity) and descendants'
  // (subtopic heat) — a section whose clauses are collectively hot rises,
  // and a hot section lifts its clauses. Pure post-retrieval re-scoring
  // over metadata the chunks already carry; no new index lane required.
  hits = structuralPropagation(hits);

  // Per-publication diversity, keyed by normalized identity: overview
  // chunks are near-duplicates across editions — at most ONE per
  // publication; clause chunks get a higher cap so content can fill slots.
  const perDoc = new Map<string, number>();
  let overviews = 0;
  const diversified: Hit[] = [];
  for (const h of hits) {
    const isOverview = h.metadata.clause_anchor === "overview";
    // a doc-number query matches every part (R 60-1/-2/Annexe A) — without
    // a global overview cap their near-identical overviews crowd out the
    // definition and clause chunks the answer needs
    const ovCap = filters?.doc_number ? 6 : 2; // part overviews of the queried family are signal, not noise
    if (isOverview && overviews >= ovCap) continue;
    const key = `${h.metadata.docidentifier}|${h.metadata.language}`;
    const n = perDoc.get(key) ?? 0;
    const cap = isOverview ? 1 : filters?.doc_number ? 3 : 2;
    if (n < cap) {
      diversified.push(h);
      perDoc.set(key, n + 1);
      if (isOverview) overviews += 1;
    }
    if (diversified.length >= LIMITS.rerankKeep + 2) break;
  }

  // ── Vocabulary link (the L2 nomenclature bridge) ──
  // Everyday words don't match defined terms — the one gap every
  // comparison lane fails. Dense candidates + cross-encoder rerank, and
  // the ANSWER model adjudicates among the top-2 (the entity-linking
  // pattern: retrieval proposes, generation disambiguates — naive top-1
  // dense binding picks the wrong term). Runs BEFORE the typed pin: the
  // candidates' defining publications also anchor the pin's family (a
  // term question names the family even when the question text doesn't).
  let glossary: NonNullable<Retrieved["glossary"]> = [];
  if (env.GLOSSARY && vector) {
    try {
      const g = await env.GLOSSARY.query(vector, { topK: 5, returnMetadata: "all" });
      const cands = (g.matches ?? []).filter((m: any) => m.score >= 0.5);
      if (cands.length) {
        const texts = cands.map((m: any) => String(m.metadata?.chunk_text ?? ""));
        const rs = await rerank(env.AI, MODELS.rerank, query, texts);
        const ranked = cands
          .map((m: any, i: number) => ({
            term: String(m.metadata?.clause_title ?? "").trim(),
            definition: String(m.metadata?.chunk_text ?? "").split(" — ").slice(1).join(" — ").slice(0, 300),
            docidentifier: String(m.metadata?.docidentifier ?? ""),
            doc_number: String(m.metadata?.doc_number ?? ""),
            score: rs ? rs[i] : m.score,
          }))
          .filter((x: any) => x.term && x.definition);
        // one entry per DISTINCT term — the same concept is often defined
        // by several publications and the top-2 would repeat it (observed:
        // "maximum number of load cell verification intervals" twice, the
        // first instance from the wrong family)
        const byTerm = new Map<string, (typeof ranked)[number]>();
        for (const r of ranked) if (!byTerm.has(r.term)) byTerm.set(r.term, r);
        glossary = [...byTerm.values()].sort((a, b) => b.score - a.score).slice(0, 2);
        if (glossary.length) console.log("glossary link:", glossary.map((g2) => g2.term).join(", "));
      }
    } catch {
      // additive lane; primary results stand
    }
  }

  // answer contract v2 — typed-chunk pin (FINAL position): doc-scoped
  // queries get ONE typed unit chunk (table first) guaranteed a slot.
  // Prose outranks serialized tables under the cross-encoder AND the
  // per-doc diversity cap counts typed chunks against the same doc key —
  // without this guarantee the model never sees a unit id to reference.
  let finalHits = diversified.slice(0, LIMITS.rerankKeep);
  // family scope: the hard doc filter, else the understanding's family,
  // else the UNION of the vocabulary link's candidate families — a value
  // question can straddle families that define near-identical tables
  // (n_LC class B = 5 000 exists in R 60-1 AND R 76-2); pickTypedChunk's
  // overlap + top-prose-anchor scoring then picks the right table among
  // them instead of the family choice deciding in advance
  const glossaryFamilies = new Set<string>();
  for (const g of glossary) if (g.doc_number) glossaryFamilies.add(g.doc_number.split("-")[0]);
  const pinFamily = filters?.doc_number ?? u?.doc_number ?? null;
  const pinFamilies = new Set<string>(pinFamily ? [pinFamily.split("-")[0]] : [...glossaryFamilies]);
  if (pinFamilies.size) {
    const base = (dn?: string) => String(dn ?? "").split("-")[0];
    const sameDocTyped = (h: Hit) =>
      !!h.metadata.unit_id && !!h.metadata.block && pinFamilies.has(base(h.metadata.doc_number));
    {
      // the pin guarantees the BEST query-overlap typed unit a slot — not
      // merely "some" typed unit. Hard doc scope pins unconditionally
      // (existing behavior); the glossary-family union (no hard scope)
      // pins only on real query overlap — the picker always returns
      // SOMETHING, and a near-zero-overlap table riding the window on
      // every vocabulary-linked query would be pollution.
      const typed = pickTypedChunk(query, hits.filter(sameDocTyped), hits);
      const hardScope = !!pinFamily;
      const overlap = (() => {
        if (!typed || hardScope) return Infinity;
        const terms = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2);
        const hay = `${typed.metadata.clause_title ?? ""} ${typed.text}`.toLowerCase();
        return terms.filter((t) => hay.includes(t)).length;
      })();
      if (typed && overlap >= 3 && !finalHits.some((h) => h.id === typed.id)) {
        finalHits = [...finalHits.slice(0, LIMITS.rerankKeep - 1), typed];
        console.log("typed pin:", typed.metadata.docidentifier, "§", typed.metadata.clause_anchor, `(${typed.metadata.block})${hardScope ? "" : " [glossary families]"}`);

        // small-to-big (the hierarchy every bundle carries): an
        // embedded object answers WITH its clause — if the parent
        // clause's prose passage is not already among the finals, one
        // metadata-filtered fetch adds it. The typed unit cites; the
        // clause grounds.
        const anchor = typed.metadata.clause_anchor;
        const docId = typed.metadata.doc_id;
        const parentPresent = finalHits.some(
          (h) => h.metadata.doc_id === docId && h.metadata.clause_anchor === anchor && !h.metadata.unit_id,
        );
        if (anchor && docId && !parentPresent) {
          try {
            const pv = await env.VECTORIZE.query(vector, {
              topK: 4,
              returnMetadata: "all",
              filter: { $and: [{ doc_id: { $eq: docId } }, { clause_anchor: { $eq: anchor } }] },
            });
            const parent = (pv.matches ?? []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata, text: m.metadata?.chunk_text ?? "" })).find((h: any) => !h.metadata?.unit_id);
            if (parent && !finalHits.some((h) => h.id === parent.id)) {
              finalHits = [...finalHits, { ...parent, score: parent.score * 0.7 }];
              console.log("small-to-big: parent §", anchor, "of", typed.metadata.docidentifier, "added");
            }
          } catch {
            // additive lane; primary results stand
          }
        }
      }
    }
  }

  // ── Section-summary units → leaf evidence (FABLE multi-granularity) ──
  // A depth-1 summary vector that ranked is a navigation node, not
  // quotable evidence: fetch its top child clauses (metadata-filtered,
  // same query vector) so the model gets source text to cite, then retire
  // the synthetic summary — the answer contract grounds claims in source
  // clauses, never in our own summaries. The summary stays only when no
  // child answered (it is then the doc's sole representative).
  const sectionHit = finalHits.find(
    (h) => h.metadata.section_summary === "1" && h.metadata.child_anchors && h.score > 0,
  );
  if (sectionHit && vector) {
    try {
      const kids = sectionHit
        .metadata.child_anchors!.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 25);
      if (kids.length) {
        const cv = await env.VECTORIZE.query(vector, {
          topK: 3,
          returnMetadata: "all",
          filter: {
            $and: [
              { doc_id: { $eq: sectionHit.metadata.doc_id } },
              { clause_anchor: { $in: kids } },
            ],
          },
        });
        const childHits = (cv.matches ?? [])
          .filter((m: any) => !m.metadata?.section_summary)
          .map((m: any) => ({
            id: m.id,
            score: m.score * 0.8,
            metadata: m.metadata as ChunkMeta,
            text: (m.metadata?.chunk_text as string) ?? "",
          }))
          .filter((c: Hit) => !finalHits.some((h) => h.id === c.id))
          .slice(0, 2);
        if (childHits.length) {
          finalHits = [...finalHits.filter((h) => h !== sectionHit), ...childHits];
          console.log(
            "section descent:",
            sectionHit.metadata.docidentifier,
            "§" + sectionHit.metadata.clause_anchor,
            "→",
            childHits.map((c: Hit) => "§" + c.metadata.clause_anchor).join(", "),
          );
        }
      }
    } catch {
      // additive lane; primary results stand
    }
  }

  // Same-chain near-duplicate collapse (FABLE ancestor-descendant dedup)
  finalHits = ancestorDescendantDedup(finalHits);

  return { hits: finalHits, filters: filters ?? {}, ...(glossary?.length ? { glossary } : {}) };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// ── context budget ─────────────────────────────────────────────────────
// The model window is finite; without a cap, a long conversation plus 8
// clause chunks (tables can be huge) overflows and the request FAILS
// outright. Everything is estimated (never exact) and stays well under
// the smallest context our models accept. Priority when the budget is
// tight: system + query always fit → newest history gets a bounded slice
// → passages fill the rest, best-ranked first, worst-ranked dropped.

function estTokens(s: string): number {
  // CJK/Arabic/Indic scripts ≈ 1 token per char; Latin ≈ 1 per 4 chars
  const wide = (s.match(/[؀-ۿݐ-ݿऀ-ॿ぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  return wide + Math.ceil((s.length - wide) / 4);
}

function clipToTokens(s: string, maxTok: number): string {
  if (maxTok < 40 || estTokens(s) <= maxTok) return s;
  const wide = (s.match(/[؀-ۿݐ-ݿऀ-ॿ぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  const latinChars = Math.max(0, maxTok - wide) * 4;
  return s.slice(0, Math.min(s.length, wide + latinChars)).trimEnd() + " …";
}

export interface BuiltMessages {
  messages: { role: string; content: string }[];
  usedHits: Hit[]; // passages actually included (citations must match these)
}

/** System instruction for a conversational (non-knowledge) turn: the
 *  service facts the model speaks from, composed from the DATASETS
 *  catalog — the same SSOT /api/datasets serves. Routing is decided by
 *  query UNDERSTANDING (understanding.ts), never by string matching. */
export function identityNote(member: boolean): string {
  const corpora = DATASETS.filter((d) => !d.session || member)
    .map((d) => `- ${d.label}: ${d.description}`)
    .join("\n");
  const locked = DATASETS.filter((d) => d.session && !member);
  const upsell = locked.length
    ? `Signed-in members additionally search: ${locked.map((d) => `${d.label} (${d.description})`).join("; ")}.`
    : "";
  return fill(conversationalPromptText, { CORPORA: corpora, UPSELL: upsell })
    .split("\n")
    .filter((l) => l.trim())
    .join("\n");
}

/** Split history into the turns that fit the budget slice (kept, newest)
 *  and the older ones that must be compacted into a summary (overflow). */
export function splitHistory(
  history: HistoryTurn[],
  budgetTokens: number,
): { kept: HistoryTurn[]; overflow: HistoryTurn[] } {
  const historyBudget = Math.floor(budgetTokens * 0.3);
  let used = 0;
  let cut = 0; // everything before `cut` overflows
  for (let i = history.length - 1; i >= 0; i--) {
    const t = Math.min(estTokens(history[i].content), 600);
    if (used + t > historyBudget) {
      cut = i + 1;
      break;
    }
    used += t;
  }
  return { kept: history.slice(cut), overflow: history.slice(0, cut) };
}


/** Final-tier LLM listwise rerank: jointly reorders the top passages for
 *  hard queries (cascade stage after the cross-encoder). Null = keep the
 *  incoming order (timeout/parse failure never blocks serving). */
export async function listwiseRerank(
  env: any,
  model: string,
  query: string,
  hits: Hit[],
): Promise<Hit[] | null> {
  if (hits.length < 4) return null;
  try {
    const listing = hits
      .map((h, i) => {
        const label = `${h.metadata.docidentifier || h.metadata.doc_id}:${h.metadata.edition || ""} §${h.metadata.clause_anchor || ""}`;
        return `[${i + 1}] ${label.replace(/(:|§)+$/g, "")} — ${h.text.replace(/\s+/g, " ").slice(0, 220)}`;
      })
      .join("\n");
    // bounded to 2.5s: this call sits serially before generation starts —
    // a slow reorder must never hold the first token hostage; the
    // cross-encoder order is the fallback and is already good
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2500));
    const call = (async () => {
      const res: any = await env.AI.run(model, {
        messages: [
          { role: "system", content: listwisePromptText.trimEnd() },
          { role: "user", content: `Question: ${query}\n\nPassages:\n${listing}` },
        ],
        max_tokens: 700,
        reasoning_effort: "low",
      });
      const text = typeof res?.response === "string" ? res.response : res?.choices?.[0]?.message?.content;
      const m = (text ?? "").match(/\[[\s\S]*?\]/);
      if (!m) return null;
      const order = JSON.parse(m[0]);
      if (!Array.isArray(order) || order.length !== hits.length) return null;
      const idx = order.map((n: unknown) => Number(n) - 1);
      if (idx.some((n: number) => !Number.isInteger(n) || n < 0 || n >= hits.length) || new Set(idx).size !== hits.length) return null;
      return idx.map((n: number) => hits[n]);
    })();
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  }
}

export function buildMessages(
  query: string,
  hits: Hit[],
  lang?: string,
  history: HistoryTurn[] = [],
  retrievalNote?: string,
  conversationSummary?: string,
  budgetTokens: number = LIMITS.inputTokenBudget,
): BuiltMessages {
  // per-corpus guidance travels WITH the dataset (config.ts): every
  // dataset whose corpus appears in the passages contributes its note —
  // new corpora need a catalog entry, never pipeline changes
  const corpusNotes = DATASETS.filter(
    (d) => d.note && hits.some((h) => (h.metadata as any).corpus === d.id),
  )
    .map((d) => d.note!)
    .join("\n");

  // the prompt itself is data (prompts/system.md); one rule per line,
  // joined with spaces exactly as the original array form
  const system = fill(systemPromptText, {
    HISTORY_CONTEXT: history.length
      ? " Earlier turns of this conversation are provided for context — answer the LATEST question, treating the passages below as the source of truth for facts and citations."
      : "",
    CORPUS_NOTES: corpusNotes,
    LANG_CLAUSE: lang ? ` (explicitly requested: ${lang})` : "",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");

  // history: newest-first into a bounded slice (oldest dropped first);
  // each turn is clipped so accounting and content agree
  const historyBudget = Math.floor(budgetTokens * 0.3);
  const keptHistory: { role: "user" | "assistant"; content: string }[] = [];
  let historyUsed = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = clipToTokens(history[i].content, 600);
    const t = estTokens(content);
    if (historyUsed + t > historyBudget) break;
    keptHistory.unshift({ role: history[i].role, content });
    historyUsed += t;
  }

  // passages: best-ranked first into whatever remains
  const summaryBlock = conversationSummary
    ? `Earlier in this conversation (summarized for continuity):\n${conversationSummary}`
    : "";
  let remain =
    budgetTokens - estTokens(system) - estTokens(retrievalNote ?? "") - estTokens(summaryBlock) - estTokens(`Question: ${query}\n\nContext passages:\n`) - historyUsed - 120; // slack for estimator error + output framing
  const passageParts: string[] = [];
  const usedHits: Hit[] = [];
  // Passage label as the MODEL should cite it (it copies these into
  // answers): drop OIML language markers, append the edition only when
  // the identifier doesn't already carry it ("B 18:2025 (E)" + "2025" →
  // no ":2025"; "PD-06 Edition 4" + "4" → no ":4"), and never show a
  // producer UUID as a clause anchor — cite the clause title instead.
  const passageLabel = (m: ChunkMeta): string => {
    const id = (m.docidentifier || m.doc_id || "source").replace(/\s*\(([A-Z])\)\s*$/, "").trim();
    const edition = m.edition && !id.includes(m.edition) ? ":" + m.edition : "";
    const raw = String(m.clause_anchor ?? "");
    const garbage = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw) || (raw.startsWith("_") && raw.length > 12);
    const anchor = garbage || !raw ? "" : ` §${raw}`;
    return `${id}${edition}${anchor}`;
  };
  // passages in document reading order (FABLE NodeFusion): same-doc
  // clauses read top-to-bottom, docs by best rank — synthesis quality
  // depends on arrangement, not just the selected set
  for (const h of positionOrder(hits)) {
    const st = h.metadata.status === "withdrawn" || h.metadata.status === "superseded" ? ` [${h.metadata.status}]` : "";
    const label = `${passageLabel(h.metadata)}${st}`;
    // answer contract v2: typed passages declare their unit id so the
    // model can reference [[u:<id>]] instead of retyping the object
    const unitTag = (h.metadata as any).unit_id ? ` unit ${(h.metadata as any).unit_id}${(h.metadata as any).block ? ` (${(h.metadata as any).block})` : ""}` : "";
    const head = `[${usedHits.length + 1}] ${label}${unitTag} ${h.metadata.clause_title ? "— " + h.metadata.clause_title : ""}\n`;
    // tables: schema-aware pruning from the producer payload; the
    // stored text is the fallback (pruning never goes below baseline)
    const pruned = (h.metadata as any).block === "table" ? tableContext(h.metadata, query) : null;
    const body = clipToTokens(pruned ?? h.text, LIMITS.maxPassageTokens);
    const t = estTokens(head) + estTokens(body);
    if (t <= remain) {
      passageParts.push(head + body);
      usedHits.push(h);
      remain -= t;
    } else if (usedHits.length < 2) {
      // always keep at least the two best passages, truncated to fit
      passageParts.push(head + clipToTokens(h.text, Math.max(150, remain - estTokens(head))));
      usedHits.push(h);
      remain = 0;
      break;
    } else break;
  }
  const context = passageParts.join("\n\n") || "(no passages)";

  return {
    messages: [
      { role: "system", content: system },
      ...(retrievalNote ? [{ role: "system", content: retrievalNote }] : []),
      ...(summaryBlock ? [{ role: "system", content: summaryBlock }] : []),
      ...keptHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: `Question: ${query}\n\nContext passages:\n${context}` },
    ],
    usedHits,
  };
}

function oimlPublicationUrl(meta: ChunkMeta): string | undefined {
  if (!meta.doctype || !meta.doc_number) return undefined;
  const typeMap: Record<string, string> = { R: "r", D: "d", B: "b", G: "g", E: "e" };
  const t = typeMap[meta.doctype];
  if (!t) return undefined;
  return `https://www.oiml.org/en/publications/${t}${meta.doc_number}`;
}

export function citations(hits: Hit[]) {
  const rank = (s?: string) => (s === "in-force" || s === "joint" ? 0 : s === "unknown" || !s ? 1 : 2);
  return [...hits]
    .map((h) => ({
      doc_id: h.metadata.doc_id,
      docidentifier: h.metadata.docidentifier,
      edition: h.metadata.edition,
      language: h.metadata.language,
      clause_anchor: h.metadata.clause_anchor,
      clause_title: h.metadata.clause_title,
      status: h.metadata.status ?? "unknown",
      superseded_by: h.metadata.superseded_by || undefined,
      corpus: h.metadata.corpus || "oiml",
      url: oimlPublicationUrl(h.metadata),
      snippet: h.text.slice(0, 400),
      score: h.rerank_score ?? h.score,
    }))
    .sort((a, b) => rank(a.status) - rank(b.status)); // in-force first, withdrawn last
}
