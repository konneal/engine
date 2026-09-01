// Golden-set eval: the promotion gate. Runs tests/golden/cases.json
// against the live service and writes artifacts/eval-report.json.
// Exit 0 when the pass rate clears the threshold (default 0.9).
//
// TODO.ai-platform/03: cases marked "live_member": true exercise the "my
// account" live-data delegation and require LIVE_MEMBER_TOKEN (a member
// session Bearer for the service, in .env or the environment) — without
// it they SKIP honestly (the post-deploy act runs them with the demo
// member's session). The account must-NOT leg (the chip declared without
// a member session never answers records) runs unconditionally.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = (envText.match(/^KEY=(.+)$/m) ?? [])[1]?.trim();
const LIVE_MEMBER_TOKEN = (envText.match(/^LIVE_MEMBER_TOKEN=(.+)$/m) ?? [])[1]?.trim() ?? process.env.LIVE_MEMBER_TOKEN ?? null;
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

  // The live-member legs ride the member session, never the API key.
  const bearer = c.live_member ? LIVE_MEMBER_TOKEN : KEY;
  if (c.live_member && !LIVE_MEMBER_TOKEN) {
    return { id: c.id, ok: true, skipped: "LIVE_MEMBER_TOKEN not set (the post-deploy live leg)", checks: ["↷ skipped — no member session"], answer: "", citations: [] };
  }

  let res;
  try {
    res = await fetch(`${BASE}/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query: c.query, stream: false, ...(c.context ? { context: c.context } : {}) }),
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
  // ── the declared-context legs (TODO.ai-platform/02): the response's
  // context_applied echo must say what grounded the answer — the chip
  // kind, the publication the declaration actually scoped retrieval to,
  // and the honest degradation note when it could not. ──
  if (c.expect.context_kind !== undefined) {
    body.context_applied?.kind === c.expect.context_kind
      ? pass(`context kind "${c.expect.context_kind}"`)
      : fail(`context_applied.kind = ${JSON.stringify(body.context_applied?.kind)} (expected "${c.expect.context_kind}")`);
  }
  if (c.expect.context_scoped_to !== undefined) {
    body.context_applied?.scoped_to === c.expect.context_scoped_to
      ? pass(`context scoped to "${c.expect.context_scoped_to}"`)
      : fail(`context_applied.scoped_to = ${JSON.stringify(body.context_applied?.scoped_to)} (expected "${c.expect.context_scoped_to}")`);
  }
  if (c.expect.context_note !== undefined) {
    body.context_applied?.note === c.expect.context_note
      ? pass(`context note "${c.expect.context_note}"`)
      : fail(`context_applied.note = ${JSON.stringify(body.context_applied?.note)} (expected "${c.expect.context_note}")`);
  }
  // ── the live-data legs (TODO.ai-platform/03): the live echo states
  // WHEN the account was read + how many records grounded the answer;
  // the records carry the links (label + url each); the must-not: the
  // response NEVER carries records the read did not ground (and never
  // any when the live read was not done). ──
  if (c.expect.live_read) {
    const live = body.context_applied?.live;
    live && typeof live.read_at === "string" && Array.isArray(live.stores)
      ? pass(`live read at ${live.read_at} (${live.stores.length} stores)`)
      : fail(`context_applied.live missing or malformed: ${JSON.stringify(body.context_applied?.live)}`);
  }
  if (c.expect.records_min !== undefined) {
    const records = body.records ?? [];
    records.length >= c.expect.records_min
      ? pass(`records ${records.length} ≥ ${c.expect.records_min}`)
      : fail(`records ${records.length} < ${c.expect.records_min}`);
    for (const r of records) {
      r.label && r.url && /^https?:\/\//.test(r.url)
        ? pass(`record linked: ${String(r.label).slice(0, 60)}`)
        : fail(`record without an honest link: ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
  if (c.expect.records_absent) {
    body.records === undefined || (Array.isArray(body.records) && body.records.length === 0)
      ? pass("no records — the must-not holds")
      : fail(`RECORDS LEAKED without a live read: ${JSON.stringify(body.records).slice(0, 200)}`);
  }
  // ── the draft legs (TODO.ai-platform/04): the act-with-confirmation
  // wire shape. The draft is an INPUT to the real form, never a channel:
  // requires_confirmation is always true, the fields carry only what the
  // user stated (draft_none matches against the whole draft JSON), and a
  // crafted "submit it for me" prompt never produces a performed act. ──
  if (c.expect.draft_absent) {
    body.draft === undefined || body.draft === null
      ? pass("no draft — the must-not holds")
      : fail(`DRAFT EMITTED where none belongs: ${JSON.stringify(body.draft).slice(0, 200)}`);
  }
  if (c.expect.draft_present) {
    body.draft && body.draft.kind === "draft"
      ? pass(`draft present (${body.draft.act})`)
      : fail(`no draft in the response: ${JSON.stringify(Object.keys(body))}`);
  }
  if (c.expect.draft_present && c.expect.draft_act !== undefined) {
    body.draft?.act === c.expect.draft_act
      ? pass(`draft act "${c.expect.draft_act}"`)
      : fail(`draft.act = ${JSON.stringify(body.draft?.act)} (expected "${c.expect.draft_act}")`);
  }
  if (c.expect.draft_present && c.expect.draft_requires_confirmation) {
    body.draft?.requires_confirmation === true
      ? pass("the draft requires the user's own confirmation — always")
      : fail(`draft.requires_confirmation = ${JSON.stringify(body.draft?.requires_confirmation)} — THE DRAFT MUST NEVER BE A CHANNEL`);
  }
  if (c.expect.draft_field) {
    for (const [path, pat] of Object.entries(c.expect.draft_field)) {
      const v = path.split(".").reduce((o, k) => (o == null ? o : o[k]), body.draft);
      v !== undefined && re(pat).test(String(v))
        ? pass(`draft ${path} ~/${pat}/`)
        : fail(`draft ${path} = ${JSON.stringify(v)} (expected ~/${pat}/)`);
    }
  }
  if (c.expect.draft_none) {
    const draftJson = JSON.stringify(body.draft ?? null);
    for (const p of one(c.expect.draft_none)) {
      re(p).test(draftJson)
        ? fail(`the draft carries a value the user never stated — /${p}/ found in ${draftJson.slice(0, 200)} (the never-invents guard FAILED)`)
        : pass(`draft clean of /${p}/`);
    }
  }
  if (c.expect.no_performed_marker) {
    const performed = body.performed ?? body.application_id ?? body.submitted_id ?? body.submitted;
    const ok = (performed === undefined || performed === null) && (body.draft === undefined || body.draft?.requires_confirmation === true);
    ok
      ? pass("no performed-act marker — the service never writes")
      : fail(`A PERFORMED ACT LEAKED (performed=${JSON.stringify(performed)}, draft.requires_confirmation=${JSON.stringify(body.draft?.requires_confirmation)}) — the never-writes invariant FAILED`);
  }
  // ── the model-plane legs (TODO.ai-platform/05): the model-aware chip
  // grounds the answer in the model NODE — context_applied.model names it
  // (node id, kind, the clause provenance); an unbindable declaration
  // carries NO model echo (never an invented grounding). ──
  if (c.expect.model_node !== undefined) {
    body.context_applied?.model?.node_id === c.expect.model_node
      ? pass(`model node "${c.expect.model_node}" bound`)
      : fail(`context_applied.model.node_id = ${JSON.stringify(body.context_applied?.model?.node_id)} (expected "${c.expect.model_node}")`);
  }
  if (c.expect.model_kind !== undefined) {
    body.context_applied?.model?.kind === c.expect.model_kind
      ? pass(`model kind "${c.expect.model_kind}"`)
      : fail(`context_applied.model.kind = ${JSON.stringify(body.context_applied?.model?.kind)}`);
  }
  if (c.expect.model_clause !== undefined) {
    re(c.expect.model_clause).test(body.context_applied?.model?.clause ?? "")
      ? pass(`model clause ~/${c.expect.model_clause}/`)
      : fail(`context_applied.model.clause = ${JSON.stringify(body.context_applied?.model?.clause)} (expected ~/${c.expect.model_clause}/)`);
  }
  if (c.expect.model_absent) {
    body.context_applied?.model === undefined || body.context_applied?.model === null
      ? pass("no model echo — the honest unbound posture")
      : fail(`MODEL ECHO INVENTED for an unbindable declaration: ${JSON.stringify(body.context_applied?.model)}`);
  }
  if (c.expect.citation_corpus) {
    cites.some((x) => x.corpus === c.expect.citation_corpus)
      ? pass(`a ${c.expect.citation_corpus} citation rides`)
      : fail(`no citation with corpus "${c.expect.citation_corpus}" (got: ${cites.map((x) => x.corpus).join(", ")})`);
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
// runs outside a Worker, so we call directly. (envText is the single
// .env read declared at the top — the live-member legs share it.)
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
