// The register search: register-shaped questions query the D1 table,
// misses are stated as misses, and the note quotes the snapshot's terms.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRegisterShaped, registerNote, registerTokens, searchRegister } from "../workers/worker_public/src/certificates.ts";

test("register-shaped detection: standing questions in, definitions out", () => {
  assert.equal(isRegisterShaped("Is the Utilcell 190 model still certified in the OIML R 60 certificate register?"), true);
  assert.equal(isRegisterShaped("What is the status of certificate R60/1999-GB1-99.01?"), true);
  assert.equal(isRegisterShaped("What must a load cell certificate contain per R 60?"), false);
});

test("the tokens skip the question words and keep the identifiers", () => {
  const tokens = registerTokens("Is the Utilcell 190 model still certified in the OIML R 60 certificate register?");
  assert.ok(tokens.includes("Utilcell"));
  assert.ok(tokens.includes("190"));
  assert.ok(!tokens.includes("still"));
  assert.ok(!tokens.includes("certified"));
});

test("a miss returns zero rows and the note states the snapshot honestly", async () => {
  const db = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };
  const out = await searchRegister(db, "Is the Utilcell 190 still certified in the R 60 register?");
  assert.ok(out);
  assert.equal(out.rows.length, 0);
  const note = registerNote(out.rows);
  assert.match(note, /NO certificate matching/);
  assert.match(note, /snapshot/);
});

test("a hit carries the register's own fields for verbatim quoting", async () => {
  const rows = [{ num: "R60/2021-DK1-24.01", family: "R60", holder: "Vetek Weighing AB", model: "CFSI", year: "2024", status: "Valid" }];
  const note = registerNote(rows);
  assert.match(note, /Vetek Weighing AB/);
  assert.match(note, /status Valid/);
});

test("a D1 failure degrades to no-note, never an error", async () => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("down"); } }) }) };
  const out = await searchRegister(db, "Is the Utilcell 190 still certified?");
  assert.ok(out);
  assert.equal(out.rows.length, 0);
});

import { buildRegisterQuery } from "../workers/worker_public/src/certificates.ts";

test("numeric tokens match standalone values, never substrings", () => {
  const { sql, params } = buildRegisterQuery(["190", "Utilcell"]);
  // the numeric clause: exact model/num + the delimiter-separated LIKE
  assert.ok(sql.includes("model = ?1 OR num = ?1"));
  assert.ok(sql.includes("LIKE ?3"));
  // the word clause: the plain substring LIKE
  assert.ok(sql.includes("holder LIKE ?4 OR model LIKE ?4 OR num LIKE ?4"));
  assert.deepEqual(params, ["190", "190", "% 190 %", "%Utilcell%"]);
});

test("the padded comparison normalizes punctuation to spaces", () => {
  const { params } = buildRegisterQuery(["190"]);
  assert.equal(params[2], "% 190 %");
});

import { queryFamily } from "../workers/worker_public/src/certificates.ts";

test("the question's family scopes the register search", () => {
  assert.equal(queryFamily("Is the Utilcell 190 still certified in the OIML R 60 certificate register?"), "R60");
  assert.equal(queryFamily("What is the status of certificate R60/1999-GB1-99.01?"), "R60");
  assert.equal(queryFamily("Is the Acme D 31 meter certified?"), "D31");
  assert.equal(queryFamily("Is the Acme meter certified?"), null);
});


// ── the aggregate register lane (2026-10-11): count/latest intents are
//    deterministic computation, editions never poison the tokens ──

test("aggregate intents parse", async () => {
  const { registerAggregateIntent } = await import("../workers/worker_public/src/certificates.ts");
  assert.equal(registerAggregateIntent("How many certificates are issued for R 60:2021?"), "count");
  assert.equal(registerAggregateIntent("What is the latest certificate issued for R 60?"), "latest");
  assert.equal(registerAggregateIntent("Total certificates under R 76?"), "count");
  assert.equal(registerAggregateIntent("Is the Utilcell certificate still valid?"), null);
});

test("edition years strip from register tokens", async () => {
  const { registerTokens } = await import("../workers/worker_public/src/certificates.ts");
  const t = registerTokens("How many certificates are issued for R 60:2021?");
  assert.ok(!t.includes("2021"), "the edition year must not reach the token arms");
});

test("the aggregate computes in SQL and renders its note with the edition disclaimer", async () => {
  const { registerAggregate, aggregateNote, aggregateBlock } = await import("../workers/worker_public/src/certificates.ts");
  const db = {
    prepare(sql: string) {
      return {
        bind(..._a: unknown[]) {
          if (sql.includes("COUNT(*)")) {
            return { first: async () => ({ n: 1624, valid: 1624, suspended: 0 }) };
          }
          return { all: async () => ({ results: [{ num: "R60/2021-A-NL1-26.12 Rev. 0", family: "60", holder: "TEA", model: "C16A", year: "2026", status: "Valid", pdf_key: "R60/2021/x.pdf" }] }) };
        },
      };
    },
  };
  const agg = await registerAggregate(db, "R60");
  assert.equal(agg!.count, 1624);
  assert.equal(agg!.latest!.num, "R60/2021-A-NL1-26.12 Rev. 0");
  const note = aggregateNote(agg!);
  assert.ok(note.includes("1624"));
  assert.ok(note.includes("no edition dimension"));
  assert.ok(note.includes("/cert-pdf/R60/2021/x.pdf"));
  const block = aggregateBlock(agg!);
  assert.equal(block.type, "register");
  assert.equal(block.payload.count, 1624);
  assert.equal(block.payload.latest.url, "/cert-pdf/R60/2021/x.pdf");
});

test("the note names the family with its series letter, derived from the certificate numbers", async () => {
  const { aggregateNote } = await import("../workers/worker_public/src/certificates.ts");
  const agg = {
    family: "60",
    count: 1624,
    valid: 1624,
    latest: { num: "R60/2021-A-NL1-26.12", holder: "H", model: "M", year: "2026", status: "Valid", pdf_key: "R60/2021/x.pdf" },
  } as any;
  const note = aggregateNote(agg);
  // the publisher name prefixes the series: "OIML R 60" — the model
  // quotes the note's identifier verbatim
  assert.match(note, /The \w+ R 60 family holds 1624 certificates/);
  assert.ok(!note.includes("The 60 family"), "the bare digits must not stand alone");
});

import { registerBypassesCache } from "../workers/worker_public/src/certificates.ts";

test("register-shaped and aggregate asks bypass the answer cache; requirement questions do not", () => {
  assert.equal(registerBypassesCache("Is the Utilcell 190 model still certified in the OIML R 60 certificate register?"), true);
  assert.equal(registerBypassesCache("How many certificates are issued for R 60?"), true);
  assert.equal(registerBypassesCache("What is the latest certificate issued for R 60?"), true);
  // a requirements question consults the corpus, whose cache IS
  // namespaced by the index — it rides the cache as before
  assert.equal(registerBypassesCache("What must a load cell certificate contain per R 60?"), false);
});
