# F1 — Verdict as data (conformance-as-a-service)

**Powering objects:** `entities/workflow.yaml` Verdict data class ("the
canonical verdict chain"), `specification/constraints.yaml` (OCL check +
violation_meaning + on_violation), `entities/examination-reports.yaml`,
`specification/conformance/*`.

**The win:** conformance questions stop being answered with prose and
start being answered with a **VERDICT BLOCK** — an answer-contract
artifact like the table block, resolved from the model by EXECUTION:

```json
{"type": "verdict", "unit_id": "u:con-dead-load-max-geometry",
 "payload": {"verdict": "fail", "on_violation": "invalid",
   "meaning": "D_max lies outside [0.9·E_max, E_max] — … the type
               evaluation of this load cell is void.",
   "check": "ocl{d_max >= 0.9*e_max and d_max <= e_max}",
   "source": "urn:oiml:pub:r:60-1:2021#clause-3.6"}}
```

The model's own violation_meaning IS the explanation — the standard
explains itself in its recorded words. **Why documents can't follow:**
a verdict requires executing semantics; prose can only be quoted at.

**Build:** verdict evaluation in the D lane's serving path (constraints
interpreter over provided parameters), the verdict block type (contract
v2 already resolves any typed payload — only the UI card is new).
