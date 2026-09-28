import test from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, toolNote, TOOL_DECLARATION } from "../workers/worker_public/src/tools.ts";

test("the tool protocol parses a clean call and prose around it", () => {
  const c = parseToolCall('Let me check.\nTOOL register_search {"query": "ASCELL CF"}\nThen I will answer.');
  assert.equal(c?.name, "register_search");
  assert.equal((c?.args as any)?.query, "ASCELL CF");
  const bare = parseToolCall("TOOL register_search {}");
  assert.equal(bare?.name, "register_search");
  assert.equal(parseToolCall("no tool here"), null);
  assert.equal(parseToolCall('TOOL register_search {broken'), null);
  assert.equal(parseToolCall("TOOL delete_everything {}")?.name, "delete_everything");
});

test("the injected note attributes the result to the tool and the string", () => {
  const note = toolNote({ name: "register_search", query: "ASCELL CF", output: "3 rows…" });
  assert.match(note, /register_search tool returned/);
  assert.match(note, /"ASCELL CF"/);
});

test("the declaration demands the visible string and the attributed phrasing", () => {
  assert.match(TOOL_DECLARATION, /TOOL register_search/);
  assert.match(TOOL_DECLARATION, /searched string stays visible/);
});

test("the family normalizes to the column's digits-only form", async () => {
  const { queryFamily } = await import("../workers/worker_public/src/certificates.ts");
  assert.equal(queryFamily("does this manufacturer have the R 60 certificate?"), "R60");
});
