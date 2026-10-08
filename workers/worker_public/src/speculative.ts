// ── Speculative draft-verify, the geometry (TODO.sota/02, row 2) ──
//
// The partition of the answer window into DIVERSIFIED subsets: hits
// group by document (first-seen order), the groups deal round-robin
// into the subsets, and each subset keeps reading order. Fewer than two
// distinct documents means nothing to diversify — the orchestration
// (ask.ts) falls through to the normal single-shot generation.
//
// Self-contained (no imports) so the unit tests run on plain node type
// stripping, like ablate/answercache/verdict. The LLM legs (draft per
// subset, the strong verifier) live in ask.ts beside the other
// ask-path mechanisms; their gate is the ablation grid (TODO.sota/09),
// never the unit suite.

export const SPECULATIVE_SUBSETS = 3;

/** Minimal structural shape the partition reads. */
export interface Partitionable {
  metadata: { docidentifier?: string; doc_id?: string };
}

export function partitionSubsets<T extends Partitionable>(
  hits: T[],
  k: number = SPECULATIVE_SUBSETS,
): T[][] | null {
  const groups: T[][] = [];
  const byDoc = new Map<string, T[]>();
  for (const h of hits) {
    const key = h.metadata.docidentifier || h.metadata.doc_id || "";
    const arr = byDoc.get(key) ?? [];
    arr.push(h);
    if (arr.length === 1) groups.push(arr);
    byDoc.set(key, arr);
  }
  if (groups.length < 2) return null;
  const subsets: T[][] = Array.from({ length: Math.min(k, groups.length) }, () => []);
  groups.forEach((g, i) => subsets[i % subsets.length].push(...g));
  return subsets;
}
