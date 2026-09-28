import test from "node:test";
import assert from "node:assert/strict";
import { isOperationIntent, catalogNote, matchOperations, anchorWords } from "../workers/worker_public/src/operations.ts";

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

test("the question's object words reach the operation through its NAME, not its description wording", () => {
  const rows = [
    { anchor: "putEntityRecord", text: "Replaces the stored value for one entity, checked against the store's schema." },
    { anchor: "uploadBlob", text: "Uploads a binary object and updates the owner's blob index." },
    { anchor: "getEntityRecord", text: "Reads the stored value for one entity." },
    { anchor: "updateStore", text: "Updates a store's metadata." },
  ];
  const matched = matchOperations("Which platform operation updates an entity record?", rows);
  assert.equal(matched[0].anchor, "putEntityRecord");
  assert.ok(matched.length >= 2, `siblings should follow: ${matched.map((m) => m.anchor).join(", ")}`);
  assert.ok(matched.every((m) => m.anchor !== "uploadBlob"), "a verb-only mention must not displace the object match");
});

test("anchorWords splits camelCase and snake anchors", () => {
  assert.deepEqual(anchorWords("putEntityRecord"), ["put", "entity", "record"]);
  assert.deepEqual(anchorWords("get_entity_record"), ["get", "entity", "record"]);
});

test("a question with no object overlap still matches on the verb stem", () => {
  const rows = [
    { anchor: "deleteBlob", text: "Deletes one uploaded blob." },
    { anchor: "getEntityRecord", text: "Reads the stored value for one entity." },
  ];
  const matched = matchOperations("Which operation deletes a file?", rows);
  assert.equal(matched[0].anchor, "deleteBlob");
});
