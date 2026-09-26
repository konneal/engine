// The answer-quality ladder: the tier derives from provenance the chunk
// wire already carries, and the answer stands on its WORST citation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuality, hitQuality, qualityNote } from "../workers/worker_public/src/quality.ts";

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
  assert.match(qualityNote("verified"), /verified/i);
  assert.match(qualityNote("curated"), /edited corpus/);
  assert.match(qualityNote("ocr"), /experimental OCR/);
});
