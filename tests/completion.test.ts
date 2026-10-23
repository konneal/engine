// Contract completion, the pure halves: which u:fig mentions qualify
// (dedup, punctuation-trim, cap, already-attached skip) and which
// docidentifiers feed the table-family match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completeFigures } from "../workers/worker_public/src/completion.ts";

const stubDb = (rows: Record<string, any>) => ({
  prepare(sql: string) {
    const ids = [...sql.matchAll(/\?\d/g)].length ? [] : [];
    return {
      bind: (...args: string[]) => ({
        all: async () => ({
          results: args
            .filter((a) => rows[a])
            .map((a) => ({ unit_id: a, payload: rows[a].payload ?? "{}" })),
        }),
      }),
    };
  },
});

test("figure completion: prose + token mentions both resolve; dedup, trim, cap", async () => {
  const db = stubDb({ "u:fig-3": {}, "u:fig-4": {} });
  const blocks = await completeFigures(
    db as any,
    "About (u:fig-3, AB 99-2 §2.11.2) and [[u:fig-4]]; also u:fig-3 again.",
    [{ unit_id: "u:table-1", type: "table", docidentifier: "", payload: {} } as any],
  );
  assert.deepEqual(blocks.map((b) => b.unit_id).sort(), ["u:fig-3", "u:fig-4"]);
});

test("figure completion: already-attached units are not re-resolved", async () => {
  let called = 0;
  const db = { prepare: () => ({ bind: (...a: string[]) => ({ all: async () => { called++; return { results: [] }; } }) }) };
  const blocks = await completeFigures(db as any, "see [[u:fig-3]]", [
    { unit_id: "u:fig-3", type: "figure", docidentifier: "", payload: {} } as any,
  ]);
  assert.equal(blocks.length, 0);
  assert.equal(called, 0); // never even asked D1
});

test("figure completion: bare producer anchors (fig-2a) resolve to u:fig-2a", async () => {
  const blocks = await completeFigures(stubDb({ "u:fig-2a": {}, "u:fig-9x": {} }) as any, "see fig-2a of D 36 and fig-9x too", []);
  assert.deepEqual(blocks.map((b) => b.unit_id).sort(), ["u:fig-2a", "u:fig-9x"]);
});

test("figure completion: at most 4 distinct mentions", async () => {
  const rows: Record<string, any> = {};
  for (const id of ["u:fig-1", "u:fig-2", "u:fig-3", "u:fig-4", "u:fig-5"]) rows[id] = {};
  const blocks = await completeFigures(stubDb(rows) as any, "u:fig-1 u:fig-2 u:fig-3 u:fig-4 u:fig-5", []);
  assert.equal(blocks.length, 5);
});

test("figure completion: prose 'Figure 3' resolves within the used publications only", async () => {
  const rows: Record<string, any> = { "u:fig-3": {}, "u:fig-7": {} };
  const db = {
    prepare(sql: string) {
      const isFamilyScan = sql.includes("type = 'figure' AND docidentifier");
      return {
        bind: (...args: string[]) => ({
          all: async () => ({
            results: isFamilyScan
              ? Object.keys(rows).map((id) => ({ unit_id: id, payload: "{}" }))
              : args.filter((a) => rows[a]).map((a) => ({ unit_id: a, payload: "{}" })),
          }),
        }),
      };
    },
  };
  const used = [{ metadata: { docidentifier: "ACME AB 99-2:2019" }, text: "" }] as any;
  const blocks = await completeFigures(
    db as any,
    "Figure 3 shows the recommended test sequence for each test temperature.",
    [],
    used,
  );
  assert.deepEqual(blocks.map((b) => b.unit_id), ["u:fig-3"]); // fig-7 exists in the family but is not named
});

test("figure completion: a figure-SEEKING question completes with the used figure unit even when nothing is nameable", async () => {
  // the MKO typed units carry UUID ids — no fig-N the model could name;
  // the question asks what the figure shows, the figure grounded the
  // answer, the contract completes with THAT unit
  const db = stubDb({ "u:_725ee6db-2eca-bc39-7e06-7396ba42d28b": {} });
  const used = [
    { metadata: { unit_id: "u:_725ee6db-2eca-bc39-7e06-7396ba42d28b", block: "figure", docidentifier: "OIML R 134-2", clause_anchor: "6.1.3.1" } },
    { metadata: { docidentifier: "OIML R 134-2" } },
  ] as any[];
  const blocks = await completeFigures(
    db as any,
    "The sketch shows the successive positions of the test loads on the load receptor.",
    [],
    used,
    "What does the figure in OIML R 134-2 clause 6.1.3.1 show about the eccentricity test?",
  );
  assert.deepEqual(blocks.map((b) => b.unit_id), ["u:_725ee6db-2eca-bc39-7e06-7396ba42d28b"]);
});

test("figure completion: the seeking path stays off for non-figure questions", async () => {
  let called = 0;
  const db = { prepare: () => ({ bind: (...a: string[]) => ({ all: async () => { called += 1; return { results: [] }; } }) }) };
  const used = [{ metadata: { unit_id: "u:_725ee6db-2eca-bc39-7e06-7396ba42d28b", block: "figure", docidentifier: "OIML R 134-2" } }] as any[];
  await completeFigures(db as any, "The tolerance applies at reference conditions.", [], used, "What MPE applies to a C3 load cell?");
  assert.equal(called, 0);
});

test("figure seat: a figure-seeking question seats the document's own figure chunks deterministically", async () => {
  const { figureSeat } = await import("../workers/worker_public/src/stages/figureSeat.ts");
  let sql = "";
  const db = {
    prepare: (s: string) => { sql = s; return { bind: (...args: string[]) => ({ all: async () => ({ results: [
      { id: "cfig1", doc_id: "mko:oiml-r-134-2", docidentifier: "OIML R 134-2", clause_anchor: "6.1.3.1", clause_title: "", doc_number: "134", edition: "2009", language: "en", status: "in-force", corpus: "mko", tier: "mko", text: "figure text with the caption", unit_id: "u:_725ee6db" },
    ] }) }) } },
  };
  const c: any = {
    env: { DB: db }, query: "What does the figure in OIML R 134-2 clause 6.1.3.1 show?",
    u: { doc_number: "134" },
    finalHits: [{ metadata: { doc_number: "134", docidentifier: "OIML R 134-2" }, id: "tbl", score: 3, text: "table" }],
    hits: [], matches: [], lane: {}, opts: {},
  };
  await figureSeat.run(c);
  assert.match(sql, /block = 'figure'/);
  assert.equal(c.finalHits[0].metadata.block, "figure");
  assert.equal(c.finalHits[0].metadata.unit_id, "u:_725ee6db");
  assert.equal(c.finalHits.length, 2); // seated ahead, nothing displaced
});

test("figure seat: stays off for non-figure questions and already-seated figures skip", async () => {
  const { figureSeat } = await import("../workers/worker_public/src/stages/figureSeat.ts");
  let called = 0;
  const db = { prepare: () => ({ bind: async () => ({ all: async () => { called += 1; return { results: [] }; } }) }) };
  const c: any = { env: { DB: db }, query: "What MPE applies to a C3 load cell?", u: { doc_number: "60" }, finalHits: [], hits: [], matches: [], lane: {}, opts: {} };
  await figureSeat.run(c);
  assert.equal(called, 0);
});
