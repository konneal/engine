# L1 — EXTRACT (P1–P2)

**Definition:** return a normative value VERBATIM from prose — no
disambiguation beyond finding the sentence.

**Example** — *"Quote the note that governs which p_LC value the creep
MPE must use."*
Witness (real, from notes.yaml): "p_LC = 0.7" AND the qualifier
"regardless of any value declared by the manufacturer"
(note_creep_plc_always_0_7 — see also F10: this note is an OVERRIDE in
the model, prose everywhere else).

**Example** — *"What validity date does the current R 60 edition carry?"*
Witness: "2021-01-01" (standard.yaml edition.validity.from — P2
provenance makes this trivial in D, findable in C via the registry).

Lane expectations: all pass; separation is noise-level. L1 exists to
calibrate the harness's regex discipline before structure matters.
