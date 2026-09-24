// The license entitlement hard scope (TODO.external-refs/08): the
// predicate, the pool-level stage's placement in the registry (including
// the dense widen fallback — the known leak-trap shape), the request-scope
// derivation + cache salt, the gated model binding, and the boundary
// note/refusal composition. The TRANSPORT proof (zero licensed chunks on
// the search/ask RESPONSE) rides the deployment's suite against the built
// package — the route layer imports the pipeline, which plain node cannot
// load (the .md prompt imports).
import { test } from "node:test";
import assert from "node:assert/strict";
import { standardKeyAllowed } from "../workers/worker_public/src/selfquery.ts";
import { STAGES } from "../workers/worker_public/src/stages/index.ts";
import { runStages, type PipelineContext } from "../workers/worker_public/src/stages/types.ts";
import { resolveRequestScope, requestSalt, entitlementScope, standardKeysFrom, licenseDeclared } from "../workers/worker_public/src/requestScope.ts";
import { bindModelNode, licenseBoundaryNote, licenseBoundaryRefusal } from "../workers/worker_public/src/modelplane.ts";
import { setProfile, P } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";
import type { ChunkMeta, Hit } from "../workers/shared/chunk.ts";

// ── the fixture: a public family + a licensed one ───────────────────────

const LICENSED_KEY = "std:fixture-ab-99";

function meta(partial: Partial<ChunkMeta>): ChunkMeta {
  return {
    doc_id: "", docidentifier: "", doctype: "R", doc_number: "", edition: "",
    language: "en", clause_anchor: "", clause_title: "", tier: "", corpus: "oiml", text_ref: "",
    ...partial,
  } as ChunkMeta;
}

const CORPUS: Array<{ id: string; m: ChunkMeta; text: string }> = [
  { id: "pub-1", m: meta({ doc_id: "d-r60", docidentifier: "OIML R 60-1", doc_number: "60", clause_anchor: "5.2", clause_title: "Load cell" }), text: "a load cell converts force into a signal" },
  { id: "lic-1", m: meta({ doc_id: "d-iec", docidentifier: "ACME AB-99", doc_number: "ab-99", clause_anchor: "7", clause_title: "Cyclic humidity procedure", standard_key: LICENSED_KEY, standard: "fixture-ab-99" }), text: "the cyclic humidity procedure steps" },
  { id: "lic-2", m: meta({ doc_id: "d-iec", docidentifier: "ACME AB-99", doc_number: "ab-99", clause_anchor: "8", clause_title: "Severity", standard_key: LICENSED_KEY, standard: "fixture-ab-99" }), text: "severity rows for the cyclic humidity test" },
];

function vec(text: string): number[] {
  return [1, 0.5]; // any non-zero vector — scores are irrelevant to the scope
}

function makeEnv(lexicalIds: string[] = []) {
  const AI = {
    run: async (_model: string, body: any) => {
      if (body?.text?.[0] !== undefined) return { data: [vec(String(body.text[0]))] };
      if (body?.messages) return {}; // understanding unavailable — vanilla retrieval
      return {};
    },
  };
  const VECTORIZE = {
    query: async (v: number[], q: any) => {
      const pool = CORPUS.filter((f) => {
        if (!q.filter) return true;
        for (const [k, cond] of Object.entries(q.filter)) {
          if ((cond as any)?.$eq !== undefined ? (f.m as any)[k] !== (cond as any).$eq : (f.m as any)[k] !== cond) return false;
        }
        return true;
      }).map((f) => ({ id: f.id, score: 0.9, metadata: { ...f.m, chunk_text: f.text } }));
      return { matches: pool.slice(0, q.topK ?? 10) };
    },
  };
  const DB = {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("chunks_fts")) {
              const rows = lexicalIds.map((id) => CORPUS.find((f) => f.id === id)).filter(Boolean)
                .map((f, i) => ({ ...(f as any).m, text: (f as any).text, rank: -(i + 1) }));
              return { results: rows as any };
            }
            return { results: [] };
          },
          run: async () => ({}),
          first: async () => null,
        }),
      };
    },
  };
  const CACHE = { get: async () => null, put: async () => {} };
  return { AI, VECTORIZE, DB, CACHE };
}

function ctx(env: any, over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    env, query: "damp heat", rq: "damp heat", folded: "damp heat",
    u: null, filters: null, filter: null, vector: vec("damp heat"),
    lexicalHits: [], matches: [], hits: [], finalHits: [], glossary: [], notes: [],
    opts: {}, lane: {}, ...over,
  } as PipelineContext;
}

const licensedIds = (hits: Hit[]) => hits.filter((h) => h.metadata.standard_key).map((h) => h.id);

// ── the predicate ────────────────────────────────────────────────────────

test("standardKeyAllowed: public always passes; a key outside the set never does", () => {
  const keys = new Set([LICENSED_KEY]);
  assert.ok(standardKeyAllowed(meta({}), keys), "public chunk dropped");
  assert.ok(standardKeyAllowed(meta({ standard_key: LICENSED_KEY }), keys), "entitled chunk dropped");
  assert.ok(!standardKeyAllowed(meta({ standard_key: "std:other" }), keys), "unentitled chunk admitted");
  assert.ok(!standardKeyAllowed(meta({ standard_key: LICENSED_KEY }), new Set()), "empty set admitted licensed content");
  assert.ok(standardKeyAllowed(meta({ standard_key: LICENSED_KEY }), null), "inactive scope must not filter");
  assert.ok(standardKeyAllowed(meta({}), new Set()), "empty set keeps public content");
});

// ── the registry composition (every lane merges BEFORE the scope) ───────

test("license scope, empty entitlement set: zero licensed chunks survive the full registry", async () => {
  const env = makeEnv(["lic-1", "pub-1"]); // lexical lane carries a licensed hit too
  const c = ctx(env, {
    opts: { standardKeys: new Set<string>() }, // fail-closed: the unentitled caller
    lexicalHits: ["lic-1", "pub-1"].map((id) => {
      const f = CORPUS.find((x) => x.id === id)!;
      return { id, score: 0.5, metadata: { ...f.m, chunk_text: f.text }, text: f.text };
    }),
  });
  await runStages(STAGES, c);
  assert.deepEqual(licensedIds(c.finalHits), [], "licensed chunks reached the window");
  assert.ok(c.finalHits.some((h) => h.id === "pub-1"), "public content must survive the scope");
});

test("license scope, entitled caller: licensed chunks compete normally", async () => {
  const env = makeEnv();
  const c = ctx(env, { opts: { standardKeys: new Set([LICENSED_KEY]) } });
  await runStages(STAGES, c);
  assert.ok(licensedIds(c.finalHits).length >= 1, "entitled caller lost the licensed content");
});

test("inactive scope (null): deployment without licensed content is untouched", async () => {
  const env = makeEnv();
  const c = ctx(env, { opts: { standardKeys: null } });
  await runStages(STAGES, c);
  assert.equal(licensedIds(c.finalHits).length, 2, "inactive scope filtered licensed chunks");
});

// ── the dense widen fallback (the leak-trap shape) ───────────────────────

test("dense widen fallback under an empty entitlement set stays licensed-clean", async () => {
  // doc-scoped filter returns fewer than rerankKeep (10) matches → dense
  // widens with the UNFILTERED ranking (licensed hits ride in) → the pool
  // scope must still cut them before ranking.
  const env = makeEnv();
  const c = ctx(env, {
    u: { doc_number: "60" } as any,
    filters: { doc_number: "60" },
    filter: { doc_number: "60" },
    opts: { standardKeys: new Set<string>() },
  });
  await runStages(STAGES, c);
  assert.deepEqual(licensedIds(c.finalHits), [], "the widen re-admitted licensed chunks");
});

// ── the request-scope derivation + salt ──────────────────────────────────

test("standardKeysFrom validates against the declared whitelist (fail-closed)", () => {
  setProfile(PROFILE); // the fixture declares std:fixture-ab-99
  assert.ok(licenseDeclared());
  assert.deepEqual([...standardKeysFrom({ licensed_standards: [LICENSED_KEY, "std:forged", 42, null] })], [LICENSED_KEY]);
  assert.deepEqual([...standardKeysFrom({})], [], "absent field must derive empty");
  assert.deepEqual([...standardKeysFrom({ licensed_standards: "junk" })], []);
});

test("entitlementScope: null only when the deployment declares no licensed content", () => {
  setProfile(PROFILE);
  assert.deepEqual(entitlementScope(new Set()), new Set(), "declared licensed: empty set stays active");
  setProfile({ ...PROFILE, sources: { ...PROFILE.sources, licensed: [] } });
  assert.equal(entitlementScope(new Set([LICENSED_KEY])), null, "no declared licensed: scope must be inert");
  setProfile(PROFILE);
});

test("requestSalt carries the entitlement set whenever the deployment keys content", () => {
  setProfile(PROFILE);
  const sc = resolveRequestScope({ licensed_standards: [LICENSED_KEY] }, null) as any;
  assert.deepEqual([...sc.standardKeys], [LICENSED_KEY]);
  const salted = requestSalt(sc, []);
  assert.ok(salted && salted.includes('"s"'), `entitlement missing from salt: ${salted}`);
  const anon = resolveRequestScope({}, null) as any;
  assert.equal(requestSalt(anon, []), JSON.stringify({ s: [] }), "the unentitled ask salts as the empty set");
  // a deployment without licensed content keeps the legacy unsalted default
  setProfile({ ...PROFILE, sources: { ...PROFILE.sources, licensed: [] } });
  const legacy = resolveRequestScope({}, null) as any;
  assert.equal(requestSalt(legacy, []), null);
  setProfile(PROFILE);
  assert.equal(P().sources.licensed.length, 1, "fixture profile not restored");
});

// ── the gated model binding ──────────────────────────────────────────────

test("bindModelNode gates a licensed package's grounding for the unentitled caller", async () => {
  const env = {
    DB: {
      prepare(_sql: string) {
        return {
          bind: (..._args: unknown[]) => ({
            first: async () => ({
              standard: "fixture-ab-99", node_id: "/req/class-a/mpe", kind: "requirement", name: "MPE",
              clause_doc: "urn:fixture", clause_ref: "3.2",
              content: JSON.stringify({ statement: "the licensed machine content" }),
            }),
            all: async () => ({ results: [{ standard: "fixture-ab-99" }] }),
          }),
        };
      },
    },
  };
  const bound = await bindModelNode(env as any, { query: "explain /req/class-a/mpe", standardKeys: new Set() });
  assert.ok(bound?.gated, "licensed node bound unguarded");
  assert.deepEqual(bound.content, {}, "gated binding kept its content");
  assert.equal(bound.clause?.ref, "3.2", "citation-level metadata must survive the gate");

  const entitled = await bindModelNode(env as any, { query: "explain /req/class-a/mpe", standardKeys: new Set([LICENSED_KEY]) });
  assert.ok(entitled && !entitled.gated, "entitled caller lost the grounding");
  assert.ok(entitled.content.statement, "entitled binding lost its content");

  const open = await bindModelNode(env as any, { query: "explain /req/class-a/mpe" });
  assert.ok(open, "binding refused without an entitlement set");
});

test("license boundary note + refusal: composed only for the unentitled licensed case", () => {
  setProfile(PROFILE);
  const note = licenseBoundaryNote("ab-99", new Set());
  assert.ok(note?.includes("does not cover"), "boundary note missing the boundary");
  assert.ok(note?.includes("declare flow"), "boundary note missing the declare pointer");
  assert.equal(licenseBoundaryNote("ab-99", new Set([LICENSED_KEY])), undefined, "entitled caller got a boundary note");
  assert.equal(licenseBoundaryNote("60", new Set()), undefined, "public publication got a boundary note");
  const refusal = licenseBoundaryRefusal("ab-99", new Set());
  assert.ok(refusal?.includes("licensed"), "boundary refusal missing");
  assert.ok(refusal?.includes("ab-99"), "boundary refusal must name the standard");
  assert.equal(licenseBoundaryRefusal("60", new Set()), undefined);
});
