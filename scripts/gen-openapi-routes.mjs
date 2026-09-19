// Generates src/openapi-surface.gen.ts from workers/worker_public/openapi.yaml
// — the API surface declaration. The route table registers from this module
// and a drift test pins the bijection with the handler map. Regenerate with
// `node scripts/gen-openapi-routes.mjs` after editing the yaml; CI checks
// freshness (the committed artifact must equal a fresh generation).
import { readFileSync, writeFileSync } from "node:fs"
import { parse } from "yaml"

const spec = parse(readFileSync(new URL("../workers/worker_public/openapi.yaml", import.meta.url), "utf8"))
const VERB_ALLOW = new Set(["get", "post", "put", "patch", "delete"])
const routes = []
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [verb, op] of Object.entries(methods)) {
    if (!VERB_ALLOW.has(verb)) continue
    const pattern = path.replaceAll("{", ":").replaceAll("}", "")
    routes.push({ method: verb.toUpperCase(), pattern, operationId: op.operationId })
  }
}
const out = `// GENERATED from workers/worker_public/openapi.yaml — do not edit.
// Regenerate: node scripts/gen-openapi-routes.mjs
export interface OpenApiRoute {
  method: string
  pattern: string
  operationId: string
}

export type OpenApiOperationId =
${routes.map((r) => `  | "${r.operationId}"`).join("\n")}

export const OPENAPI_SURFACE: readonly (Omit<OpenApiRoute, "operationId"> & { operationId: OpenApiOperationId })[] = ${JSON.stringify(routes, null, 2)} as const
`
writeFileSync(new URL("../workers/worker_public/src/openapi-surface.gen.ts", import.meta.url), out)
console.log(`openapi-surface.gen.ts: ${routes.length} routes from the definition`)
