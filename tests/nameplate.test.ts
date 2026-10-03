import test from "node:test";
import assert from "node:assert/strict";
import { parseNameplate, nameplateRegisterQuery } from "../workers/worker_public/src/nameplate-parse.ts";
import { printedCertificateNumber } from "../workers/worker_public/src/certificates.ts";

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

test("a printed certificate number rides the extraction and leads the register query", () => {
  const np = parseNameplate('{"manufacturer": "CAS Corporation", "model": "CI-2001", "certificate_number": "R76/2006-A-GB1-18.08"}');
  assert.ok(np);
  assert.equal(np.certificate_number, "R76/2006-A-GB1-18.08");
  const q = nameplateRegisterQuery(np, "What certificates does this belong to?");
  assert.match(q, /R76\/2006-A-GB1-18\.08/);
  assert.ok(q.indexOf("R76/2006-A-GB1-18.08") < q.indexOf("CAS"), "the number leads");
});

test("printedCertificateNumber extracts the printed number through punctuation noise", () => {
  assert.equal(printedCertificateNumber("The plate reads R76/2006-A-GB1-18.08, made in Korea"), "R76/2006-A-GB1-18.08");
  assert.equal(printedCertificateNumber("no number here"), null);
});
