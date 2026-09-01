# F4 — Instance-grounded, parameterized answers

**Powering objects:** attributes with `scope: family|instance` and
`origin`, entities/load-cell-instance.yaml (serial, type ref),
sample-data.yaml, the unit register for input normalization.

**The win:** the corpus answers FOR YOUR INSTRUMENT. The MPE table
stops being a table to read and becomes a FUNCTION to evaluate:

> Q (member): "Model LC-3000, Max 30 kg, e 5 g, class C — my MPE at
>  12 kg load?" → lookupMPE(load=2400 v, class C) → ±0.35·v … with the
> full clause chain and the unit register normalizing whatever units
> the user typed (kgf, kN, lb) before computing (quantity-kind
  coherence, never string matching).

**Tiering:** instance data is member/internal by default; sample data
is public. **Why documents can't follow:** there are no instances in a
document — only the general case. This is the personalization rung.
