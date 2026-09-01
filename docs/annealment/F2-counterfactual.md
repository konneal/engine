# F2 — Counterfactual simulation

**Powering objects:** constraints (OCL), formulas-as-operations
(table_lookup with params), calculations (typed IO).

**The win:** hypotheticals become answerable: *"what if D_max were
0.8·E_max?"* → run the constraint set on the hypothetical profile →
F1's verdict. *"which accuracy class should I pick so that n_LC = 3 000
clears the minimum?"* → INVERT lookupMPE's tier table (class C needs
n_LC ≥ … ; solve). Documents state facts about the world as written;
the model evaluates worlds as they could be.

**Example interaction:**
> Q: "My E_max is 30 000 v and I want to test to D_max = 26 000 v."
> A: VERDICT fail — d_max (26 000) < 0.9·E_max (27 000) … evaluation
>    void [R 60-1 §3.6 chain]. The minimum acceptable D_max is 27 000 v.

**Why documents can't follow:** nothing to execute; an LLM on prose
would HALLUCINATE a rule application. Containment rule: the
counterfactual probe must not be answerable by printed text.
