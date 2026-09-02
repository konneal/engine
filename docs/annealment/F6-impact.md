# F6 — Impact analysis (committee tooling)

**Powering objects:** the binding graph — requirements ↔ conformance
tests ↔ formulas (`formulas-used.yaml` binds MDLO to conversion_factor_f,
E_L, E_R, C_M), tables (mpe_tiers feeds lookupMPE), aspects
(requirement-binding-targets), execution forms (E_R's report field).

**The win:** DRAFTING becomes queryable. *"If the committee raises the
class C limit_factor, what changes?"* → traverse the graph: the MPE
verdicts for class C, the tests whose verdicts derive from lookupMPE,
the R 60-3 report fields that record them, the instances already
evaluated. The answer is an IMPACT SET — machine-derived, exhaustive
(F3's completeness), with every hop's clause anchor.

**Why it matters:** this is the first capability whose customer is the
STANDARDS DEVELOPER, not the reader — the model pays for its own
maintenance by making revision risk computable.

**Why documents can't follow:** the binding "this test's verdict
consumes this table's factor" exists nowhere in any single document —
it is model knowledge spanning three parts.
