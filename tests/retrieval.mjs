#!/usr/bin/env node
// Retrieval eval — ETSI-protocol metrics (Al Masoud et al. arXiv:2604.09868 §III-B):
//   R@K   fraction of golden citation patterns hit in top-K
//   AP@K  average precision (precision only at ranks where a hit lands)
//   MRR@K mean reciprocal rank of the first hit
//
//   node tests/retrieval.mjs                 # against production
//   node tests/retrieval.mjs --save tag      # snapshot to artifacts/eval/
//   node tests/retrieval.mjs --k 10

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const KEY = (() => {
  try {
    const m = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^KEY=(\S+)/m);
    return m ? m[1] : process.env.RAG_API_KEY ?? null;
  } catch {
    return process.env.RAG_API_KEY ?? null;
  }
})();
const saveTag = process.argv.includes("--save") ? process.argv[process.argv.indexOf("--save") + 1] : null;
const K = process.argv.includes("--k") ? Number(process.argv[process.argv.indexOf("--k") + 1]) : 5;

const cases = [
  ...JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")),
  ...JSON.parse(readFileSync(new URL("./golden/retrieval-probes.json", import.meta.url), "utf8")),
];

async function search(query, topK) {
  const res = await fetch(`${BASE}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (res.status === 429) throw new Error("QUOTA");
  if (!res.ok) throw new Error(`search ${res.status}`);
  return (await res.json()).results ?? [];
}

function isRelevant(result, expect) {
  const docRe = new RegExp(expect.citation_any, "i");
  if (!docRe.test(String(result.docidentifier ?? ""))) return false;
  if (expect.clause_any) {
    const clRe = new RegExp(expect.clause_any, "i");
    return clRe.test(String(result.clause_anchor ?? "")) || clRe.test(String(result.clause_title ?? ""));
  }
  return true;
}

function apAtK(relevances) {
  let hits = 0;
  let sum = 0;
  for (let i = 0; i < relevances.length; i++) {
    if (relevances[i]) {
      hits++;
      sum += hits / (i + 1);
    }
  }
  return hits === 0 ? 0 : sum / hits;
}

function rrAtK(relevances) {
  const idx = relevances.findIndex(Boolean);
  return idx < 0 ? 0 : 1 / (idx + 1);
}

let nScored = 0;
let nHit = 0;
let sumAP = 0;
let sumRR = 0;
let sumR = 0;
const rows = [];

for (const c of cases) {
  if (!c.expect?.citation_any) {
    rows.push({ id: c.id, query: c.query, skipped: true });
    continue;
  }
  nScored++;
  let results = [];
  let err = null;
  try {
    results = await search(c.query, K);
  } catch (e) {
    if (String(e).includes("QUOTA")) {
      console.error("\nquota exhausted — aborting. Use KEY= in .env.");
      process.exit(3);
    }
    err = String(e);
  }
  const top = results.slice(0, K);
  const relevances = top.map((r) => isRelevant(r, c.expect));
  const hit = relevances.some(Boolean);
  const rank = relevances.findIndex(Boolean);
  const rAtK = hit ? 1 : 0;
  const ap = apAtK(relevances);
  const rr = rrAtK(relevances);
  if (hit) nHit++;
  sumAP += ap;
  sumRR += rr;
  sumR += rAtK;

  const topLabel = top.map((r) => `${r.docidentifier}§${r.clause_anchor ?? ""}`);
  rows.push({
    id: c.id,
    query: c.query,
    hit,
    rank: hit ? rank + 1 : null,
    r_at_k: rAtK,
    ap_at_k: +ap.toFixed(4),
    rr_at_k: +rr.toFixed(4),
    top: topLabel,
    ...(err ? { error: err } : {}),
  });
  const mark = hit ? "✓" : "✗";
  const detail = hit
    ? `rank ${rank + 1}  AP=${ap.toFixed(2)} RR=${rr.toFixed(2)}`
    : `miss — ${topLabel.join(", ") || err || "nothing"}`;
  console.log(`  ${mark} ${c.id.padEnd(22)} ${detail}`);
}

const summary = {
  base: BASE,
  ts: new Date().toISOString(),
  k: K,
  protocol: "etsi-2604.09868",
  scored: nScored,
  hit_at_5: nHit,
  rate: +(nHit / nScored).toFixed(3),
  R_at_K: +(sumR / nScored).toFixed(4),
  AP_at_K: +(sumAP / nScored).toFixed(4),
  MRR_at_K: +(sumRR / nScored).toFixed(4),
  rows,
};

console.log(
  `\nretrieval@${K}: R=${(100 * summary.R_at_K).toFixed(0)}%  AP=${summary.AP_at_K.toFixed(3)}  MRR=${summary.MRR_at_K.toFixed(3)}  (${nHit}/${nScored} hit)`,
);

if (saveTag) {
  mkdirSync(new URL("../artifacts/eval/", import.meta.url), { recursive: true });
  const path = new URL(`../artifacts/eval/retrieval-${saveTag}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`saved: ${path.pathname}`);
}
process.exit(0);
