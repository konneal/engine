// The entailment gate's pure verdict mapper (TODO.new-era/10): what the
// confidence line says once the claims were measured against the
// passages they cite. Lives apart from faithfulness.ts so the unit
// suites (plain node, no esbuild .md loader) can exercise it.

export interface EntailmentVerdict {
  support: "supported" | "partial" | "unsupported";
  note: string;
}

export function entailmentVerdict(score: number, supportedFloor: number, partialFloor: number): EntailmentVerdict {
  if (score >= supportedFloor) return { support: "supported", note: "" };
  if (score >= partialFloor) return { support: "partial", note: "Partially grounded — some claims lack support in the cited passages; verify against the cited clauses." };
  return { support: "unsupported", note: "WARNING: This answer's claims are largely unsupported by the retrieved passages. Verify against official publications." };
}
