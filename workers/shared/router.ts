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

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const segments = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;
    const patternSegs = route.pattern.split("/").filter(Boolean);
    if (patternSegs.length !== segments.length && !patternSegs[patternSegs.length - 1]?.startsWith("*")) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegs.length; i++) {
      const ps = patternSegs[i];
      if (ps.startsWith("*")) break; // wildcard matches rest
      if (ps.startsWith(":")) {
        params[ps.slice(1)] = segments[i];
      } else if (ps !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}
