// Unit tests for the family community-summary seam (TODO.sota/06 item 2):
// editionNote serves the precomputed KV summary beside the
// deterministic registry line; the handler's family validation and the
// lineage SQL are pinned against fixture stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editionNote } from "../workers/worker_public/src/graph.ts";

const env = (famsum: string | null) => ({
  DB: {
    prepare(sql: string) {
      if (sql.includes("active = 1")) {
        return {
          bind(..._a: unknown[]) {
            return { all: async () => ({ results: [{ docidentifier: "OIML R 60-1:2021" }, { docidentifier: "OIML R 60-2:2021" }] }) };
          },
        };
      }
      // the family lookup
      return {
        bind(..._a: unknown[]) {
          return { first: async () => ({ family: "R-60" }) };
        },
      };
    },
  },
  CACHE: {
    async get(key: string) { return key === "famsum:R-60" ? famsum : null; },
  },
});

test("editionNote: the registry line alone when no summary is stored", async () => {
  const note = await editionNote(env(null) as any, { doc_number: "60" });
  assert.ok(note!.startsWith("Publication registry (authoritative):"));
  assert.ok(note!.includes("OIML R 60-1:2021"));
  assert.ok(!note!.includes("Family summary"));
});

test("editionNote: the precomputed summary rides beside the registry line", async () => {
  const note = await editionNote(env("The 2017 monolith was split into parts in 2021.") as any, { doc_number: "60" });
  assert.ok(note!.startsWith("Publication registry (authoritative):"));
  const i = note!.indexOf("Family summary (precomputed from the registry and the successor graph):");
  assert.ok(i > 0, "the summary block rides");
  assert.ok(note!.slice(i).includes("split into parts"));
});

test("editionNote: no doc scope, no note", async () => {
  assert.equal(await editionNote(env("x") as any, null), undefined);
  assert.equal(await editionNote(env("x") as any, { doc_number: null }), undefined);
});
