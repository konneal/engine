// Prompt rendering (konneal: the last ledger item): every prompt
// template's tokens exist in the profile's var map — an unknown token
// silently interpolates to "", deleting instructional text from a live
// prompt. Standalone on purpose: the fill semantics are three lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";

const DIR = "workers/worker_public/prompts";
const vars = Object.fromEntries(
  Object.entries(PROFILE.prompts.vars).map(([k, v]) => [k.toUpperCase(), v]).concat([['PUBLISHER_NAME', PROFILE.publisher.name]])
);

test("every prompt token resolves under the fixture profile", () => {
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".md")) continue;
    const tpl = readFileSync(`${DIR}/${f}`, "utf8");
    for (const m of tpl.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(
        m[1] in vars || ["CORPORA", "UPSELL", "HISTORY_CONTEXT", "CORPUS_NOTES", "LANG_CLAUSE", "SERVICE_POSTURE"].includes(m[1]),
        `${f}: token {{${m[1]}}} resolves neither from the profile nor at a call site`,
      );
    }
  }
});

test("the varianlized surfaces carry real content, and none emptied", () => {
  for (const key of ["CORPUS_KIND", "CITE_EXAMPLE", "CITE_QUOTE_EXAMPLE", "PARTS_EXAMPLE", "DOCID_EXAMPLE", "SPELLING_EXAMPLES", "PROCESS_VOCAB", "ASSISTANT_IDENTITY", "REFUSAL_SENTENCE"]) {
    assert.ok(typeof vars[key] === "string" && vars[key].length > 3, `var ${key} missing or empty`);
  }
  assert.equal(vars.PUBLISHER_NAME, "Fixture");
});
