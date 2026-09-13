/** The first model-node id a text names (the declared chip label first,
 *  the question second — the caller orders). */
export declare function modelNodeRefIn(text: string | undefined | null): string | null;
/** The doc scope's publication family → the model plane's standard
 *  (doc_number "60" → oiml-r60). Only the four modeled Recommendations
 *  carry a plane; anything else resolves null (honest: no model to bind). */
export declare function standardForDocNumber(docNumber: string | undefined): string | null;
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
}
/** Bind the ask's model node: the declared entity label's id wins (the
 *  model-aware chip), then a node id the question names. The standard
 *  comes from the declared doc scope when it carries one; without a scope
 *  the node binds only when it exists in EXACTLY ONE indexed standard —
 *  ambiguity is refused honestly (retrieval still surfaces the chunks). */
export declare function bindModelNode(env: any, opts: {
    label?: string;
    query: string;
    standard?: string | null;
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
    url: any;
    snippet: string;
    score: number;
};
/** The context_applied echo's model block — the honest context line's
 *  grounding record. */
export declare function modelEcho(node: BoundModelNode): {
    clause?: string;
    node_id: string;
    kind: string;
    standard: string;
};
/** The per-corpus guidance note (config.ts's DATASETS pattern — every
 *  retrieved model-plane chunk carries it, chip or no chip). */
export declare const MODEL_CORPUS_NOTE = "Some passages are the OIML SMART model plane (labeled OIML SMART model) \u2014 the platform's machine-readable Recommendation models derived from the Primmel packages. Treat their machine limits, applicability rules and acceptance criteria as the model's own statement of them (quote machine limits verbatim); where a model passage and a prose passage disagree, say so explicitly and cite both.";
