// The verdict engine (TODO.era3/01): deterministic evaluation of the
// model plane's machine-checkable objects — OCL boolean checks over
// dotted parameter paths and structured threshold limits. The worker
// computes; the model narrates. No eval, no network, linear parse.
//
// Verdict vocabulary: "pass" when every check holds; the node's own
// on_violation word ("invalid"/"void") when any fails; "void" plus the
// missing parameter names when the question does not state enough —
// honest degradation, never a guess.

export interface MachineCheck {
  expression: string;
  symbolic: string;
  values: Record<string, number>;
  result: boolean | null; // null: could not evaluate (missing params)
}

export interface Verdict {
  verdict: "pass" | "fail" | "void";
  on_violation?: string;
  violation_meaning?: string;
  missing: string[];
  /** why a fully-stated question still cannot evaluate (TODO.sota/04):
   *  the stated quantities' units carry conflicting dimensions */
  void_reason?: string;
  checks: MachineCheck[];
}

// ── a tiny safe expression parser ─────────────────────────────────────
// grammar: or := and ("or" and)* ; and := not (("and")? not)*  [juxtaposition]
//          not := "not" not | cmp ; cmp := add ((">="|"<="|">"|"<"|"=="|"!=") add)?
//          add := mul (("+"|"-") mul)* ; mul := unary (("*"|"/") unary)*
//          unary := "-" unary | atom ; atom := number | ident | "(" or ")"
type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const s = src.replace(/\s+/g, " ");
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^[0-9]*\.?[0-9]+/)!;
      toks.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/)!;
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/()<>".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`bad char ${c!}`);
  }
  return toks;
}

function parseAndEval(src: string, params: Record<string, number>): boolean | number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => { const t = toks[p++]; if (v && (!t || t.t !== "op" || t.v !== v)) throw new Error(`expected ${v}`); return t; };
  const isKw = (k: string) => { const t = peek(); return t && t.t === "id" && t.v.toLowerCase() === k; };

  function or(): boolean | number {
    let l = and();
    while (isKw("or")) { p++; const r = and(); l = truthy(l) || truthy(r); }
    return l;
  }
  function and(): boolean | number {
    let l = not();
    while (isKw("and")) { p++; const r = not(); l = truthy(l) && truthy(r); }
    return l;
  }
  function not(): boolean | number {
    if (isKw("not")) { p++; return !truthy(not()); }
    return cmp();
  }
  function cmp(): boolean | number {
    const l = add();
    const t = peek();
    if (t && t.t === "op" && [">=", "<=", ">", "<", "==", "!="].includes(t.v)) {
      p++;
      const r = add();
      switch (t.v) {
        case ">=": return num(l) >= num(r);
        case "<=": return num(l) <= num(r);
        case ">": return num(l) > num(r);
        case "<": return num(l) < num(r);
        case "==": return num(l) === num(r);
        default: return num(l) !== num(r);
      }
    }
    return l;
  }
  function add(): boolean | number {
    let l = mul();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) { p++; const r = mul(); l = t.v === "+" ? num(l) + num(r) : num(l) - num(r); }
      else return l;
    }
  }
  function mul(): boolean | number {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/")) { p++; const r = unary(); l = t.v === "*" ? num(l) * num(r) : num(l) / num(r); }
      else return l;
    }
  }
  function unary(): boolean | number {
    const t = peek();
    if (t && t.t === "op" && t.v === "-") { p++; return -num(unary()); }
    return atom();
  }
  function atom(): boolean | number {
    const t = eat();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "id") {
      if (params[t.v] !== undefined) return params[t.v];
      throw new Error(`missing ${t.v}`);
    }
    if (t.v === "(") { const v = or(); eat(")"); return v; }
    throw new Error(`unexpected ${t.v}`);
  }
  const truthy = (v: boolean | number) => (typeof v === "boolean" ? v : v !== 0);
  const num = (v: boolean | number) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

  const out = or();
  if (p !== toks.length) throw new Error("trailing tokens");
  return out;
}

// ── the node's machine checks ─────────────────────────────────────────

function oclBody(s: string): string | null {
  const m = String(s ?? "").match(/ocl\{([\s\S]*?)\}/);
  return m ? m[1]!.trim() : null;
}

export function extractChecks(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const c = content as Record<string, any>;
  const out: string[] = [];
  const push = (e?: string) => { const b = e && oclBody(e); if (b) out.push(b); };
  push(c.check);
  // the plain oiml-r60 projection carries the OCL under `expression`
  // (the r60-lml projection under `check`) — the dead-load geometry
  // nodes bound for their whole life and evaluated to null because
  // their only check sat under the key nobody read
  push(c.expression);
  push(c.limit?.expression);
  push(c.acceptance_criteria?.limit && !c.acceptance_criteria.limit.expression?.includes("ocl{") ? null : c.acceptance_criteria?.limit?.expression);
  // structured threshold limits compile to a comparison expression
  const st = c.acceptance_criteria?.limit;
  if (st?.expression && st.operator && st.threshold_expression) {
    out.push(`${st.expression} ${st.operator} ${st.threshold_expression}`);
  }
  return [...new Set(out)];
}

export function symbolsIn(checks: string[]): string[] {
  const ids = new Set<string>();
  const KEYWORDS = new Set(["and", "or", "not"]);
  for (const chk of checks) {
    try {
      for (const t of tokenize(chk)) if (t.t === "id" && !KEYWORDS.has(t.v.toLowerCase())) ids.add(t.v);
    } catch {
      // unparseable check: no symbols extractable
    }
  }
  return [...ids];
}

/** Grounded parameter extraction: the node's OWN symbols only. Each
 *  symbol's leaf (d_max) or full spelling (D_max) followed by a number
 *  in the question text binds the value. A closed symbol set from the
 *  model plane — meaning never comes from string matching. */
function parseNumber(raw: string): number {
  // strip spaces/commas; a lone dot before exactly 3 final digits is a
  // thousands separator (metrology magnitudes; decimals like 0.9 keep
  // their meaning)
  let s = raw.replace(/[ ,]/g, "");
  s = s.replace(/\.(\d{3})$/, "$1");
  return Number(s.replace(/,(?=\d{3}\b)/g, ""));
}

export function extractParams(query: string, symbols: string[]): Record<string, number> {
  return extractParamsWithUnits(query, symbols).values;
}

/** The stated values WITH their unit tokens (TODO.sota/04's unit
 *  semantics): "E_max 30000 v" binds e_max=30000 and the unit "v" —
 *  the dimension check needs both. */
export function extractParamsWithUnits(
  query: string,
  symbols: string[],
): { values: Record<string, number>; units: Record<string, string> } {
  const values: Record<string, number> = {};
  const units: Record<string, string> = {};
  for (const sym of symbols) {
    const leaf = sym.split(".").pop() ?? sym;
    const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // symbol, a short non-numeric gap (words like "were"/"of" allowed),
    // then the number, then an optional unit token directly after
    const re = new RegExp(`\\b${esc}\\b\\D{0,14}?([0-9][0-9 ,.]*[0-9])\\s*(%|\\u00b0?[A-Za-z\\u00b5\\u03a9]{0,6})?`, "iu");
    const m = query.match(re);
    if (m) {
      const v = parseNumber(m[1]!);
      if (Number.isFinite(v)) {
        values[sym] = v;
        const u = (m[2] ?? "").trim();
        if (u) units[sym] = u;
      }
    }
  }
  return { values, units };
}

/** Dimension coherence (TODO.sota/04 item 2): the units plane gives
 *  each unit token a dimension; a parameter set whose bound symbols
 *  carry CONFLICTING known dimensions is incoherent — the check
 *  compares quantities that are not comparable. Pure: the dimensions
 *  map arrives from the caller (the units register at load). */
export function dimensionMismatch(
  check: string,
  units: Record<string, string>,
  dimensions: Record<string, string>,
): string | null {
  // the symbols THIS check compares, each mapped through its stated
  // unit's dimension; more than one distinct dimension in one
  // comparison is incoherent (a length is not a voltage)
  const dims = new Map<string, string>();
  for (const [sym, unit] of Object.entries(units)) {
    const leaf = sym.split(".").pop();
    if (!leaf || !new RegExp(`\\b${leaf}\\b`, "i").test(check)) continue;
    const dim = dimensions[unit.toLowerCase()];
    if (dim) dims.set(sym, dim);
  }
  const distinct = [...new Set(dims.values())];
  if (distinct.length <= 1) return null;
  const parts = [...dims.entries()].map(([sym, dim]) => `${sym} is in ${dim}`);
  return `the stated quantities mix dimensions: ${parts.join(" while ")}`;
}

export function evaluate(content: unknown, query: string, opts?: { dimensions?: Record<string, string> }): Verdict | null {
  const c = (content && typeof content === "object" ? content : {}) as Record<string, any>;
  const checks = extractChecks(content);
  if (!checks.length) return null;
  const symbols = symbolsIn(checks);
  const bound = extractParamsWithUnits(query, symbols);
  const params = bound.values;
  const missing = symbols.filter((s) => params[s] === undefined);
  let voidReason: string | null = null;
  const machine: MachineCheck[] = checks.map((expression) => {
    const values: Record<string, number> = {};
    try {
      for (const t of tokenize(expression)) if (t.t === "id" && params[t.v] !== undefined) values[t.v] = params[t.v];
    } catch { /* values stay partial */ }
    let result: boolean | null = null;
    if (missing.length === 0) {
      // unit semantics (TODO.sota/04): a comparison mixing dimensions
      // cannot evaluate — void with the reason, never a number answer
      const mismatch = opts?.dimensions ? dimensionMismatch(expression, bound.units, opts.dimensions) : null;
      if (mismatch) {
        voidReason = voidReason ?? mismatch;
      } else {
        try { result = !!parseAndEval(expression, params); } catch { result = null; }
      }
    }
    return { expression, symbolic: expression, values, result };
  });
  if (missing.length) {
    return { verdict: "void", missing, checks: machine };
  }
  const failed = machine.some((m) => m.result === false);
  const evaluable = machine.some((m) => m.result !== null);
  if (!evaluable) {
    if (voidReason) return { verdict: "void", missing: [], void_reason: voidReason, checks: machine };
    return null;
  }
  return {
    verdict: failed ? "fail" : "pass",
    on_violation: failed ? String(c.on_violation ?? "invalid") : undefined,
    violation_meaning: failed ? (typeof c.violation_meaning === "string" ? c.violation_meaning : undefined) : undefined,
    missing: [],
    checks: machine,
  };
}

/** The deterministic note the answer model narrates — never recomputes. */
export function verdictNote(v: Verdict, node: { node_id: string; clause?: { urn?: string } | null }): string {
  const lines = [
    `Machine verdict (deterministic evaluation of node ${node.node_id}${node.clause?.urn ? `, ${node.clause.urn}` : ""}) — the service EXECUTED the node's machine check against the values stated in the question:`,
  ];
  for (const c of v.checks) {
    const vals = Object.entries(c.values).map(([k, n]) => `${k}=${n}`).join(", ");
    lines.push(`- ${c.expression}${vals ? `  [${vals}]` : ""} → ${c.result === null ? "not evaluated" : c.result ? "holds" : "VIOLATED"}`);
  }
  if (v.verdict === "void") {
    lines.push(v.void_reason
      ? `VERDICT: VOID — ${v.void_reason}. State the mismatch plainly; the question cannot be decided as stated.`
      : `VERDICT: VOID — the question does not state: ${v.missing.join(", ")}. Say exactly what is missing; never assume values.`);
  } else if (v.verdict === "pass") {
    lines.push(`VERDICT: PASS — every machine check holds at the stated values. Present this verdict, the arithmetic above, and cite the node's clause.`);
  } else {
    lines.push(`VERDICT: ${String(v.on_violation ?? "FAIL").toUpperCase()} — a machine check is violated. Present this verdict, the arithmetic, the violation meaning verbatim, and cite the node's clause.`);
  }
  lines.push("This verdict is computed data — quote it faithfully; do not recompute, soften, or contradict it.");
  return lines.join("\n");
}
