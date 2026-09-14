#!/usr/bin/env node
// Publisher-leak purity lint (konneal item 10, the reference matrix):
// engine code names NO publisher. A non-comment occurrence of a
// publisher string outside the allowlist is a leak — the shrinking
// allowlist is the migration ledger (the ports lint's pattern).
//
// Allowlist ledger:
//   ingest/codecs.py, src/codecs.ts — the codec registry (an id like
//     "oiml-pubid" names the codec, and the codec's own grammar is
//     publisher-shaped by definition)
//   prompts/*.md — prompt templates still carry OIML example wording
//     (PR: varianlize like ASSISTANT_IDENTITY; then delist)
//   drafts.ts — the OIML-CS application-drafting feature, gated behind
//     features.drafts (off by default); its home is an extension
//     package, not more profile vars
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOW = new Set([
  "workers/worker_public/src/codecs.ts",
  "workers/worker_public/src/drafts.ts",
]);
const ALLOW_DIR = ["workers/worker_public/prompts/"];
// scope for now: the SERVING engine (workers/). The producer-side trees
// (ingest/, scripts/, tests/) still carry publisher defaults from the
// extraction; each gets its own pass and then joins this lint's walk.
const SCOPE_DIR = ["workers/"];

const PATTERNS = [/oiml/i];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === "dist-types" || e === ".git") continue;
      yield* walk(p);
    } else if (/\.(ts|mjs|py)$/.test(e) && !/\.gen\.ts$/.test(e)) yield p;
  }
}

let violations = 0;
for (const file of walk(".")) {
  const rel = file.replace(/^\.\//, "");
  if (!SCOPE_DIR.some((d) => rel.startsWith(d))) continue;
  if (ALLOW.has(rel) || ALLOW_DIR.some((d) => rel.startsWith(d))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const bare = line.replace(/\/\/.*$/, "").replace(/#.*$/, "").replace(/^\s*(\/\*\*|\*|\*\/).*$/, "");
    if (!bare.trim()) return;
    for (const pat of PATTERNS) {
      if (pat.test(bare)) {
        console.log(`✗ ${rel}:${i + 1}: ${pat} outside the profile (add to profile/, not to the allowlist)`);
        violations++;
        break;
      }
    }
  });
}
if (violations) {
  console.log(`publisher leak: ${violations} occurrence(s)`);
  process.exit(1);
}
console.log("publisher purity OK (allowlist ledger in scripts/lint-publisher-leak.mjs)");
