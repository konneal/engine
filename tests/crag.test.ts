// The CRAG per-passage grader (TODO.sota/14.6 v2): parse discipline and
// fail-open honesty — a clean reply grades, a drifting reply grades null,
// a throwing or stalling ai grades null. Absence is honest; a guess is not.
import test from "node:test";
import assert from "node:assert/strict";
import { gradePassage, gradePassages } from "../workers/worker_public/src/crag.ts";

const SYS = "You judge passage relevance.";

function aiReplying(text: any) {
  return { run: async (_m: string, _b: any) => ({ response: text }) };
}

test("a clean CRAG reply parses to its grade", async () => {
  const g = await gradePassage(aiReplying('{"grade": "correct"}'), "m", SYS, "q?", "p");
  assert.equal(g, "correct");
  assert.equal(await gradePassage(aiReplying('{"grade": "incorrect"}'), "m", SYS, "q?", "p"), "incorrect");
  assert.equal(await gradePassage(aiReplying('{"grade": "ambiguous"}'), "m", SYS, "q?", "p"), "ambiguous");
});

test("reasoning fragments around the verdict still parse", async () => {
  const text = 'Let me check. The passage covers the question.\n{"grade": "correct"}';
  assert.equal(await gradePassage(aiReplying(text), "m", SYS, "q?", "p"), "correct");
});

test("an off-vocabulary or absent grade grades null", async () => {
  assert.equal(await gradePassage(aiReplying('{"grade": "good"}'), "m", SYS, "q?", "p"), null);
  assert.equal(await gradePassage(aiReplying("no json here"), "m", SYS, "q?", "p"), null);
  assert.equal(await gradePassage(aiReplying(null), "m", SYS, "q?", "p"), null);
  assert.equal(await gradePassage(aiReplying(undefined), "m", SYS, "q?", "p"), null);
});

test("a throwing ai grades null, never rejects", async () => {
  const boom = { run: async () => { throw new Error("overloaded"); } };
  assert.equal(await gradePassage(boom as any, "m", SYS, "q?", "p"), null);
});

test("a stalled ai loses its race and grades null", async () => {
  const stalled = { run: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await gradePassage(stalled as any, "m", SYS, "q?", "p", 10), null);
  assert.ok(Date.now() - t0 < 5000);
});

test("the Workers-AI choice shape parses too", async () => {
  const shaped = { run: async () => ({ choices: [{ message: { content: '{"grade": "incorrect"}' } }] }) };
  assert.equal(await gradePassage(shaped as any, "m", SYS, "q?", "p"), "incorrect");
});

test("gradePassages grades in order and independently fail-open", async () => {
  let n = 0;
  const mixed = {
    run: async () => {
      n += 1;
      if (n === 2) throw new Error("flaky");
      return { response: '{"grade": "correct"}' };
    },
  };
  const grades = await gradePassages(mixed as any, "m", SYS, "q?", ["a", "b", "c"]);
  assert.deepEqual(grades, ["correct", null, "correct"]);
});
