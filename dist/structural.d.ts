import type { Hit } from "./pipeline";
/** "3.1.2" → [3,1,2]; null for everything else (annex labels, producer
 *  UUIDs, overview/family, empty). */
export declare function parseAnchor(anchor: string | undefined | null): number[] | null;
/** a is a PROPER ancestor of b ("3.1" ⊳ "3.1.2"). */
export declare function isAncestorOf(a: number[], b: number[]): boolean;
/** Document order for dotted numeric anchors ("3" < "3.1" < "3.1.2" < "3.2"). */
export declare function anchorCompare(a: number[], b: number[]): number;
/** TreeExpansion-style structural propagation (Eq. 7 of the paper):
 *  S(v) = (self + inherited + childAgg)/3, blended into the live score as
 *  a spread-scaled adjustment — same idiom as edition steering, so the
 *  adjustment can never outrank the cross-encoder's own signal. */
export declare function structuralPropagation(hits: Hit[]): Hit[];
/** Position-preserving evidence order (NodeFusion, Algorithm 2): passages
 *  of the same publication are fed in document order, publications ordered
 *  by their best-ranked member. Document order is the PRODUCER'S ordinal
 *  when the metadata carries one (metanorma-document#56) — a sort, never
 *  an anchor parse; the anchor compare is the fallback for chunks whose
 *  producer doesn't emit ordinals. Structural chunks (overview/family)
 *  lead their doc; unnumbered passages follow the numbered ones. */
export declare function positionOrder(hits: Hit[]): Hit[];
/** Same-chain near-duplicate collapse: when an ancestor chunk and a
 *  descendant chunk of one clause chain carry substantially the same text,
 *  the weaker one leaves the window (FABLE keeps the subtree, drops the
 *  redundant node). Different-text relatives both stay — a parent clause
 *  and a deep sub-clause are usually different content. */
export declare function ancestorDescendantDedup(hits: Hit[]): Hit[];
