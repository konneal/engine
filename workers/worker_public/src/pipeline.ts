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
  return { hits: hits.slice(0, LIMITS.rerankKeep), filters };
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
    "Quote normative values exactly (MPE values, accuracy classes, edition-specific wording) — do not round or paraphrase them.",
    "If the context does not contain the answer, reply exactly: I don't have information on this in the indexed OIML publications. — never invent content.",
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
