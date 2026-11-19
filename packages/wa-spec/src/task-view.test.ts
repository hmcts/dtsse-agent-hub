import { describe, expect, it } from "vitest";
import { type Spec, Spec as SpecSchema } from "./schema.ts";
import { renderTaskRows, taskRows } from "./task-view.ts";

const spec: Spec = SpecSchema.parse({
  version: 1,
  service: { slug: "demo" },
  caseTypes: [{ id: "ct_a" }],
  decisions: {
    permissions: {
      name: "P",
      hitPolicy: "RULE ORDER",
      inputs: [{ key: "taskType" }],
      outputs: [{ name: "name" }],
      rows: [
        { when: { taskType: { in: ["T1", "T2"] } }, returns: { name: "named" } },
        { when: { taskType: { in: ["T2"] } }, returns: { name: "other" } },
        { returns: { name: "everyone" } },
        { when: { taskType: { notIn: ["T1"] } }, returns: { name: "not T1" } },
        { when: { taskType: { notIn: ["T2"] } }, returns: { name: "not T2" } },
        { when: { taskType: { feel: 'starts with(taskType, "T")' } }, returns: { name: "feel" } }
      ]
    },
    initiation: {
      name: "I",
      hitPolicy: "COLLECT",
      inputs: [],
      outputs: [{ name: "taskId" }],
      rows: [{ returns: { taskId: "T1" } }, { returns: { taskId: { feel: 'x + "T1"' } } }, {}]
    }
  }
});

describe("taskRows", () => {
  it("should include rows with an empty task cell, a notIn that leaves the task out and a FEEL cell when the task is T1", () => {
    const permissions = taskRows(spec, "T1").find((f) => f.kind === "permissions");
    expect(permissions?.rows.map((r) => [r.index, r.mayApply])).toEqual([
      [1, undefined],
      [3, undefined],
      [5, undefined],
      [6, true]
    ]);
  });

  it("should leave out a row whose notIn names the task or whose in does not when the task is T2", () => {
    const permissions = taskRows(spec, "T2").find((f) => f.kind === "permissions");
    expect(permissions?.rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 6]);
  });

  it("should match an output value that names the task when the side is returns", () => {
    expect(
      taskRows(spec, "T1")
        .find((f) => f.kind === "initiation")
        ?.rows.map((r) => r.index)
    ).toEqual([1, 2]);
  });

  it("should mark a FEEL row as may apply when the rows are rendered", () => {
    expect(renderTaskRows(taskRows(spec, "T1"))).toContain("mayApply: true");
  });
});

describe("taskRows structured values", () => {
  it("should mark a row that names the task inside a structured expression as may apply when the task is T9", () => {
    const structured = SpecSchema.parse({
      version: 1,
      service: { slug: "demo" },
      caseTypes: [{ id: "ct_a" }],
      decisions: {
        initiation: {
          name: "I",
          hitPolicy: "COLLECT",
          inputs: [],
          outputs: [{ name: "taskId" }],
          rows: [
            { returns: { taskId: { if: { field: "a", op: "exists" }, use: "T9", otherwise: { call: "f", args: [{ plus: ["x", "T9"] }] } } } },
            { returns: { taskId: { if: { field: "a", op: "exists" }, use: "T8", otherwise: null } } }
          ]
        }
      }
    });
    expect(taskRows(structured, "T9")[0]?.rows).toEqual([{ index: 1, row: structured.decisions.initiation?.rows[0], mayApply: true }]);
  });
});

describe("taskRows cancellation and FEEL", () => {
  const cancel = SpecSchema.parse({
    version: 1,
    service: { slug: "demo" },
    caseTypes: [{ id: "ct_a" }],
    decisions: {
      initiation: {
        name: "I",
        hitPolicy: "COLLECT",
        inputs: [],
        outputs: [{ name: "taskId" }, { name: "processCategories" }],
        rows: [
          { returns: { taskId: "T1", processCategories: { if: { field: "a", op: "exists" }, use: "catA", otherwise: "catB" } } },
          { returns: { taskId: { feel: "other" }, processCategories: "catF" } },
          { returns: { taskId: "T2", processCategories: "catZ" } }
        ]
      },
      cancellation: {
        name: "C",
        hitPolicy: "COLLECT",
        inputs: [],
        outputs: [{ name: "processCategories" }],
        rows: [
          { returns: { processCategories: "catA" } },
          { returns: { processCategories: "catZ" } },
          {},
          { returns: { processCategories: { feel: "x" } } },
          { returns: { processCategories: { if: { field: "a", op: "exists" }, use: "catB", otherwise: null } } }
        ]
      }
    }
  });

  it("should include cancellation rows that apply to every category or may match one when the task makes categories structurally", () => {
    const rows = taskRows(cancel, "T1").find((f) => f.kind === "cancellation")?.rows;
    expect(rows?.map((r) => [r.index, r.mayApply])).toEqual([
      [1, undefined],
      [3, undefined],
      [4, true],
      [5, true]
    ]);
  });

  it("should keep a raw FEEL task cell as may apply when it does not name the task", () => {
    const rows = taskRows(cancel, "T1").find((f) => f.kind === "initiation")?.rows;
    expect(rows?.map((r) => [r.index, r.mayApply])).toEqual([
      [1, undefined],
      [2, true]
    ]);
  });
});

describe("taskRows comma-separated categories", () => {
  const listed = SpecSchema.parse({
    version: 1,
    service: { slug: "demo" },
    caseTypes: [{ id: "ct_a" }],
    decisions: {
      initiation: {
        name: "I",
        hitPolicy: "COLLECT",
        inputs: [],
        outputs: [{ name: "taskId" }, { name: "processCategories" }],
        rows: [{ returns: { taskId: "T1", processCategories: "catA, catB" } }]
      },
      cancellation: {
        name: "C",
        hitPolicy: "COLLECT",
        inputs: [],
        outputs: [{ name: "processCategories" }],
        rows: [{ returns: { processCategories: "catB,catC" } }, { returns: { processCategories: "catD,catE" } }]
      }
    }
  });

  it("should match a cancellation row when any category in either list is shared", () => {
    expect(
      taskRows(listed, "T1")
        .find((f) => f.kind === "cancellation")
        ?.rows.map((r) => r.index)
    ).toEqual([1]);
  });
});
