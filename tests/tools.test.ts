import test from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, runTool, toolNote, TOOL_DECLARATION } from "../workers/worker_public/src/tools.ts";

test("the tool protocol parses a clean call and prose around it", () => {
  const c = parseToolCall('Let me check.\nTOOL certificates.search {"query": "ASCELL CF"}\nThen I will answer.');
  assert.equal(c?.name, "certificates.search");
  assert.equal((c?.args as any)?.query, "ASCELL CF");
  const bare = parseToolCall("TOOL certificates.search {}");
  assert.equal(bare?.name, "certificates.search");
  assert.equal(parseToolCall("no tool here"), null);
  assert.equal(parseToolCall('TOOL certificates.search {broken'), null);
  assert.equal(parseToolCall("TOOL delete_everything {}")?.name, "delete_everything");
});

test("the injected note attributes the result to the tool and the string", () => {
  const note = toolNote({ name: "certificates.search", query: "ASCELL CF", output: "3 rows…" });
  assert.match(note, /certificates.search tool returned/);
  assert.match(note, /"ASCELL CF"/);
});

test("the declaration demands the visible string and the attributed phrasing", () => {
  assert.match(TOOL_DECLARATION, /TOOL certificates.search/);
  assert.match(TOOL_DECLARATION, /searched string visible in your answer/);
});

test("the family normalizes to the column's digits-only form", async () => {
  const { queryFamily } = await import("../workers/worker_public/src/certificates.ts");
  assert.equal(queryFamily("does this manufacturer have the R 60 certificate?"), "R60");
});

test("the registry is the tool surface: the declaration is generated and dispatch is lookup", async () => {
  assert.match(TOOL_DECLARATION, /TOOL certificates\.search \{"query"/);
  // the generated declaration's tool line comes from the registry entry —
  // the proof of generation is structural: exactly one occurrence of the
  // name (the generated line), never a second hand-written copy
  assert.equal(TOOL_DECLARATION.split("certificates.search").length - 1, 1, "the name appears exactly once — generated, not duplicated");
  const r = await runTool({}, { name: "certificates.search", args: { query: "" } });
  assert.equal(r, null, "an empty query returns null — the handler decides");
  const unknown = await runTool({}, { name: "nope.tool", args: {} });
  assert.equal(unknown, null, "an unregistered name dispatches to nothing");
});

test("the parser accepts dotted tool names", () => {
  const c = parseToolCall('prose\nTOOL certificates.search {"query": "ASCELL CF"}');
  assert.ok(c);
  assert.equal(c.name, "certificates.search");
  assert.equal(c.args.query, "ASCELL CF");
});
