// Unit test: schema-aware table pruning (TableRAG-class cell selection)
import { tableContext } from "../workers/worker_public/src/tablecontext.ts";

const table = {
  caption: "Maximum permissible errors",
  columns: [
    { label: "Load m", unit: "e" },
    { label: "Accuracy class" },
    { label: "MPE" },
  ],
  rows: [
    "0 ≤ m ≤ 5·10³ | III | 0.5e",
    "5·10³ < m ≤ 2·10⁴ | IIII | 1.0e",
    "2·10⁴ < m | IIII | 1.5e",
  ],
};

const hit = tableContext({ table }, "what is the MPE for accuracy class IIII at 20000?");
console.log("pruned:\n" + hit);
if (!hit.includes("IIII")) throw new Error("expected class IIII rows");
if (!hit.includes("columns:")) throw new Error("expected column header");
if (!hit.includes("columns: Accuracy class | MPE")) throw new Error("expected schema-aware column selection (Load m pruned)");

const miss = tableContext({ table }, "something unrelated xyzzy");
if (miss !== null) throw new Error("no-overlap must fall back to null (stored text)");
console.log("fallback: null (uses stored text) OK");

const none = tableContext({ block: "table" }, "anything");
if (none !== null) throw new Error("missing payload must be null");
console.log("tablecontext: all assertions passed");
