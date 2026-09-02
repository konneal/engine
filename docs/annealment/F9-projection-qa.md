# F9 — Document-as-projection verification

**Powering objects:** documents/{1,2,3,a}/document.presentation.xml —
the model CARRIES its own rendered document projections per part.

**The win:** publishing QA becomes a query. *"Does the published
R 60-1 Table 4 match the model's mpe_tiers?"* → parse the projection's
table, compare cell-by-cell against the model's typed table → a
diff-and-verdict. The direction inverts: instead of the document being
the source the model was derived from, the MODEL becomes the source and
the document a VIEW to be verified. Forward: model → document
GENERATION (the view rendered FROM truth, drift structurally
impossible).

**Why it matters:** every standards body's dirty secret is render drift
(errata). Projection QA makes errata a computable diff. And it is the
on-ramp to the fully closed loop: author → model → verified document.
