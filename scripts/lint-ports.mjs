// Port purity lint (konneal item 06): domain modules must not name a
// provider binding API. Only ports/cloudflare/** may reference the
// provider types; everything else fails. Run: npm run lint:ports
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "workers";
const PROVIDER_TYPES = /\b(KVNamespace|R2Bucket|D1Database|VectorizeIndex|Fetcher|ExecutionContext)\b/;
const PROVIDER_BINDINGS = /\benv\.(AI|VECTORIZE|EXP_PRIMMEL|EXP_COMPOSED|EXP_PLAIN|EXP_ADC|EXP_MKO|EXP_PFLAT|GLOSSARY|UNIT_ASSETS|DB|CACHE|ASSETS)\b/;

// The explicit migration allowlist: files still on raw bindings, each
// with the board item that moves it. SHRINKS; never grows.
const ALLOWLIST = new Set([
  "worker_public/src/admin.ts", // ops surface — the admin routes ARE provider-shaped by charter
  "worker_public/src/index.ts", // the route table + binding wiring (edge by charter)
  "worker_public/src/projects.ts",
  "worker_public/src/ask.ts",
  "worker_public/src/conversations.ts",
  "worker_public/src/memories.ts",
  "worker_public/src/livedata.ts",
  "worker_public/src/share.ts",
  "worker_public/src/auth.ts",
  "worker_public/src/quota.ts",
  "worker_public/src/modelplane.ts",
  "worker_public/src/graph.ts",
  "worker_public/src/research.ts",
  "worker_public/src/lexical.ts",
  "worker_public/src/drafts.ts",
  "worker_public/src/context.ts",
  "worker_public/src/ai.ts",
  "worker_public/src/pipeline.ts",
  "worker_public/src/stages/dense.ts",
  "worker_public/src/stages/editionCover.ts",
  "worker_public/src/stages/conceptGraph.ts",
  "worker_public/src/stages/typedPin.ts",
  "worker_public/src/stages/subQuery.ts",
  "worker_public/src/stages/sectionDescent.ts",
  "worker_public/src/stages/multiQuery.ts",
  "worker_public/src/stages/hyde.ts",
  "worker_public/src/stages/graphLane.ts",
  "worker_public/src/stages/citationProbe.ts", // D1 FTS + Vectorize getByIds + graph cites (the 2026-09-15 incident hotfix lane)
  "worker_public/src/lib/http.ts",
  "shared/router.ts",
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

let fails = 0;
for (const p of walk(ROOT)) {
  if (!p.endsWith(".ts") || p.endsWith(".d.ts")) continue;
  if (p.includes("node_modules")) continue;
  const rel = p.replace(/\\/g, "/").replace(/^workers\//, "");
  if (rel.includes("ports/")) continue;
  // env.ts declares the binding surface — the edge by charter (the
  // port composition helpers live there too)
  if (rel === "worker_public/src/env.ts") continue;
  // the internal federation and MCP workers are edge workers; they
  // migrate behind the ports as their own board item
  if (rel.startsWith("worker_internal/") || rel.startsWith("worker_mcp/")) continue;
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(p, "utf8");
  for (const [re, label] of [[PROVIDER_TYPES, "provider type"], [PROVIDER_BINDINGS, "raw binding"]]) {
    if (re.test(src)) {
      console.error(`✗ ${rel}: ${label} outside the ports (add to ports/, not to the allowlist)`);
      fails++;
    }
  }
}
if (fails) {
  console.error(`port purity: ${fails} violation(s)`);
  process.exit(1);
}
console.log(`port purity OK (${ALLOWLIST.size} files in the migration allowlist — see scripts/lint-ports.mjs)`);
