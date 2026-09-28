import test from "node:test";
import assert from "node:assert/strict";
import { isOperationIntent, catalogNote } from "../workers/worker_public/src/operations.ts";

test("operation intent: the noun triggers, ordinary questions do not", () => {
  assert.equal(isOperationIntent("Which platform operation updates an entity record?"), true);
  assert.equal(isOperationIntent("What endpoints expose the register?"), true);
  assert.equal(isOperationIntent("What is the MPE for a load cell?"), false);
  assert.equal(isOperationIntent("Is ASCELL SENSOR certified?"), false);
});

test("the catalog note is a complete, attributed name index", () => {
  const note = catalogNote(["putEntityRecord", "getEntityRecord", "deleteBlob"]);
  assert.match(note, /COMPLETE name index/);
  assert.match(note, /- putEntityRecord/);
  assert.match(note, /- getEntityRecord/);
  assert.equal(catalogNote([]), "");
});
