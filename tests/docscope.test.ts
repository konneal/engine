// The seal's grain fix (the 2026-10-09 gate): parts live at family
// grain in the corpus — doc_number "60" — with the part identity only
// in the docidentifier. matchesDocScope admits exactly the declared
// part; the R 60-2 neighbor never passes an R 60-1 chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesDocScope } from "../workers/worker_public/src/context.ts";

const r60part = { doc_number: "60", docidentifier: "OIML R 60-1:2021", edition: "2021" };
const r60other = { doc_number: "60", docidentifier: "OIML R 60-2:2021", edition: "2021" };
const r60mono = { doc_number: "60", docidentifier: "OIML R 60:2017", edition: "2017" };

test("a part scope admits its own family-grain chunks by identifier stem", () => {
  assert.equal(matchesDocScope(r60part, "60-1"), true);
  assert.equal(matchesDocScope(r60part, "60-1"), true); // stable
});

test("a part scope excludes the sibling part at the same family grain", () => {
  assert.equal(matchesDocScope(r60other, "60-1"), false);
});

test("a part scope excludes the monolith at the same family grain", () => {
  assert.equal(matchesDocScope(r60mono, "60-1"), false);
});

test("exact grain agreement matches without the identifier", () => {
  assert.equal(matchesDocScope({ doc_number: "60-1" }, "60-1"), true);
  assert.equal(matchesDocScope({ doc_number: "60" }, "60"), true);
});

test("a family-numbered scope admits every part at that grain", () => {
  // the understanding's doc_number is often the bare family number —
  // it must keep admitting the parts (the dense filter's semantics)
  assert.equal(matchesDocScope(r60part, "60"), true);
  assert.equal(matchesDocScope(r60other, "60"), true);
  assert.equal(matchesDocScope(r60mono, "60"), true);
});

test("edition and language markers do not break the stem", () => {
  assert.equal(matchesDocScope({ doc_number: "76", docidentifier: "OIML R 76-1:2006 (E)" }, "76-1"), true);
  assert.equal(matchesDocScope({ doc_number: "76", docidentifier: "OIML R 76-2:2007 (F)" }, "76-1"), false);
});
