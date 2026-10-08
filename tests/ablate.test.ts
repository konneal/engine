// Unit tests for the ablation boundary (TODO.sota/09): the request
// parse (admin gate, validation) and the registry projection (the
// registry IS the switch — a subset narrows, never reorders).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAblate } from "../workers/worker_public/src/ablate.ts";
import { STAGE_NAMES, projectStages } from "../workers/worker_public/src/stages/index.ts";

const KNOWN = ["dense", "hyde", "glossary", "concept-graph", "graph-lane", "licensed-lane", "multi-query", "sub-query", "pool-open", "lexical-union", "federate", "seal", "license-scope", "overview-demote", "family-boost", "rerank", "lexical-rrf", "citation-probe", "corpus-scope", "edition-cover", "std-ref-nudge", "term-nudge", "concept-steer", "edition-steer", "structural-propagate", "diversity", "licensed-cover", "typed-pin", "section-descent", "dedup", "window-floor"];

test("no ablation fields: a normal ask, config null", () => {
  const r = parseAblate({}, "tok", "tok", KNOWN);
  assert.equal(r.ok, true);
  assert.equal((r as any).config, null);
  const r2 = parseAblate({ query: "what is mpe" }, undefined, null, KNOWN);
  assert.equal(r2.ok, true);
  assert.equal((r2 as any).config, null);
});

test("ablation fields without the admin credential are 403 — never silent", () => {
  for (const body of [{ ablate_stages: ["dense"] }, { ablate_no_verdict: true }]) {
    const noHeader = parseAblate(body, "tok", null, KNOWN);
    assert.equal(noHeader.ok, false);
    assert.equal((noHeader as any).status, 403);
    const wrongToken = parseAblate(body, "tok", "wrong", KNOWN);
    assert.equal(wrongToken.ok, false);
    assert.equal((wrongToken as any).status, 403);
  }
});

test("ablation is refused when no admin token is configured", () => {
  const r = parseAblate({ ablate_stages: ["dense"] }, undefined, "anything", KNOWN);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 403);
});

test("a valid stage list parses with the admin credential", () => {
  const r = parseAblate({ ablate_stages: ["dense", "pool-open", "diversity", "window-floor"] }, "tok", "tok", KNOWN);
  assert.equal(r.ok, true);
  assert.deepEqual((r as any).config, { stages: ["dense", "pool-open", "diversity", "window-floor"], noVerdict: false, route: "adaptive", speculative: false });
});

test("no-verdict parses standalone", () => {
  const r = parseAblate({ ablate_no_verdict: true }, "tok", "tok", KNOWN);
  assert.equal(r.ok, true);
  assert.deepEqual((r as any).config, { stages: null, noVerdict: true, route: "adaptive", speculative: false });
});

test("ablate_route: \"adaptive\" is the default and needs no gate", () => {
  const r = parseAblate({ ablate_route: "adaptive" }, undefined, null, KNOWN);
  assert.equal(r.ok, true);
  assert.equal((r as any).config, null);
});

test("ablate_route: forced routes gate on the admin credential", () => {
  const denied = parseAblate({ ablate_route: "fast" }, "tok", "wrong", KNOWN);
  assert.equal(denied.ok, false);
  assert.equal((denied as any).status, 403);
  const fast = parseAblate({ ablate_route: "fast" }, "tok", "tok", KNOWN);
  assert.equal(fast.ok, true);
  assert.deepEqual((fast as any).config, { stages: null, noVerdict: false, route: "fast", speculative: false });
  const deep = parseAblate({ ablate_route: "deep" }, "tok", "tok", KNOWN);
  assert.equal((deep as any).config.route, "deep");
});

test("ablate_route: an unknown route is 400", () => {
  const r = parseAblate({ ablate_route: "turbo" }, "tok", "tok", KNOWN);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 400);
});

test("ablate_speculative gates on the admin credential like every field", () => {
  const denied = parseAblate({ ablate_speculative: true }, "tok", null, KNOWN);
  assert.equal(denied.ok, false);
  assert.equal((denied as any).status, 403);
  const ok = parseAblate({ ablate_speculative: true }, "tok", "tok", KNOWN);
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as any).config, { stages: null, noVerdict: false, route: "adaptive", speculative: true });
  // the false/absent form is a normal ask, not an ablation
  assert.equal((parseAblate({ ablate_speculative: false }, undefined, null, KNOWN) as any).config, null);
});

test("unknown stage names are 400 — a typo'd config must never measure", () => {
  const r = parseAblate({ ablate_stages: ["dense", "re-rank"] }, "tok", "tok", KNOWN);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 400);
  assert.match((r as any).message, /re-rank/);
});

test("malformed stage lists are 400", () => {
  assert.equal((parseAblate({ ablate_stages: [] }, "tok", "tok", KNOWN) as any).ok, false);
  assert.equal((parseAblate({ ablate_stages: "dense" }, "tok", "tok", KNOWN) as any).ok, false);
  assert.equal((parseAblate({ ablate_stages: [1, 2] }, "tok", "tok", KNOWN) as any).ok, false);
});

test("duplicates collapse — the projection is a set over the registry", () => {
  const r = parseAblate({ ablate_stages: ["dense", "dense", "rerank"] }, "tok", "tok", KNOWN);
  assert.equal(r.ok, true);
  assert.deepEqual((r as any).config.stages, ["dense", "rerank"]);
});

test("projectStages: the registry order is preserved whatever the caller's order", () => {
  const names = [...KNOWN].reverse();
  const projected = projectStages(names);
  assert.deepEqual(projected.map((s) => s.name), KNOWN);
});

test("projectStages: a subset is registry-ordered", () => {
  const projected = projectStages(["window-floor", "dense", "rerank"]);
  assert.deepEqual(projected.map((s) => s.name), ["dense", "rerank", "window-floor"]);
});

test("projectStages: unknown names throw", () => {
  assert.throws(() => projectStages(["dense", "nonexistent"]), /unknown stage: nonexistent/);
});

test("the pinned vocabulary matches the registry — a new stage updates it consciously", () => {
  assert.deepEqual(KNOWN, STAGE_NAMES);
  // the load-bearing order invariants (docs/spec-pipeline.md): dense
  // first, pool-open before refinement, window-floor last
  assert.equal(STAGE_NAMES[0], "dense");
  assert.ok(STAGE_NAMES.indexOf("pool-open") < STAGE_NAMES.indexOf("rerank"));
  assert.equal(STAGE_NAMES[STAGE_NAMES.length - 1], "window-floor");
});
