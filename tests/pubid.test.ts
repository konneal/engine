// The OIML grammar is @oimlsmart/oiml-pubid (the estate's SSOT); this
// codec adapts it to the surfaces callers use (bare forms, URNs,
// family keys). The expectations are THE shared corpus the package
// ships — nobody pins their own copies (the package's doctrine).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { oimlPubid } from "../workers/worker_public/src/codecs.ts";

const corpus = JSON.parse(
  readFileSync("node_modules/@oimlsmart/oiml-pubid/conformance/identifiers.json", "utf8"),
);

test("every corpus identifier parses to the codec's DocScope", () => {
  for (const c of corpus.cases) {
    const scope = oimlPubid.parse(c.identifier, c.bibdataYear);
    if (c.structure.series === "cs") {
      // the CS family (PD/OD/CID) is a valid pubid but outside this
      // retrieval plane's publication families — honestly null
      assert.equal(scope, null, c.identifier);
      continue;
    }
    assert.ok(scope, `${c.identifier}: parse returned null`);
    assert.equal(scope.doc_number, String(Number(c.structure.number)), c.identifier);
    const expectLabel = `OIML ${c.structure.family.toUpperCase()} ${String(Number(c.structure.number))}${c.structure.part ? `-${c.structure.part}` : ""}${(c.structure.year ?? c.bibdataYear) ? `:${c.structure.year ?? c.bibdataYear}` : ""}`;
    assert.equal(scope.label, expectLabel, c.identifier);
    assert.equal(scope.edition, c.structure.year ?? c.bibdataYear ?? undefined, c.identifier);
    // the URN provenance form parses to the same scope
    const viaUrn = oimlPubid.parse(c.urn);
    assert.deepEqual(viaUrn, scope, `${c.urn} ≠ ${c.identifier}`);
    // bare (unprefixed) form — the API's doc refs — parses identically
    const bare = c.identifier.replace(/^OIML\s+/i, "");
    assert.deepEqual(oimlPubid.parse(bare, c.bibdataYear), scope, `bare ${bare}`);
  }
});

test("corpus rejections never parse (incl. the glued class designations)", () => {
  for (const r of corpus.rejections) assert.equal(oimlPubid.parse(r), null, r);
  assert.equal(oimlPubid.parse("E2 weights"), null);
  assert.equal(oimlPubid.parse("urn:oiml:pub:x:99"), null);
});

test("familyOf uses the parser (editions and languages no longer break it)", () => {
  assert.equal(oimlPubid.familyOf("OIML R 60-1:2004 (E)"), "R-60");
  assert.equal(oimlPubid.familyOf("OIML B 18 Edition 4"), "B-18");
  assert.equal(oimlPubid.familyOf("OIML R 060"), "R-60");
});

test("scanQuestion (the question-tolerant surface) is unchanged", () => {
  const s = oimlPubid.scanQuestion("What ISO standards does R 60 cite?");
  assert.equal(s?.doc_number, "60");
  assert.equal(s?.label, "OIML R 60");
});
