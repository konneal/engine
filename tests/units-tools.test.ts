// The unitsdb plane's tools: lookup binds symbols and names to the
// canonical unit with its dimension and quantities; conversion is
// exact over SI prefix powers, refuses cross-dimension pairs, and
// states the non-SI honesty (a ratio scale is not a factor) instead of
// inventing one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../workers/worker_public/src/tools.ts";

const METER = {
  code: "u:meter", short: "meter", name_en: "meter", name_fr: "mètre",
  root: 1, symbols: JSON.stringify({ ascii: "m" }), root_units: "[]",
  dimension_id: "NISTd1", dimension_ascii: "L", quantity_ids: '["NISTq1"]',
  unit_system: "si-base", scale: "continuous_ratio",
};
const KM = {
  code: "u:kilometer", short: "kilometer", name_en: "kilometer", name_fr: "kilomètre",
  root: 0, symbols: JSON.stringify({ ascii: "km" }), root_units: '[{"code":"u:meter","power":1}]',
  dimension_id: "NISTd1", dimension_ascii: "L", quantity_ids: '["NISTq1"]',
  unit_system: "non-SI_not_acceptable", scale: "continuous_ratio",
};
const PASCAL = {
  code: "u:pascal", short: "pascal", name_en: "pascal", name_fr: null,
  root: 0, symbols: JSON.stringify({ ascii: "Pa" }), root_units: '[{"code":"u:newton","power":-2},{"code":"u:meter","power":2}]',
  dimension_id: "NISTd22", dimension_ascii: "L^-1·M·T^-2", quantity_ids: '["NISTq44"]',
  unit_system: "SI_derived_special", scale: "continuous_ratio",
};
const FOOT = {
  code: "u:foot", short: "foot", name_en: "foot", name_fr: null,
  root: 0, symbols: JSON.stringify({ ascii: "ft" }), root_units: "[]",
  dimension_id: "NISTd1", dimension_ascii: "L", quantity_ids: '["NISTq1"]',
  unit_system: "non-SI_acceptable", scale: "continuous_ratio",
};

function db(rowsByShape: { units?: any[]; prefixes?: any[]; quantities?: any[] }) {
  return {
    prepare(sql: string) {
      return {
        bind: (..._a: unknown[]) => ({
          all: async () => ({
            results: sql.includes("unit_prefixes")
              ? (db.rows.prefixes ?? []).filter((p: any) => sql.includes("symbol = ?1") || true)
              : sql.includes("unit_quantities")
                ? (db.rows.quantities ?? [])
                : (db.rows.units ?? []),
          }),
        }),
      };
    },
  };
}
// per-call row selection: the fake keys off the bound value
function unitDb(units: any[], prefixes: any[] = [], quantities: any[] = []) {
  const d: any = { rows: { prefixes, quantities } };
  d.prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        if (sql.includes("unit_prefixes")) return { results: prefixes.filter((p: any) => args.includes(p.symbol)) };
        if (sql.includes("unit_quantities")) return { results: quantities.filter((q: any) => args.includes(q.id)) };
        return { results: units.filter((u: any) => args.some((a) => [u.code, u.short, u.name_en?.toLowerCase(), JSON.parse(u.symbols || "{}").ascii?.toLowerCase()].includes(String(a).toLowerCase()) || String(a) === u.code || String(a) === u.short)) };
      },
      // the lookup's quantity loop binds ids one at a time
      first: async () => null,
    }),
  });
  return d;
}

test("units.lookup binds a symbol to the canonical unit with its dimension", async () => {
  const db2 = unitDb([METER], [], [{ id: "NISTq1", name_en: "length" }]);
  const r = await runTool({ DB: db2 }, { name: "units.lookup", args: { term: "m" } }, "mcp");
  assert.ok(r);
  const u = JSON.parse(r.output);
  assert.equal(u.code, "u:meter");
  assert.equal(u.symbol, "m");
  assert.equal(u.dimension, "L");
  assert.deepEqual(u.quantities, ["length"]);
});

test("units.convert applies SI prefix powers exactly", async () => {
  const db2 = unitDb([METER], [{ id: "p:kilo", name_en: "kilo", symbol: "k", base: 10, power: 3 }]);
  const r = await runTool({ DB: db2 }, { name: "units.convert", args: { value: 5, from_unit: "km", to_unit: "m" } }, "mcp");
  assert.ok(r);
  const out = JSON.parse(r.output);
  assert.equal(out.result, 5000);
  assert.equal(out.dimension, "L");
});

test("units.convert refuses cross-dimension pairs plainly", async () => {
  const db2 = unitDb([METER, PASCAL]);
  const r = await runTool({ DB: db2 }, { name: "units.convert", args: { value: 1, from_unit: "m", to_unit: "Pa" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /Not convertible/);
});

test("units.convert states the non-SI honesty instead of inventing a factor", async () => {
  const db2 = unitDb([FOOT, METER]);
  const r = await runTool({ DB: db2 }, { name: "units.convert", args: { value: 3, from_unit: "ft", to_unit: "m" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /defines no numeric factor/);
  assert.match(r.output, /no factor is invented/);
});

test("units.convert with an unknown unit states the miss", async () => {
  const db2 = unitDb([METER]);
  const r = await runTool({ DB: db2 }, { name: "units.convert", args: { value: 1, from_unit: "parsec", to_unit: "m" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No unit matches "parsec"/);
});
