// The reference matrix (konneal item 10): the engine serves DECLARED
// profiles. The second fixture (profile2/, "atlas") differs in shape
// from the primary (different publisher, domains, datasets, cookie,
// codec surfaces); these tests prove every profile-derived surface
// re-keys — and that no surface remembers the previous profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render } from "../scripts/gen_profile.mjs";
import { setProfile, P } from "../workers/worker_public/src/profile.ts";
import { PROFILE as FIXTURE } from "../workers/worker_public/src/profile.gen.ts";
import { PROFILE as ATLAS } from "../workers/worker_public/src/profile2.gen.ts";
import { refusalAnswer } from "../workers/worker_public/src/refusal.ts";
import { DATASETS } from "../workers/worker_public/src/config.ts";
import { refCodec } from "../workers/worker_public/src/codecs.ts";
import { isAllowedBubbleOrigin } from "../workers/worker_public/src/bubble.ts";

test("the second fixture's generated profile matches its yaml sources", () => {
  const regenerated = render("profile2");
  const committed = readFileSync("workers/worker_public/src/profile2.gen.ts", "utf8");
  assert.equal(regenerated, committed);
});

test("the two fixtures are actually different publishers", () => {
  assert.notEqual(FIXTURE.publisher.id, ATLAS.publisher.id);
  assert.notEqual(FIXTURE.publisher.session_cookie, ATLAS.publisher.session_cookie);
});

test("under the atlas profile, every surface speaks atlas", () => {
  setProfile(ATLAS);
  assert.match(refusalAnswer(), /Atlas/);
  assert.deepEqual(DATASETS().map((d) => d.id), ["spec", "wg"]);
  assert.equal(P().publisher.session_cookie, "atlas-session");
  assert.ok(isAllowedBubbleOrigin("https://app.atlas.example"));
  assert.ok(isAllowedBubbleOrigin("https://atlas.example"));
  assert.ok(!isAllowedBubbleOrigin("https://app.fixture.example.org"));
  // plain-slug: no pubid grammar, no doc steering
  assert.equal(refCodec().parse("R 60"), null);
  assert.equal(refCodec().scanQuestion("What does R 60 say?"), null);
});

test("setProfile is request-time — restoring the fixture restores its surfaces", () => {
  setProfile(ATLAS);
  assert.match(refusalAnswer(), /Atlas/);
  setProfile(FIXTURE);
  assert.match(refusalAnswer(), /fixture/);
  assert.deepEqual(DATASETS().map((d) => d.id), ["pub", "internal"]);
  assert.ok(isAllowedBubbleOrigin("https://app.fixture.example.org"));
  assert.ok(!isAllowedBubbleOrigin("https://app.atlas.example"));
});
