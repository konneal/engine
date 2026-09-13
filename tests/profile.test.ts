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
