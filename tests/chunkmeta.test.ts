// Contract test: the serving-side chunk wire type and the producer-side
// pydantic schema are the same set of fields. The producer
// (ingest/vector_adapter.py ChunkMetaModel) is canonical; the serving
// mirror (workers/shared/chunk.ts) must never drift from it — a field
// renamed on one side only would silently vanish at the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHUNK_META_FIELDS } from "../workers/shared/chunk.ts";

function pydanticFields(source: string): string[] {
  const cls = source.indexOf("class ChunkMetaModel(BaseModel):");
  assert.ok(cls >= 0, "ChunkMetaModel not found in vector_adapter.py");
  const body = source.slice(cls);
  const fields: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    if (/^\S/.test(line)) break; // next top-level statement ends the class
    const m = line.match(/^\s{4}([a-z_]+)\s*:/);
    if (m) fields.push(m[1]!);
  }
  return fields;
}

test("serving ChunkMeta fields match the pydantic wire schema exactly", () => {
  const source = readFileSync(new URL("../ingest/vector_adapter.py", import.meta.url), "utf8");
  const producer = pydanticFields(source);
  assert.ok(producer.length >= 20, `parsed too few pydantic fields: ${producer.join(",")}`);
  const serving = [...CHUNK_META_FIELDS];
  assert.deepEqual(
    [...serving].sort(),
    [...producer].sort(),
    "workers/shared/chunk.ts and ingest/vector_adapter.py ChunkMetaModel drifted — change both in the same commit",
  );
});
