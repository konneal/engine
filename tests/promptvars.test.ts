// The prompt template's voice slots are publisher data; the interpolation
// must be byte-identical to the pre-template literals for this profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

const ORIGINAL_IDENTITY =
  "the OIML SMART AI assistant at ai.oimlsmart.org — a public service answering questions about OIML legal-metrology publications (Recommendations, Documents, Basic publications, Guides). You serve metrologists, regulators, manufacturers and students";
const ORIGINAL_REFUSAL =
  "I don't have information on this in the indexed OIML publications.";

test("the assistant identity interpolates to the historical literal", () => {
  assert.equal(PROFILE.prompts.vars.assistant_identity, ORIGINAL_IDENTITY);
});

test("the refusal sentence is the canonical literal (runtime + prompt agree)", () => {
  assert.equal(PROFILE.prompts.vars.refusal_sentence, ORIGINAL_REFUSAL);
  const system = readFileSync("workers/worker_public/prompts/system.md", "utf8");
  assert.ok(system.includes("{{ASSISTANT_IDENTITY}}"));
  assert.ok(system.includes("{{REFUSAL_SENTENCE}}"));
  assert.ok(!system.includes("OIML SMART AI assistant"), "the hardcoded voice is gone from the template");
});
