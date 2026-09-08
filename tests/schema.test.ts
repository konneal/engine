// Contract test: the D1 schema has ONE set of tables, however you build
// the database. schema.sql (bootstrap path) and migrations/*.sql
// (incremental path) drifted disjointly before 0011 — a fresh
// migrations-only environment lacked api_keys (hit live 2026-09-07).
// This test fails when either path adds a table the other lacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function createTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]!);
}

test("schema.sql and migrations define the same table set", () => {
  const schema = readFileSync(new URL("../workers/worker_public/schema.sql", import.meta.url), "utf8");
  const migrationsDir = new URL("../workers/worker_public/migrations/", import.meta.url);
  const migrationSql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, migrationsDir), "utf8"))
    .join("\n");
  assert.deepEqual(
    [...new Set(createTables(schema))].sort(),
    [...new Set(createTables(migrationSql))].sort(),
    "schema.sql and migrations/*.sql table sets drifted — add the table to BOTH (see 0011_schema_union.sql)",
  );
});
