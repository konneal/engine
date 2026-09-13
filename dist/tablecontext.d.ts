/** Schema-aware table context composition (TableRAG-class cell
 *  selection) over the producer's typed table payload. Pure — the
 *  interface is the test surface. */
/** Schema-aware table context (TableRAG-class cell selection): the
 *  producer payload (metadata.table) carries caption/columns/rows; the
 *  consumer composes the model-facing serialization — columns whose
 *  labels overlap the query, rows whose cells overlap the query or the
 *  selected column labels. Full table stays available for rendering;
 *  this only shapes the prompt context, and falls back to the stored
 *  text when pruning matches nothing (never worse than baseline). */
export declare function tableContext(meta: any, query: string): string | null;
