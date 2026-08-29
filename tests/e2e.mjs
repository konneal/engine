#!/usr/bin/env node
// E2E golden suite for the live OIML RAG service. Hits the deployed
// endpoints (BASE_URL, default https://ai.oimlsmart.org) with a set of
// golden questions and asserts answer, citation, refusal, language and
// auth contracts. Most cases ride the /v1 API-key path so the anonymous
// per-IP quota is not burned by test runs.
//
//   node tests/e2e.mjs            # against production
//   BASE_URL=... node tests/e2e.mjs

import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const REFUSAL = "I don't have information on this in the indexed OIML publications.";

function loadKey() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^KEY=(\S+)/m);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  if (process.env.RAG_API_KEY) return process.env.RAG_API_KEY;
  throw new Error("No API key: set KEY in .env or RAG_API_KEY");
}
const KEY = loadKey();

async function post(path, body, auth = true) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or non-JSON */
  }
  return { status: res.status, json, text };
}

async function ask(query, extra = {}) {
  return post("/v1/ask", { query, stream: false, ...extra });
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("health: service is up", async () => {
  const res = await fetch(`${BASE}/health`);
  const j = await res.json();
  if (res.status !== 200 || j.ok !== true) throw new Error(`status ${res.status}`);
});

test("ask doc-level: What is R 60?", async () => {
  const { status, json } = await ask("What is R 60?");
  if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(json?.error)}`);
  if (!/load cell/i.test(json.answer)) throw new Error(`answer does not mention load cells: ${json.answer.slice(0, 200)}`);
  if (!json.citations?.length) throw new Error("no citations");
  if (!json.citations.some((c) => /R 60/.test(c.docidentifier))) throw new Error("no R 60 citation");
});

test("ask definition: what is a load cell", async () => {
  const { status, json } = await ask("What is a load cell according to OIML R 60?");
  if (status !== 200) throw new Error(`status ${status}`);
  if (!/transducer|measuring/i.test(json.answer)) throw new Error(`answer lacks definition content: ${json.answer.slice(0, 160)}`);
  if (!json.citations.some((c) => /R 60/.test(c.docidentifier))) throw new Error("no R 60 citation");
});

test("ask table value: n_LC limits per accuracy class", async () => {
  const { status, json } = await ask(
    "According to OIML R 60, what is the maximum number of load cell verification intervals?",
  );
  if (status !== 200) throw new Error(`status ${status}`);
  if (!/\d{3,}/.test(json.answer)) throw new Error(`answer has no numeric limits: ${json.answer.slice(0, 200)}`);
  if (!json.citations.some((c) => /R 60/.test(c.docidentifier))) throw new Error("no R 60 citation");
});

test("ask refusal: out-of-corpus question", async () => {
  const { status, json } = await ask("How do I make lasagna?");
  if (status !== 200) throw new Error(`status ${status}`);
  if (!json.answer.includes(REFUSAL)) throw new Error(`expected refusal, got: ${json.answer.slice(0, 160)}`);
});

test("ask meta: identity questions are answered, never refused", async () => {
  for (const q of ["Who are you?", "Hello! What can you do?", "Qui es-tu ?", "Wer bist du?", "what datasets do you have?"]) {
    const { status, json } = await ask(q);
    if (status !== 200) throw new Error(`${q}: status ${status}`);
    if (json.answer.includes(REFUSAL)) throw new Error(`${q}: got refusal`);
    if (!/oiml|metrology|publication|assistant/i.test(json.answer)) throw new Error(`${q}: no self-description: ${json.answer.slice(0, 160)}`);
  }
});

test("ask long question (~200 words) is accepted and answered", async () => {
  const q =
    "I am a manufacturer of nonautomatic weighing instruments and I am preparing a complete technical file for a new electronic bench scale with a maximum capacity of 30 kilograms and a verification scale interval of 5 grams, intended to be used in commercial retail transactions in several export markets. The instrument will be classified as a class III accuracy scale according to the OIML classification system, and our national market surveillance authority has asked us to demonstrate conformity with the applicable OIML requirements before we can place the instrument on the market. In addition, one of our export customers has asked whether the same instrument could be re-verified after a repair that replaces the load cell, and what that would imply for the errors we are allowed. I therefore need to understand precisely what the OIML publication for nonautomatic weighing instruments says about the maximum permissible errors on initial verification for such an instrument, how those errors scale with the applied load across the weighing range, whether there are any special provisions that apply to instruments with a scale interval smaller than the typical ratio, and what applies at subsequent verification after repair. Could you explain the applicable maximum permissible error values, the accuracy class requirements, and any conditions or notes that I should be aware of when declaring conformity for this class of instrument in the technical file?";
  if (q.length < 1200) throw new Error("test question is not long enough");
  const { status, json } = await ask(q);
  if (status !== 200) throw new Error(`status ${status} — long question rejected`);
  if (json.answer.length < 80) throw new Error(`no real answer: ${json.answer.slice(0, 160)}`);
  if (json.answer.includes(REFUSAL)) throw new Error(`long legitimate question refused: ${json.answer.slice(0, 160)}`);
});

test("ask French question gets French answer", async () => {
  const { status, json } = await ask("Qu'est-ce qu'une cellule de pesée ?");
  if (status !== 200) throw new Error(`status ${status}`);
  if (!/cellule|mesure|transducteur/i.test(json.answer)) throw new Error(`answer not French: ${json.answer.slice(0, 160)}`);
});

test("search: ranked clauses, no raw adoc", async () => {
  const { status, json } = await post("/v1/search", { query: "maximum permissible error accuracy class" });
  if (status !== 200) throw new Error(`status ${status}`);
  if (!json.results?.length || json.results.length < 3) throw new Error(`expected ≥3 results, got ${json.results?.length}`);
  if (!json.results[0].docidentifier) throw new Error("results lack docidentifier");
  const raw = json.results.some((r) => r.text.includes("|===") || r.text.includes("[cols="));
  if (raw) throw new Error("raw AsciiDoc table syntax leaked into results");
});

test("search: doc-number filter applies", async () => {
  const { status, json } = await post("/v1/search", { query: "R 60 verification intervals" });
  if (status !== 200) throw new Error(`status ${status}`);
  if (!json.results.some((r) => /R 60/.test(r.docidentifier))) throw new Error("R 60 filter did not surface R 60 results");
});

test("anon ask endpoint works (refusal path)", async () => {
  const { status, json } = await post("/api/ask", { query: "Colorless green ideas sleep furiously?", stream: false }, false);
  if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(json?.error)}`);
  if (!json.answer.includes(REFUSAL)) throw new Error(`expected refusal, got: ${json.answer.slice(0, 120)}`);
});

test("contract v2: table question returns typed block, not retyped markdown", async () => {
  const { status, json } = await ask("What is the minimum number of load cell verification intervals for each accuracy class in OIML R 60-1?", { fresh: true });
  if (status !== 200) throw new Error(`status ${status}`);
  const blocks = Array.isArray(json.blocks) ? json.blocks : [];
  const mdTable = /(^|\n)\s*\|[^\n]+\|\s*(\n\s*\|[-: |]+\|)?/.test(json.answer) && (json.answer.match(/\|/g) ?? []).length >= 6;
  if (mdTable && blocks.length === 0) throw new Error("answer retyped a table as markdown while no block was returned");
  if (blocks.length) {
    const t = blocks.find((b) => b.type === "table");
    if (!t) throw new Error(`blocks present but no table block (got ${blocks.map((b) => b.type)})`);
    if (!t.payload || !Array.isArray(t.payload.columns) || !Array.isArray(t.payload.rows) || t.payload.rows.length === 0) {
      throw new Error("table block payload missing columns/rows");
    }
  }
});

test("auth: bad key rejected", async () => {
  const res = await fetch(`${BASE}/v1/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oiml_bogus" },
    body: JSON.stringify({ query: "test" }),
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
});

test("auth: missing body rejected", async () => {
  const { status, json } = await post("/v1/ask", { query: "" });
  if (status !== 400 || json?.error?.code !== "invalid_input") throw new Error(`expected 400 invalid_input, got ${status}`);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
console.log(`\ne2e: ${passed} passed, ${failed} failed (base ${BASE})`);
process.exit(failed ? 1 : 0);
