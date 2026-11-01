// The user lane's federation stage: additive, undiscunted, sub-scoped —
// the member's own documents join the pool beside the corpus and cite
// as their own documents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { userLane } from "../workers/worker_public/src/stages/userLane.ts";
import { queryUserLane } from "../workers/worker_public/src/userDocuments.ts";

test("the stage merges the caller's lane hits undiscunted, deduped", async () => {
  const laneHit = { id: "ud-1", score: 0.61, metadata: { docidentifier: "Member document — cert.pdf", corpus: "user_docs", chunk_text: "Member document (certificate) — cert.pdf" }, text: "Member document (certificate) — cert.pdf" };
  const c: any = {
    rq: "what does my report record at 1000 v",
    hits: [{ id: "mko:oiml-r-60-1", score: 0.5, metadata: {}, text: "corpus" }],
    opts: { userDocs: async () => [laneHit] },
  };
  await userLane.run!(c);
  assert.equal(c.hits.length, 2);
  assert.equal(c.hits[1].id, "ud-1");
  assert.equal(c.hits[1].score, 0.61, "no discount on the member's own content");
  // a duplicate id never enters twice
  c.opts.userDocs = async () => [laneHit];
  await userLane.run!(c);
  assert.equal(c.hits.length, 2);
});

test("the stage stands down when the callback fails or is absent", async () => {
  const c: any = { rq: "q", hits: [{ id: "a", score: 1, metadata: {}, text: "" }], opts: { userDocs: async () => { throw new Error("lane down"); } } };
  await userLane.run!(c);
  assert.equal(c.hits.length, 1);
  const c2: any = { rq: "q", hits: [{ id: "a", score: 1, metadata: {}, text: "" }], opts: {} };
  assert.equal(userLane.when!(c2), false);
});

test("queryUserLane filters by the caller's sub — mandatory, not optional", async () => {
  let seen: any = null;
  const model = { embed: async (texts: string[]) => texts.map(() => [0.1, 0.2]), rerank: async () => null, run: async () => ({ text: null }) };
  const lane = {
    query: async (q: any) => {
      seen = q;
      return [{ id: "ud-1", score: 0.9, metadata: { chunk_text: "the report text" } }];
    },
    upsert: async () => {},
    getByIds: async () => [],
    deleteIds: async () => {},
  };
  const hits = await queryUserLane(model as any, lane as any, "sub-abc", "my report MPE", 3);
  assert.equal(seen.topK, 3);
  assert.deepEqual(seen.filter, { user_sub: "sub-abc" }, "the filter is the caller's own sub");
  assert.equal(hits[0].text, "the report text");
  assert.equal(hits[0].metadata.chunk_text, "the report text");
});
