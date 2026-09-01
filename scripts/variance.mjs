// Answer-variance harness (TODO.remaining/08): the same golden question,
// asked N times fresh, at production sampling. Reports the distinct-answer
// ratio, answer_any regex stability and refusal stability — the
// determinism number for quote-anchored answers.
// Usage: node scripts/variance.mjs [n=5] [ids=tbl-r76-mpe-class3,doc-r60]
import { readFileSync } from "node:fs";

const KEY = readFileSync(".env", "utf8").match(/^KEY=(.+)$/m)[1].trim();
const BASE = process.env.BASE_URL ?? "https://ai.oimlsmart.org";
const N = Number(process.argv[2] ?? 5);
const want = (process.argv[3] ?? "tbl-r76-mpe-class3,def-loadcell,refuse-cooking").split(",");

const table = JSON.parse(readFileSync("tests/golden/table-cases.json", "utf8"));
const probes = [
  { id: "doc-r60", query: "What is OIML R 60?", expect: { answer_any: ["load cell"] } },
  { id: "def-loadcell", query: "what is a load cell", expect: { answer_any: ["transducteur|transducer|force"] } },
  { id: "refuse-cooking", query: "What is the best recipe for chocolate chip cookies?", expect: { answer_any: ["I don.t have information"] } },
];
const cases = [...table, ...probes].filter((c) => want.includes(c.id));

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[“”"]/g, "'").trim();
let report = [];
for (const c of cases) {
  const answers = [];
  let regexOk = 0;
  for (let i = 0; i < N; i++) {
    const res = await fetch(`${BASE}/v1/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "user-agent": "oiml-eval" },
      body: JSON.stringify({ query: c.query, fresh: true }),
    });
    const d = await res.json();
    const a = d.answer ?? "";
    answers.push(norm(a));
    if ((c.expect.answer_any ?? []).every((r) => new RegExp(r, "i").test(a))) regexOk++;
  }
  const distinct = new Set(answers).size;
  // pairwise prefix stability (first 120 chars) — the part users read
  const prefixes = new Set(answers.map((a) => a.slice(0, 120))).size;
  report.push({ id: c.id, n: N, distinct_full: distinct, distinct_prefix120: prefixes, regex_stability: `${regexOk}/${N}` });
  console.log(`${c.id}: distinct ${distinct}/${N} (prefix120 ${prefixes}/${N}), regex stable ${regexOk}/${N}`);
}
const avgDistinct = report.reduce((s, r) => s + r.distinct_full, 0) / report.length;
const avgPrefix = report.reduce((s, r) => s + r.distinct_prefix120, 0) / report.length;
console.log(`\nvariance: mean distinct answers ${(avgDistinct / N * 100).toFixed(0)}%, mean distinct openings ${(avgPrefix / N * 100).toFixed(0)}% (n=${N} x ${report.length} questions)`);
