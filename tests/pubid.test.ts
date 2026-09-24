// The OIML grammar is the unified pubid grammar (@pubid/pubid's oiml
// flavor); this codec adapts it to the surfaces callers use (bare
// forms, URNs, family keys, the dual-published print). The
// conformance expectations live in tests/pubid-testsuite.test.ts
// (against pubid/pubid-testsuite); this file pins the codec's OWN
// adaptation contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oimlPubid } from "../workers/worker_public/src/codecs.ts";

test("prefixed, bare and URN forms parse to one scope", () => {
  const expected = { doc_number: "60", edition: "2021", label: "OIML R 60-1:2021" };
  assert.deepEqual(oimlPubid.parse("OIML R 60-1:2021"), expected);
  assert.deepEqual(oimlPubid.parse("R 60-1:2021"), expected);
  assert.deepEqual(oimlPubid.parse("urn:oiml:pub:r:60-1:2021"), expected);
});

test("the edition argument wins over the parsed year (bibdata's truth)", () => {
  assert.equal(oimlPubid.parse("OIML R 60-1:2004", "2021")?.edition, "2021");
  assert.equal(oimlPubid.parse("OIML R 87", "2004")?.edition, "2004");
});

test("families and types: B, V, D parse with their letters", () => {
  assert.equal(oimlPubid.parse("OIML B 18:2025")?.label, "OIML B 18:2025");
  assert.equal(oimlPubid.parse("OIML V 2-200")?.label, "OIML V 2-200");
  assert.equal(oimlPubid.parse("OIML D 29")?.label, "OIML D 29");
});

test("the dual-published print resolves to the OIML side, either order", () => {
  const expected = { doc_number: "49", edition: "2024", label: "OIML R 49-1:2024" };
  assert.deepEqual(oimlPubid.parse("ISO 4064-1:2024|OIML R 49-1:2024"), expected);
  assert.deepEqual(oimlPubid.parse("OIML R 49-1:2024|ISO 4064-1:2024"), expected);
});

test("rejections never parse (incl. the glued class designations)", () => {
  assert.equal(oimlPubid.parse("OIML X 99"), null);
  assert.equal(oimlPubid.parse("E2 weights"), null);
  assert.equal(oimlPubid.parse("urn:oiml:pub:x:99"), null);
  assert.equal(oimlPubid.parse("OIML-CS PD-06"), null);
});

test("R 060 normalizes to R 60 (display and steering agree)", () => {
  assert.equal(oimlPubid.parse("OIML R 060")?.doc_number, "60");
  assert.equal(oimlPubid.parse("OIML R 060")?.label, "OIML R 60");
});

test("familyOf uses the grammar, with the regex floor for odd prints", () => {
  assert.equal(oimlPubid.familyOf("OIML R 60-1:2004 (E)"), "R-60");
  assert.equal(oimlPubid.familyOf("OIML B 18 Edition 4"), "B-18");
  assert.equal(oimlPubid.familyOf("OIML R 060"), "R-60");
  assert.equal(oimlPubid.familyOf("ISO 8601:2004"), null);
});

test("scanQuestion (the question-tolerant surface) is unchanged", () => {
  const s = oimlPubid.scanQuestion("What ISO standards does R 60 cite?");
  assert.equal(s?.doc_number, "60");
  assert.equal(s?.label, "OIML R 60");
  assert.equal(oimlPubid.scanQuestion("E2 weights"), null);
});

test("graphDocNumber reads the graph's node-id shape", () => {
  assert.equal(oimlPubid.graphDocNumber("doc:OIML-R-60-2021"), "60");
  assert.equal(oimlPubid.graphDocNumber("cite:ISO-8601-2004"), null);
});
