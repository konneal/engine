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
| P8 | quantitative typing | unit strings in payloads | **unit register**: stable ids, quantity_kind, dimension vector, SI coherent unit, conversion factor; coherence on KINDS |
| P9 | computation | formula LaTeX (display) | formulas-as-operations (lookup with params); calculations (typed IO); **OCL constraints with violation meaning + on_violation** |
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
D via figure references, A/B zero. **The visible demo separator.**

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
