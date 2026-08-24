import { embed, rerank } from "./ai";
import { LIMITS, MODELS } from "./config";
import { extractFilters, toVectorizeFilter, QueryFilters } from "./selfquery";

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

export async function retrieve(env: any, query: string): Promise<Retrieved> {
  const filters = extractFilters(query);
  const vector = await embed(env.AI, MODELS.embed, query);
  const q: any = { topK: LIMITS.retrieveK, returnMetadata: "all" };
  const filter = toVectorizeFilter(filters);
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

  const hits: Hit[] = matches.map((m) => ({
    id: m.id,
    score: m.score,
    metadata: (m.metadata ?? {}) as ChunkMeta,
    text: (m.metadata?.chunk_text as string) ?? "",
  }));

  // overview chunks repeat the title/doctype boilerplate and embed strongly
  // for name-like queries, crowding clause chunks out of the rerank window
  for (const h of hits) {
    if (h.metadata.clause_anchor === "overview") h.score *= 0.85;
  }
  hits.sort((a, b) => b.score - a.score);

  if (hits.length > 1) {
    try {
      const scores = await rerank(env.AI, MODELS.rerank, query, hits.map((h) => h.text));
      if (scores) {
        hits.forEach((h, i) => (h.rerank_score = scores[i]));
        hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
      }
    } catch {
      // vector order is the fallback, by design
    }
  }

  // Exact term lookup: definition questions ("what is a load cell") target a
  // term entry whose clause_title IS the term — a decisive nudge when it
  // exists, no effect otherwise. Lexically identical headers on every chunk
  // of the same publication make the reranker alone unreliable here.
  {
    const dm = query.match(
      /^(?:what is|what are|what's|define|definition of|qu'est-ce que(?: le | la | les | l'|un |une )?|qu'est-ce qu'(?:un |une )?|was ist|qué es(?: un | una | el | la )?)\s+(.+?)[?]*\s*$/i,
    );
    if (dm) {
      let term = (dm[1] ?? "").trim().toLowerCase();
      // drop qualifier tails: "a load cell according to OIML R 60" → "load cell"
      term = term.split(/,| according to | per | dans | dans le | dans la | selon | d'après | in | of the /)[0];
      term = term.replace(/^(?:a|an|the|un|une|le|la|les|l')\s+/, "").replace(/[.,;:!?]+$/, "");
      if (term.length >= 3) {
        const scored = hits.map((h) => h.rerank_score ?? h.score);
        const spread = Math.max(...scored) - Math.min(...scored);
        if (spread > 0) {
          // term entries may carry a bare clause number as title with the
          // term name at the head of the body — match both
          const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const termRe = new RegExp(`(^|[^a-zà-ÿ])${esc}([^a-zà-ÿ]|$)`);
          for (const h of hits) {
            // skip the header line — it names the publication, so for R 60
            // it contains "load cell" and would match every chunk
            const body = h.text.split("\n").slice(1).join(" ").slice(0, 200);
            const hay = `${h.metadata.clause_title || ""} ${body}`.toLowerCase();
            if (termRe.test(hay)) {
              h.rerank_score = (h.rerank_score ?? h.score) + spread * 1.5;
            }
          }
          hits.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));
        }
      }
    }
  }

  // Language nudge: an English question should not lose its slots to French
  // duplicates when both exist (and vice versa) — tie-break magnitude only.
  {
    const qLang = /ñ/i.test(query)
      ? "es"
      : /ß/i.test(query) || /[äöü]/i.test(query)
        ? "de"
        : /[àâçéèêëîïôùûüœ]|qu'|d'un|d'une/i.test(query)
          ? "fr"
          : "en";
    const scored = hits.map((h) => h.rerank_score ?? h.score);
    const spread = Math.max(...scored) - Math.min(...scored);
    if (spread > 0) {
      for (const h of hits) {
        if (h.metadata.language === qLang) {
          h.rerank_score = (h.rerank_score ?? h.score) + spread * 0.15;
        }
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
    if (isOverview && overviews >= 2) continue;
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

export function buildMessages(query: string, hits: Hit[], lang?: string) {
  const context = hits
    .map((h, i) => {
      const label = `${h.metadata.docidentifier || h.metadata.doc_id}:${h.metadata.edition || ""} §${h.metadata.clause_anchor || ""}`.replace(/(:|§)+$/g, "");
      return `[${i + 1}] ${label} ${h.metadata.clause_title ? "— " + h.metadata.clause_title : ""}\n${h.text}`;
    })
    .join("\n\n");

  const system = [
    "You answer questions about OIML publications (legal metrology: Recommendations, Documents, Basic publications, Guides).",
    "Use ONLY the numbered context passages provided. Never use outside knowledge for substantive claims.",
    "Cite every claim inline with the passage label, e.g. [OIML R 87:2004 §3.2]. Cite only provided passages.",
    "Quote normative values exactly (MPE values, accuracy classes, limits, edition-specific wording) — do not round, convert or paraphrase them.",
    "For definitions, quote the source definition verbatim.",
    "When passages from several editions of the same document appear, answer from the most recent edition unless the question names an edition; say which edition you used.",
    "If the context does not contain the answer, reply with ONLY this exact sentence and nothing else: I don't have information on this in the indexed OIML publications. — never invent content.",
    "Be concise and precise. Answer in the question's language" + (lang ? ` (explicitly requested: ${lang})` : "") + ".",
  ].join(" ");

  return [
    { role: "system", content: system },
    { role: "user", content: `Question: ${query}\n\nContext passages:\n${context}` },
  ];
}

export function citations(hits: Hit[]) {
  return hits.map((h) => ({
    doc_id: h.metadata.doc_id,
    docidentifier: h.metadata.docidentifier,
    edition: h.metadata.edition,
    language: h.metadata.language,
    clause_anchor: h.metadata.clause_anchor,
    clause_title: h.metadata.clause_title,
    snippet: h.text.slice(0, 400),
    score: h.rerank_score ?? h.score,
  }));
}
