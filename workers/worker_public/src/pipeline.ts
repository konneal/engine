import { embed, rerank } from "./ai";
import { LIMITS, MODELS } from "./config";
import { QueryFilters, toVectorizeFilter, extractFilters, PROCESS_INTENT_RE } from "./selfquery";
import { keywordRank, rrfFuse } from "./hybrid";
import { toHits } from "./lib/hit";
import { QueryUnderstanding } from "./understand";

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
}

// "give me more details" is semantically empty on its own — fold the
// previous question into the RETRIEVAL query (generation still sees the
// original wording) so follow-ups search the right neighborhood
export function retrievalQuery(query: string, prev?: string): string {
  if (!prev || !prev.trim()) return query;
  const words = query.trim().split(/\s+/).length;
  const vague = /^(more|continue|details?|elaborate|why|how so|and|also|explain|go on)\b/i.test(query.trim());
  if (words <= 8 || vague) return `${prev.trim()} — ${query.trim()}`;
  return query;
}

// colloquial process questions ("how do I get a device certified to R 60")
// share almost no vocabulary with the B-series prose that answers them —
// expand the retrieval query with the corpus's own terms so the window
// contains the certification-system documents at all
const PROCESS_EXPANSION = " OIML Certification System OIML-CS issuing authority application type evaluation certificate";

export async function retrieve(
  env: any,
  query: string,
  opts: { prev?: string; understanding?: QueryUnderstanding | null; queryOverride?: string; federate?: (query: string) => Promise<Hit[]> } = {},
): Promise<Retrieved> {
  const u = opts.understanding ?? null;
  // UNION of signals: deterministic regexes are the floor (tested, zero
  // latency); the LLM understanding layers on top for what regexes cannot
  // see (creative phrasings, context rewriting). Both contribute.
  const rf = extractFilters(query);
  const filters: QueryFilters =
    u && !u.process_intent && u.doc_number
      ? { doc_number: u.doc_number, ...(u.edition ? { edition: u.edition } : {}) }
      : rf;
  const filter = toVectorizeFilter(filters);
  let rq = opts.queryOverride?.trim() || u?.standalone_query?.trim() || retrievalQuery(query, opts.prev);
  if (u?.process_intent || PROCESS_INTENT_RE.test(query)) rq += PROCESS_EXPANSION;
  const vector = await embed(env.AI, MODELS.embed, rq);
  const q: any = { topK: LIMITS.retrieveK, returnMetadata: "all" };
  if (filter) q.filter = filter;

  let matches: any[] = [];
  if (filter) {
    const filtered = await env.VECTORIZE.query(vector, q);
    matches = filtered.matches ?? [];
    if (matches.length < LIMITS.rerankKeep) {
      const unfiltered = await env.VECTORIZE.query(vector, { topK: LIMITS.retrieveK, returnMetadata: "all" });
      const seen = new Set(matches.map((m: any) => m.id));
      matches = [...matches, ...(unfiltered.matches ?? []).filter((m: any) => !seen.has(m.id))];
    }
  } else {
    const res = await env.VECTORIZE.query(vector, q);
    matches = res.matches ?? [];
  }

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

  // ── Multi-Query RAG-Fusion ──
  // Generate 2-3 alternative phrasings, retrieve for each, fuse via RRF.
  // Different phrasings surface documents the original query misses.
  // Ref: RAG-Fusion paper (Semantic Scholar b4d1da74); dev.to 2026 blueprint
  if (u?.query_variants?.length) {
    const variantResults: Hit[][] = [];
    for (const variant of u.query_variants.slice(0, 3)) {
      try {
        const vv = await embed(env.AI, MODELS.embed, variant);
        const vres = await env.VECTORIZE.query(vv, { topK: 20, returnMetadata: "all", ...(filter ? { filter } : {}) });
        const vhits: Hit[] = (vres.matches ?? []).map((m: any) => ({
          id: m.id,
          score: m.score,
          metadata: (m.metadata ?? {}) as ChunkMeta,
          text: (m.metadata?.chunk_text as string) ?? "",
        }));
        variantResults.push(vhits);
      } catch {
        // variant retrieval failure — the primary results stand
      }
    }
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
    const subResults: Hit[][] = [];
    for (const sub of u.sub_queries.slice(0, 4)) {
      try {
        const sv = await embed(env.AI, MODELS.embed, sub);
        const sres = await env.VECTORIZE.query(sv, { topK: 15, returnMetadata: "all" });
        subResults.push(
          (sres.matches ?? []).map((m: any) => ({
            id: m.id,
            score: m.score,
            metadata: (m.metadata ?? {}) as ChunkMeta,
            text: (m.metadata?.chunk_text as string) ?? "",
          })),
        );
      } catch {
        // sub-query failure — primary results stand
      }
    }
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

  if (hits.length > 1) {
    // 1. cross-encoder rerank (semantic precision)
    try {
      const scores = await rerank(env.AI, MODELS.rerank, query, hits.map((h) => h.text));
      if (scores) {
        hits.forEach((h, i) => (h.rerank_score = scores[i]));
        hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      }
    } catch {
      // vector order is the fallback, by design
    }

    // 2. keyword (lexical) ranking — catches exact terms dense embeddings
    //    miss (part numbers, "n_LC", defined terms)
    const keywordRanked = keywordRank(rq, hits);

    // 3. RRF fusion of dense+rerank ranking with keyword ranking
    //    (only when keyword actually found something)
    if (keywordRanked.length > 0) {
      hits = rrfFuse(hits, keywordRanked, LIMITS.retrieveK);
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

// Edition recency: when the query does not pin an edition, newer editions
  // get a tie-break nudge so stale duplicate chunks don't crowd out current
  // ones. Scaled to the live score spread — rerank scores cluster within
  // ~0.001, so any fixed-magnitude boost would reorder everything.
  if (!filters.edition && hits.length > 1) {
    const year = (s?: string) => (/^(19|20)\d{2}$/.test(s ?? "") ? Number(s) : null);
    const scored = hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      const years = hits.map((h) => year(h.metadata.edition)).filter((y): y is number => y !== null && y >= 1990);
      const max = years.length ? Math.max(...years) : 0;
      for (const h of hits) {
        const y = year(h.metadata.edition);
        if (y && y >= 1990 && max > 1990) {
          h.rerank_score = (h.rerank_score ?? h.score) + spread * 0.1 * ((y - 1990) / (max - 1990));
        }
      }
      hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
    }
  }

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
    const ovCap = filters.doc_number ? 6 : 2; // part overviews of the queried family are signal, not noise
    if (isOverview && overviews >= ovCap) continue;
    const key = `${h.metadata.docidentifier}|${h.metadata.language}`;
    const n = perDoc.get(key) ?? 0;
    const cap = isOverview ? 1 : filters.doc_number ? 3 : 2;
    if (n < cap) {
      diversified.push(h);
      perDoc.set(key, n + 1);
      if (isOverview) overviews += 1;
    }
    if (diversified.length >= LIMITS.rerankKeep + 2) break;
  }
  return { hits: diversified.slice(0, LIMITS.rerankKeep), filters };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export function buildMessages(query: string, hits: Hit[], lang?: string, history: HistoryTurn[] = [], retrievalNote?: string) {
  const context = hits
    .map((h, i) => {
      const st = h.metadata.status === "withdrawn" || h.metadata.status === "superseded" ? ` [${h.metadata.status}]` : "";
      const label = `${h.metadata.docidentifier || h.metadata.doc_id}:${h.metadata.edition || ""} §${h.metadata.clause_anchor || ""}${st}`.replace(/(:|§)+$/g, "");
      return `[${i + 1}] ${label} ${h.metadata.clause_title ? "— " + h.metadata.clause_title : ""}\n${h.text}`;
    })
    .join("\n\n");

  const isoHits = hits.some((h) => (h.metadata as any).corpus === "iso");

  const system = [
    "You answer questions about OIML publications (legal metrology: Recommendations, Documents, Basic publications, Guides).",
    "Use ONLY the numbered context passages provided. Never use outside knowledge for substantive claims.",
    "Cite every claim inline with the passage label as plain text in square brackets, e.g. [OIML R 87:2004 §3.2] — never as markdown links, never invent URLs. Cite only provided passages.",
    "Quote normative values exactly (MPE values, accuracy classes, limits, edition-specific wording) — do not round, convert or paraphrase them.",
    "For definitions, quote the source definition verbatim.",
    "Publications are issued in parts and annex volumes (e.g. OIML R 60-1, OIML R 60-A, 'OIML R 60 (Annexes)') — a passage from any part or annex of a publication IS that publication's content; use and cite it as such. This includes bibliography and normative-reference lists found in those volumes.",
    "When passages from several editions of the same document appear, answer from the most recent edition unless the question names an edition; say which edition you used.",
    "Passages carry a status (in-force, superseded, withdrawn). Prefer in-force editions for normative claims; if you must cite a superseded or withdrawn edition, say so explicitly.",
    "Synthesize practical answers from the passages: definitions, procedures and rules across passages answer the question even when no single passage states the answer verbatim — cite each passage you draw on.",
    "MANDATORY: when the question asks how to do something (get certified, apply, comply, register, test) and the passages describe the governing system or procedure, ALWAYS answer with that procedure citing the governing documents. Refusing such a question because the passages do not name the specific publication is WRONG — the publication sets technical requirements; the HOW is governed by the certification-system documents in the passages.",
    "Refuse (with ONLY this exact sentence: I don't have information on this in the indexed OIML publications.) only when NO passage relates to the question's topic — never invent content.",
    ...(isoHits
      ? [
          "Some passages come from the internal ISO/IEC corpus (labeled ISO/IEC …) — use them alongside the OIML passages and cite them the same way.",
        ]
      : []),
    "Be concise and precise. Answer in the question's language" + (lang ? ` (explicitly requested: ${lang})` : "") + ".",
  ].join(" ");

  const systemWithHistory = history.length
    ? system.replace(
        "You answer questions about OIML publications",
        "You answer questions about OIML publications. Earlier turns of this conversation are provided for context — answer the LATEST question, treating the passages below as the source of truth for facts and citations",
      )
    : system;

  return [
    { role: "system", content: systemWithHistory },
    ...(retrievalNote ? [{ role: "system", content: retrievalNote }] : []),
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: `Question: ${query}\n\nContext passages:\n${context}` },
  ];
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
