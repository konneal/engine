import { embed, rerank } from "./ai";
import { LIMITS, MODELS, DATASETS } from "./config";
import systemPromptText from "../prompts/system.md";
import conversationalPromptText from "../prompts/conversational.md";
import listwisePromptText from "../prompts/listwise.md";

/** The one sanctioned refusal sentence (also in prompts/system.md).
 *  Refusals are never cached: a refusal says "retrieval found nothing",
 *  which is a property of the moment, not of the question. */
export const REFUSAL_ANSWER = "I don't have information on this in the indexed OIML publications.";

/** Fill {{TOKEN}} placeholders in a prompt data file. Unknown/empty tokens
 *  resolve to "" so optional lines vanish cleanly. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : ""));
}
import { QueryFilters, toVectorizeFilter } from "./selfquery";
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

// colloquial process questions ("how do I get a device certified to R 60")
// share almost no vocabulary with the B-series prose that answers them —
// expand the retrieval query with the corpus's own terms so the window
// contains the certification-system documents at all
const PROCESS_EXPANSION = " OIML Certification System OIML-CS issuing authority application type evaluation certificate";

export async function retrieve(
  env: any,
  query: string,
  opts: { prev?: string; understanding?: QueryUnderstanding | null; queryOverride?: string; federate?: (query: string) => Promise<Hit[]>; warmEmbed?: Promise<number[] | null>; graphDocNumbers?: string[] } = {},
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
  // the folded query can be embedded WHILE understanding runs — if the
  // final retrieval query turns out to be exactly that, the warm embedding
  // (started ~2s earlier) is reused and the serial understand→embed
  // pipeline collapses to max(understand, embed)
  const vector =
    rq === folded && opts.warmEmbed
      ? ((await opts.warmEmbed) ?? (await embed(env.AI, MODELS.embed, rq)))
      : await embed(env.AI, MODELS.embed, rq);
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
  if (!filters?.edition && hits.length > 1) {
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
  return { hits: diversified.slice(0, LIMITS.rerankKeep), filters: filters ?? {} };
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
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));
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
  for (const h of hits) {
    const st = h.metadata.status === "withdrawn" || h.metadata.status === "superseded" ? ` [${h.metadata.status}]` : "";
    const label = `${h.metadata.docidentifier || h.metadata.doc_id}:${h.metadata.edition || ""} §${h.metadata.clause_anchor || ""}${st}`.replace(/(:|§)+$/g, "");
    const head = `[${usedHits.length + 1}] ${label} ${h.metadata.clause_title ? "— " + h.metadata.clause_title : ""}\n`;
    const body = clipToTokens(h.text, LIMITS.maxPassageTokens);
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
