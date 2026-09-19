// The API surface is generated from workers/worker_public/openapi.yaml
// (scripts/gen-openapi-routes.mjs → src/openapi-surface.gen.ts) and bound
// to handlers in index.ts's OPENAPI_HANDLERS. This test pins the three
// together: the committed generation must equal a fresh derivation from
// the yaml, every operation must carry a unique operationId, and the
// handler map must bind exactly the declared operations — no unbound
// operation, no dead binding. index.ts's import graph isn't node-loadable
// (see projects.test.ts for the same pattern), so the map is read at
// source level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { OPENAPI_SURFACE } from "../workers/worker_public/src/openapi-surface.gen.ts";

const VERBS = ["get", "post", "put", "patch", "delete"];

const spec = parse(readFileSync("workers/worker_public/openapi.yaml", "utf8"));
const declared: { method: string; pattern: string; operationId: string }[] = [];
for (const [path, methods] of Object.entries<any>(spec.paths ?? {})) {
  for (const [verb, op] of Object.entries<any>(methods)) {
    if (!VERBS.includes(verb)) continue;
    assert.ok(op.operationId, `${verb.toUpperCase()} ${path} has no operationId — the surface cannot bind it`);
    declared.push({
      method: verb.toUpperCase(),
      pattern: path.replaceAll("{", ":").replaceAll("}", ""),
      operationId: op.operationId,
    });
  }
}

test("the committed surface is fresh (regenerate: node scripts/gen-openapi-routes.mjs)", () => {
  assert.deepEqual([...OPENAPI_SURFACE].sort(byKey), [...declared].sort(byKey));
});

function byKey(a: { method: string; pattern: string }, b: { method: string; pattern: string }) {
  return (a.method + a.pattern).localeCompare(b.method + b.pattern);
}

test("operationIds are unique", () => {
  const ids = OPENAPI_SURFACE.map((r) => r.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test("index.ts binds exactly the declared operations", () => {
  const src = readFileSync("workers/worker_public/src/index.ts", "utf8");
  const map = src.match(/const OPENAPI_HANDLERS[^{]*\{([\s\S]*?)\n\};/);
  assert.ok(map, "OPENAPI_HANDLERS not found in index.ts");
  const bound = [...map[1].matchAll(/^  ([a-zA-Z0-9_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...bound].sort(),
    OPENAPI_SURFACE.map((r) => r.operationId).sort(),
    "the handler map and the OpenAPI surface disagree — add the binding in index.ts or fix the yaml",
  );
});

test("the generated file carries the operationId union (exhaustive Record at typecheck)", () => {
  const gen = readFileSync("workers/worker_public/src/openapi-surface.gen.ts", "utf8");
  assert.match(gen, /export type OpenApiOperationId =/);
});
