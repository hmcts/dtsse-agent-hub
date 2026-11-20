import { describe, expect, it } from "vitest";
import { BASE, SMALL } from "./__fixtures__/model.ts";
import { compileModel } from "./model-compile.ts";
import { parseModel } from "./model-io.ts";
import type { Row } from "./schema.ts";
import { compareSpecs, diffSpecs } from "./spec-diff.ts";

describe("diffSpecs", () => {
  it("should name the path of a difference when specs differ in a value, a length or a key", () => {
    const a = compileModel(parseModel(SMALL));
    const b = structuredClone(a);
    (b.decisions.completion?.rows[0] as Row).returns = { taskType: "Other" };
    b.decisions.initiation?.rows.pop();
    b.service.displayName = "Demo";
    const differences = diffSpecs(a, b);
    expect(differences).toContain("spec.service.displayName: only in the second");
    expect(differences.some((d) => d.startsWith("spec.decisions.initiation.rows[1]: removed {"))).toBe(true);
    expect(differences.some((d) => d.startsWith("spec.decisions.completion.rows[0].returns"))).toBe(true);
  });
});

describe("compareSpecs", () => {
  it("should report the true number of differences when more than the shown limit differ", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    const rows = a.decisions.completion?.rows as Row[];
    const otherRows = b.decisions.completion?.rows as Row[];
    for (let i = 0; i < 45; i++) {
      rows.push({ returns: { taskType: `T${i}` } });
      otherRows.push({ returns: { taskType: `U${i}` } });
    }
    const { differences, total } = compareSpecs(a, b);
    expect(total).toBe(45);
    expect(differences).toHaveLength(40);
  });
});

describe("ignoring rule order", () => {
  it("should compare rows as sets when the diff ignores rule order", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    b.decisions.cancellation?.rows.reverse();
    expect(compareSpecs(a, b).total).toBeGreaterThan(0);
    expect(compareSpecs(a, b, { ignoreRuleOrder: true }).total).toBe(0);
  });
});

describe("row order by hit policy", () => {
  it("should compare rows as sets only where the hit policy allows when diffing without a flag", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    for (const spec of [a, b]) {
      (spec.decisions.cancellation as { hitPolicy: string }).hitPolicy = "UNIQUE";
    }
    b.decisions.cancellation?.rows.reverse();
    expect(compareSpecs(a, b).total).toBe(0);
    expect(compareSpecs(a, b, { strict: true }).total).toBeGreaterThan(0);
    expect(diffSpecs(a, b).length).toBeGreaterThan(0);
    (a.decisions.cancellation as { hitPolicy: string }).hitPolicy = "COLLECT";
    (b.decisions.cancellation as { hitPolicy: string }).hitPolicy = "COLLECT";
    expect(compareSpecs(a, b).total).toBeGreaterThan(0);
  });
});

describe("arrays of different length", () => {
  const _NAMED = (name: string, extra = "") => `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}]
tasks:
  - id: T
    name: ${name}
    create: [{event: e${extra}}]
`;

  it("should report an inserted row as inserted and not every later row as different when diffing specs", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    const rows = b.decisions.cancellation?.rows as Row[];
    rows.splice(1, 0, { when: { event: { in: ["new"] } }, returns: { action: "Cancel" } });
    const { differences, total } = compareSpecs(a, b, { strict: true });
    expect(total).toBe(1);
    expect(differences[0]).toContain("spec.decisions.cancellation.rows[1]: inserted");
  });
});
