// Citation probe (deterministic, GraphRAG): questions asking what a
// publication CITES/REFERENCES need the bibliography chunks in the
// pool, but the bibliography's embedding rarely matches the question's
// phrasing — and prior editions may carry references the current one
// dropped. This stage pattern-matches the citation question shape and
// does two things for the named document family (all editions):
//   1. surfaces the bibliography SECTIONS as passages (FTS over the
//      chunk store — no embedding similarity involved), and
//   2. injects the graph's structured `cites` edges (built at ingest
//      from the same bibliographies) as an authoritative note — the
//      graph answers the STRUCTURE (the list of cited standards), the
//      passages ground it verbatim.
// Additive: results join the pool; nothing is filtered.
import type { Stage } from "./types.ts";
import { namedDocumentIn } from "../context.ts";
import { refCodec } from "../codecs.ts";
import { standardKeyAllowed } from "../selfquery.ts";
import type { Hit } from "../../../shared/chunk.ts";

const CITE_PATTERN = /\b(?:cite[sd]?|citing|referenc(?:e|es|ed|ing)|list[s]?|quote[sd]?)\b/i;
const REFS_PATTERN = /\b(?:standard|publication|document|normative|bibliograph)/i;

export interface CiteRow {
  docidentifier: string;
  edition: string;
  active: number;
  label: string;
}

/** The authoritative citation note: per edition, the cited standards in
 * bibliography order. docLabel is the codec-normalized identifier — a
 * bare number never appears. */
export function citationGraphNote(docLabel: string, rows: CiteRow[], cap = 30): string {
  const bySrc = new Map<string, { active: boolean; labels: string[] }>();
  for (const r of rows) {
    const key = r.edition && !r.docidentifier.includes(r.edition) ? `${r.docidentifier}:${r.edition}` : r.docidentifier;
    let e = bySrc.get(key);
    if (!e) bySrc.set(key, (e = { active: !!r.active, labels: [] }));
    if (e.labels.length < cap && !e.labels.includes(r.label)) e.labels.push(r.label);
  }
  if (!bySrc.size) return "";
  const lines = [...bySrc.entries()]
    .sort((a, b) => Number(b[1].active) - Number(a[1].active))
    .map(([k, v]) => `- ${k}${v.active ? " (active edition)" : ""} cites: ${v.labels.join(", ")}`);
  return [
    `Citation graph (authoritative — extracted from the indexed bibliographies of ${docLabel}):`,
    ...lines,
    `When the question asks what ${docLabel} cites or references, answer from this list, name each standard exactly as listed, and cite the bibliography passage(s) provided in the context.`,
  ].join("\n");
}

export const citationProbe: Stage = {
  name: "citation-probe",
  failure: "additive",
  when: (c) => {
    if (!CITE_PATTERN.test(c.query) || !REFS_PATTERN.test(c.query)) return false;
    // the TEXT-derived naming (namedDocumentIn), never the LLM's
    // extraction — the understand model may omit doc_number for this
    // query shape (measured: it did)
    const named = namedDocumentIn(c.query);
    if (!named) return false;
    (c as any).__citeDocNum = named.doc_number;
    // the family key is codec-derived (label → family), never a bare number
    (c as any).__citeFamily = refCodec().familyOf(named.label);
    (c as any).__citeLabel = named.label;
    (c as any).__citeEdition = named.edition ?? null;
    return true;
  },
  prefetch: (c) => {
    // deterministic: the chunk store's own bibliography-titled chunks for
    // this document family — no embedding similarity involved (three
    // vector-probe iterations measured: the embedding never matched
    // reliably)
    const docNum = String((c as any).__citeDocNum ?? c.u?.doc_number ?? "");
    const family = (c as any).__citeFamily as string | null;
    c.lane["citation-probe"] = Promise.all([
      (async () => {
        if (!docNum) return [] as Hit[];
        try {
          // chunks_fts is a virtual FTS5 table over chunks.fts_text — it
          // has NO metadata columns. The doc_number and clause_title live
          // in the chunks content table; join them.
          const rows = await c.env.DB.prepare(
            "SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ?1 AND c.doc_number = ?2 AND (c.clause_title LIKE '%ibliograph%' OR c.clause_title LIKE '%ormative reference%') LIMIT 8",
          )
            .bind("bibliography OR references", docNum)
            .all() as { results?: Array<{ id: string }> };
          const ids = (rows.results ?? []).map((r: { id: string }) => r.id).slice(0, 8);
          if (!ids.length) return [] as Hit[];
          const got = await c.env.VECTORIZE.getByIds(ids);
          if (!got?.length) return [] as Hit[];
          // getByIds returns metadata WITHOUT the chunk text — the
          // usedHits builder calls h.text.clipToTokens and crashes on
          // undefined (the live 503). Fetch the text from D1 and merge.
          const ph = ids.map((_: string, i: number) => `?${i + 1}`).join(",");
          const texts = await c.env.DB.prepare(`SELECT id, text FROM chunks WHERE id IN (${ph})`)
            .bind(...ids)
            .all() as { results?: Array<{ id: string; text: string }> };
          const textById = new Map((texts.results ?? []).map((r) => [r.id, r.text]));
          return got
            .filter((h: any) => textById.has(h.id))
            .map((h: any) => ({ ...h, score: 10, text: textById.get(h.id)! }));
        } catch {
          return [] as Hit[];
        }
      })(),
      // the graph's cites edges for the family — structured, edition-keyed
      (async () => {
        if (!family) return [] as CiteRow[];
        try {
          const rows = await c.env.DB.prepare(
            "SELECT d.docidentifier, d.edition, d.active, n.label FROM graph_edges e JOIN documents d ON e.src = d.canonical_id JOIN graph_nodes n ON e.dst = n.id WHERE e.kind = 'cites' AND d.family = ?1 ORDER BY d.active DESC, d.edition DESC LIMIT 120",
          )
            .bind(family)
            .all() as { results?: CiteRow[] };
          return rows.results ?? [];
        } catch {
          return [] as CiteRow[];
        }
      })(),
    ]);
  },
  run: async (c) => {
    const [probes, citeRows] = (await c.lane["citation-probe"]) as [Hit[], CiteRow[]];
    const seen = new Set(c.hits.map((m: any) => m.id));
    let added = 0;
    // only bibliography-shaped chunks (clause title or text mentions it);
    // the push rides the entitlement predicate — the probe runs past the
    // pool-level license scope, and a licensed family's bibliography
    // passages must obey the same hard scope as everything else
    for (const h of probes) {
      if (seen.has(h.id as any)) continue;
      if (!standardKeyAllowed(h.metadata as any, c.opts.standardKeys)) continue;
      const title = String((h.metadata as any)?.clause_title ?? "");
      const text = String(h.text ?? "");
      if (/bibliograph|normative reference/i.test(title + " " + text.slice(0, 300))) {
        c.hits.push(h);
        seen.add(h.id as any);
        added++;
      }
    }
    // the structured note: an edition-scoped question sees only that
    // edition's citations; the family question sees all editions
    const edition = (c as any).__citeEdition as string | null;
    const scoped = edition ? citeRows.filter((r) => r.edition === edition) : citeRows;
    const note = citationGraphNote((c as any).__citeLabel as string, scoped);
    if (note) c.notes.push(note);
    console.log("citation-probe:", added, "passages,", note ? "graph note on" : "graph note off", `(${citeRows.length} cite rows)`);
  },
};
