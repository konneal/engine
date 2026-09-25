// The dependency-free core of the faithfulness grounding (node-loadable
// for unit tests — the verdict-parse law; faithfulness.ts imports the
// bundled prompt and cannot load under node). The [M] family is this
// service's own machine-computed model data: a machine-grounded answer
// quotes it legitimately, so the judge must see it.

export function buildJudgeContext(passages: string[], machine: string[] = []): string {
  const context = passages
    .slice(0, 8)
    .map((p, i) => `[${i + 1}] ${p.replace(/\s+/g, " ").slice(0, 900)}`)
    .join("\n");
  const machineContext = machine.length
    ? "\n" + machine.slice(0, 6).map((m) => `[M] ${m.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")
    : "";
  return context + machineContext;
}
