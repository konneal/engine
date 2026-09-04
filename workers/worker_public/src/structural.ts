// Structural retrieval over the producer-native clause tree — serving-path
// adaptations of FABLE/BEAR (arXiv:2601.18116) to a corpus that already HAS
// the hierarchy: Metanorma clause anchors ARE the tree, so unlike FABLE no
// LLM tree-builder runs at index time. Three techniques:
//
//   - structuralPropagation: TreeExpansion's relevance propagation — a
//     clause blends its own score with its ancestors' (topic continuity)
//     and descendants' (subtopic heat): sections whose clauses are
//     collectively hot rise, hot sections lift their clauses.
//   - positionOrder: NodeFusion's position-preserving ordering — evidence
//     is presented in document reading order (per publication, groups by
//     selection priority), because synthesis quality depends on
//     arrangement, not just set membership.
//   - ancestorDescendantDedup: near-duplicate chunks of the same clause
//     chain (parent §3.1 vs child §3.1.2 repeating its heading + text)
//     collapse to the stronger one before the window is cut.
import type { Hit } from "./pipeline";

/** "3.1.2" → [3,1,2]; null for everything else (annex labels, producer
 *  UUIDs, overview/family, empty). */
export function parseAnchor(anchor: string | undefined | null): number[] | null {
  if (!anchor) return null;
  const a = anchor.trim().replace(/\.$/, "");
  if (!/^\d+(\.\d+)*$/.test(a)) return null;
  return a.split(".").map(Number);
}

/** a is a PROPER ancestor of b ("3.1" ⊳ "3.1.2"). */
export function isAncestorOf(a: number[], b: number[]): boolean {
  return a.length < b.length && b.slice(0, a.length).every((s, i) => s === a[i]);
}

/** Document order for dotted numeric anchors ("3" < "3.1" < "3.1.2" < "3.2"). */
export function anchorCompare(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

const scoreOf = (h: Hit) => h.rerank_score ?? h.score;

/** TreeExpansion-style structural propagation (Eq. 7 of the paper):
 *  S(v) = (self + inherited + childAgg)/3, blended into the live score as
 *  a spread-scaled adjustment — same idiom as edition steering, so the
 *  adjustment can never outrank the cross-encoder's own signal. */
export function structuralPropagation(hits: Hit[]): Hit[] {
  if (hits.length < 3) return hits;
  const scored = hits.map(scoreOf);
  const min = Math.min(...scored);
  const max = Math.max(...scored);
  const spread = max - min;
  if (spread <= 0) return hits;

  const byDoc = new Map<string, { h: Hit; a: number[]; n: number }[]>();
  for (const h of hits) {
    const a = parseAnchor(h.metadata.clause_anchor);
    if (!a) continue;
    const k = h.metadata.doc_id;
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k)!.push({ h, a, n: (scoreOf(h) - min) / spread });
  }

  let adjusted = 0;
  for (const nodes of byDoc.values()) {
    if (nodes.length < 2) continue;
    for (const nd of nodes) {
      let inherited: number | null = null;
      let childSum = 0;
      let childN = 0;
      for (const other of nodes) {
        if (other === nd) continue;
        if (isAncestorOf(other.a, nd.a)) inherited = Math.max(inherited ?? 0, other.n);
        else if (isAncestorOf(nd.a, other.a)) {
          childSum += other.n;
          childN++;
        }
      }
      if (inherited === null && childN === 0) continue;
      const s = (nd.n + (inherited ?? nd.n) + (childN ? childSum / childN : nd.n)) / 3;
      const adj = spread * 0.2 * (s - nd.n);
      if (Math.abs(adj) < 1e-9) continue;
      if (nd.h.rerank_score !== undefined) nd.h.rerank_score += adj;
      else nd.h.score += adj;
      adjusted++;
    }
  }
  if (adjusted) {
    console.log("structural propagation:", adjusted, "hits re-scored across the clause tree");
    hits.sort((a, b) => scoreOf(b) - scoreOf(a));
  }
  return hits;
}

/** Position-preserving evidence order (NodeFusion, Algorithm 2): passages
 *  of the same publication are fed in document order, publications ordered
 *  by their best-ranked member. Document order is the PRODUCER'S ordinal
 *  when the metadata carries one (metanorma-document#56) — a sort, never
 *  an anchor parse; the anchor compare is the fallback for chunks whose
 *  producer doesn't emit ordinals. Structural chunks (overview/family)
 *  lead their doc; unnumbered passages follow the numbered ones. */
export function positionOrder(hits: Hit[]): Hit[] {
  if (hits.length < 3) return hits;
  const idx = new Map(hits.map((h, i) => [h, i]));
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const k = h.metadata.doc_id || h.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(h);
  }
  const rank = (g: Hit[]) => Math.min(...g.map((h) => idx.get(h)!));
  const structural = (h: Hit) => h.metadata.clause_anchor === "overview" || h.metadata.clause_anchor === "family";
  const byOrig = (a: Hit, b: Hit) => idx.get(a)! - idx.get(b)!;
  const byDocOrder = (a: Hit, b: Hit) => {
    const oa = (a.metadata as any).ordinal;
    const ob = (b.metadata as any).ordinal;
    if (typeof oa === "number" && typeof ob === "number" && oa !== ob) return oa - ob;
    const pa = parseAnchor(a.metadata.clause_anchor);
    const pb = parseAnchor(b.metadata.clause_anchor);
    if (pa && pb) return anchorCompare(pa, pb) || byOrig(a, b);
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return byOrig(a, b);
  };

  const out: Hit[] = [];
  for (const g of [...groups.values()].sort((a, b) => rank(a) - rank(b))) {
    const head = g.filter(structural).sort(byOrig);
    const ordered = g.filter((h) => !structural(h)).sort(byDocOrder);
    out.push(...head, ...ordered);
  }
  return out;
}

const headText = (h: Hit) => h.text.replace(/\s+/g, " ").toLowerCase().slice(0, 600);

function overlap(a: string, b: string): number {
  const A = new Set(a.split(/[^a-z0-9°%]+/).filter((t) => t.length > 3));
  const B = new Set(b.split(/[^a-z0-9°%]+/).filter((t) => t.length > 3));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Same-chain near-duplicate collapse: when an ancestor chunk and a
 *  descendant chunk of one clause chain carry substantially the same text,
 *  the weaker one leaves the window (FABLE keeps the subtree, drops the
 *  redundant node). Different-text relatives both stay — a parent clause
 *  and a deep sub-clause are usually different content. */
export function ancestorDescendantDedup(hits: Hit[]): Hit[] {
  if (hits.length < 2) return hits;
  const anchors = hits.map((h) => parseAnchor(h.metadata.clause_anchor));
  const drop = new Set<Hit>();
  for (let i = 0; i < hits.length; i++) {
    if (!anchors[i] || drop.has(hits[i])) continue;
    for (let j = i + 1; j < hits.length; j++) {
      if (!anchors[j] || drop.has(hits[j])) continue;
      if (hits[i].metadata.doc_id !== hits[j].metadata.doc_id) continue;
      const chained = isAncestorOf(anchors[i]!, anchors[j]!) || isAncestorOf(anchors[j]!, anchors[i]!);
      if (!chained) continue;
      if (overlap(headText(hits[i]), headText(hits[j])) >= 0.5) {
        drop.add(scoreOf(hits[i]) >= scoreOf(hits[j]) ? hits[j] : hits[i]);
      }
    }
  }
  if (drop.size) {
    console.log("structural dedup:", drop.size, "same-chain near-duplicate(s) dropped");
    return hits.filter((h) => !drop.has(h));
  }
  return hits;
}
