// The declarative router (shared by both workers — one HTTP idiom):
// adding a route = adding an entry, never router modification. Each
// entry declares its method, path pattern, and handler; matchRoute
// dispatches by segment-exact match with :param capture and a trailing
// * wildcard.

export interface RouteContext {
  env: any;
  req: Request;
  ctx: ExecutionContext;
  url: URL;
  path: string;
  params: Record<string, string>;
}

export type RouteHandler = (c: RouteContext) => Promise<Response>;

export interface Route {
  method: string;
  pattern: string; // "/api/conversations/:id/messages" — :name captures params
  handler: RouteHandler;
}

/** The path half of the match, method-blind: segment-exact with :param
 *  capture and a trailing * wildcard. Returns the captured params when
 *  the pattern fits, null otherwise. The 405 probe uses it to tell a
 *  known path under a wrong method from an unknown path. */
export function routeMatchesPath(pattern: string, path: string): Record<string, string> | null {
  const segments = path.split("/").filter(Boolean);
  const patternSegs = pattern.split("/").filter(Boolean);
  if (patternSegs.length !== segments.length && !patternSegs[patternSegs.length - 1]?.startsWith("*")) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i];
    if (ps.startsWith("*")) return params; // wildcard matches rest
    if (ps.startsWith(":")) {
      params[ps.slice(1)] = segments[i];
    } else if (ps !== segments[i]) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  // HEAD rides the GET route (the fetch pipeline strips the body) — a
  // bare HEAD / must not answer 405 to link previewers and probes.
  const effective = method === "HEAD" ? "GET" : method;
  for (const route of routes) {
    if (route.method !== effective && route.method !== "*") continue;
    const params = routeMatchesPath(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}
