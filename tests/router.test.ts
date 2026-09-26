// The router primitives the generated surface dispatches through. The
// 2026-09-19 bug this suite pins: probing a known path with another
// method through matchRoute(ROUTES, "*", path) matches nothing, because
// the method check skips every concrete-method route — the 405 fallback
// built on it was dead code and every wrong-method request answered
// 404. The method-blind half lives in routeMatchesPath.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute, routeMatchesPath } from "../workers/shared/router.ts";
import type { Route } from "../workers/shared/router.ts";

const ok = async () => new Response("ok");
const ROUTES: Route[] = [
  { method: "GET", pattern: "/api/conversations", handler: ok },
  { method: "POST", pattern: "/api/conversations", handler: ok },
  { method: "GET", pattern: "/api/conversations/:id/messages", handler: ok },
  { method: "GET", pattern: "/assets/*", handler: ok },
  { method: "*", pattern: "/legacy/anything", handler: ok },
];

test("matchRoute dispatches by method with param capture", () => {
  const m = matchRoute(ROUTES, "GET", "/api/conversations/c123/messages");
  assert.ok(m);
  assert.equal(m.params.id, "c123");
  assert.equal(matchRoute(ROUTES, "PUT", "/api/conversations"), null);
});

test("a known path under a wrong method is distinguishable from an unknown path", () => {
  // this is the probe that was dead: matchRoute with "*" finds nothing
  // when no route declares "*"
  assert.equal(matchRoute(ROUTES, "*", "/api/conversations"), null);
  // the method-blind half sees the path
  assert.ok(routeMatchesPath("/api/conversations", "/api/conversations"));
  assert.ok(ROUTES.some((r) => routeMatchesPath(r.pattern, "/api/conversations")));
  assert.equal(ROUTES.some((r) => routeMatchesPath(r.pattern, "/api/nowhere")), false);
});

test("routeMatchesPath: params, wildcards, segment exactness", () => {
  assert.deepEqual(routeMatchesPath("/a/:id", "/a/42"), { id: "42" });
  assert.equal(routeMatchesPath("/a/:id", "/a/42/b"), null);
  assert.deepEqual(routeMatchesPath("/assets/*", "/assets/u:xyz.png"), {});
  assert.deepEqual(routeMatchesPath("/assets/*", "/assets"), {});
  assert.deepEqual(routeMatchesPath("/a", "/a/"), {}, "trailing slashes are equivalent");
  assert.equal(routeMatchesPath("/a", "/b"), null);
});

test("HEAD rides the GET route (no 405 for link previewers)", async (t) => {
  const { matchRoute } = await import("../workers/shared/router.ts");
  const routes = [{ method: "GET", pattern: "/", handler: async () => new Response("ok") }];
  assert.ok(matchRoute(routes, "HEAD", "/"));
  assert.ok(matchRoute(routes, "GET", "/"));
  assert.equal(matchRoute(routes, "POST", "/"), null);
});
