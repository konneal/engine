// The answer-contract's text guards (answerGuards.ts): both lanes'
// retry triggers. Behavioral edges, not implementation — each detector
// must catch its live-observed shape and pass every honest answer that
// merely resembles it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolNarration,
  intentPreamble,
  TOOL_NARRATION_NOTICE,
  INTENT_PREAMBLE_NOTICE,
} from "../workers/worker_public/src/answerGuards.ts";

test("toolNarration catches the live narrated shapes", () => {
  assert.equal(
    toolNarration('The db.find tool returned, for the query "x": {"agg":1}'),
    true,
  );
  assert.equal(
    toolNarration("certificates.search tool returned the register rows."),
    true,
  );
  assert.equal(
    toolNarration("The db_find tool returned, for the query …"),
    true,
  );
});

test("toolNarration passes prose that merely discusses tools", () => {
  assert.equal(
    toolNarration(
      "The OIML counter tool is verified per OIML R 76-1; the tool returned values are in the table below.",
    ),
    false,
  );
  assert.equal(toolNarration(""), false);
});

test("intentPreamble catches the live plan-not-answer shape", () => {
  assert.equal(
    intentPreamble(
      "I'll look up the R 76-1 MPE clause and classification details in the corpus.",
    ),
    true,
  );
  assert.equal(intentPreamble("Let me check the applicable requirements."), true);
  assert.equal(intentPreamble("I am going to search the register now."), true);
});

test("intentPreamble vetoes substantive answers that open with intent verbs", () => {
  assert.equal(
    intentPreamble(
      "I'll be direct: the maximum permissible error is 1.5 g for this load.",
    ),
    false,
  );
  assert.equal(
    intentPreamble(
      "Let me summarize: per OIML R 76-1:2006 §5.5, zero-setting shall not alter the weighing range.",
    ),
    false,
  );
  assert.equal(
    intentPreamble(
      "I'll outline the table: [[u:table-3]] carries the class limits, per R 60-1 §3.7.1.",
    ),
    false,
  );
});

test("intentPreamble vetoes long drafts regardless of opener", () => {
  assert.equal(intentPreamble(`I'll begin. ${"x".repeat(300)}`), false);
  assert.equal(intentPreamble("The answer is 3.7."), false);
});

test("both notices are correction notices naming their behavior", () => {
  for (const n of [TOOL_NARRATION_NOTICE, INTENT_PREAMBLE_NOTICE]) {
    assert.match(n, /^Correction notice:/);
    assert.ok(n.length > 120);
  }
});
