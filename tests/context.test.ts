// Unit tests for the declared-context module (TODO.ai-platform/02).
// Runs on plain node (type stripping, no build step):
//   node --test tests/context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_CONTEXT,
  appliedContext,
  contextNote,
  parseContext,
  parseDocRef,
  resolveDocScope,
} from "../workers/worker_public/src/context.ts";

test("parseContext: absent / malformed context degrades to null, never to an error", () => {
  assert.equal(parseContext({}), null);
  assert.equal(parseContext(null), null);
  assert.equal(parseContext({ context: "R 60" }), null);
  assert.equal(parseContext({ context: { kind: "everything" } }), null);
  assert.equal(parseContext({ context: { kind: 42 } }), null);
});

test("parseContext: the three kinds parse, fields are bounded", () => {
  const c = parseContext({
    context: {
      kind: "entity",
      label: `  ${"x".repeat(200)}  `,
      route: "/app/standards/r60/certificates/abc",
      doc: "urn:oiml:pub:r:60-1:2021",
      edition: "2021",
    },
  });
  assert.equal(c?.kind, "entity");
  assert.equal(c?.label.length, 120); // bounded
  assert.equal(c?.route, "/app/standards/r60/certificates/abc");
  assert.equal(c?.doc, "urn:oiml:pub:r:60-1:2021");
  assert.equal(c?.edition, "2021");
  // a malformed edition is dropped, not carried
  assert.equal(parseContext({ context: { kind: "page", label: "p", edition: "20" } })?.edition, undefined);
});

test("parseDocRef: the URN provenance form", () => {
  assert.deepEqual(parseDocRef("urn:oiml:pub:r:60-1:2021"), { doc_number: "60", edition: "2021", label: "OIML R 60:2021" });
  assert.deepEqual(parseDocRef("urn:oiml:pub:b:18:2025"), { doc_number: "18", edition: "2025", label: "OIML B 18:2025" });
  assert.deepEqual(parseDocRef("urn:oiml:pub:d:29"), { doc_number: "29", label: "OIML D 29" });
});

test("parseDocRef: the plain docidentifier forms", () => {
  assert.deepEqual(parseDocRef("OIML R 60-1:2021"), { doc_number: "60", edition: "2021", label: "OIML R 60:2021" });
  assert.deepEqual(parseDocRef("R 76"), { doc_number: "76", label: "OIML R 76" });
  assert.deepEqual(parseDocRef("OIML B 18"), { doc_number: "18", label: "OIML B 18" });
  // the explicit edition argument wins over the reference's own
  assert.deepEqual(parseDocRef("R 60", "2017"), { doc_number: "60", edition: "2017", label: "OIML R 60:2017" });
});

test("parseDocRef: garbage never resolves", () => {
  assert.equal(parseDocRef("the certificate"), null);
  assert.equal(parseDocRef(""), null);
  assert.equal(parseDocRef("R 1234"), null); // doc numbers are 1-3 digits
});

const dbWith = (families: string[]) => ({
  DB: {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          void sql;
          const family = String(args[0]);
          return families.includes(family) ? { "1": 1 } : null;
        },
      }),
    }),
  },
});

test("resolveDocScope: an unknown family honestly does not scope", async () => {
  const env = dbWith(["R-60"]);
  const hit = await resolveDocScope(env, { kind: "document", label: "R 60", doc: "OIML R 60-1:2021" });
  assert.deepEqual(hit, { doc_number: "60", edition: "2021", label: "OIML R 60:2021" });
  const miss = await resolveDocScope(env, { kind: "document", label: "R 999", doc: "OIML R 999" });
  assert.equal(miss, null);
  // no doc declared → no scope
  assert.equal(await resolveDocScope(env, { kind: "page", label: "the IA console" }), null);
});

test("resolveDocScope: a registry failure keeps the parsed scope (fail-open scoped, never silently widened)", async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 down"); } }) }) } };
  const scope = await resolveDocScope(env, { kind: "entity", label: "this certificate X", doc: "urn:oiml:pub:r:60-1:2021" });
  assert.deepEqual(scope, { doc_number: "60", edition: "2021", label: "OIML R 60:2021" });
});

test("appliedContext: none when undeclared; the scope label rides when resolved", () => {
  assert.deepEqual(appliedContext(null, null), NO_CONTEXT);
  assert.deepEqual(appliedContext({ kind: "page", label: "the IA console" }, null), {
    kind: "page",
    label: "the IA console",
    scoped_to: null,
  });
  assert.deepEqual(appliedContext({ kind: "entity", label: "this certificate R60/2021-A-EX1-26.01", doc: "R 60" }, { doc_number: "60", edition: "2021", label: "OIML R 60:2021" }), {
    kind: "entity",
    label: "this certificate R60/2021-A-EX1-26.01",
    scoped_to: "OIML R 60:2021",
  });
});

test("contextNote: the entity note is honest about the wave-02 boundary (no entity data)", () => {
  const note = contextNote({ kind: "entity", label: "this certificate R60/2021-A-EX1-26.01" }, { doc_number: "60", label: "OIML R 60" });
  assert.match(note!, /R60\/2021-A-EX1-26\.01/);
  assert.match(note!, /do NOT have the entity's own data/);
  const unresolved = contextNote({ kind: "document", label: "OIML R 999" }, null);
  assert.match(unresolved!, /not in the indexed corpus/);
  assert.equal(contextNote(null, null), undefined);
});
