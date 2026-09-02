// Annealment runner (TODO.model-rag/03): rung-tagged questions → /v1/ask
// with per-rung witness grading. D-only rungs are skipped when the target
// lane lacks primmel. Usage: node tests/annealment.mjs [--rung L3] [--lane C]
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const KEY = readFileSync(".env", "utf8").match(/^KEY=(.+)$/m)?.[1]?.trim();
const args = process.argv.slice(2);
const rungFilter = args.includes("--rung") ? args[args.indexOf("--rung") + 1] : null;
const lane = args.includes("--lane") ? args[args.indexOf("--lane") + 1] : null;

const cases = JSON.parse(readFileSync("tests/golden/annealment.json", "utf8"))
  .filter((c) => !rungFilter || c.rung === rungFilter)
  .filter((c) => !lane || c.lanes.includes(lane));

let pass = 0, skip = 0;
const laneXIdx = args.indexOf("--lane-x");
const byRung = {};
for (const c of laneXIdx >= 0 ? [] : cases) {
  try {
    const res = await fetch(`${BASE}/v1/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "user-agent": "oiml-eval" },
      body: JSON.stringify({ query: c.query, fresh: true }),
    });
    const d = await res.json();
    const answer = d.answer ?? "";
    const cites = (d.citations ?? []).map((x) => `${x.docidentifier ?? ""} §${x.clause_anchor ?? ""} ${x.snippet ?? ""}`).join(" | ");
    const blocks = d.blocks ?? [];
    const answerOk = (c.expect.answer_any ?? []).every((r) => new RegExp(r, "i").test(answer));
    const citeOk = !c.expect.citation_any || new RegExp(c.expect.citation_any).test(cites);
    const anchorOk = !c.expect.anchor_any || new RegExp(c.expect.anchor_any).test(cites);
    const artifactOk = !c.expect.artifact || blocks.some((b) => b.type === c.expect.artifact);
    const ok = answerOk && citeOk && anchorOk && artifactOk;
    if (ok) pass++; else skip++;
    byRung[c.rung] = byRung[c.rung] || { pass: 0, total: 0 };
    if (ok) byRung[c.rung].pass++;
    byRung[c.rung].total++;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.rung} ${c.id} a=${answerOk} c=${citeOk} an=${anchorOk} art=${artifactOk}`);
  } catch (e) {
    skip++;
    console.log("ERR", c.rung, c.id, String(e).slice(0, 80));
  }
}
console.log(`\nannealment: ${pass}/${cases.length} pass (${skip} fail/err)`);
for (const [r, v] of Object.entries(byRung)) console.log(`  ${r}: ${v.pass}/${v.total}`);

// ── lane-retrieval matrix mode ─────────────────────────────────────────
// --lane-x <key> grades the 6×10 matrix over /v1/lane (dense+lexical
// fused): per rung, does the lane's top-10 contain the witness (citation
// regex over docidentifier §anchor text, anchor regex over anchors, the
// artifact block present). The `lanes` tags stay advisory — the matrix
// runs every case on every lane (E/F were tagged after the set froze).
if (laneXIdx >= 0) {
  const laneKey = args[laneXIdx + 1];
  const all = JSON.parse(readFileSync("tests/golden/annealment.json", "utf8"));
  let lp = 0;
  const byRungLane = {};
  for (const c of all) {
    try {
      const res = await fetch(`${BASE}/v1/lane`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "user-agent": "oiml-eval" },
        body: JSON.stringify({ lane: laneKey, query: c.query }),
      });
      const d = await res.json();
      const hits = d.hits ?? [];
      const hay = hits.map((h) => `${h.docidentifier ?? ""} §${h.clause_anchor ?? ""} ${h.clause_title ?? ""} ${h.text ?? ""}`).join(" | ");
      const anchors = hits.map((h) => `§${h.clause_anchor ?? ""}`).join(" ");
      const citeOk = !c.expect.citation_any || new RegExp(c.expect.citation_any, "i").test(hay);
      const anchorOk = !c.expect.anchor_any || new RegExp(c.expect.anchor_any).test(anchors);
      const artifactOk = !c.expect.artifact || hits.some((h) => h.block === c.expect.artifact);
      const ok = citeOk && anchorOk && artifactOk;
      if (ok) lp++;
      byRungLane[c.rung] = byRungLane[c.rung] || { pass: 0, total: 0 };
      if (ok) byRungLane[c.rung].pass++;
      byRungLane[c.rung].total++;
      if (!ok) console.log(`FAIL ${c.rung} ${c.id} c=${citeOk} an=${anchorOk} art=${artifactOk}`);
    } catch (e) {
      console.log("ERR", c.rung, c.id, String(e).slice(0, 80));
    }
  }
  console.log(`\nlane ${laneKey}: ${lp}/${all.length}`);
  for (const [r, v] of Object.entries(byRungLane)) console.log(`  ${r}: ${v.pass}/${v.total}`);
}
