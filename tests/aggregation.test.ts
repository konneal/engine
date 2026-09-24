import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAggregation } from "../workers/worker_public/src/aggregation.ts";

// the production payloads, verbatim from D1 model_nodes (oiml-r60, oiml-r91)
const stabilisation = {
  node_id: "/table/loading_stabilisation_times",
  content: {
    name: "Combined loading and stabilisation times to be achieved prior to reading (R 60-2, Table 1)",
    payload: {
      columns: [
        { name: "load_change_gt", type: "number", unit: "kg" },
        { name: "load_change_max", type: "number", unit: "kg" },
        { name: "class_cd", type: "integer", unit: "s" },
        { name: "class_b", type: "integer", unit: "s" },
        { name: "class_a", type: "integer", unit: "s" },
      ],
      rows: [
        ["0", "10", "10", "15", "20"],
        ["10", "100", "20", "30", "40"],
        ["100", "1000", "30", "45", "60"],
        ["1000", "10000", "40", "60", "80"],
        ["10000", "100000", "50", "75", "100"],
        ["100000", "null", "60", "90", "120"],
      ],
    },
  },
};

const mpeMoving = {
  node_id: "/table/mpe_moving",
  content: {
    name: "MPE for moving measurements per class (R 91-1, 6.15.1)",
    payload: {
      columns: [
        { name: "metrological_class", type: "string" },
        { name: "speed_min", type: "number", unit: "km/h" },
        { name: "speed_max", type: "number", unit: "km/h" },
        { name: "mpe_factor", type: "number" },
        { name: "mode", type: "string" },
      ],
      rows: [
        ["A", "0", "100", "3", "absolute"],
        ["A", "100", "null", "0.03", "relative"],
        ["B", "0", "100", "7", "absolute"],
        ["B", "100", "null", "0.07", "relative"],
      ],
    },
  },
};

const mpeTiers = {
  node_id: "/table/mpe_tiers",
  content: {
    name: "MPE tier breakpoints per accuracy class (R 60-1, Table 4)",
    payload: {
      columns: [
        { name: "accuracy_class", type: "string" },
        { name: "load_min", type: "number", unit: "v" },
        { name: "load_max", type: "number", unit: "v" },
        { name: "limit_factor", type: "number" },
      ],
      rows: [
        ["A", "0", "50000", "0.5"],
        ["A", "50000", "200000", "1"],
        ["A", "200000", "null", "1.5"],
        ["B", "0", "5000", "0.5"],
        ["B", "5000", "20000", "1"],
        ["B", "20000", "null", "1.5"],
        ["C", "0", "500", "0.5"],
        ["C", "500", "2000", "1"],
        ["C", "2000", "null", "1.5"],
        ["D", "0", "50", "0.5"],
        ["D", "50", "200", "1"],
        ["D", "200", "null", "1.5"],
      ],
    },
  },
};

test("lookup, class as column: 500 kg change, class C → 30 s (interval 100 < 500 ≤ 1000)", () => {
  const v = evaluateAggregation([stabilisation], "After a 500 kg load change, how long must a class C load cell stabilise before the reading per OIML R 60?");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 30);
  assert.equal(v?.unit, "s");
  assert.equal(v?.row?.class_cd, "30");
});

test("interval boundary belongs to the lower (a,b] row: 10 kg → (0,10], 100 kg → (10,100]", () => {
  const v10 = evaluateAggregation([stabilisation], "After a 10 kg load change, how long must a class D load cell stabilise per OIML R 60?");
  assert.equal(v10?.value, 10);
  const v100 = evaluateAggregation([stabilisation], "After a 100 kg load change, how long must a class D load cell stabilise per OIML R 60?");
  assert.equal(v100?.value, 20);
});

test("lookup, class as row value: class B at 120 km/h → 0.07 relative", () => {
  const v = evaluateAggregation([mpeMoving], "What is the MPE for a class B road vehicle measuring at 120 km/h?");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 0.07);
  assert.equal(v?.row?.mode, "relative");
});

test("lookup with thousands grouping: 1,000 kg parses as 1000 and stays in (100, 1000]", () => {
  const v = evaluateAggregation([stabilisation], "After a 1,000 kg load change, what stabilisation time applies for class B?");
  assert.equal(v?.value, 45);
});

test("count distinct: accuracy classes in R 60-1 Table 4", () => {
  const v = evaluateAggregation([mpeTiers], "How many accuracy classes does OIML R 60-1 define?");
  assert.equal(v?.operation, "count");
  assert.equal(v?.value, 4);
  assert.equal(v?.column, "accuracy_class");
});

test("count rows when no class column is named", () => {
  const v = evaluateAggregation([mpeMoving], "How many MPE rows does the moving table have?");
  assert.equal(v?.operation, "count");
  assert.equal(v?.value, 4);
});

test("min over a class column: shortest class B stabilisation time", () => {
  const v = evaluateAggregation([stabilisation], "What is the shortest stabilisation time for a class B load cell?");
  assert.equal(v?.operation, "min");
  assert.equal(v?.column, "class_b");
  assert.equal(v?.value, 15);
  assert.equal(v?.unit, "s");
});

test("max over a class column: longest class A stabilisation time (open top row included)", () => {
  const v = evaluateAggregation([stabilisation], "What is the longest stabilisation time for a class A load cell?");
  assert.equal(v?.value, 120);
});

test("several tables: table-name scoring picks mpe_moving, not mpe_tiers", () => {
  const v = evaluateAggregation([mpeTiers, mpeMoving], "What is the MPE factor for a class A moving measurement at 150 km/h?");
  assert.equal(v?.table, "/table/mpe_moving");
  assert.equal(v?.value, 0.03);
});

test("ambiguous across many unscored tables: refuse rather than guess", () => {
  const v = evaluateAggregation([mpeTiers, mpeMoving], "What is the value?");
  assert.equal(v, null);
});

test("the stated unit and class beat a title-word tie: 500 kg class C picks the stabilisation table (live regression)", () => {
  const v = evaluateAggregation([mpeTiers, stabilisation], "After a 500 kg load change, how long must a class C load cell stabilise before the reading, per OIML R 60?");
  assert.equal(v?.table, "/table/loading_stabilisation_times");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 30);
  assert.equal(v?.unit, "s");
});

test("no aggregation intent matchable: no verdict", () => {
  assert.equal(evaluateAggregation([stabilisation], "What is damp heat?"), null);
});
