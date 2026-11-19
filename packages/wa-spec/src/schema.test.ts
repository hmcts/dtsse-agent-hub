import { describe, expect, it } from "vitest";
import { Cond, Expr, Spec, validateSpec } from "./schema.ts";

const decision = {
  name: "Demo",
  hitPolicy: "COLLECT" as const,
  inputs: [{ key: "eventId", expression: { field: "event" } }],
  outputs: [{ name: "taskType" }],
  rows: [{ when: { eventId: { in: ["a"] } }, returns: { taskType: "T" } }]
};

const spec = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  service: { slug: "demo" },
  caseTypes: [{ id: "ct_a" }, { id: "ct_b" }],
  decisions: { completion: decision },
  ...overrides
});

describe("Spec", () => {
  it("should accept a minimal spec when every part is well formed", () => {
    expect(Spec.parse(spec())).toBeTruthy();
  });

  it("should reject unknown keys when a part has a misspelt property", () => {
    expect(() => Spec.parse(spec({ decisions: { completion: { ...decision, hitpolicy: "FIRST" } } }))).toThrow();
  });

  it("should reject a hit policy outside the DMN set when the spec names one", () => {
    expect(() => Spec.parse(spec({ decisions: { completion: { ...decision, hitPolicy: "SOMETIMES" } } }))).toThrow();
  });
});

describe("Expr and Cond", () => {
  it("should accept nested conditions and an if when the shapes are valid", () => {
    expect(
      Expr.parse({
        if: { all: [{ field: "a", op: "exists" }, { any: [{ field: "b", op: "eq", value: 1 }] }] },
        use: { plus: ["x", { field: "y" }] },
        otherwise: null
      })
    ).toBeTruthy();
  });

  it("should reject a condition with an unknown operator when the operator is not supported", () => {
    expect(() => Cond.parse({ field: "a", op: "like", value: "x" })).toThrow();
  });
});

describe("validateSpec", () => {
  it("should find no problems when references all resolve", () => {
    expect(validateSpec(Spec.parse(spec()))).toEqual([]);
  });

  it("should report an unknown case type, input and output when a row refers to one that does not exist", () => {
    const bad = Spec.parse(
      spec({
        decisions: {
          completion: {
            ...decision,
            rows: [{ only: ["ct_z"], when: { nope: { in: ["a"] } }, returns: { missing: 1 } }]
          }
        }
      })
    );
    const problems = validateSpec(bad);
    expect(problems).toContain("completion row 1: unknown case type ct_z");
    expect(problems).toContain("completion row 1: unknown input nope");
    expect(problems).toContain("completion row 1: unknown output missing");
  });

  it("should report a row that reads a column its case type does not have when the column is scoped", () => {
    const bad = Spec.parse(
      spec({
        decisions: {
          completion: {
            ...decision,
            inputs: [{ key: "eventId", expression: { field: "event" }, only: ["ct_a"] }],
            rows: [{ when: { eventId: { in: ["a"] } }, returns: { taskType: "T" } }]
          }
        }
      })
    );
    expect(validateSpec(bad)).toEqual(["completion row 1: input eventId does not exist for ct_b"]);
  });

  it("should report duplicate columns and dangling dependencies when the lists are inconsistent", () => {
    const bad = Spec.parse(
      spec({
        decisions: {
          completion: {
            ...decision,
            inputs: [
              { key: "k", expression: "x" },
              { key: "k", expression: "y" }
            ],
            rows: [],
            helpers: [{ name: "H", expression: 1 }],
            dependencies: [
              { decision: "table", requires: "Other" },
              { decision: "Ghost", requires: "H" }
            ]
          }
        }
      })
    );
    const problems = validateSpec(bad);
    expect(problems).toContain("completion: duplicate input key");
    expect(problems).toContain("completion: dependency on unknown helper Other");
    expect(problems).toContain("completion: dependency from unknown decision Ghost");
  });
});

describe("validateSpec helpers and dependencies", () => {
  const withHelpers = (helpers: unknown[], dependencies: unknown[] = []) =>
    Spec.parse(spec({ decisions: { completion: { ...decision, helpers, dependencies } } }));
  const helper = (extra: Record<string, unknown> = {}) => ({ name: "H", expression: 1, ...extra });

  it("should name an unknown case type when a helper's only or overrides refers to one", () => {
    expect(validateSpec(withHelpers([helper({ only: ["ct_z"] })]))).toEqual(["completion helper H: unknown case type ct_z"]);
    expect(validateSpec(withHelpers([helper({ overrides: { ct_y: { expression: 2 } } })]))).toEqual(["completion helper H overrides: unknown case type ct_y"]);
  });

  it("should name an unknown case type when a dependency's only refers to one", () => {
    expect(validateSpec(withHelpers([helper()], [{ decision: "table", requires: "H", only: ["ct_q"] }]))).toEqual([
      "completion dependency table -> H: unknown case type ct_q"
    ]);
  });

  it("should accept two helpers of one name when their only lists do not overlap", () => {
    expect(validateSpec(withHelpers([helper({ only: ["ct_a"] }), helper({ only: ["ct_b"], expression: 2 })]))).toEqual([]);
  });

  it("should reject two helpers of one name when their only lists overlap or one has none", () => {
    expect(validateSpec(withHelpers([helper({ only: ["ct_a"] }), helper({ only: ["ct_a", "ct_b"] })]))).toEqual([
      "completion: helper H is defined more than once for the same case type"
    ]);
    expect(validateSpec(withHelpers([helper(), helper({ only: ["ct_b"] })]))).toHaveLength(1);
  });

  it("should reject a service slug or case type that cannot be part of a decision id when it holds a space", () => {
    expect(validateSpec(Spec.parse(spec({ service: { slug: "my service" } })))).toHaveLength(1);
    expect(validateSpec(Spec.parse(spec({ caseTypes: [{ id: "a b" }] })))[0]).toContain("case type a b");
  });
});

describe("validateSpec dependencies on helpers that a case type lacks", () => {
  const build = (helpers: unknown[], dependencies: unknown[]) => Spec.parse(spec({ decisions: { completion: { ...decision, helpers, dependencies } } }));

  it("should name the case type that lacks the helper when a dependency applies to more case types than the helper", () => {
    expect(validateSpec(build([{ name: "H", expression: 1, only: ["ct_a"] }], [{ decision: "table", requires: "H" }]))).toEqual([
      "completion: table requires helper H, which ct_b does not have"
    ]);
  });

  it("should accept the dependency when it is limited to the case types that have the helper", () => {
    expect(validateSpec(build([{ name: "H", expression: 1, only: ["ct_a"] }], [{ decision: "table", requires: "H", only: ["ct_a"] }]))).toEqual([]);
  });

  it("should not report a helper-to-helper dependency when the requiring helper is absent for that case type", () => {
    const helpers = [
      { name: "A", expression: 1, only: ["ct_a"] },
      { name: "B", expression: 1, only: ["ct_a"] }
    ];
    expect(validateSpec(build(helpers, [{ decision: "A", requires: "B" }]))).toEqual([]);
  });
});

describe("validateSpec scoped decisions and names", () => {
  const scoped = (decisionExtra: Record<string, unknown>, rows: unknown[] = decision.rows) =>
    Spec.parse(spec({ decisions: { completion: { ...decision, only: ["ct_a"], ...decisionExtra, rows } } }));

  it("should check a row against the case types of its own decision when the decision is limited to some", () => {
    const limited = Spec.parse(
      spec({
        decisions: {
          completion: {
            ...decision,
            only: ["ct_a"],
            inputs: [{ key: "eventId", only: ["ct_a"] }],
            rows: [{ when: { eventId: { in: ["a"] } }, returns: { taskType: "T" } }]
          }
        }
      })
    );
    expect(validateSpec(limited)).toEqual([]);
    expect(validateSpec(Spec.parse(spec({ decisions: { completion: { ...decision, inputs: [{ key: "eventId", only: ["ct_a"] }] } } })))).toHaveLength(1);
  });

  it("should check a dependency and same-named helpers against the decision's own case types", () => {
    const helpers = [{ name: "H", expression: 1, only: ["ct_a"] }];
    expect(validateSpec(scoped({ helpers, dependencies: [{ decision: "table", requires: "H" }] }))).toEqual([]);
    expect(
      validateSpec(
        scoped({
          helpers: [
            { name: "H", expression: 1 },
            { name: "H", expression: 2, only: ["ct_a"] }
          ]
        })
      )
    ).toHaveLength(1);
  });

  it("should reject a helper named table when it would be mistaken for the main decision", () => {
    expect(validateSpec(scoped({ helpers: [{ name: "table", expression: 1 }] }))[0]).toContain("cannot be named table");
  });

  it("should reject a hyphen in a case type and say why when the id is checked", () => {
    expect(validateSpec(Spec.parse(spec({ caseTypes: [{ id: "ct-a" }] })))[0]).toContain('where "-" ends the service slug');
    expect(validateSpec(Spec.parse(spec({ service: { slug: "a-b" } })))).toEqual([]);
  });
});
