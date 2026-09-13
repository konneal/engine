// The profile drift guard (multi-SDO step 1): the committed
// profile.gen.ts must be exactly what profile/*.yaml regenerates — one
// side is never edited without the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render } from "../scripts/gen_profile.mjs";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

test("the generated profile matches the yaml sources", () => {
  const regenerated = render();
  const committed = readFileSync("workers/worker_public/src/profile.gen.ts", "utf8");
  assert.equal(regenerated, committed);
});

test("the publisher profile carries the identity facts", () => {
  assert.equal(PROFILE.publisher.id, "oiml");
  assert.ok(PROFILE.publisher.identity.issuer.length > 0);
});

test("every dataset declares the required shape", () => {
  for (const d of PROFILE.datasets) {
    assert.ok(d.id && d.label && d.description, `dataset ${d.id} incomplete`);
    if (d.session) assert.ok(d.permission, `session dataset ${d.id} must name its permission`);
  }
});

test("the corpora registry covers production and every lane target", () => {
  const c = PROFILE.corpora;
  assert.ok(c.production.includes("oiml"));
  // the ablation lane indexes the same primmel corpus, unlinked
  assert.deepEqual(c.lanes.primmel_flat, ["primmel"]);
  for (const target of Object.keys(c.lanes)) {
    assert.ok(c.lanes[target].length > 0, `lane ${target} declares no corpora`);
  }
});

test("the site profile module is the same generation", () => {
  const site = readFileSync("site/src/profile.gen.ts", "utf8");
  assert.ok(site.includes('"publisher"'));
  assert.equal(site.split("\n")[0], readFileSync("workers/worker_public/src/profile.gen.ts", "utf8").split("\n")[0]);
});

test("publisher UI data declares its surfaces", () => {
  assert.ok(PROFILE.ui.suggestions.length >= 4);
  assert.ok(PROFILE.ui.models_disclosure.length >= 3);
  assert.ok(PROFILE.ui.smoke.length >= 3);
  for (const s of PROFILE.ui.smoke) {
    assert.ok(s.label && s.query && s.expect, "each smoke probe is complete");
  }
  assert.ok((PROFILE.retrieval.process_expansion ?? "").length > 50);
  assert.ok(PROFILE.sources.models.primmel.repo);
});
