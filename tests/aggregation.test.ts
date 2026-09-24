import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAggregation } from "../workers/worker_public/src/aggregation.ts";

// synthetic fixtures — the shapes here are the engine's own contract
// (typed columns, per-column units, string rows, half-open interval
// pairs); no deployment data. Interval rows follow the (a,b] convention
// with "null" as the open top.
const soak = {
  node_id: "/table/soak_windows",
  content: {
    name: "Combined load and settle windows prior to reading (ACME AB-2, Table 1)",
    payload: {
      columns: [
        { name: "load_step_gt", type: "number", unit: "kg" },
        { name: "load_step_max", type: "number", unit: "kg" },
        { name: "class_x", type: "integer", unit: "s" },
        { name: "class_y", type: "integer", unit: "s" },
        { name: "class_z", type: "integer", unit: "s" },
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

const movingTolerance = {
  node_id: "/table/tolerance_moving",
  content: {
    name: "Tolerance for moving measurements per grade (ACME AB-9, 6.15.1)",
    payload: {
      columns: [
        { name: "grade_class", type: "string" },
        { name: "speed_min", type: "number", unit: "km/h" },
        { name: "speed_max", type: "number", unit: "km/h" },
        { name: "tolerance", type: "number" },
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

const tierLimits = {
  node_id: "/table/tier_limits",
  content: {
    name: "Tolerance tier breakpoints per grade class (ACME AB-2, Table 4)",
    payload: {
      columns: [
        { name: "grade_class", type: "string" },
        { name: "load_min", type: "number", unit: "u" },
        { name: "load_max", type: "number", unit: "u" },
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

test("lookup, class as column: 500 kg change, class X → 30 s (interval 100 < 500 ≤ 1000)", () => {
  const v = evaluateAggregation([soak], "After a 500 kg load change, how long must a class X instrument settle before the reading per ACME AB-2?");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 30);
  assert.equal(v?.unit, "s");
  assert.equal(v?.row?.class_x, "30");
});

test("interval boundary belongs to the lower (a,b] row: 10 kg → (0,10], 100 kg → (10,100]", () => {
  const v10 = evaluateAggregation([soak], "After a 10 kg load change, how long must a class Z instrument settle per ACME AB-2?");
  assert.equal(v10?.value, 20);
  const v100 = evaluateAggregation([soak], "After a 100 kg load change, how long must a class Z instrument settle per ACME AB-2?");
  assert.equal(v100?.value, 40);
});

test("lookup, class as row value: class B at 120 km/h → 0.07 relative", () => {
  const v = evaluateAggregation([movingTolerance], "What is the tolerance for a class B vehicle measuring at 120 km/h?");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 0.07);
  assert.equal(v?.row?.mode, "relative");
});

test("lookup with thousands grouping: 1,000 kg parses as 1000 and stays in (100, 1000]", () => {
  const v = evaluateAggregation([soak], "After a 1,000 kg load change, what settle time applies for class Y?");
  assert.equal(v?.value, 45);
});

test("count distinct: grade classes in the tier table", () => {
  const v = evaluateAggregation([tierLimits], "How many grade classes does ACME AB-2 define?");
  assert.equal(v?.operation, "count");
  assert.equal(v?.value, 4);
  assert.equal(v?.column, "grade_class");
});

test("count rows when no class column is named", () => {
  const v = evaluateAggregation([movingTolerance], "How many tolerance rows does the moving table have?");
  assert.equal(v?.operation, "count");
  assert.equal(v?.value, 4);
});

test("min over a class column: shortest class Y settle time", () => {
  const v = evaluateAggregation([soak], "What is the shortest settle time for a class Y instrument?");
  assert.equal(v?.operation, "min");
  assert.equal(v?.column, "class_y");
  assert.equal(v?.value, 15);
  assert.equal(v?.unit, "s");
});

test("max over a class column: longest class X settle time (open top row included)", () => {
  const v = evaluateAggregation([soak], "What is the longest settle time for a class Z instrument?");
  assert.equal(v?.value, 120);
});

test("several tables: table-name scoring picks tolerance_moving, not tier_limits", () => {
  const v = evaluateAggregation([tierLimits, movingTolerance], "What is the tolerance factor for a class A moving measurement at 150 km/h?");
  assert.equal(v?.table, "/table/tolerance_moving");
  assert.equal(v?.value, 0.03);
});

test("ambiguous across many unscored tables: refuse rather than guess", () => {
  const v = evaluateAggregation([tierLimits, movingTolerance], "What is the value?");
  assert.equal(v, null);
});

test("the stated unit and class beat a title-word tie: 500 kg class X picks the soak table", () => {
  const v = evaluateAggregation([tierLimits, soak], "After a 500 kg load change, how long must a class X instrument settle before the reading, per ACME AB-2?");
  assert.equal(v?.table, "/table/soak_windows");
  assert.equal(v?.operation, "lookup");
  assert.equal(v?.value, 30);
  assert.equal(v?.unit, "s");
});

test("no aggregation intent matchable: no verdict", () => {
  assert.equal(evaluateAggregation([soak], "What is climatic conditioning?"), null);
});
