import type { Hit } from "./pipeline";
/** Rank all candidates by keyword overlap against the query. */
export declare function keywordRank(query: string, hits: Hit[]): Hit[];
/** Fuse two rankings with Reciprocal Rank Fusion.
 *  score(d) = Σ 1/(k + rank_i(d)) — rank-agnostic, robust across
 *  heterogeneous scorers (dense + sparse). */
export declare function rrfFuse(dense: Hit[], keyword: Hit[], keep: number): Hit[];
