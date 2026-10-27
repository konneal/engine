// The decision pass core (TODO.decisions/01): requirement-shaped
// questions are answered as CHECKLISTS, not essays. Pure and
// dependency-free — the I/O orchestrator (decisionWire.ts) calls these
// with the model outputs; everything here is deterministic and
// node-testable. Every failure of the live pass degrades to the essay
// answer; nothing in this module can break an ask.

export interface DerivedRequirement {
  text: string;
  clause: string;
}

export interface DecisionItem {
  text: string;
  clause: string;
  band: "met" | "not-met" | "unclear";
  probability: number;
}

export type DecisionMode = "check" | "list";

/** Parse the derivation model's reply: JSON with
 *  {mode: "check"|"list", requirements: [{text, clause}]}.
 *  Tolerant of prose around the JSON, of trailing commas-free objects,
 *  and of missing clauses (empty string). Returns [] when nothing
 *  sane survives — the pass then stands down. */
export function parseDerivation(text: string | null | undefined, cap: number): {
  mode: DecisionMode;
  requirements: DerivedRequirement[];
} {
  const fallback = { mode: "list" as DecisionMode, requirements: [] as DerivedRequirement[] };
  if (!text) return fallback;
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return fallback;
  }
  const reqs = Array.isArray(parsed?.requirements) ? parsed.requirements : [];
  const requirements: DerivedRequirement[] = [];
  for (const r of reqs) {
    const t = typeof r?.text === "string" ? r.text.trim() : "";
    if (t.length < 8) continue;
    requirements.push({ text: t.slice(0, 300), clause: typeof r?.clause === "string" ? r.clause.trim().slice(0, 40) : "" });
    if (requirements.length >= cap) break;
  }
  if (!requirements.length) return fallback;
  const mode: DecisionMode = parsed?.mode === "check" ? "check" : "list";
  return { mode, requirements };
}

/** Build the Clef questions map from the derived requirements. In
 *  "check" mode each requirement becomes a noul (met-or-not given the
 *  user's stated values); in "list" mode a noul on whether the
 *  requirement is genuinely stated in the corpus text. */
export function buildDecisionQuestions(
  mode: DecisionMode,
  requirements: DerivedRequirement[],
  userQuestion: string,
  statedValues: string,
): Record<string, { type: "noul"; instructions: string; criteria?: { true: string; false: string } }> {
  const questions: Record<string, { type: "noul"; instructions: string; criteria?: { true: string; false: string } }> = {};
  requirements.forEach((r, i) => {
    const id = `r${i + 1}`;
    if (mode === "check") {
      questions[id] = {
        type: "noul",
        instructions:
          `Requirement: "${r.text}" (clause ${r.clause || "n/a"}). ` +
          `The user asks: "${userQuestion}". ` +
          `Stated values: ${statedValues || "(none stated — judge whether the state text answers it)"}. ` +
          `Is this requirement met, based only on what the state contains?`,
        criteria: {
          true: "the state shows the requirement is satisfied",
          false: "the state shows it is not satisfied, or the state says nothing about it",
        },
      };
    } else {
      questions[id] = {
        type: "noul",
        instructions: `Is this a genuine, self-contained requirement statement: "${r.text}"?`,
        criteria: {
          true: "a real requirement a reader could check",
          false: "a fragment, duplicate, or not a requirement",
        },
      };
    }
  });
  return questions;
}

export function bandFor(p: number, metBand: number, refuteBand: number): DecisionItem["band"] {
  if (p >= metBand) return "met";
  if (p <= refuteBand) return "not-met";
  return "unclear";
}

/** Match the Clef answers (keyed r1..rN) back onto the requirements and
 *  band them. Unmatched/missing answers drop (absence is honest). */
export function matchAnswers(
  mode: DecisionMode,
  requirements: DerivedRequirement[],
  answers: Record<string, any>,
  metBand: number,
  refuteBand: number,
): DecisionItem[] {
  const items: DecisionItem[] = [];
  requirements.forEach((r, i) => {
    const a = answers[`r${i + 1}`];
    let probability: number;
    if (a && a.type === "noul" && typeof a.noul === "number") {
      probability = a.noul;
    } else if (a && typeof a === "number") {
      probability = a;
    } else {
      return;
    }
    if (probability < 0 || probability > 1) return;
    items.push({
      text: r.text,
      clause: r.clause,
      band: mode === "check" ? bandFor(probability, metBand, refuteBand) : "met",
      probability: Math.round(probability * 100) / 100,
    });
  });
  return items;
}

const MARK: Record<DecisionItem["band"], string> = { met: "✓", "not-met": "✗", unclear: "?" };
const WORD: Record<DecisionItem["band"], string> = { met: "met", "not-met": "not met", unclear: "not clearly stated" };

/** The deterministic checklist section appended to the answer. The
 *  model never writes this — the server composes it from the decisions. */
export function assembleSection(mode: DecisionMode, items: DecisionItem[]): string {
  if (!items.length) return "";
  const title = mode === "check" ? "Requirements check (automated)" : "Requirements (from the cited clauses)";
  const lines = items.map((it) => {
    const mark = mode === "check" ? MARK[it.band] : "•";
    const clause = it.clause ? ` — ${it.clause}` : "";
    const prob = mode === "check" ? ` (${Math.round(it.probability * 100)}%)` : "";
    return `- ${mark} ${it.text}${clause}${prob}${mode === "check" ? ` — ${WORD[it.band]}` : ""}`;
  });
  return `\n\n${title}:\n${lines.join("\n")}`;
}
