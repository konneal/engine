// The citation GraphRAG path: what a publication cites comes from the
// graph's `cites` edges (extracted at ingest from the bibliographies),
// presented as an authoritative note alongside the bibliography
// passages. The note must carry the codec-normalized identifier — a
// bare number never appears (the pubid rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { citationGraphNote, type CiteRow } from "../workers/worker_public/src/stages/citationProbe.ts";
import { oimlPubid } from "../workers/worker_public/src/codecs.ts";

const ROWS: CiteRow[] = [
  { docidentifier: "OIML R 60", edition: "2017", active: 1, label: "OIML R 76" },
  { docidentifier: "OIML R 60", edition: "2017", active: 1, label: "OIML V 2-200" },
  { docidentifier: "OIML R 60", edition: "2017", active: 1, label: "ISO 376" },
  { docidentifier: "OIML R 60", edition: "2017", active: 1, label: "IEC 60068-2-6" },
  { docidentifier: "OIML R 60", edition: "1967", active: 0, label: "ISO 8601:2004" },
];

test("the note groups citations per edition, active first, label verbatim", () => {
  const note = citationGraphNote("OIML R 60", ROWS);
  assert.ok(note.startsWith("Citation graph (authoritative"));
  const lines = note.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("- OIML R 60:2017 (active edition) cites: OIML R 76, OIML V 2-200, ISO 376, IEC 60068-2-6"));
  assert.ok(lines[1].startsWith("- OIML R 60:1967 cites: ISO 8601:2004"));
  assert.match(note, /answer from this list/);
});

test("no graph rows → no note (the passages stand alone)", () => {
  assert.equal(citationGraphNote("OIML R 60", []), "");
});

test("the identifier is the codec-normalized label, never a bare number", () => {
  const scope = oimlPubid.scanQuestion("What ISO standards does R 60 cite?")!;
  assert.equal(scope.doc_number, "60");
  assert.equal(scope.label, "OIML R 60");
  assert.equal(oimlPubid.familyOf(scope.label), "R-60");
  const note = citationGraphNote(scope.label, ROWS);
  // the naming is the full pubid label; a bare "60" as a citation or a
  // source name never appears (every "60" sits inside "OIML R 60")
  assert.ok(note.includes("of OIML R 60):"));
  for (const m of note.matchAll(/(?<![A-Za-z0-9:-])60(?![0-9-])/g)) {
    const around = note.slice(Math.max(0, m.index - 8), m.index + 3);
    assert.match(around, /OIML R 60/);
  }
});

test("duplicate cited labels within an edition collapse", () => {
  const dup = [...ROWS, { docidentifier: "OIML R 60", edition: "2017", active: 1, label: "ISO 376" }];
  const note = citationGraphNote("OIML R 60", dup);
  const line = note.split("\n").find((l) => l.includes("(active edition)"))!;
  assert.equal(line.split("ISO 376").length - 1, 1);
});

test("long bibliographies are capped per edition", () => {
  const many: CiteRow[] = Array.from({ length: 60 }, (_, i) => ({
    docidentifier: "OIML R 60", edition: "2017", active: 1, label: `ISO ${1000 + i}`,
  }));
  const note = citationGraphNote("OIML R 60", many);
  const line = note.split("\n").find((l) => l.startsWith("- "))!;
  assert.equal(line.split(",").length, 30);
});

test("edition identifiers already carrying the year do not duplicate it", () => {
  const note = citationGraphNote("OIML R 60", [
    { docidentifier: "OIML R 60:2017 (E)", edition: "2017", active: 1, label: "ISO 376" },
  ]);
  assert.match(note, /- OIML R 60:2017 \(E\)( \(active edition\))? cites: ISO 376/);
  assert.ok(!note.includes("2017:2017"), "no duplicated year");
});

// ── stage mechanics (the naming/codec path is covered above; the
// fixture profile's codec is plain-slug, so when()'s document scan is
// honestly false under it — the stash is set the way when() sets it) ──
import { citationProbe } from "../workers/worker_public/src/stages/citationProbe.ts";

test("under the fixture codec the shape never fires without a naming", () => {
  const c: any = { query: "What ISO standards does R 60 cite?", u: null, opts: {} };
  assert.equal(citationProbe.when!(c), false);
});

test("the stage merges bibliography passages AND injects the graph note", async () => {
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (..._a: unknown[]) => ({
            all: async () =>
              sql.includes("graph_edges")
                ? { results: ROWS }
                : sql.includes("SELECT id, text FROM chunks")
                  ? { results: [{ id: "b1", text: "22.3 Bibliography [1] OIML R 76 — text" }] }
                  : { results: [{ id: "b1" }] },
          }),
        };
      },
    },
    VECTORIZE: {
      getByIds: async (ids: string[]) =>
        ids.map((id) => ({ id, score: 0.5, metadata: { clause_title: "Bibliography", doc_number: "60" } })),
    },
  };
  const c: any = {
    env, query: "What ISO standards does R 60 cite?", rq: "x", folded: "x", u: null,
    filters: null, filter: null, vector: [], lexicalHits: [], matches: [], hits: [],
    finalHits: [], glossary: [], notes: [], opts: {}, lane: {},
  };
  // the stash when() sets when the codec names the document
  c.__citeDocNum = "60";
  c.__citeFamily = "R-60";
  c.__citeLabel = "OIML R 60";
  c.__citeEdition = null;
  citationProbe.prefetch!(c);
  await citationProbe.run(c);
  assert.equal(c.hits.length, 1, "bibliography passage merged");
  assert.equal(c.hits[0].score, 10, "deterministic high score");
  assert.equal(c.notes.length, 1, "graph note injected");
  assert.ok(c.notes[0].includes("OIML R 76"));
  assert.ok(c.notes[0].includes("OIML R 60:2017 (active edition)"));
});

test("graph rows absent → passages only, no note, no crash", async () => {
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            all: async () =>
              sql.includes("graph_edges")
                ? { results: [] }
                : sql.includes("SELECT id, text FROM chunks")
                  ? { results: [] }
                  : { results: [{ id: "b1" }] },
          }),
        };
      },
    },
    VECTORIZE: { getByIds: async () => [] },
  };
  const c: any = {
    env, query: "x", rq: "x", folded: "x", u: null, filters: null, filter: null,
    vector: [], lexicalHits: [], matches: [], hits: [], finalHits: [],
    glossary: [], notes: [], opts: {}, lane: {},
    __citeDocNum: "60", __citeFamily: "R-60", __citeLabel: "OIML R 60", __citeEdition: null,
  };
  citationProbe.prefetch!(c);
  await citationProbe.run(c);
  assert.equal(c.hits.length, 0);
  assert.equal(c.notes.length, 0);
});
