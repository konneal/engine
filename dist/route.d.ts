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
export declare const ROUTE_FAST_WORD_CAP = 10;
/** The candidate-expansion lanes the fast route drops (the stage
 *  names in the registry). */
export declare const ROUTE_FAST_DROPS: string[];
/** Route one question from its understanding features. Returns the
 *  route and the fired features — the response echoes both, which is
 *  the telemetry the routing-accuracy analysis reads (TODO.sota/05). */
export declare function routeFor(u: RouteFeatures | null, query: string): {
    route: Route;
    features: string[];
};
/** The fast route's stage list: the registry minus the expansion lanes.
 *  projectStages owns the ordering and validation semantics. */
export declare function fastRouteStages(registry: readonly string[]): string[];
