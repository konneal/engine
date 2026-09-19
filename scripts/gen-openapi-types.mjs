// Generates dist/openapi-types.d.ts from workers/worker_public/openapi.yaml
// — the same document that generates the route table and renders the API
// reference. Consumers import @konneal/engine/openapi-types; the types can
// no more drift from the served surface than the routes can.
import { spawnSync } from "node:child_process"

const r = spawnSync(
  process.execPath,
  [new URL("../node_modules/openapi-typescript/bin/cli.js", import.meta.url).pathname,
   new URL("../workers/worker_public/openapi.yaml", import.meta.url).pathname,
   "-o", new URL("../dist/openapi-types.d.ts", import.meta.url).pathname],
  { stdio: "inherit" },
)
if (r.status !== 0) process.exit(r.status ?? 1)
const { readFileSync, writeFileSync } = await import("node:fs")
const f = new URL("../dist/openapi-types.d.ts", import.meta.url)
writeFileSync(f, "// GENERATED from workers/worker_public/openapi.yaml - do not edit.\n// Regenerate: node scripts/gen-openapi-types.mjs (runs in npm run build)\n" + readFileSync(f))
console.log("dist/openapi-types.d.ts generated from the OpenAPI document")
