// The extractive prompt compressor (TODO.sota/02 row 5): deterministic
// selection, never growth — the query decides what survives the budget,
// the lead always survives, numbers get their bump, reading order is
// preserved.
import test from "node:test";
import assert from "node:assert/strict";
import { compressText, scoreSentence, splitSentences, tokens } from "../workers/worker_public/src/compress.ts";

test("tokens drop stopwords and short fragments", () => {
  assert.deepEqual(tokens("The maximum permissible error of a load cell"), ["maximum", "permissible", "error", "load", "cell"]);
  // decimals survive as one token; 'R 60' keeps its number
  assert.ok(tokens("tolerance 30.5 v at R 60").includes("30.5"));
  assert.ok(tokens("tolerance 30.5 v at R 60").includes("60"));
});

test("splitSentences honours sentence and line boundaries", () => {
  const s = splitSentences("First sentence. Second one!\nThird; fourth?");
  assert.equal(s.length, 4);
});

test("scoreSentence rewards query density and numeric evidence", () => {
  const q = new Set(tokens("maximum permissible error"));
  const onTopic = scoreSentence("The maximum permissible error is 60 v.", q);
  const offTopic = scoreSentence("The instrument shall be presented for verification.", q);
  const numeric = scoreSentence("Values: 30 000 v.", new Set());
  assert.ok(onTopic > offTopic);
  assert.ok(numeric > 0); // numbers score even with no query overlap
});

test("compressText returns short input untouched", () => {
  const text = "Short clause text.";
  assert.equal(compressText(text, "anything", 100), text);
});

test("compressText keeps the query-relevant sentence over an off-topic one", () => {
  const text =
    "This section describes the general test procedure for instruments. " +
    "The maximum permissible error for class III instruments shall not exceed the stated tolerance in service. " +
    "Records of each verification are retained by the issuing authority for audit purposes. " +
    "The report format follows the annex to this Recommendation.";
  const out = compressText(text, "what is the maximum permissible error for class III", 200);
  assert.ok(out.length <= 200);
  assert.match(out, /maximum permissible error/i);
});

test("compressText always keeps the lead and preserves reading order", () => {
  const text = "Lead sentence identifies the clause. Alpha detail about calibration. Beta detail about the test bench.";
  const out = compressText(text, "calibration", 90);
  assert.ok(out.startsWith("Lead sentence"));
  const a = out.indexOf("Alpha");
  const b = out.indexOf("Beta");
  if (a >= 0 && b >= 0) assert.ok(a < b);
});

test("compressText never grows the input and never returns empty for non-empty input", () => {
  const text = "One very long unrepeatable clause passage without any sentence boundary that goes on and on and on past any budget one could set for it, honestly quite long indeed";
  const out = compressText(text, "calibration", 60);
  assert.ok(out.length <= 60);
  assert.ok(out.length > 0);
  assert.equal(compressText("", "q", 10), "");
});

test("compressText is deterministic", () => {
  const text = "First clause. Second clause with tolerances 60 v. Third clause.";
  assert.equal(compressText(text, "tolerances", 50), compressText(text, "tolerances", 50));
});
