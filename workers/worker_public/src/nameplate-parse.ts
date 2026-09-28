// The nameplate bridge's pure half (TODO.new-era/6's image lane): parse
// the vision call's answer into {manufacturer, model}. Lives apart from
// the AI-call module so the plain-node suites can exercise it (the
// prompt is a bundled .md, which only esbuild can load).

export interface Nameplate {
  manufacturer: string | null;
  model: string | null;
}

export function parseNameplate(text: string): Nameplate | null {
  const m = /\{[^{}]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { manufacturer?: unknown; model?: unknown };
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
    const out = { manufacturer: clean(j.manufacturer), model: clean(j.model) };
    return out.manufacturer || out.model ? out : null;
  } catch {
    return null;
  }
}

/** The register query the extraction feeds: the nameplate's tokens lead,
 *  the question's family (if named) scopes. */
export function nameplateRegisterQuery(np: Nameplate, question: string): string {
  const fam = /\b([RDMB])\s?-?(\d{2,3})\b/i.exec(question);
  return [np.manufacturer, np.model, fam ? `${fam[1]} ${fam[2]}` : null].filter(Boolean).join(" ");
}
