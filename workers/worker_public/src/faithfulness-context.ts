// The dependency-free core of the faithfulness grounding (node-loadable
// for unit tests — the verdict-parse law; faithfulness.ts imports the
// bundled prompt and cannot load under node). The [M] family is this
// service's own machine-computed model data: a machine-grounded answer
// quotes it legitimately, so the judge must see it.

export function buildJudgeContext(
  passages: (string | { text: string; table?: boolean })[],
  machine: string[] = [],
): string {
  const context = passages
    .slice(0, 8)
    .map((p, i) => {
      const text = typeof p === "string" ? p : p.text;
      // a table's evidence lives across its whole row set — a truncated
      // table hides the very rows the answer computed from
      const limit = typeof p !== "string" && p.table ? 2400 : 1400;
      return `[${i + 1}] ${text.replace(/\s+/g, " ").slice(0, limit)}`;
    })
    .join("\n");
  const machineContext = machine.length
    ? "\n" + machine.slice(0, 6).map((m) => `[M] ${m.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")
    : "";
  return context + machineContext;
}
