// Feedback triage (TODO.remaining/08): weekly ops report over thumbs-down.
// PRIVACY: the service stores only query HASHES (never the question text),
// so triage clusters negatives by telemetry joins (route/model/tier/day) —
// it points at WHERE quality regressed, never at WHO asked WHAT.
// Usage: node scripts/feedback-triage.mjs [days=14]
import { execSync } from "node:child_process";

const DAYS = process.argv[2] ?? 14;
const sql = `
SELECT f.query_hash, f.ts, q.route, q.model, q.tier, q.ok, q.answer_chars
  FROM feedback f
  LEFT JOIN queries q ON q.query_hash = f.query_hash
   AND q.ts = (SELECT MAX(q2.ts) FROM queries q2 WHERE q2.query_hash = f.query_hash)
 WHERE f.rating = -1 AND f.ts >= datetime('now', '-${DAYS} days')`;

const raw = execSync(
  `npx wrangler d1 execute rag-public --remote --command "${sql.replace(/\n\s*/g, " ")}" -c workers/worker_public/wrangler.toml --json`,
  { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "06cad8ae9a017c856ab496c6bca9a9d8" } },
).toString();
const rows = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]")[0]?.results ?? [];

console.log(`feedback-triage: ${rows.length} thumbs-down in the last ${DAYS} days`);
if (!rows.length) process.exit(0);

const by = (key) => rows.reduce((m, r) => ((m[r[key] ?? "unknown"] = (m[r[key] ?? "unknown"] ?? 0) + 1), m), {});
for (const k of ["route", "model", "tier", "ok"]) {
  const c = by(k);
  console.log(`  by ${k}:`, Object.entries(c).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x}=${n}`).join(" "));
}
const avgChars = rows.reduce((s, r) => s + (r.answer_chars ?? 0), 0) / rows.length;
console.log(`  avg answer chars: ${avgChars.toFixed(0)} (very short → refusal clusters; check the refusal contract)`);
console.log(`  hashes for cross-reference with worker logs (wrangler tail by query_hash):`);
for (const r of rows.slice(0, 10)) console.log(`    ${String(r.query_hash).slice(0, 12)} ${r.ts} route=${r.route ?? "-"} model=${r.model ?? "-"}`);
