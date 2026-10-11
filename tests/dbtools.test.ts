// The data-plane grammar's tests (dbtools.ts): the compiler's
// parameterization and identifier allowlist, the catalog's sync with
// schema.sql, the schema-named errors, and runFind's deterministic
// output. Runs on plain node type stripping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFind, DB_CATALOG, runFind, runSchema, publishedTable } from "../workers/worker_public/src/dbtools.ts";
import { parseToolCall, TOOL_DECLARATION } from "../workers/worker_public/src/tools.ts";

test("compileFind: identifiers come from the allowlist, values bind", () => {
  const c = compileFind({ table: "certificates", where: [{ col: "family", op: "eq", value: "60" }, { col: "status", op: "eq", value: "Valid" }] });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.ok(c.sql.includes("WHERE family = ?1 AND status = ?2"));
  assert.deepEqual(c.params, ["60", "Valid"]);
  assert.ok(!c.sql.includes("'60'"), "values never interpolate");
});

test("compileFind: an unknown column names the valid columns (schema-linked errors)", () => {
  const c = compileFind({ table: "certificates", where: [{ col: "holder_name", op: "eq", value: "x" }] });
  assert.ok(!c.ok);
  if (c.ok) return;
  assert.match(c.error, /has no column "holder_name"/);
  assert.match(c.error, /num, family, holder, model/);
});

test("compileFind: an unknown table names the published tables", () => {
  const c = compileFind({ table: "api_keys", where: [] });
  assert.ok(!c.ok);
  if (c.ok) return;
  assert.match(c.error, /unknown table "api_keys"/);
  assert.match(c.error, /certificates, documents/);
});

test("compileFind: private tables are unreachable", () => {
  for (const t of ["api_keys", "queries", "spend", "feedback", "memories", "projects", "project_files", "conversations", "messages", "shared_conversations", "conversation_entities", "attachments", "model_plane_meta"]) {
    assert.ok(!publishedTable(t), `${t} must not be published`);
  }
});

test("compileFind: in/between/like bind their values", () => {
  const c = compileFind({ table: "certificates", where: [{ col: "status", op: "in", value: ["Valid", "Suspended"] }, { col: "year", op: "between", value: [2020, 2024] }, { col: "holder", op: "like", value: "ASCELL%" }] });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.ok(c.sql.includes("IN (?1, ?2)"));
  assert.ok(c.sql.includes("BETWEEN ?3 AND ?4"));
  assert.ok(c.sql.includes("LIKE ?5"));
  assert.deepEqual(c.params, ["Valid", "Suspended", 2020, 2024, "ASCELL%"]);
});

test("compileFind: numeric ops cast text-carried numbers (certificates.year)", () => {
  const c = compileFind({ table: "certificates", where: [{ col: "year", op: "ge", value: 2021 }], order_by: { col: "year", dir: "desc" } });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.ok(c.sql.includes("CAST(year AS INTEGER) >= ?1"));
  assert.ok(c.sql.includes("ORDER BY CAST(year AS INTEGER) DESC"));
});

test("compileFind: numeric ops refuse text columns", () => {
  const c = compileFind({ table: "certificates", where: [{ col: "holder", op: "lt", value: "A" }] });
  assert.ok(!c.ok);
  if (c.ok) return;
  assert.match(c.error, /needs a numeric column/);
});

test("compileFind: limit clamps to 25", () => {
  const c = compileFind({ table: "certificates", limit: 500 });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.ok(c.sql.endsWith("LIMIT 25"));
});

test("compileFind: agg compiles count and group_by", () => {
  const c = compileFind({ table: "certificates", agg: { fn: "count" }, group_by: ["family"], where: [{ col: "status", op: "eq", value: "Valid" }] });
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.match(c.sql, /^SELECT family, COUNT\(\*\) AS agg FROM certificates WHERE status = \?1 GROUP BY family/);
});

test("compileFind: wide columns are not in the default select", () => {
  for (const t of DB_CATALOG) {
    for (const w of t.columns.filter((c) => c.wide)) {
      assert.ok(!t.default_select.includes(w.name), `${t.name}.${w.name} must not default-select`);
    }
  }
});

test("the catalog stays in sync with schema.sql (published tables exist, columns real)", () => {
  const ddl = readFileSync(new URL("../workers/worker_public/schema.sql", import.meta.url), "utf8");
  const tableOf = (name: string): string[] | null => {
    const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`).exec(ddl);
    if (!m) return null;
    return m[1].split("\n").map((l) => l.trim().split(/\s+/)[0]?.replace(",", "")).filter((c) => c && !c.startsWith("--"));
  };
  for (const t of DB_CATALOG) {
    const cols = tableOf(t.name);
    if (!cols) continue; // certificates' DDL ships with the register ingest, not schema.sql
    for (const c of t.columns) {
      assert.ok(cols.includes(c.name), `${t.name}.${c.name} is not in schema.sql`);
    }
  }
});

test("runSchema: the catalog names the grammar and the tables", () => {
  const r = runSchema();
  assert.match(r.output, /db\.find/);
  assert.match(r.output, /certificates — /);
  const one = runSchema("documents");
  assert.match(one.output, /canonical_id/);
  const bad = runSchema("nope");
  assert.match(bad.output, /Unknown table "nope"/);
});

test("runFind: rejections name the fix; rows format with the echoed query", async () => {
  const rejected = await runFind({ DB: null } as any, { table: "certificates", where: [{ col: "nope", op: "eq", value: 1 }] });
  assert.match(rejected!.output, /rejected/);
  assert.match(rejected!.output, /Valid columns/);

  const rows = [{ num: "R60/2021-A-NL1-26.12", holder: "Técnicas" }];
  const env = { DB: { prepare: (_sql: string) => ({ bind: (..._p: unknown[]) => ({ all: async () => ({ results: rows }) }) }) } };
  const ok = await runFind(env as any, { table: "certificates", where: [{ col: "family", op: "eq", value: "60" }] });
  assert.match(ok!.output, /db\.find certificates · where family eq "60"/);
  assert.match(ok!.output, /R60\/2021-A-NL1-26\.12/);
});

test("the line protocol parses db.find's nested predicates", () => {
  const call = parseToolCall('TOOL db.find {"table":"certificates","where":[{"col":"family","op":"eq","value":"60"}],"order_by":{"col":"year","dir":"desc"}}');
  assert.ok(call);
  assert.equal(call!.name, "db.find");
  assert.equal((call!.args.where as unknown[])[0] && (call!.args.where as { col: string }[])[0].col, "family");
  assert.equal(parseToolCall("TOOL db.find {broken"), null);
});

test("the declaration arms the data plane: schema first, then find, three rounds", () => {
  assert.match(TOOL_DECLARATION, /TOOL db\.schema/);
  assert.match(TOOL_DECLARATION, /TOOL db\.find/);
  assert.match(TOOL_DECLARATION, /up to three calls/);
  assert.match(TOOL_DECLARATION, /single line/);
});
