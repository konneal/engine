// The answer-quality ladder: the tier derives from provenance the chunk
// wire already carries, and the answer stands on its WORST citation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuality, experimentalSourceLabels, hitQuality, qualityNote } from "../workers/worker_public/src/quality.ts";

test("the model plane is verified; curated and OCR follow the tier field", () => {
  assert.equal(hitQuality({ model_node: "r60/general" } as any), "verified");
  assert.equal(hitQuality({ model_version: "1", tier: "curated" } as any), "verified");
  assert.equal(hitQuality({ producer: "primmel" } as any), "verified");
  assert.equal(hitQuality({ tier: "curated" } as any), "curated");
  assert.equal(hitQuality({ tier: "ocr-clean" } as any), "ocr");
  assert.equal(hitQuality({ tier: "shell" } as any), "ocr");
  assert.equal(hitQuality({} as any), "ocr");
});

test("the answer's tier is the worst rung its citations stand on", () => {
  assert.equal(answerQuality(["verified", "verified"]), "verified");
  assert.equal(answerQuality(["verified", "ocr", "curated"]), "ocr");
  assert.equal(answerQuality(["curated"]), "curated");
  // citations without a tier (pre-ladder cache entries) contribute nothing
  assert.equal(answerQuality([undefined, undefined]), null);
  assert.equal(answerQuality([undefined, "curated"]), "curated");
  assert.equal(answerQuality([]), null);
});

test("the note names the posture honestly, strongest tier included", () => {
  assert.match(qualityNote("verified"), /High confidence/);
  assert.match(qualityNote("curated"), /Established sources/);
  // the owner's 2026-09-26 wording, verbatim
  assert.equal(
    qualityNote("ocr"),
    "WARNING: Partly grounded in experimental data source that was derived from OCR content. Please verify content against official publications.",
  );
});

test("experimental sources are NAMED, with garbage anchors dropped and a cap", () => {
  const cites = [
    { quality: "verified", docidentifier: "OIML R 60:2021", clause_anchor: "model" },
    { quality: "ocr", docidentifier: "OIML R 60", edition: "2000", clause_anchor: "4.1.2" },
    { quality: "ocr", docidentifier: "OIML D 31", clause_anchor: "_c631773b-1c2d-4e5f-a6b7-c8d9e0f1a2b3" },
    { quality: "ocr", docidentifier: "OIML D 11", clause_anchor: "overview" },
    { quality: "curated", docidentifier: "OIML B 18", clause_anchor: "5" },
  ];
  assert.deepEqual(experimentalSourceLabels(cites as any), ["OIML R 60 §4.1.2", "OIML D 31", "OIML D 11"]);
  assert.equal(experimentalSourceLabels(cites as any, 2).length, 2);
  assert.deepEqual(experimentalSourceLabels([{ quality: "verified", docidentifier: "x" }] as any), []);
});
