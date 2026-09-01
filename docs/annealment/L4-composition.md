# L4 — INTRA-DOCUMENT COMPOSITION (P2 + P5)

**Definition:** an answer that JOINS ≥2 clauses (often + a table) and
returns both anchors plus the derived relation.

**Sub-probes:**
- **a) intra-document** — *"initial-verification MPE vs in-service
  limits for a class C load cell, and how they scale across the
  range"* → R 60-1 MPE table (tier breakpoints, limit_factor) + the
  applicability clauses. Witness: both anchors + the scaling statement
  expressed in v-units.
- **b) cross-part** — *"which R 60-2 test validates the R 60-1
  repeatability requirement, and where is its result recorded in
  R 60-3?"* → requirement `/req/metrological/repeatability` (R 60-1) ↔
  test `/conf/metrological-tests/...` (R 60-2) ↔ test-report form
  (R 60-3 §2.1.3 E_R). Witness: the three part-anchors. In D the chain
  is EDGES (formulas_used binds the test to
  `repeatabilityError`); in C it must be co-retrieved.

Lane expectations: C/D strong at (a); (b) separates C (partial — needs
all three parts in the window) from D (edges). A/B partial.
