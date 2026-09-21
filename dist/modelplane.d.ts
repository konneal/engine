/** The first model-node id a text names (the declared chip label first,
 *  the question second — the caller orders). */
export declare function modelNodeRefIn(text: string | undefined | null): string | null;
/** The doc scope's publication family → the model plane's standard
 *  (doc_number "60" → oiml-r60). Only the four modeled Recommendations
 *  carry a plane; anything else resolves null (honest: no model to bind). */
export declare function standardForDocNumber(docNumber: string | undefined): string | null;
/** The license entry for a package id (the model-plane standard id, e.g.
 *  `iec-60068-2-30`), or null when the package is public content. */
export declare function licensedEntryForPackage(packageId: string | undefined | null): {
    key: string;
    package: string;
    doc_number?: string;
    title?: string;
    edition?: string;
} | null;
/** The license entry for a doc number (the question's named publication,
 *  e.g. "60068-2-30"), or null when unnamed/public. */
export declare function licensedEntryForDocNumber(docNumber: string | undefined | null): {
    key: string;
    package: string;
    doc_number?: string;
    title?: string;
    edition?: string;
} | null;
/** The per-question license boundary note: composed ONLY when the
 *  question's named/understood publication is licensed AND the caller's
 *  entitlement set does not carry its key. The honesty posture, made
 *  structural: name the standard, say the organization's license does
 *  not cover its text, keep every procedural claim out, point at the
 *  declare flow. Citation-level metadata (title, edition, the invoking
 *  clause the RECs publicly name) stays answerable from the public
 *  passages already in context — the note instructs exactly that. */
export declare function licenseBoundaryNote(docNumber: string | undefined | null, standardKeys: ReadonlySet<string> | null | undefined): string | undefined;
/** The deterministic boundary answer for the zero-passage case: the
 *  question's licensed publication has nothing to show an unentitled
 *  caller — name the standard, state the boundary, point at the declare
 *  flow. Undefined when the question is not the licensed case (the plain
 *  refusal applies). */
export declare function licenseBoundaryRefusal(docNumber: string | undefined | null, standardKeys: ReadonlySet<string> | null | undefined): string | undefined;
export interface BoundModelNode {
    standard: string;
    node_id: string;
    kind: string;
    name: string;
    clause: {
        doc: string;
        ref: string;
        urn: string;
    } | null;
    /** The node's bundle projection (verbatim JSON). */
    content: any;
    /** True when the node's package is licensed and the caller's
     *  entitlement set lacks the key (TODO.external-refs/08): the citation
     *  and the echo stay (metadata), but the grounding block and the
     *  verdict engine are withheld — no licensed machine content enters
     *  the prompt. */
    gated?: boolean;
}
/** Bind the ask's model node: the declared entity label's id wins (the
 *  model-aware chip), then a node id the question names. The standard
 *  comes from the declared doc scope when it carries one; without a scope
 *  the node binds only when it exists in EXACTLY ONE indexed standard —
 *  ambiguity is refused honestly (retrieval still surfaces the chunks).
 *  A licensed package binds GATED for an unentitled caller (metadata
 *  only — the grounding block and the verdict engine are the ask path's
 *  to withhold). */
export declare function bindModelNode(env: any, opts: {
    label?: string;
    query: string;
    standard?: string | null;
    standardKeys?: ReadonlySet<string> | null;
}): Promise<BoundModelNode | null>;
/** The structured grounding block for the prompt — every line is the
 *  node's own declared content (the bundle projection), never a model
 *  paraphrase. The discrepancy block, when the model declares one, is the
 *  model/prose disagreement posture made structural. */
export declare function modelGroundingBlock(node: BoundModelNode): string;
/** The citation the panel renders for the bound node (the model plane is
 *  a first-class corpus: the citation names the node + its clause). */
export declare function modelCitation(node: BoundModelNode): {
    doc_id: string;
    docidentifier: string;
    edition: string;
    language: string;
    clause_anchor: string;
    clause_title: string;
    status: string;
    corpus: string;
    url: undefined;
    snippet: string;
    score: number;
};
/** The context_applied echo's model block — the honest context line's
 *  grounding record. */
export declare function modelEcho(node: BoundModelNode): {
    clause?: string | undefined;
    node_id: string;
    kind: string;
    standard: string;
};
/** The per-corpus guidance note (config.ts's DATASETS pattern — every
 *  retrieved model-plane chunk carries it, chip or no chip). */
export declare function modelCorpusNote(): string;
