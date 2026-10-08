// Graph PPR lane (additive, TODO.sota/06 — the catalog's row 4,
// HippoRAG-style multi-hop memory): Personalized-PageRank over the D1
// graph projection, seeded from the query's resolved entities — the
// vocabulary link's concepts and the understood publication's family
// node — spreading over the domain's own law edges (defines, successor,
// part_of, variant_of, amends, cites). Documents ranked by stationary
// mass merge their query-relevant candidates like the graph lane does:
// multi-hop neighborhoods (a term defined by R 87, whose family cites
// R 61) surface without any hand-written traversal.
//
// The neighborhood is bounded (two hops, capped frontier) and the
// iteration is deterministic power iteration over the undirected
// adjacency — same query, same ranks, always.
import { THRESHOLDS } from "../config.ts";
import { lexicalWithin } from "../lexical.ts";
import { refCodec } from "../codecs.ts";
import { portStore } from "../env.ts";
import type { StoreQuery } from "../ports/store.ts";
import type { Stage } from "./types.ts";

const EDGE_KINDS = "('defines','successor','part_of','variant_of','amends','cites')";
const PPR_DAMPING = 0.85;
const PPR_ITERATIONS = 12;
const PPR_FRONTIER_CAP = 24;

/** Deterministic Personalized-PageRank: uniform teleport over the
 *  seeds, propagation over the UNDIRECTED adjacency (typed direction
 *  matters for semantics, not for spread — a doc defines a concept as
 *  much as the concept is defined by the doc). Pure: the unit tests
 *  pin the convergence and the seed preference. */
export function pageRank(
  edges: [string, string][],
  seeds: string[],
  opts: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? PPR_DAMPING;
  const iterations = opts.iterations ?? PPR_ITERATIONS;
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const live = seeds.filter((s) => adj.has(s));
  if (!live.length) return new Map();
  const base = 1 / live.length;
  let rank = new Map<string, number>(live.map((s) => [s, base]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const s of live) next.set(s, (1 - damping) * base);
    for (const [node, r] of rank) {
      const nbrs = adj.get(node);
      if (!nbrs?.length) {
        // a dangling node returns its mass to the seeds
        for (const s of live) next.set(s, (next.get(s) ?? 0) + damping * r * base);
        continue;
      }
      const share = (damping * r) / nbrs.length;
      for (const n of nbrs) next.set(n, (next.get(n) ?? 0) + share);
    }
    rank = next;
  }
  return rank;
}

/** Seed node ids for a query: the glossary's concepts (label match,
 *  the concept-graph lane's resolution) and the understood
 *  publication's family node. */
async function seedNodes(store: StoreQuery, glossary: { term: string }[], docidentifier: string | null): Promise<string[]> {
  const jobs: Promise<string[]>[] = [];
  for (const gl of glossary.slice(0, 3)) {
    if (gl.term.length < 3) continue;
    jobs.push(
      store.prepare(
        "SELECT id FROM graph_nodes WHERE kind = 'concept' AND (label = ?1 OR label LIKE ?2) LIMIT 6",
      )
        .bind(gl.term, `%${gl.term}%`)
        .all()
        .then((r: any) => (r.results ?? []).map((x: any) => String(x.id)))
        .catch(() => [] as string[]),
    );
  }
  const fam = docidentifier ? refCodec().familyOf(docidentifier) : null;
  if (fam) {
    jobs.push(
      store.prepare("SELECT id FROM graph_nodes WHERE kind = 'family' AND id = ?1")
        .bind(`family:${fam}`)
        .first()
        .then((r: any) => (r?.id ? [String(r.id)] : []))
        .catch(() => [] as string[]),
    );
  }
  const settled = await Promise.all(jobs);
  return [...new Set(settled.flat())].slice(0, 4);
}

/** Two bounded hops of the seed neighborhood: the edge list and the
 *  frontier's node kinds (doc nodes are what retrieval can use). */
async function neighborhood(store: StoreQuery, seeds: string[]): Promise<{ edges: [string, string][]; kinds: Map<string, string> }> {
  const seenEdges = new Set<string>();
  const edges: [string, string][] = [];
  let frontier = seeds.slice(0, PPR_FRONTIER_CAP);
  const visited = new Set(seeds);
  for (let hop = 0; hop < 2 && frontier.length; hop++) {
    const marks = frontier.map(() => "?").join(",");
    const rows = (await store.prepare(
      `SELECT src, dst FROM graph_edges WHERE kind IN ${EDGE_KINDS} AND (src IN (${marks}) OR dst IN (${marks})) LIMIT 400`,
    )
      .bind(...frontier)
      .all()
      .catch(() => ({ results: [] }))) as any;
    const next: string[] = [];
    for (const r of rows.results ?? []) {
      const key = `${r.src}>${r.dst}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push([String(r.src), String(r.dst)]);
      for (const n of [String(r.src), String(r.dst)]) {
        if (!visited.has(n)) {
          visited.add(n);
          if (next.length < PPR_FRONTIER_CAP) next.push(n);
        }
      }
    }
    frontier = next;
  }
  const nodeIds = [...visited].slice(0, 60);
  const kinds = new Map<string, string>();
  for (let i = 0; i < nodeIds.length; i += 30) {
    const chunk = nodeIds.slice(i, i + 30);
    const marks = chunk.map(() => "?").join(",");
    const rows = (await store.prepare(`SELECT id, kind FROM graph_nodes WHERE id IN (${marks})`)
      .bind(...chunk)
      .all()
      .catch(() => ({ results: [] }))) as any;
    for (const r of rows.results ?? []) kinds.set(String(r.id), String(r.kind));
  }
  return { edges, kinds };
}

/** The ranked document numbers for the query's seeds: PPR mass over
 *  the neighborhood, doc nodes only, rendered through the codec. */
export async function pprDocuments(
  store: StoreQuery,
  glossary: { term: string }[],
  docidentifier: string | null,
): Promise<string[]> {
  const seeds = await seedNodes(store, glossary, docidentifier);
  if (!seeds.length) return [];
  const { edges, kinds } = await neighborhood(store, seeds);
  if (!edges.length) return [];
  const rank = pageRank(edges, seeds);
  const docs = [...rank.entries()]
    .filter(([id, mass]) => kinds.get(id) === "doc" && mass > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => refCodec().graphDocNumber(id))
    .filter((n): n is string => !!n);
  return [...new Set(docs)].slice(0, 6);
}

export const graphPpr: Stage = {
  name: "graph-ppr",
  failure: "additive",
  // no raw-binding guard: a deployment without the store degrades
  // through the prefetch's own catch (the lane stays silent)
  when: (c) => (c.glossary.length > 0 || !!c.u?.docidentifier) && c.vector.length > 0,
  prefetch: (c) => {
    c.lane["graph-ppr"] = pprDocuments(portStore(c.env), c.glossary, c.u?.docidentifier ?? null).catch(() => [] as string[]);
  },
  run: async (c) => {
    const docs = (await c.lane["graph-ppr"]!) as string[];
    if (!docs?.length) return;
    // same identity resolution and narrowing law as the graph lane
    // (rag#137): BM25-within-set candidates at the half discount, five
    // at most, cross-encoder preference decides
    const g = await lexicalWithin(c.env, c.rq || c.query, docs, 6);
    const seenIds = new Set(c.matches.map((m: any) => m.id));
    let merged = 0;
    for (const m of (g ?? []).slice(0, 5)) {
      if (!seenIds.has(m.id)) {
        c.matches.push({ id: m.id, score: m.score * THRESHOLDS.pprDiscount, metadata: m.metadata });
        seenIds.add(m.id);
        merged++;
      }
    }
    if (merged) console.log("graph ppr:", docs.join(","), "— merged", merged);
  },
};
