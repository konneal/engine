// Condition-set evaluation (konneal/engine#90): the severity menus of
// the test-method packages as machine-verifiable membership. A
// condition_set node's payload.entries carry the kernel's quantity
// doctrine — value + unit inseparable, tolerance the SPECIFIED band —
// and each entry resolves to SI through the package's own quantity
// register (the export ships si { value, unit }). The stated quantities
// normalize through the same SI targets, so 313 K and 40 °C are the
// same stated temperature.

export interface ConditionCheck {
  quantity_kind: string;
  band: string;
  stated: number;
  stated_unit: string;
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
  si?: { value: number; unit: string };
}

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;

/** The question's stated quantities with their SI normalization
 *  (temperature → K, relative_humidity → the ratio unit, duration → s).
 *  Units, never words: "12 months" is not a 12 h duration. */
export function quantitiesIn(query: string): Record<string, { stated: number; stated_unit: string; si: number }> {
  const out: Record<string, { stated: number; stated_unit: string; si: number }> = {};
  const num = (s: string) => Number(s.replace(",", "."));
  const put = (kind: string, stated: number, stated_unit: string, si: number) => {
    if (Number.isFinite(si)) out[kind] = { stated, stated_unit, si };
  };
  const tempC = query.match(new RegExp(`(${NUM})\\s*(?:°\\s*)?C\\b`));
  if (tempC) put("temperature", num(tempC[1]!), "degC", num(tempC[1]!) + 273.15);
  const tempK = query.match(new RegExp(`(${NUM})\\s*K\\b`));
  if (tempK && out.temperature === undefined) put("temperature", num(tempK[1]!), "K", num(tempK[1]!));
  const rh = query.match(new RegExp(`(${NUM})\\s*%\\s*(?:RH\\b|relative\\s+humidity)?`, "i"));
  if (rh) put("relative_humidity", num(rh[1]!), "%", num(rh[1]!) / 100);
  const hours = query.match(new RegExp(`(${NUM})\\s*h\\b`, "i"));
  if (hours) put("duration", num(hours[1]!), "h", num(hours[1]!) * 3600);
  const days = query.match(new RegExp(`(${NUM})\\s*days?\\b`, "i"));
  if (days && out.duration === undefined) put("duration", num(days[1]!), "d", num(days[1]!) * 86400);
  return out;
}

interface SiEntry {
  quantity_kind: string;
  unit: string;
  tolerance: string | number;
  si: { value: number; unit: string };
}

/** Evaluate ONE set: every stated quantity's SI value inside the
 *  entry's SI band (the tolerance converts with the factor, never the
 *  offset — a difference has no affine part). */
function scoreSet(entries: (Entry | SiEntry)[], q: Record<string, { stated: number; stated_unit: string; si: number }>): { checks: ConditionCheck[]; distance: number; stated: number } | null {
  const checks: ConditionCheck[] = [];
  let distance = 0;
  let stated = 0;
  for (const e of entries) {
    const siEntry = e as SiEntry;
    const statedQ = q[e.quantity_kind];
    if (!statedQ || !siEntry?.si) continue;
    const tol = Number(String(siEntry.tolerance ?? "0").replace(",", "."));
    const tolSi = (Number.isFinite(tol) ? tol : 0) * (siEntry.si.unit === "K" ? 1 : siEntry.si.unit === "1" ? 0.01 : 1);
    const in_band = statedQ.si >= siEntry.si.value - tolSi && statedQ.si <= siEntry.si.value + tolSi;
    const gap = Math.max(0, statedQ.si - (siEntry.si.value + tolSi), siEntry.si.value - tolSi - statedQ.si);
    distance += gap / Math.max(tolSi, 1);
    stated += 1;
    checks.push({
      quantity_kind: e.quantity_kind,
      band: `${siEntry.si.value} ${siEntry.si.unit} ±${tolSi}`,
      stated: statedQ.stated,
      stated_unit: statedQ.stated_unit,
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
    const payload = (c.payload ?? {}) as { entries?: (Entry | SiEntry)[] };
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
      note: `VERDICT: PASS — the stated combination (${kinds.join(", ")}) matches a severity set (${matched[0]!.checks.map((c) => c.band).join("; ")}). Present this verdict and cite the set's clause. The machine set identifier rides the verdict block as data — never write it in your prose.`,
    };
  }
  const nearest = scored[0]!;
  return {
    verdict: "fail",
    matched: [],
    nearest: { node_id: nearest.node_id, distance: Number(nearest.distance.toFixed(2)), bands: nearest.checks.map((c) => c.band) },
    checks: nearest.checks,
    note: `VERDICT: FAIL — no severity set admits the stated combination. The nearest set (bands: ${nearest.checks.map((c) => c.band).join("; ")}) is the closest match. Say the combination is outside the menu and describe the nearest set's bands; never soften it. The machine set identifier rides the verdict block as data — never write it in your prose.`,
  };
}
