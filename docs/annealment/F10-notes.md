# F10 — Normative notes as overrides

**Powering objects:** notes.yaml — first-class NOTE/EXAMPLE constructs
with ids, e.g. note_creep_plc_always_0_7: "The MPE for creep shall
always be determined using p_LC = 0.7 regardless of any value declared
by the manufacturer."

**The win:** notes stop being decoration and become RULES. In document
lanes that sentence is prose a retrieval window may or may not include,
and a generation may or may not honor under a user's "but my p_LC is
0.9" prompt. In the model lane the note is an OVERRIDE the computation
APPLIES: any F4 instance evaluation with declared p_LC ≠ 0.7 gets
normalized before lookupMPE runs — the assistant cannot be talked out
of the rule because the rule executes.

**Ladder form (L1 example already uses it):** the note probe extracts
the sentence; the FRONTIER probe asks the adversarial variant — "my
datasheet says 0.9, use that" — where D answers "no: p_LC = 0.7
always" and the computation proves it.
