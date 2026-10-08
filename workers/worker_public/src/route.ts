// ── The adaptive router (TODO.sota/05, the catalog's row 1) ──
//
// Query features (understanding's own output, never string hacks) pick
// the route: FAST drops the candidate-expansion lanes (hyde, multi-
// query, sub-query — each costs extra embeds and Vectorize queries, and
// for a scoped, definitional, or short question they rarely fire); DEEP
// keeps the full registry. The stage registry IS the switch: the route
// is a projection of the same registry, never a second pipeline.
//
// The policy is deliberately conservative — ambiguous questions route
// DEEP, and the caller-declared effort always wins — because the
// routing frontier is a measured claim (TODO.sota/09's grid scores
// route-fast, route-deep and adaptive on the dev half; the policy
// thresholds tune after that evidence, never before).
//
// Self-contained (no imports) so the unit tests run on plain node type
// stripping, like ablate/answercache/verdict.

export type Route = "fast" | "deep";

/** Minimal structural shape of the understanding the router reads —
 *  the full contract lives in understandContract.ts; this subset keeps
 *  the module self-contained. */
export interface RouteFeatures {
  complexity?: "simple" | "complex" | null;
  doc_number?: string | null;
  term?: string | null;
  defined_terms?: string[];
  sub_queries?: string[];
  process_intent?: boolean;
}

/** THRESHOLDS-adjacent policy numbers (declared here until the grid
 *  measures them; every steering number lives in one place — this is
 *  the router's place). */
export const ROUTE_FAST_WORD_CAP = 10;

/** The candidate-expansion lanes the fast route drops (the stage
 *  names in the registry). */
export const ROUTE_FAST_DROPS = ["hyde", "multi-query", "sub-query"];

/** Route one question from its understanding features. Returns the
 *  route and the fired features — the response echoes both, which is
 *  the telemetry the routing-accuracy analysis reads (TODO.sota/05). */
export function routeFor(u: RouteFeatures | null, query: string): {
  route: Route;
  features: string[];
} {
  const features: string[] = [];
  const words = query.trim().split(/\s+/).filter(Boolean).length;

  // DEEP features — complexity is the understanding model's own
  // multi-perspective judgment; sub-queries and process intent both
  // need the widest candidate pool
  if (u?.complexity === "complex") features.push("complex");
  if ((u?.sub_queries ?? []).length > 0) features.push("sub-queries");
  if (u?.process_intent) features.push("process-intent");
  if (words > ROUTE_FAST_WORD_CAP) features.push("long-question");
  if (features.length) return { route: "deep", features };

  // FAST — everything else: a question within the word cap rides the
  // fast registry. The conservative direction is structural here: the
  // long, the complex, the multi-perspective and the process-shaped all
  // routed deep above; under-routing costs accuracy, over-routing costs
  // only latency, and the grid prices both.
  if (u?.doc_number) features.push("doc-scoped");
  if (u?.term) features.push("definitional");
  if ((u?.defined_terms ?? []).length > 0) features.push("terminology");
  features.push("short-question");
  return { route: "fast", features };
}

/** The fast route's stage list: the registry minus the expansion lanes.
 *  projectStages owns the ordering and validation semantics. */
export function fastRouteStages(registry: readonly string[]): string[] {
  return registry.filter((n) => !ROUTE_FAST_DROPS.includes(n));
}
