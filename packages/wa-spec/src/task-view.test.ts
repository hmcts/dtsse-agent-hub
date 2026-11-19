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
