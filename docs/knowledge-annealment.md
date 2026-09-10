# The knowledge-annealment ladder v2 — defined by system primitives

**The instrument for the four-corpus comparison** (Bulletin paper #2).
Annealment = the degree to which knowledge is bound into structure a
machine can traverse and compute. Each rung is defined by WHICH PRIMITIVES
it requires; each corpus lane is characterized by the primitives its
representation carries. A lane's **capability ceiling** = the highest
consecutive rung at ≥60% witness-checked pass; its **annealment index** =
the fraction of primitive tiers it materializes. Pass is always
witness-checked; L8/L9 witnesses are COMPUTED, never judged.

Fixed corpus across lanes: the OIML R 60 family (2021 p1–3 + annexes;
the 2017 edition package for diachrony).

## The primitive taxonomy (P1–P10) and who carries what

| Tier | Primitive | Metanorma/MKO realizes | Primmel realizes |
|---|---|---|---|
| P1 | surface text | adoc prose | prl descriptions |
| P2 | editorial anchoring | clause/unit/number/title/breadcrumb/cite_as | section + `source: urn#clause` on everything |
| P3 | object geometry | table payload (cols/rows), figure, formula display | tables with TYPED columns (name/type/unit) |
| P4 | nomenclature | glossary concepts, designations | terms with vocabulary registers (VIML), multilingual spellings, form types; aspects & behaviors registries |
| P5 | relation | part_of/cites/defines edges | curated clause-level references; `uses:` package composition (CASCO); requirement↔aspect binding; type↔instance references |
| P6 | temporality | editions + derived status | edition lifecycle (status/supersedes/validity.from) + FULL edition packages (diffable) |
| P7 | perception | figure units + assets + captions | figure references (fig-2/fig-3 in sequences) |
| P8 | quantitative typing | UnitsML in stems — flattened to string suffixes by the export (metanorma-document#55) | **unit register**: stable ids, quantity_kind, dimension vector, SI coherent unit, conversion factor; coherence on KINDS |
| P9 | computation | formula asciimath+mathml (display-only; no evaluation semantics — metanorma-document#55 GAP-3) | formulas-as-operations (lookup with params); calculations (typed IO); **OCL constraints with violation meaning + on_violation** |
| P10 | instance & process | — | entity schemas (type vs instance, obligation/cardinality); ordered test sequences (roles, contamination semantics); workflows; execution forms |

Meta-primitive (P★, Primmel only): **self-verification** — the model-linker
rules (quantity-coherence, requirement-binding-targets) and the
burned-to-empty allowlist ledger: the model is machine-checked consistent.

**Lane inventories:** A `exp_plain` = P1(+P2 as text) · B `exp_adoc` =
P1, P2-textual, P3-degraded · C `exp_mko` = P1–P7 (P8 weak strings) ·
D `exp_primmel` = P1–P10 · **E `exp_primmel_flat`** (diagnostic ablation:
D's projected prose WITHOUT payloads/edges/typing) — separates "better
text" from "better structure" inside D; the causal control the paper
needs.

## The ladder (L0–L9, sub-probes where the systems diverge)

**L0 LOCATE** (P1–P2). *"Where does R 60 address creep?"* Witness: clause
anchor. All lanes pass — the sanity floor.

**L1 EXTRACT** (P1–P2). Verbatim value from prose. Witness: exact
string. All lanes pass; small separation.

**L2 NOMENCLATURE** (P4). Colloquial → defined term.
a) corpus-local ("drift"→durability) b) **cross-register**: the VIML
clause via vocab_ref c) multilingual spelling resolution (Primmel only).
Witness: term + register anchor. Expected: C strong at (a), D strong
(a–c), A/B luck.

**L3 GEOMETRY** (P3+P8). a) cell lookup by row×column (typed block
required) b) **unit-aware cell**: the value AND its quantity kind (P8:
is n_LC dimensionless? loads in `v` units?) c) derived cell (needs a
lookup formula — transitional to L8). Witness: value + row/col keys +
unit kind. Expected: A ≤40%, B partial, C strong (a), D strong (a–c).

**L4 COMPOSITION** (P2+P5). a) intra-document join (MPE table + doubling
clause + load bands) b) **cross-part** join (R 60-1 requirement ↔ R 60-2
test ↔ R 60-3 form). Witness: both anchors + derived relation. Expected:
C/D strong at both; A/B partial (b near-zero).

**L5 CROSS-STANDARD** (P5). a) cites-edge ("which ISO/IEC test method
does R 60-2 invoke for humidity?") b) **composition + binding** ("which
CASCO vocabulary governs the certification activities; which aspects do
requirements bind?"). Witness: the linked id/clause. **ISOLATION: links
only in public lanes — ISO/IEC text never appears** (structural rule).
Expected: D strong, C partial (a), A/B near-zero.

**L6 DIACHRONY** (P6). a) current-edition selection b) **delta
extraction** 2017→2021 (the 2017 edition PACKAGE makes real diffs
computable) c) validity windows. Witness: edition pair + delta fact.
Expected: D strong, C partial (alignment, no diffs), A/B near-zero.

**L7 PERCEPTION** (P7). a) caption/asset b) pixel-only content (labels
readable only from the drawing) c) user-image grounding (nameplate
photo). Witness: pixel-only label / classification. Expected: C strong,
D via figure references, A/B zero. **The visible demo separator — and
live in production:** the pinned figure's pixels ride the generation
call (asset readability + message shape are measured invariants; see
the mechanism reference #12), so pixel-only labels are read from the
drawing itself, not disclaimed against the caption.

**L8 COMPUTATION** (P9+P8). a) pure calculation (conversion factor f
from inputs) b) **constraint/conformance verdict with the violation
meaning** ("is D_max=0.8·E_max acceptable?" → the OCL answer AND the
recorded violation semantics) c) **unit-coherence judgment** (compare
3000 kgf vs 30 kN via the register — P8). Witnesses: COMPUTED offline
from the model (deterministic, no judge). Expected: **D only, by
construction.**

**L9 INSTANCE & PROCESS** (P10). a) **process order & consequence**
("what is contaminated if creep runs before MDLO?" — encoded as sequence
semantics, not prose) b) instance-grounded facts (a specific recorded
type/instance profile — sample data only) c) execution-form knowledge
(test report structure). Witnesses: order verdict / instance fact
(deterministic from entities). Expected: **D only.**

## Rigor rules (v2 additions)

1. **Containment filtering**: every L8/L9 question is checked against
   the corpus text — if the specific answer string exists in prose, the
   question cannot separate lanes and is replaced. The instrument must
   probe structure, not memory of printed answers.
2. **Ablation lane E** (primmel-flat) is mandatory: without it, D's win
   is confounded by projection prose quality.
3. **Deterministic graders** for L8/L9 (computed ground truth); judge
   only at L4 (synthesis) — the instrument's upper rungs are its most
   objective.
4. Sequential measurement windows per lane; ×3 repeats; ranges reported.

## Golden set v2

~66 primary questions (6–7/rung incl. sub-probes) + 2 paraphrases for
L0–L6; R 60 primary, R 76-1 generality probes at L1/L3/L4 (A/B/C only).
Headline outputs: the **lane × rung matrix**, per-lane **primitive
activation radar** (P1–P10), **capability ceiling**, **annealment
index**, and **cost per correct answer**.


---

# The three eras — and the Primmel frontier (F1–F12)

## The era framing

| Era | Representation | Primitives | What the assistant IS | Ceiling |
|---|---|---|---|---|
| **1 · LEGACY** | plain text / raw adoc | P1–P2 | an index: find and restate | L1–L3 |
| **2 · NOW** | MKO (P1–P7) · Primmel-KO (P1–P10) | structure, typing, execution | a grounded instrument: cite, render, verify, compute | MKO L7 · Primmel L9 |
| **3 · FRONTIER** | Primmel objects (F1–F12 below) | closed world + executability + instances | an OPERATOR: verdict, simulate, prove, personalize, walk processes, verify publications | beyond L9 |

The comparison programme (TODO 15–20) measures Era 2's value per primitive.
The FRONTIER is Era 3 — capabilities that exist because the corpus is a
model with a closed world, executable semantics, and recorded instances.
**No document representation can follow** — these are the special wins
for D that make Primmel the destination, not just the winner of a test.

## F1 — Verdict as data (conformance-as-a-service)
`Verdict` data class ("the canonical verdict chain"), OCL constraints
with `violation_meaning` + `on_violation`, examination reports. Answers
return a **VERDICT BLOCK**: pass/fail/void + the reason in the
standard's own words + the full clause chain — produced by EXECUTION,
verified by execution. The answer contract's strongest artifact class.

## F2 — Counterfactual simulation
Constraints and table-lookup formulas run on HYPOTHETICAL parameters:
*"what if D_max were 0.8·E_max?"* → the OCL verdict + violation meaning;
*"which accuracy class for n_LC = 3000?"* → the lookup INVERTED.
Documents state facts; models evaluate hypotheses.

## F3 — Exhaustiveness and provable absence
The closed world (audited: all 60 requirements, 62 tests; forAll
semantics) → *"list ALL requirements binding marking"* is COMPLETE, and
*"does R 60 require X? — no, provably"* is a proof, not a refusal.
Retrieval corpora can only fail to find; the model can show the absence.

## F4 — Instance-grounded, parameterized answers
Attributes scoped family/instance + load-cell-instance entities + sample
data → the MPE table becomes a FUNCTION evaluated at the user's
instrument (Max, e, class): the answer is computed for YOUR device.
(Member/internal tier.) Input annealment: the unit register normalizes
any input units first.

## F5 — Certification workflow statefulness
`evaluation/processes` (layer-composed, `validate_provision` URN
anchors), gateways, execution forms + checklist → a procedural assistant
that knows where the evaluation stands, what gates what, what runs next —
and can advance checklist state. Agentic, not just informative.

## F6 — Impact analysis (committee tooling)
Requirement↔test↔formula↔table bindings (`formulas-used`, aspect
bindings) → *"if limit_factor for class C changes, which requirements,
tests, verdicts and forms change?"* — change impact over the dependency
graph. Drafting-committee superpower.

## F7 — Semantic edition diffs + temporal jurisdiction
Full 2017 edition PACKAGES + `validity.from` → edition deltas COMPUTED at
model level ("what changed in the creep requirement") and retro-jurisdiction
questions ("which edition governed a 2019 evaluation?").

## F8 — Self-verification as a query (meta-grounding)
The model-linker rules and the burned-empty allowlist: the corpus is
machine-checked consistent — so the assistant can VERIFY ITS OWN
model-grounded claims by execution. The faithfulness judge's successor
for the D lane.

## F9 — Document-as-projection verification
`documents/*/presentation.xml`: the model carries its own renders →
*"does the published Table 4 match the model?"* — QA of PUBLISHING
itself; the inverse direction (model → document generation) later.

## F10 — Normative notes as overrides
First-class NOTE/EXAMPLE objects with override semantics ("the MPE for
creep shall ALWAYS use p_LC = 0.7 regardless of the manufacturer's
declaration") → notes become queryable RULES that feed computation, not
buried prose that computation ignores.

## F11 — Composition-aware answers
`uses:` package composition (ISO/IEC 17000/17065) with layer-overlay
semantics → questions spanning the composition carry per-layer
provenance: "core says X; R 60 overlays Y" — co-location is not
composition, and only the model composes.

## F12 — The machine passport (r60-to-dpp.prm)
The `.prm` artifact: answers exportable as structured passport DATA, not
prose — the answer contract's ultimate block type. The Q&A becomes a
data source for downstream systems.

## Frontier sequencing

**LIVE** (serving the public today): F1 verdicts, F2 counterfactuals, F3
provable absence, F8 answer verification. **Within reach of the current
model plane** (deterministic witnesses, no producer dependency): F7
edition diffs, F10 note overrides. **Programme scale** (instance
execution and estate data): F4, F5, F6, F9, F11, F12.

## Structural retrieval (the clause tree, adapted from FABLE/BEAR, arXiv:2601.18116)

FABLE/BEAR (arXiv:2601.18116) retrieves over LLM-built semantic forests;
we adapt its serving techniques to a corpus that already IS a tree —
Metanorma clause anchors chain parent→child natively, so no index-time
tree-builder runs at all (the paper's entire offline cost collapses to
~1,400 synthetic depth-1 summary nodes, ≈$3 one-time). Three techniques
ship in the serving path (`src/structural.ts`), each gated by the golden
suite:

1. **Structural propagation** (their TreeExpansion, Eq. 7): a hit's
   score blends with its ancestors' (topic continuity) and descendants'
   (subtopic heat) — a section whose clauses are collectively hot rises;
   a hot section lifts its clauses. Spread-scaled like edition steering,
   so the cross-encoder's own signal always dominates.
2. **Position-preserving evidence order** (their NodeFusion): passages
   are presented in document reading order per publication (publications
   by best rank) — synthesis quality depends on arrangement, not just
   set membership. Applied in `buildMessages`, so every consumer (ask,
   research, lanes) inherits it.
3. **Ancestor-descendant dedup**: near-duplicate chunks of one clause
   chain (parent §3.1 vs child §3.1.2 repeating its text) collapse to
   the stronger one before the window is cut.

Plus the **multi-granularity index** (their internal-node indexing): the
corpus's chunks start at depth 2 ("3.1") — depth-1 nodes ("§3") did not
exist as retrievable objects. `/admin/section` (admin-token gated,
mirrors `/admin/enrich`) generates, embeds (toc-path ⊕ summary style)
and upserts them; the pipeline descends from a ranked section unit to
its quotable child clauses and retires the synthetic summary (citations
must quote source clauses, never our own summaries). Driver:
`ingest/cli.py sections` (resumable — KV-cached per unit id). And the
eval harness reports **EIR** (context utilization: cited/retrieved at
the answer) — the precision-side counterpart to witness recall, after
their EIR metric.

## Era 3: execution (the frontier is live)

Beyond the ladder, the machine objects are EXECUTED, not retrieved:

- **Verdicts** (`src/verdict.ts`): a question naming a constraint or
  machine limit gets the check evaluated against its stated values —
  pass / the standard's own violation word / void naming what is
  missing — attached as data the answer must present faithfully.
  Counterfactuals are free (values are values).
- **Provable absence** (`/v1/absence`): an enumeration certificate
  over the standard's model plane — absent means "N nodes enumerated,
  0 matches", never a bare refusal.
- **Answer verification** (`/v1/verify`): the deterministic contract
  battery plus a judged faithfulness score, exposed for any answer.

The full mechanism reference — every serving layer with its staircase
(what the layer below cannot do) — is `docs/sota-mechanisms.md`.
