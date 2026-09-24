// The understanding JSON contract (TODO.impl/29): extractJson turns the
// model's output into a QueryUnderstanding with silent coercions
// everywhere — these tests pin each one, so a prompt change that moves
// the JSON shape fails here instead of degrading retrieval quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../workers/worker_public/src/understandContract.ts";

const FULL = JSON.stringify({
  intent: "knowledge",
  docidentifier: "ACME R 60-1",
  docnumber: "60",
  edition: "2006",
  language: null,
  process_intent: false,
  term: "creep",
  defined_terms: ["creep", "span stability"],
  standalone_query: "What is creep in a load cell?",
  complexity: "simple",
  query_variants: ["load cell creep definition"],
  sub_queries: [],
  hypothetical_answer: "Creep is the change of load cell output under constant load.",
  follow_ups: ["What limits apply to creep?"],
});

test("full valid JSON parses with every field", () => {
  const u = extractJson(FULL)!;
  assert.equal(u.intent, "knowledge");
  assert.equal(u.docidentifier, "ACME R 60-1");
  assert.equal(u.doc_number, "60");
  assert.equal(u.edition, "2006");
  assert.equal(u.language, null);
  assert.equal(u.process_intent, false);
  assert.equal(u.term, "creep");
  assert.deepEqual(u.defined_terms, ["creep", "span stability"]);
  assert.equal(u.standalone_query, "What is creep in a load cell?");
  assert.deepEqual(u.query_variants, ["load cell creep definition"]);
  assert.equal(u.hypothetical_answer.length > 0, true);
  assert.deepEqual(u.follow_ups, ["What limits apply to creep?"]);
});

test("prose-wrapped JSON still parses (reasoning models emit fragments)", () => {
  const u = extractJson(`Here is the analysis.\n{"intent":"conversational","standalone_query":"hi"}\ntrailing words`);
  assert.equal(u?.intent, "conversational");
});

test("garbage and empty input → null (the vanilla-retrieval fallback)", () => {
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("{broken json"), null);
});

test("docnumber coercion: 1-3 digits pass, anything else is null", () => {
  assert.equal(extractJson(`{"docnumber":"76"}`)?.doc_number, "76");
  assert.equal(extractJson(`{"docnumber":"1234"}`)?.doc_number, null);
  assert.equal(extractJson(`{"docnumber":"R 60"}`)?.doc_number, null);
  assert.equal(extractJson(`{"docnumber":60}`)?.doc_number, null);
});

test("edition/language coercion: strict shapes only", () => {
  assert.equal(extractJson(`{"edition":"2021"}`)?.edition, "2021");
  assert.equal(extractJson(`{"edition":"21"}`)?.edition, null);
  assert.equal(extractJson(`{"language":"fr"}`)?.language, "fr");
  assert.equal(extractJson(`{"language":"french"}`)?.language, null);
});

test("process_intent is true only when literally true", () => {
  assert.equal(extractJson(`{"process_intent":true}`)?.process_intent, true);
  assert.equal(extractJson(`{"process_intent":"true"}`)?.process_intent, false);
  assert.equal(extractJson(`{"process_intent":"yes"}`)?.process_intent, false);
});

test("array fields: non-strings dropped, entries trimmed and capped", () => {
  const u = extractJson(JSON.stringify({
    defined_terms: ["creep", "  ", 42, "durability"],
    query_variants: ["a", "", "b", "c", "d", "e"],
  }))!;
  assert.deepEqual(u.defined_terms, ["creep", "durability"]);
  assert.deepEqual(u.query_variants, ["a", "b", "c", "d"]); // cap 4
});

test("intent defaults to knowledge (the safe route for real questions)", () => {
  assert.equal(extractJson(`{"intent":"chitchat"}`)?.intent, "knowledge");
  assert.equal(extractJson(`{}`)?.intent, "knowledge");
});

test("missing standalone_query degrades to empty string, not null", () => {
  const u = extractJson(`{"intent":"knowledge"}`)!;
  assert.equal(u.standalone_query, "");
  assert.equal(u.hypothetical_answer, "");
});
