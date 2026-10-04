// The bibliography record tool: a label resolves to its registry node
// with the document row (derived status, ACTIVE flag), its relation
// edges and its outgoing citations; an unknown label is stated, never
// improvised.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../workers/worker_public/src/tools.ts";

// a chainable fake: every prepare(sql) returns a responder keyed by the
// SQL's shape (graph_nodes lookup, documents row, relations, citations)
const db = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [
          { id: "doc:OIML-R-60-2017", kind: "doc", label: "OIML R 60:2017" },
        ],
      }),
    }),
  }),
};
const docDb = {
  prepare: (sql: string) => ({
    bind: () => ({
      all: async () => ({
        results: sql.includes("FROM graph_nodes")
          ? [{ id: "doc:OIML-R-60-2017", kind: "doc", label: "OIML R 60:2017" }]
          : sql.includes("FROM documents")
            ? [{ docidentifier: "OIML R 60:2017", family: "R-60", part: null, edition: "2017", derived_status: "superseded", active: 0, superseded_by: "doc:OIML-R-60-2021", title: "Metrological regulation for load cells" }]
            : sql.includes("kind = 'cites'")
              ? [{ cited: "ISO 8601" }, { cited: "OIML B 18" }]
              : [{ kind: "successor", target: "OIML R 60:2021" }],
      }),
    }),
  }),
};

test("bib.entry resolves a label to document, relations and citations", async () => {
  const r = await runTool({ DB: docDb }, { name: "bib.entry", args: { label: "OIML R 60:2017" } }, "mcp");
  assert.ok(r);
  const entries = JSON.parse(r.output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].document.docidentifier, "OIML R 60:2017");
  assert.equal(entries[0].document.active, false);
  assert.equal(entries[0].document.status, "superseded");
  assert.deepEqual(entries[0].relations, [{ kind: "successor", target: "OIML R 60:2021" }]);
  assert.deepEqual(entries[0].cites, ["ISO 8601", "OIML B 18"]);
});

test("bib.entry states an unknown label plainly", async () => {
  const empty = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  const r = await runTool({ DB: empty }, { name: "bib.entry", args: { label: "Nope 123" } }, "mcp");
  assert.ok(r);
  assert.match(r.output, /No registry node carries the label/);
});

test("bib.entry is mcp-audience only", async () => {
  const r = await runTool({ DB: db }, { name: "bib.entry", args: { label: "OIML R 60:2017" } });
  assert.equal(r, null, "the agent audience cannot dispatch it");
});
