# L8 — COMPUTATION (P9 + P8)

**Definition:** answers the documents DEFINE but never PRINT — values
that must be computed. Witnesses are COMPUTED OFFLINE from the model
(deterministic; no judge, no regex luck).

**Sub-probes:**
- **a) pure calculation** — *"the conversion factor f for these
  indications"* → calculations.yaml conversionFactor (inputs:
  avgIndicationAt75pct, indicationAtDmin; R 60-3 2.1.2.4). Witness: the
  computed number.
- **b) constraint verdict** — *"is D_max = 0.8·E_max acceptable?"* → OCL
  `dead_load_max_geometry` FAILS: d_max must lie in [0.9·E_max, E_max];
  witness: verdict + the recorded violation_meaning ("the type
  evaluation of this load cell is void") — F1's ladder form.
- **c) unit coherence** — *"are 3000 kgf and 30 kN the same force?"* →
  the unit REGISTER converts (quantity_kind force; conversion to SI);
  witness: the equality verdict. P8 pure.

Lane expectations: **D only, by construction** — A/B/C/E cannot compute
(they can at best quote a formula; E proves it's not prose quality).
The ladder's most objective rung: ground truth is arithmetic.
