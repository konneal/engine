// Judge-verdict extraction, kept free of the prompt import so plain
// node can load it for unit tests.
export interface Verdict {
  score: number; // 0-1, clamped
  ungrounded_claims: string[];
}

function coerceVerdict(obj: unknown): Verdict | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const raw = (obj as { score?: unknown }).score;
  const score = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(score)) return null;
  const claims = (obj as { ungrounded_claims?: unknown }).ungrounded_claims;
  return {
    score: Math.max(0, Math.min(1, score)),
    ungrounded_claims: Array.isArray(claims) ? claims.map(String).slice(0, 5) : [],
  };
}

// Reasoning models emit drafts, prose, fenced blocks, and several {...}
// fragments before the verdict; the verdict is the LAST well-formed
// object carrying a numeric score. Braces can also appear INSIDE claim
// strings, so the scan tracks string state instead of regexing flat
// objects (the flat scan silently missed those shapes live).
export function parseVerdict(text: string): Verdict | null {
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  try {
    const whole = coerceVerdict(JSON.parse(stripped));
    if (whole) return whole;
  } catch {
    // not one JSON document — scan candidates
  }
  let verdict: Verdict | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) { escaped = false; continue; }
    if (inString && ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const v = coerceVerdict(JSON.parse(stripped.slice(start, i + 1)));
          if (v) verdict = v;
        } catch {
          // malformed candidate — keep scanning
        }
      }
    }
  }
  return verdict;
}
