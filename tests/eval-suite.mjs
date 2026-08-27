#!/usr/bin/env node
// RAGAS-style eval battery over the golden cases (G13): for each case,
// ask the live service, then judge faithfulness / answer relevancy /
// context precision via the admin judge endpoint. Snapshots to
// artifacts/eval/. Run post-deploy (and post-enrichment for clean
// numbers — under heavy account contention the judge calls can time out
// and report as null, never as a fake score):
//
//   node tests/eval-suite.mjs --save tag [--limit N]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const saveTag = process.argv.includes("--save") ? process.argv[process.argv.indexOf("--save") + 1] : null;
const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : null;
const { KEY, ADMIN_TOKEN } = (() => {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const pick = (k) => env.match(new RegExp(`^${k}=(\\S+)`, "m"))?.[1] ?? process.env[k] ?? null;
  return { KEY: pick("KEY"), ADMIN_TOKEN: pick("ADMIN_TOKEN") };
})();
if (!KEY || !ADMIN_TOKEN) {
  console.error("KEY and ADMIN_TOKEN required in .env");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(new URL("./golden/cases.json", import.meta.url), "utf8")).filter((c) => c.query);
const run = limit ? cases.slice(0, limit) : cases;

async function searchPassages(query) {
  const res = await fetch(`${BASE}/v1/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, top_k: 8 }),
  });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.results ?? []).map((r) => `${r.docidentifier}${r.clause_anchor ? " §" + r.clause_anchor : ""}: ${(r.snippet ?? "").slice(0, 500)}`);
}

async function ask(query) {
  const res = await fetch(`${BASE}/v1/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ query, stream: false, fresh: true }),
  });
  if (!res.ok) throw new Error(`ask ${res.status}`);
  return await res.json();
}

async function judge(question, answer, passages) {
  const res = await fetch(`${BASE}/admin/judge`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ question, answer, passages }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}`);
  return await res.json();
}

const REFUSAL = "I don't have information on this in the indexed OIML publications.";
const rows = [];
for (const c of run) {
  let row = { id: c.id, query: c.query };
  try {
    const a = await ask(c.query);
    const answer = a.answer ?? "";
    // judge against the passages the answer was ACTUALLY built from (the
    // non-stream response carries them); fall back to a fresh search for
    // older deployments
    const passages = (a.context ?? []).length
      ? a.context.map((p) => `${p.doc_id}${p.clause_anchor ? " §" + p.clause_anchor : ""}: ${p.text}`)
      : await searchPassages(c.query);
    row.refused = answer.includes(REFUSAL);
    row.answer_chars = answer.length;
    row.passage_count = passages.length;
    if (answer && !row.refused) {
      const j = await judge(c.query, answer, passages);
      row.faithfulness = j.faithfulness;
      row.answer_relevancy = j.answer_relevancy;
      row.context_precision = j.context_precision;
    }
    rows.push(row);
    const m = (v) => (typeof v === "number" ? v.toFixed(2) : "  — ");
    console.log(`  ${c.id.padEnd(24)} ref:${row.refused ? "Y" : "n"} f:${m(row.faithfulness)} rel:${m(row.answer_relevancy)} prec:${m(row.context_precision)}`);
  } catch (e) {
    row.error = String(e);
    rows.push(row);
    console.log(`  ${c.id.padEnd(24)} ERROR ${e}`);
  }
}

const avg = (k) => {
  const vals = rows.map((r) => r[k]).filter((v) => typeof v === "number");
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : null;
};
const summary = {
  base: BASE, ts: new Date().toISOString(), cases: rows.length,
  refused: rows.filter((r) => r.refused).length,
  faithfulness: avg("faithfulness"),
  answer_relevancy: avg("answer_relevancy"),
  context_precision: avg("context_precision"),
  rows,
};
console.log(`\nragas battery: ${summary.cases} cases | refused ${summary.refused} | faithfulness ${summary.faithfulness} | relevancy ${summary.answer_relevancy} | context precision ${summary.context_precision}`);

if (saveTag) {
  mkdirSync(new URL("../artifacts/eval/", import.meta.url), { recursive: true });
  const path = new URL(`../artifacts/eval/ragas-${saveTag}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(`saved: ${path.pathname}`);
}
