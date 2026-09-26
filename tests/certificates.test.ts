// The register search: register-shaped questions query the D1 table,
// misses are stated as misses, and the note quotes the snapshot's terms.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegisterShaped, registerNote, registerTokens, searchRegister } from "../workers/worker_public/src/certificates.ts";

test("register-shaped detection: standing questions in, definitions out", () => {
  assert.equal(isRegisterShaped("Is the Utilcell 190 model still certified in the OIML R 60 certificate register?"), true);
  assert.equal(isRegisterShaped("What is the status of certificate R60/1999-GB1-99.01?"), true);
  assert.equal(isRegisterShaped("What must a load cell certificate contain per R 60?"), false);
});

test("the tokens skip the question words and keep the identifiers", () => {
  const tokens = registerTokens("Is the Utilcell 190 model still certified in the OIML R 60 certificate register?");
  assert.ok(tokens.includes("Utilcell"));
  assert.ok(tokens.includes("190"));
  assert.ok(!tokens.includes("still"));
  assert.ok(!tokens.includes("certified"));
});

test("a miss returns zero rows and the note states the snapshot honestly", async () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };
  const out = await searchRegister(db, "Is the Utilcell 190 still certified in the R 60 register?");
  assert.ok(out);
  assert.equal(out.rows.length, 0);
  const note = registerNote(out.rows);
  assert.match(note, /NO certificate matching/);
  assert.match(note, /snapshot/);
});

test("a hit carries the register's own fields for verbatim quoting", async () => {
  const rows = [{ num: "R60/2021-DK1-24.01", family: "R60", holder: "Vetek Weighing AB", model: "CFSI", year: "2024", status: "Valid" }];
  const note = registerNote(rows);
  assert.match(note, /Vetek Weighing AB/);
  assert.match(note, /status Valid/);
});

test("a D1 failure degrades to no-note, never an error", async () => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("down"); } }) }) };
  const out = await searchRegister(db, "Is the Utilcell 190 still certified?");
  assert.ok(out);
  assert.equal(out.rows.length, 0);
});
