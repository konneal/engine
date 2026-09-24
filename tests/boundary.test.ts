import assert from "node:assert/strict";
import { test } from "node:test";
import { matchLicensedTopic, boundaryNoteText, distinctiveTokens, type LicensedEntry } from "../workers/worker_public/src/boundary.ts";

// the deployment profile's licensed entries, trimmed to the fields the matcher reads
const licensed: LicensedEntry[] = [
  { key: "std:iec-60068-2-30", doc_number: "60068-2-30", title: "IEC 60068-2-30:2005 — Environmental testing, damp heat, cyclic" },
  { key: "std:iec-60068-2-78", doc_number: "60068-2-78", title: "IEC 60068-2-78:2001 — Environmental testing, damp heat, steady state" },
  { key: "std:iec-60068-3-4", doc_number: "60068-3-4", title: "IEC 60068-3-4:2001 — Environmental testing, guidance for damp heat tests" },
  { key: "std:iec-61000-4-2", doc_number: "61000-4-2", title: "IEC 61000-4-2:2008 — EMC, testing and measurement techniques, electrostatic discharge immunity test" },
  { key: "std:iec-61000-4-3", doc_number: "61000-4-3", title: "IEC 61000-4-3:2010 — EMC, radiated radio-frequency electromagnetic field immunity test" },
];

test("the damp-heat cyclic question matches 60068-2-30, the most specific entry", () => {
  const m = matchLicensedTopic("What are the steps of the damp-heat cyclic test?", licensed);
  assert.equal(m?.entry.key, "std:iec-60068-2-30");
  assert.ok(m!.matched.includes("cyclic"));
});

test("steady state matches 60068-2-78 over the generic damp-heat entries", () => {
  const m = matchLicensedTopic("What does the damp heat steady state test require?", licensed);
  assert.equal(m?.entry.key, "std:iec-60068-2-78");
});

test("a single shared word is not a topic match", () => {
  assert.equal(matchLicensedTopic("What is an immunity test?", licensed), null);
  assert.equal(matchLicensedTopic("What is environmental testing?", licensed), null);
});

test("unrelated questions never light the boundary", () => {
  assert.equal(matchLicensedTopic("What is a load cell according to OIML R 60?", licensed), null);
});

test("stopwords strip the generic shell off the titles", () => {
  assert.deepEqual(distinctiveTokens("IEC 61000-4-2:2008 — EMC, testing and measurement techniques, electrostatic discharge immunity test"), ["emc", "electrostatic", "discharge"]);
});

test("the note names the document, its references, and the recite-never posture", () => {
  const m = matchLicensedTopic("What are the steps of the damp-heat cyclic test?", licensed)!;
  const note = boundaryNoteText(m, ["OIML D 11 (2013)", "OIML R 129-2 (2020)"]);
  assert.ok(note.includes("60068-2-30"));
  assert.ok(note.includes("OIML D 11 (2013)"));
  assert.ok(note.includes("OIML R 129-2 (2020)"));
  assert.ok(note.includes("do NOT recite"));
  assert.ok(note.includes("cycle counts"));
});

test("the note stands without citing publications", () => {
  const m = matchLicensedTopic("the electrostatic discharge test", licensed)!;
  const note = boundaryNoteText(m, []);
  assert.ok(note.includes("61000-4-2"));
  assert.ok(!note.includes("The public corpus references"));
});
