import test from "node:test";
import assert from "node:assert/strict";
import { parseNameplate, nameplateRegisterQuery } from "../workers/worker_public/src/nameplate-parse.ts";

test("the nameplate parser takes the JSON and nothing else", () => {
  const np = parseNameplate('Sure! {"manufacturer": "ASCELL", "model": "CF"} hope that helps');
  assert.equal(np?.manufacturer, "ASCELL");
  assert.equal(np?.model, "CF");
  assert.equal(parseNameplate('{"manufacturer": null, "model": null}'), null);
  assert.equal(parseNameplate("no json at all"), null);
  const long = parseNameplate(`{"manufacturer": "${"X".repeat(200)}", "model": "CF"}`);
  assert.ok((long?.manufacturer?.length ?? 0) <= 80);
});

test("the register query leads with the nameplate and scopes the family", () => {
  const q = nameplateRegisterQuery({ manufacturer: "ASCELL", model: "CF" }, "does this manufacturer have the R 60 certificate?");
  assert.equal(q, "ASCELL CF R 60");
  const noFam = nameplateRegisterQuery({ manufacturer: "Utilcell", model: null }, "any certificates?");
  assert.equal(noFam, "Utilcell");
});
