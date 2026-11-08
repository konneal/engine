// The member's imported values as the STATED STATE of their checks
// (TODO.sota/20): the fields parse, the flat text carries numbers with
// units, and nothing leaks from other members.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsAsText, memberDocFields } from "../workers/worker_public/src/userDocuments.ts";

test("memberDocFields reads ready rows only and tolerates bad blobs", async () => {
  const rows = [
    { id: "d1", name: "report.pdf", fields: JSON.stringify({ mpe_at_1000v: "0.08 %", instrument: "XYZ 200" }) },
    { id: "d2", name: "broken.pdf", fields: "{not json" },
    { id: "d3", name: "importing.pdf", fields: JSON.stringify({ a: "1" }), status: "importing" },
  ];
  const store = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows.filter((r) => (r as any).status !== "importing") }),
      }),
    }),
  };
  const docs = await memberDocFields(store as any, "sub-1");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].doc_id, "d1");
  assert.equal(docs[0].fields.mpe_at_1000v, "0.08 %");
});

test("fieldsAsText flattens to lines the unit parser can read", () => {
  const text = fieldsAsText([{ doc_id: "d1", name: "r", fields: { "mpe at 1000 v": "0.08 %", "range max": "30000 v" } }]);
  assert.match(text, /mpe at 1000 v: 0\.08 %/);
  assert.match(text, /range max: 30000 v/);
});
