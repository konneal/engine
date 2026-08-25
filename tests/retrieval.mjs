#!/usr/bin/env node
// Retrieval eval: hit@5 on the golden cases via the live /api/search
// endpoint (embedding + vectorize only — no generation spend). Run before
// and after corpus-wide changes (e.g. contextual enrichment) to quantify
// retrieval lift:
//
//   node tests/retrieval.mjs              # against production
//   node tests/retrieval.mjs --save tag   # snapshot results to artifacts/

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
// prefer the API-key path (.env KEY) so eval runs don't burn the 50/day
// anonymous search quota
const KEY = (() => {
  try {
    const m = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^KEY=(\S+)/m);
    return m ? m[1] : process.env.RAG_API_KEY ?? null;
  } catch {
    return process.env.RAG_API_KEY ?? null;
  }
})();
const saveTag = process.argv.includes("--save") ? process.argv[process.argv.indexOf("--save") + 1] : null;
const cases = [
  ...JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")),
  ...JSON.parse(readFileSync(new URL("./golden/retrieval-probes.json", import.meta.url), "utf8")),
];

async function search(query) {
  const res = await fetch(`${BASE}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ query, top_k: 5 }),
  });
  if (res.status === 429) throw new Error("QUOTA");
  if (!res.ok) throw new Error(`search ${res.status}`);
  return (await res.json()).results ?? [];
}

let hits = 0;
let scored = 0;
const rows = [];
for (const c of cases) {
  // citation_any is a REGEX over docidentifiers; cases without one are
  // behavioral (refusals, leak probes) and are not retrieval-scored
  if (!c.expect?.citation_any) {
    rows.push({ id: c.id, query: c.query, skipped: true });
    continue;
  }
  scored++;
  let results = [];
  let err = null;
  try {
    results = await search(c.query);
  } catch (e) {
    if (String(e).includes("QUOTA")) {
      console.error("\nquota exhausted — aborting (partial results NOT saved). Use the API key path or retry after the quota window.");
      process.exit(3);
    }
    err = String(e);
  }
  const re = new RegExp(c.expect.citation_any, "i");
  const hitIdx = results.slice(0, 5).findIndex((r) => re.test(String(r.docidentifier ?? "")));
  const hit = hitIdx >= 0;
  if (hit) hits++;
  const top = results.slice(0, 5).map((r) => `${r.docidentifier}§${r.clause_anchor ?? ""}`);
  rows.push({
    id: c.id,
    query: c.query,
    hit,
    rank: hit ? hitIdx + 1 : null,
    top,
    ...(err ? { error: err } : {}),
  });
  console.log(`  ${hit ? "✓" : "✗"} ${c.id.padEnd(22)} ${hit ? `rank ${hitIdx + 1}` : `miss — got ${top.join(", ") || err || "nothing"}`}`);
}

const summary = { base: BASE, ts: new Date().toISOString(), scored, hit_at_5: hits, rate: +(hits / scored).toFixed(3), rows };
console.log(`\nretrieval: hit@5 ${hits}/${scored} (${(100 * hits / scored).toFixed(0)}%)`);

if (saveTag) {
  mkdirSync(new URL("../artifacts/eval/", import.meta.url), { recursive: true });
  const path = new URL(`../artifacts/eval/retrieval-${saveTag}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`saved: ${path.pathname}`);
}
process.exit(0);
