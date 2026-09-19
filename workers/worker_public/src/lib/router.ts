// The router lives with the shared cross-worker modules
// (workers/shared/router.ts) — re-exported for worker_public's imports.
export { matchRoute, routeMatchesPath } from "../../../shared/router.ts";
export type { RouteContext, Route, RouteHandler } from "../../../shared/router.ts";
