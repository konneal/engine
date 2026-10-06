// Unit tests for the model plane (TODO.ai-platform/05) — the ask path's
// model-native grounding. Runs on plain node (type stripping):
//   node --test tests/model-plane.test.ts
//
// The invariants under test are the wave's own:
//   - THE BIND IS EXACT: a model node binds by its canonical id (the
//     strict grammar), from the declared chip label first, the question
//     second; an unindexed id binds NOTHING; an id indexed under several
//     standards binds the canonical layer — the one the plane's registry
//     ranks first (most recently indexed; the MECE flip's law), never a
//     coin flip; the standard comes from the declared/question-named
//     publication when named, never from an inference.
//   - THE GROUNDING IS THE NODE'S OWN: the grounding block carries the
//     constraint VERBATIM, the applicability, the acceptance, the
//     provenance — and a DECLARED source discrepancy always rides (the
//     model/prose disagreement posture is structural).
//   - THE ECHO IS HONEST AND BOUNDED: context_applied.model names the
//     bound node; the persisted echo round-trips through
//     parseAppliedContext (a resumed session keeps the honesty).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelNodeRefIn,
  standardForDocNumber,
  bindModelNode,
  modelGroundingBlock,
  modelCitation,
  modelEcho,
  modelCorpusNote,
} from "../workers/worker_public/src/modelplane.ts";
import { parseAppliedContext } from "../workers/worker_public/src/context.ts";

import { setProfile } from "../workers/worker_public/src/profile.ts";
import { PROFILE } from "../workers/worker_public/src/profile.gen.ts";
// the model plane is a declared feature; these tests pin the OIML
// deployment's mapping
setProfile({
  ...PROFILE,
  publisher: { ...PROFILE.publisher, features: { drafts: false, model_plane: true } },
  sources: { ...PROFILE.sources, models: { ...PROFILE.sources.models, standards: ["60", "91", "129", "144"], standard_prefix: "oiml-r" } },
  prompts: {
    ...PROFILE.prompts,
    vars: {
      ...PROFILE.prompts.vars,
      model_grounding_intro: "Model grounding — the ACME model plane (the platform's machine-readable Recommendation model, derived from the Primmel packages, the models' single source of truth):",
      model_passage_note: "Some passages are the ACME model plane (labeled ACME model) — the platform's machine-readable Recommendation models derived from the Primmel packages. Treat their machine limits, applicability rules and acceptance criteria as the model's own statement of them (quote machine limits verbatim); where a model passage and a prose passage disagree, say so explicitly and cite both.",
    },
  },
});

// ── the doubles ──────────────────────────────────────────────────────

const MPE_NODE = {
  id: "/req/metrological/mpe",
  kind: "requirement",
  class: "/req/metrological",
  name: "Maximum permissible errors on type evaluation",
  statement: "The MPE on type evaluation shall be the values derived using the expressions: p_LC x 0.5 v for the first tier…",
  binds_to: ["group.parameters.mpe", "group.classification.accuracy_class", "family.parameters.p_lc"],
  limit: {
    expression: "ocl{group.parameters.mpe = lookupMPE(load, group.classification.accuracy_class, family.parameters.p_lc) and family.parameters.p_lc >= 0.3 and family.parameters.p_lc <= 0.8}",
    uses: ["group.parameters.mpe", "group.classification.accuracy_class", "family.parameters.p_lc", "formula:lookupMPE", "table:mpe_tiers"],
  },
  clause: { doc: "urn:oiml:pub:r:60-1:2021", clause: "5.3.2", urn: "urn:oiml:pub:r:60-1:2021#clause-5.3.2" },
};

const HUMIDITY_NODE = {
  id: "/req/metrological/humidity-ch",
  kind: "requirement",
  name: "Humidity error for CH or unmarked transducers",
  statement: "The influence of exposure to cyclic temperature conditions…",
  applicability: { humidity_class: ["CH"] },
  clause: { doc: "urn:oiml:pub:r:60-1:2021", clause: "5.6.3.1", urn: "urn:oiml:pub:r:60-1:2021#clause-5.6.3.1" },
  source_discrepancy: {
    summary: "AB 99-3 form criterion for the max-load humidity effect (C_Hmax ≤ MPE) contradicts the AB 99-1 requirement text (C_Hmax ≤ 1 v)",
    sources: ["urn:oiml:pub:r:60-1:2021#clause-5.6.3.1", "urn:oiml:pub:r:60-3:2021#clause-2.1.7"],
    resolution: "follows_clause_x",
    rationale: "The model follows AB 99-1, 5.6.3.1 — the normative requirement clause…",
  },
};

function rowFor(standard: string, node: any) {
  return {
    standard,
    node_id: node.id,
    kind: node.kind,
    name: node.name,
    clause_doc: node.clause?.doc ?? "",
    clause_ref: node.clause?.clause ?? "",
    content: JSON.stringify(node),
  };
}

/** The D1 stub: model_nodes answers by (standard, node_id); the
 *  ambiguity probe answers the standards list. */
function dbStub(opts: { nodes?: Record<string, any>; standardsFor?: Record<string, string[]>; fail?: boolean } = {}) {
  const nodes = opts.nodes ?? {};
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first() {
              if (opts.fail) throw new Error("no such table: model_nodes");
              if (/FROM model_nodes WHERE standard/i.test(sql)) {
                return nodes[`${args[0]}${args[1]}`] ?? null;
              }
              return null;
            },
            async all() {
              if (opts.fail) throw new Error("no such table: model_nodes");
              if (/FROM model_nodes/i.test(sql) && /node_id/i.test(sql)) {
                const standards = opts.standardsFor?.[args[0]] ?? [];
                return { results: standards.map((s) => ({ standard: s })) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

// ── the grammar ──────────────────────────────────────────────────────

test("the node-id grammar: strict shapes only, from chip labels and questions", () => {
  assert.equal(modelNodeRefIn("this requirement /req/metrological/mpe — Maximum permissible errors"), "/req/metrological/mpe");
  assert.equal(modelNodeRefIn("what does /conf/metrological-tests/measurement-error-repeatability-mdlo verify?"), "/conf/metrological-tests/measurement-error-repeatability-mdlo");
  assert.equal(modelNodeRefIn("/term/durability — durability"), "/term/durability");
  assert.equal(modelNodeRefIn("the /constraint/dead_load_max_geometry rule"), "/constraint/dead_load_max_geometry");
  // non-node text never parses
  assert.equal(modelNodeRefIn("this certificate R60/2021-A-EX1-26.01"), null);
  assert.equal(modelNodeRefIn("what is the MPE for class C?"), null);
  assert.equal(modelNodeRefIn("R 60 clause 5.3.2"), null);
  assert.equal(modelNodeRefIn(undefined), null);
  assert.equal(modelNodeRefIn(""), null);
  // a three-segment path is NOT a node shape — the strict grammar binds
  // nothing rather than a prefix guess (the honest posture)
  assert.equal(modelNodeRefIn("/req/metrological/mpe/extra"), null);
});

test("the standard resolution: only the modeled Recommendations carry a plane", () => {
  assert.equal(standardForDocNumber("60"), "oiml-r60");
  assert.equal(standardForDocNumber("144"), "oiml-r144");
  assert.equal(standardForDocNumber("111"), null);
  assert.equal(standardForDocNumber(undefined), null);
});

// ── the binding ──────────────────────────────────────────────────────

test("the declared chip label wins over the question; the scope's standard narrows the bind", async () => {
  const env = {
    DB: dbStub({
      nodes: { "oiml-r60/req/metrological/mpe": rowFor("oiml-r60", MPE_NODE) },
    }),
  };
  const bound = await bindModelNode(env, {
    label: "this requirement /req/metrological/mpe — Maximum permissible errors on type evaluation",
    query: "why does my class C instrument fail this?",
    standard: "oiml-r60",
  });
  assert.equal(bound?.node_id, "/req/metrological/mpe");
  assert.equal(bound?.standard, "oiml-r60");
  assert.equal(bound?.clause?.urn, "urn:oiml:pub:r:60-1:2021#clause-5.3.2");
});

test("a scope-less bind resolves: unambiguous directly, ambiguous via the plane's canonical layer", async () => {
  const unique = await bindModelNode(
    { DB: dbStub({ nodes: { "oiml-r60/req/metrological/mpe": rowFor("oiml-r60", MPE_NODE) }, standardsFor: { "/req/metrological/mpe": ["oiml-r60"] } }) },
    { query: "explain /req/metrological/mpe", standard: null },
  );
  assert.equal(unique?.standard, "oiml-r60");

  // the MECE flip left the retired standard's nodes beside the
  // successors' — the precedence query ranks the canonical layer first
  // (most recently indexed), and the binder follows it, never a coin flip
  const flipped = await bindModelNode(
    { DB: dbStub({ nodes: { "oiml-r60-lml/req/metrological/mpe": rowFor("oiml-r60-lml", MPE_NODE) }, standardsFor: { "/req/metrological/mpe": ["oiml-r60-lml", "oiml-r60"] } }) },
    { query: "explain /req/metrological/mpe", standard: null },
  );
  assert.equal(flipped?.standard, "oiml-r60-lml", "ambiguity binds the plane's canonical layer, in registry order");

  const unindexed = await bindModelNode(
    { DB: dbStub({ standardsFor: {} }) },
    { query: "explain /req/metrological/mpe", standard: null },
  );
  assert.equal(unindexed, null);
});

test("the honest degradation: a D1 failure (the pre-migration deployment) binds nothing, never a hard failure", async () => {
  const bound = await bindModelNode(
    { DB: dbStub({ fail: true }) },
    { label: "this requirement /req/metrological/mpe — …", query: "q", standard: "oiml-r60" },
  );
  assert.equal(bound, null);
});

// ── the grounding block ──────────────────────────────────────────────

test("the grounding block carries the constraint VERBATIM + the clause + the applicability — never an invented limit", async () => {
  const env = { DB: dbStub({ nodes: { "oiml-r60/req/metrological/mpe": rowFor("oiml-r60", MPE_NODE) } }) };
  const bound = await bindModelNode(env, { label: "/req/metrological/mpe", query: "q", standard: "oiml-r60" });
  const block = modelGroundingBlock(bound!);
  assert.match(block, /\/req\/metrological\/mpe/);
  assert.match(block, /urn:oiml:pub:r:60-1:2021#clause-5\.3\.2/);
  // the machine limit is quoted verbatim from the node
  assert.ok(block.includes(MPE_NODE.limit.expression));
  assert.match(block, /quote it verbatim/);
  assert.match(block, /cite both/);
  // a node without a limit never gets one invented
  const bound2 = { ...bound!, content: { id: "/term/durability", kind: "term", definition: "ability of a measuring instrument to maintain its performance characteristics over a period of use" } };
  const block2 = modelGroundingBlock(bound2);
  assert.doesNotMatch(block2, /Machine limit/);
  assert.match(block2, /Definition: ability of a measuring instrument/);
});

test("the disagreement posture is structural: a declared source_discrepancy always rides the grounding block", async () => {
  const env = { DB: dbStub({ nodes: { "oiml-r60/req/metrological/humidity-ch": rowFor("oiml-r60", HUMIDITY_NODE) } }) };
  const bound = await bindModelNode(env, { label: "/req/metrological/humidity-ch", query: "q", standard: "oiml-r60" });
  const block = modelGroundingBlock(bound!);
  assert.match(block, /DECLARED SOURCE DISCREPANCY/);
  assert.match(block, /contradicts the AB 99-1 requirement text/);
  assert.match(block, /urn:oiml:pub:r:60-1:2021#clause-5\.6\.3\.1 and urn:oiml:pub:r:60-3:2021#clause-2\.1\.7/);
  assert.match(block, /MUST surface this and cite both/);
  assert.match(block, /humidity class: CH/);
});

// ── the echo + the citation ──────────────────────────────────────────

test("the echo names the bound node, bounded; the persisted echo round-trips", async () => {
  const env = { DB: dbStub({ nodes: { "oiml-r60/req/metrological/mpe": rowFor("oiml-r60", MPE_NODE) } }) };
  const bound = await bindModelNode(env, { label: "/req/metrological/mpe", query: "q", standard: "oiml-r60" });
  const echo = modelEcho(bound!);
  assert.deepEqual(echo, {
    node_id: "/req/metrological/mpe",
    kind: "requirement",
    standard: "oiml-r60",
    clause: "urn:oiml:pub:r:60-1:2021#clause-5.3.2",
  });
  // the round-trip through the conversations store's validator
  const persisted = parseAppliedContext({
    kind: "entity",
    label: "this requirement /req/metrological/mpe — …",
    scoped_to: "ACME R 60:2021",
    model: echo,
  });
  assert.deepEqual(persisted?.model, echo);
  // garbage model echoes drop, never crash
  const garbage = parseAppliedContext({ kind: "entity", model: { node_id: 42 } });
  assert.equal(garbage?.model, undefined);
});

test("the citation names the model plane + the node's clause", async () => {
  const env = { DB: dbStub({ nodes: { "oiml-r60/req/metrological/mpe": rowFor("oiml-r60", MPE_NODE) } }) };
  const bound = await bindModelNode(env, { label: "/req/metrological/mpe", query: "q", standard: "oiml-r60" });
  const cit = modelCitation(bound!);
  assert.equal(cit.corpus, "smart-model");
  assert.equal(cit.doc_id, "model:oiml-r60");
  assert.equal(cit.clause_anchor, "5.3.2");
  assert.match(cit.clause_title, /requirement — Maximum permissible errors/);
  assert.match(cit.snippet, /clause-5\.3\.2/);
});

test("the corpus note instructs the model/prose disagreement posture for every retrieved model chunk", () => {
  assert.match(modelCorpusNote(), /machine-readable Recommendation models/);
  assert.match(modelCorpusNote(), /quote machine limits verbatim/);
  assert.match(modelCorpusNote(), /disagree, say so explicitly and cite both/);
});

// ── bind by stated quantities (the constraint resolution) ───────────

import { bindConstraintByQuantities } from "../workers/worker_public/src/modelplane.ts";

const CONSTRAINT_ROWS = [
  {
    standard: "oiml-r60-lml", node_id: "/constraint/dead_load_max_geometry", kind: "constraint",
    name: "Dead-load maximum geometry", clause_doc: "urn:oiml:pub:r:60-1:2021", clause_ref: "3.6",
    content: JSON.stringify({
      check: "ocl{model.parameters.d_max >= 0.9 * model.parameters.e_max and model.parameters.d_max <= model.parameters.e_max}",
      on_violation: "invalid",
    }),
  },
  {
    standard: "oiml-smart-core", node_id: "/constraint/completion_fees_settled", kind: "constraint",
    name: "Fees settled", clause_doc: null, clause_ref: null,
    content: JSON.stringify({ check: "ocl{application.fees >= 0 and application.fees <= 0}" }),
  },
];

function constraintDb(rows: any[]) {
  return {
    prepare(sql: string) {
      return {
        // the constraint sweep is UNBOUND; fetchNode binds
        all: async () => ({ results: sql.includes("kind = 'constraint'") ? rows : [] }),
        bind: (..._a: unknown[]) => ({
          all: async () => ({ results: [] }),
          first: async () => (sql.includes("WHERE standard") ? rows[0] : null),
        }),
      };
    },
  };
}

test("a constraint-shaped question binds by its stated symbols, not its id", async () => {
  const bound = await bindConstraintByQuantities(
    { DB: constraintDb(CONSTRAINT_ROWS) },
    "The type evaluation of a load cell whose E_max is 30000 v proposes testing to a dead load D_max of 26000 v. Is that proposal acceptable?",
  );
  assert.ok(bound, "the quantities bind");
  assert.equal(bound!.node_id, "/constraint/dead_load_max_geometry");
  assert.equal(bound!.standard, "oiml-r60-lml");
});

test("a non-verdict question never binds, and neither does a single shared symbol", async () => {
  const db = constraintDb(CONSTRAINT_ROWS);
  assert.equal(await bindConstraintByQuantities({ DB: db }, "what is E_max for a class C load cell?"), null, "no verdict vocabulary");
  assert.equal(await bindConstraintByQuantities({ DB: db }, "is a fee of 10 acceptable?"), null, "one symbol only never binds");
});
