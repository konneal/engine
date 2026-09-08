// Graph expansion (G8 query lane): map understanding's term onto the
// D1 projection (graph_nodes / graph_edges) and return the doc_numbers
// the graph says are relevant. Mirrors graph.py's node-id format
// (doc:OIML-R-60-1-2017, concept:<id>).
import type { Env } from "./env";

/** Graph expansion (G8 query lane): map understanding's term / named
 *  document onto the D1 projection (graph_nodes / graph_edges) and return
 *  the doc_numbers the graph says are relevant. Mirrors graph.py's node-id
 *  format (doc:OIML-R-60-1-2017, concept:<id>). */
function docNumberOf(nodeId: string): string | null {
  // doc:OIML-R-60-1-2017 → "60" | doc:OIML-B-18-2025 → "18"
  const m = nodeId.match(/^doc:OIML-[A-Z]-(\d+)-/);
  return m ? m[1] : null;
}

export async function graphExpand(env: Env, u: { term?: string | null; defined_terms?: string[]; docidentifier?: string | null } | null): Promise<string[] | undefined> {
  if (!env.DB || !u) return undefined;
  const numbers = new Set<string>();
  const terms = [...(u.defined_terms ?? []), ...(u.term ? [u.term] : [])].filter((t) => t.length >= 3);
  try {
    for (const term of terms.slice(0, 4)) {
      const rows = await env.DB.prepare(
        "SELECT e.src AS doc FROM graph_edges e JOIN graph_nodes c ON e.dst = c.id WHERE e.kind = 'defines' AND c.kind = 'concept' AND (c.label = ?1 OR c.label LIKE ?2) LIMIT 12",
      )
        .bind(term, `%${term}%`)
        .all<{ doc: string }>();
      for (const r of rows.results ?? []) {
        const n = docNumberOf(r.doc);
        if (n) numbers.add(n);
      }
    }
    // NOTE: the docidentifier branch is deliberately absent — a named
    // document already gets the exact doc_number filter; merging its
    // annex/variant neighbors only pollutes doc-level queries. The graph
    // lane exists for VOCABULARY MISMATCH (everyday words → defined term
    // → defining documents), which no filter can express.
  } catch {
    return numbers.size ? [...numbers] : undefined;
  }
  console.log("graphExpand: terms", JSON.stringify(terms), "→", JSON.stringify([...numbers]));
  return numbers.size ? [...numbers].slice(0, 6) : undefined;
}

/** Edition registry note (documents table): when the query names a
 *  publication, tell the model which editions are ACTIVE so superseded
 *  passages are treated as such — derived status from successor edges,
 *  not the fallible relaton status field. */
export async function editionNote(env: Env, u: { doc_number?: string | null } | null): Promise<string | undefined> {
  if (!env.DB || !u?.doc_number) return undefined;
  try {
    const rows = await env.DB.prepare(
      "SELECT docidentifier FROM documents WHERE family = (SELECT family FROM documents WHERE docidentifier LIKE ?1 || '%:%' LIMIT 1) AND active = 1",
    )
      .bind(`% ${u.doc_number}:%`)
      .all<{ docidentifier: string }>();
    const actives = (rows.results ?? []).map((r) => r.docidentifier);
    if (!actives.length) return undefined;
    return `Publication registry (authoritative): the ACTIVE edition(s) for this publication are ${actives.join(", ")}. Passages from other editions are superseded — use them only for historical comparison and say so.`;
  } catch {
    return undefined;
  }
}
