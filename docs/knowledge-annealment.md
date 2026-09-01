# The knowledge-annealment ladder — categories of increasing depth

**The instrument for the four-corpus comparison** (Bulletin paper #2). Each
level probes strictly more annealed structure than the one below; a corpus
representation (plain text / adoc / MKO / Primmel model) can be
characterized by its **capability ceiling**: the highest level at which it
still passes. "Pass" is always witness-checked, never vibes.

The corpus under test is FIXED across lanes: the OIML R 60 family (2021
parts 1–3 + annexes, plus the 2017 edition for diachrony) — the four lanes
differ ONLY in representation.

## L0 — LOCATE
*"Where does R 60 address creep?"* — witness: the clause anchor.
Probes: text presence. **Expected: all four lanes pass** (this is the
sanity floor; a lane failing L0 is mis-built, not worse).

## L1 — EXTRACT (verbatim value)
*"Quote the humidity classification for class C load cells."* — witness:
exact string/regex from prose. Probes: fidelity without structure.
Expected: A/B pass (values live in prose), C/D pass. Small separation only.

## L2 — TERMINOLOGY RESOLUTION
Colloquial vocabulary → the corpus's own defined terms, with the
authoritative definition and its vocabulary anchor: *"my load cell keeps
drifting over months — what does R 60 call that and what does VIML say?"*
("drift" → **creep/durability**; witness: the term + VIML 5.15 clause via
terminology.vocab_ref). Probes: glossary binding. Expected: C/D strong
(native glossary + sources), A/B weak-to-partial (embedding luck).

## L3 — TABULAR GEOMETRY
A value that requires row×column header disambiguation: *"minimum n_LC
for class B"* (row=class, column=lower limit); *"MPE at 500–1000e for
class III per R 76-1"* on the generality probe. Witness: the exact cell
value + row/column keys, delivered as a TYPED BLOCK (not re-typed prose).
Probes: table structure. Expected: A ≤40% (flattened), B partial (pipes
survive as noise), C/D ≥90%. **This is the first hard separator.**

## L4 — INTRA-DOCUMENT COMPOSITION
An answer that joins ≥2 clauses (often + a table) within one document:
*"initial-verification MPE vs in-service limits for a class III
instrument — and how do they scale across the range?"* (joins the MPE
table + the doubling clause + the load-band structure). Witness: BOTH
clause citations + the derived relation. Probes: section graph and chunk
provenance. Expected: C/D strong, A/B partial (right chunks may not
co-retrieve).

## L5 — CROSS-DOCUMENT LINKING
*"Which ISO/IEC standard's test method does R 60-2 invoke for humidity,
and which CASCO vocabulary governs the certification activities?"*
Witness: the linked document id + clause (references.yaml edges; the
`uses: iso-iec-17000/17065` composition). **ISOLATION RULE: the public
gate asserts the LINK only — ISO/IEC text never appears in a public lane;
content-level probing is member/internal-only** (structural, per the
two-audience rule). Expected: D strong (curated references + composition),
C partial (cites edges), A/B near-zero.

## L6 — DIACHRONY (EDITIONS)
*"What changed between R 60:2017 and R 60:2021 — and which edition
applies today?"* Witness: the edition pair + the delta fact (from the
editions/ data + lifecycle: status current, supersedes, validity).
Probes: edition identity and lifecycle. Expected: D strong (native
lifecycle + 2017 data), C partial (unit alignment, no diffs yet —
metanorma-document#53 item 5), A/B near-zero.

## L7 — MULTIMODAL (FIGURES / USER IMAGES)
*"What do the strain-gauge design-shape examples in R 60-2 show?"*
(witness: labels readable ONLY from pixels) and the nameplate-photo probe
(witness: classification). Probes: typed figure units + assets + captions.
Expected: C strong (figure lane live), D if the model references images,
A/B zero. **The visible demo separator on the site.**

## L8 — EXECUTABLE SEMANTICS
Questions the documents DEFINE but never PRINT: *"compute the conversion
factor f for these indications"*, *"is THIS load cell profile (Max 30 kg,
e 5 g, class C) conformant for n_LC?"* Ground truth is COMPUTED OFFLINE
from the model's calculations/constraints — deterministic witnesses, no
judge needed. Probes: the document as program. Expected: **D only, by
construction.** C/B/A: structurally incapable.

## Why this order (the annealment claim)

Each level adds a dimension of structural binding: presence → fidelity →
term binding → geometry → composition → traversal → time → perception →
execution. The ladder is also the interaction ladder users actually climb
(find → read → resolve jargon → read tables → synthesize → follow
references → compare editions → interpret drawings → compute), so the
capability ceiling reads as a user-facing capability, not a benchmark
artifice.

## Golden set design

- 6 questions per level = **48 primary** + 2 paraphrases each for L0–L5
  (robustness) = ~60 total; R 60 primary, R 76-1 as the generality probe
  (L1/L3/L4 only, lanes A/B/C).
- Every question carries: witness regex/values, expected citation
  anchors, required structural artifact (typed block / computed value /
  link), and the level tag.
- Grading: deterministic witness checks (regex/anchor/artifact);
  faithfulness judge only where prose synthesis is the target (L4).
- **Headline metric: cost per correct answer** (blends quality and speed)
  + the capability ceiling per lane.
