// Golden-set eval: the promotion gate. Runs tests/golden/cases.json
// against the live service and writes artifacts/eval-report.json.
// Exit 0 when the pass rate clears the threshold (default 0.9).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const KEY = (readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^KEY=(.+)$/m) ?? [])[1]?.trim();
const THRESHOLD = Number(process.env.GOLDEN_THRESHOLD ?? 0.9);
const REFUSAL = "I don't have information on this in the indexed OIML publications.";

if (!KEY) {
  console.error("KEY missing from .env");
  process.exit(2);
}

const cases = JSON.parse(readFileSync(new URL("../tests/golden/cases.json", import.meta.url), "utf8"));

const one = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const re = (s, flags = "i") => new RegExp(s, flags);

async function runCase(c) {
  const checks = [];
  const fail = (msg) => checks.push(`✗ ${msg}`);
  const pass = (msg) => checks.push(`✓ ${msg}`);

  let res;
  try {
    res = await fetch(`${BASE}/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ query: c.query, stream: false }),
    });
  } catch (e) {
    fail(`request failed: ${e.message}`);
    return { id: c.id, ok: false, checks, answer: "", citations: [] };
  }
  if (res.status !== 200) {
    fail(`status ${res.status}`);
    return { id: c.id, ok: false, checks, answer: `HTTP ${res.status}`, citations: [] };
  }
  const body = await res.json();
  const answer = body.answer ?? "";
  const cites = body.citations ?? [];
  const citeText = cites.map((x) => `${x.docidentifier ?? ""} ${x.doc_id ?? ""}`).join(" ");

  const isRefusal = answer.trim().startsWith(REFUSAL); // sentence first; a short why may follow
  if (c.expect.refusal) {
    isRefusal ? pass("refusal exact") : fail(`expected refusal, got: ${answer.slice(0, 100)}`);
  } else if (isRefusal && c.expect.allow_refusal) {
    pass("honest refusal");
  } else {
    if (isRefusal) fail("unexpected refusal");
    else pass("answered");
    const anyPats = one(c.expect.answer_any);
    if (anyPats.length) {
      const hit = anyPats.find((p) => re(p).test(answer));
      hit ? pass(`answer ~/${hit}/`) : fail(`answer lacks all of [${anyPats.join(", ")}]: ${answer.slice(0, 100)}`);
    }
    for (const p of one(c.expect.answer_none)) re(p).test(answer) ? fail(`answer contains forbidden /${p}/`) : pass(`answer clean of /${p}/`);
  }
  if (c.expect.citation_any) {
    (cites.length && re(c.expect.citation_any).test(citeText)) ? pass(`citation ~/${c.expect.citation_any}/`) : fail(`no citation matching /${c.expect.citation_any}/ (got: ${citeText.slice(0, 120)})`);
  }
  if (c.expect.citation_all) {
    cites.length && cites.every((x) => re(c.expect.citation_all).test(`${x.docidentifier ?? ""} ${x.doc_id ?? ""}`))
      ? pass(`all citations ~/${c.expect.citation_all}/`)
      : fail(`citation outside /${c.expect.citation_all}/: ${citeText.slice(0, 120)}`);
  }

  return {
    id: c.id,
    ok: checks.every((x) => x.startsWith("✓")),
    checks,
    answer: answer.slice(0, 400),
    citations: cites.map((x) => `${x.docidentifier}:${x.edition} §${x.clause_anchor}`),
  };
}

const results = [];
for (const c of cases) {
  const r = await runCase(c);
  results.push(r);
  console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(22)} ${r.ok ? "" : "\n    " + r.checks.filter((x) => x.startsWith("✗")).join("\n    ")}`);
}

// — faithfulness scoring (RAGAS-style, LLM-as-judge) —
// The REST API call uses the same Workers AI model; the eval harness
// runs outside a Worker, so we call directly.
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const CF_ACCOUNT = (envText.match(/^CLOUDFLARE_ACCOUNT_ID=(.+)$/m) ?? [])[1]?.trim();
const CF_TOKEN = (envText.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m) ?? [])[1]?.trim() ||
  (() => {
    // fall back to wrangler's stored token
    try {
      const toml = readFileSync(
        process.env.HOME + "/Library/Preferences/.wrangler/config/default.toml",
        "utf8",
      );
      return (toml.match(/oauth_token\s*=\s*"([^"]+)"/) ?? [])[1];
    } catch {
      return null;
    }
  })();

async function faithfulness(answer, passages) {
  if (!answer || !passages?.length) return null;
  const ctx = passages.slice(0, 6).map((p, i) => `[${i + 1}] ${(p.snippet || p.text || "").slice(0, 300)}`).join("\n");
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/deepseek-ai/deepseek-v4-flash`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CF_TOKEN}` },
        body: JSON.stringify({
          messages: [
            { role: "system", content: 'Judge if the answer is grounded in the passages. Reply ONLY: {"score": 0.0-1.0}' },
            { role: "user", content: `Answer:\n${answer.slice(0, 1500)}\n\nPassages:\n${ctx}` },
          ],
          max_tokens: 100,
          reasoning_effort: "low",
        }),
      },
    );
    const data = await res.json();
    const text = data?.result?.response ?? data?.result?.choices?.[0]?.message?.content ?? "";
    const m = text.match(/"score"\s*:\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

console.log("\n— faithfulness (LLM judge) —");
for (const r of results) {
  if (r.ok && r.answer && r.answer.length > 50) {
    const score = await faithfulness(r.answer, r.citations ?? []);
    if (score !== null) {
      const mark = score >= 0.8 ? "✓" : score >= 0.5 ? "△" : "✗";
      console.log(`  ${mark} ${r.id.padEnd(22)} faithfulness=${score.toFixed(2)}`);
      r.faithfulness = score;
    }
  }
}

const passed = results.filter((r) => r.ok).length;
const rate = passed / results.length;
mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
const faithScores = results.filter((r) => r.faithfulness !== undefined).map((r) => r.faithfulness);
const avgFaith = faithScores.length ? (faithScores.reduce((a, b) => a + b, 0) / faithScores.length).toFixed(2) : null;
writeFileSync(
  new URL("../artifacts/eval-report.json", import.meta.url),
  JSON.stringify({ base: BASE, at: new Date().toISOString(), passed, total: results.length, rate, avg_faithfulness: avgFaith, results }, null, 1),
);
console.log(`\ngolden eval: ${passed}/${results.length} (${(rate * 100).toFixed(0)}%)${avgFaith ? ` · faithfulness ${avgFaith}` : ""} — threshold ${(THRESHOLD * 100).toFixed(0)}%`);
process.exit(rate >= THRESHOLD ? 0 : 1);
