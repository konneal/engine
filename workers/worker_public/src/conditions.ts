// Condition-set evaluation (konneal/engine#90): the severity menus of
// the test-method packages as machine-verifiable membership. A
// condition_set node's payload.entries carry the kernel's quantity
// doctrine — value + unit inseparable, tolerance the SPECIFIED band —
// so "is 85 % RH at 40 °C a valid Test Cab severity?" computes: find
// the sets whose temperature AND relative_humidity bands admit the
// stated pair. The verdict is executed data; the model narrates it.

export interface ConditionCheck {
  quantity_kind: string;
  band: string;
  stated: number;
  in_band: boolean;
}

export interface ConditionVerdict {
  verdict: "pass" | "fail";
  matched: string[];
  nearest?: { node_id: string; distance: number; bands: string[] };
  checks: ConditionCheck[];
  note: string;
}

interface Entry {
  quantity_kind: string;
  value: string | number;
  unit: string;
  tolerance: string | number;
}

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;

/** The question's stated quantities, normalized onto the entries'
 *  quantity kinds by UNIT (degC/K → temperature; % / RH →
 *  relative_humidity; h/days → duration). Units, never words: "12
 *  months" is not a 12 h duration. */
export function quantitiesIn(query: string): Record<string, number> {
  const out: Record<string, number> = {};
  const num = (s: string) => Number(s.replace(",", "."));
  const temp = query.match(new RegExp(`(${NUM})\\s*(?:°\\s*)?(?:C\\b|degC\\b|celsius)`, "i"));
  if (temp) out.temperature = num(temp[1]!);
  const rh = query.match(new RegExp(`(${NUM})\\s*%\\s*(?:RH\\b|relative\\s+humidity)?`, "i"));
  if (rh) out.relative_humidity = num(rh[1]!);
  const hours = query.match(new RegExp(`(${NUM})\\s*h\\b`, "i"));
  if (hours) out.duration = num(hours[1]!);
  const days = query.match(new RegExp(`(${NUM})\\s*days?\\b`, "i"));
  if (days && out.duration === undefined) out.duration = num(days[1]!) * 24;
  return out;
}

function entryBand(e: Entry): { lo: number; hi: number; value: number; tolerance: number } | null {
  const value = Number(String(e.value).replace(",", "."));
  const tolerance = Number(String(e.tolerance ?? "0").replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return { value, tolerance: Number.isFinite(tolerance) ? tolerance : 0, lo: value - tolerance, hi: value + tolerance };
}

/** Evaluate ONE set: every stated quantity in-band? Sets with entries
 *  whose kind the question never states are skipped for that kind (a
 *  question stating one quantity does not fail a two-entry set). */
function scoreSet(entries: Entry[], q: Record<string, number>): { checks: ConditionCheck[]; distance: number; stated: number } | null {
  const checks: ConditionCheck[] = [];
  let distance = 0;
  let stated = 0;
  for (const e of entries) {
    const statedValue = q[e.quantity_kind];
    if (statedValue === undefined) continue;
    const band = entryBand(e);
    if (!band) continue;
    const in_band = statedValue >= band.lo && statedValue <= band.hi;
    const gap = Math.max(0, statedValue - band.hi, band.lo - statedValue);
    distance += gap / Math.max(band.tolerance, 1);
    stated += 1;
    checks.push({
      quantity_kind: e.quantity_kind,
      band: `${band.value} ${e.unit} ±${band.tolerance}`,
      stated: statedValue,
      in_band,
    });
  }
  return stated ? { checks, distance, stated } : null;
}

/** Evaluate the candidate condition_set nodes against the question's
 *  stated quantities. PASS when at least one set admits every stated
 *  quantity within its band (the set is named); FAIL names the nearest
 *  set and the violated bands. */
export function evaluateConditionSets(
  nodes: { node_id: string; content: unknown }[],
  query: string,
): ConditionVerdict | null {
  const q = quantitiesIn(query);
  const kinds = Object.keys(q);
  if (!kinds.length) return null;
  const scored: { node_id: string; checks: ConditionCheck[]; distance: number }[] = [];
  for (const n of nodes) {
    const c = (n.content && typeof n.content === "object" ? n.content : {}) as Record<string, any>;
    const payload = (c.payload ?? {}) as { role?: string; entries?: Entry[] };
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (!entries.length) continue;
    const s = scoreSet(entries, q);
    if (s) scored.push({ node_id: n.node_id, checks: s.checks, distance: s.distance });
  }
  if (!scored.length) return null;
  const matched = scored.filter((s) => s.checks.every((c) => c.in_band));
  scored.sort((a, b) => a.distance - b.distance);
  if (matched.length) {
    return {
      verdict: "pass",
      matched: matched.map((m) => m.node_id),
      checks: matched[0]!.checks,
      note: `VERDICT: PASS — the stated combination (${kinds.join(", ")}) matches severity set(s) ${matched.map((m) => m.node_id).join(", ")}. Present this verdict and cite the set's clause.`,
    };
  }
  const nearest = scored[0]!;
  return {
    verdict: "fail",
    matched: [],
    nearest: { node_id: nearest.node_id, distance: Number(nearest.distance.toFixed(2)), bands: nearest.checks.map((c) => c.band) },
    checks: scored[0]!.checks,
    note: `VERDICT: FAIL — no severity set admits the stated combination. The nearest set is ${nearest.node_id} (bands: ${nearest.checks.map((c) => c.band).join("; ")}). Say the combination is outside the menu and name the nearest set; never soften it.`,
  };
}
