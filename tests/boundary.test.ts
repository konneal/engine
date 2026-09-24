import assert from "node:assert/strict";
import { test } from "node:test";
import { matchLicensedTopic, boundaryNoteText, distinctiveTokens, type LicensedEntry } from "../workers/worker_public/src/boundary.ts";

// synthetic fixtures — the engine is publisher-agnostic code and carries
// no deployment data; the real licensed catalog arrives at runtime from
// the deployment profile (P().sources.licensed)
const licensed: LicensedEntry[] = [
  { key: "std:acme-ab-99", doc_number: "ab-99", title: "ACME AB-99:2019 — Climatic conditioning, cyclic humidity" },
  { key: "std:acme-ab-7", doc_number: "ab-7", title: "ACME AB-7:2001 — Climatic conditioning, steady humidity" },
  { key: "std:acme-cd-5", doc_number: "cd-5", title: "ACME CD-5:2008 — Electrostatic discharge test" },
];

test("the cyclic-humidity question matches ab-99, the most specific entry", () => {
  const m = matchLicensedTopic("What are the steps of the cyclic humidity conditioning test?", licensed);
  assert.equal(m?.entry.key, "std:acme-ab-99");
  assert.ok(m!.matched.includes("cyclic"));
});

test("steady humidity matches ab-7 over the generic sibling", () => {
  const m = matchLicensedTopic("What does the steady humidity conditioning test require?", licensed);
  assert.equal(m?.entry.key, "std:acme-ab-7");
});

test("a single shared word is not a topic match", () => {
  assert.equal(matchLicensedTopic("What is an electrostatic test?", licensed), null);
});

test("unrelated questions never light the boundary", () => {
  assert.equal(matchLicensedTopic("What is a transducer?", licensed), null);
});

test("stopwords strip the generic shell off the titles", () => {
  assert.deepEqual(distinctiveTokens("ACME CD-5:2008 — Electrostatic discharge test"), ["acme", "electrostatic", "discharge"]);
});

test("the note names the document, its references, and the posture", () => {
  const m = matchLicensedTopic("What are the steps of the cyclic humidity conditioning test?", licensed)!;
  const note = boundaryNoteText(m, ["ACME D 4 (2013)", "ACME EF 2-1 (2020)"]);
  assert.ok(note.includes("ab-99"));
  assert.ok(note.includes("ACME D 4 (2013)"));
  assert.ok(note.includes("ACME EF 2-1 (2020)"));
  assert.ok(note.includes("Do NOT state"));
  assert.ok(note.includes("cycle counts"));
  assert.ok(note.includes("not even as a single bound"));
});

test("the note stands without citing publications", () => {
  const m = matchLicensedTopic("the electrostatic discharge test", licensed)!;
  const note = boundaryNoteText(m, []);
  assert.ok(note.includes("cd-5"));
  assert.ok(!note.includes("The public corpus references"));
});
