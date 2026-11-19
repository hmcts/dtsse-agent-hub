import { z } from "zod";

export const KINDS = ["initiation", "configuration", "permissions", "completion", "cancellation", "task-types", "allowed-days"] as const;
export type Kind = (typeof KINDS)[number];

/** PRIORITY and OUTPUT ORDER rank outputs by an `<outputValues>` list, which the spec has no place for. */
export const HIT_POLICIES = ["UNIQUE", "FIRST", "ANY", "COLLECT", "RULE ORDER"] as const;
export const AGGREGATIONS = ["SUM", "MIN", "MAX", "COUNT"] as const;

export const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export const COMPARISONS = ["eq", "ne", "gt", "ge", "lt", "le", "exists", "notExists"] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const COMPARE_OPS = ["eq", "ne", "gt", "ge", "lt", "le"] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];

/**
 * A boolean condition: a field compared with a value, any two expressions compared, a boolean expression that is simply
 * true, or and/or combinations of those.
 */
export type Cond =
  | { field: string; op: Comparison; value?: Scalar }
  | { left: Expr; op: CompareOp; right: Expr }
  | { truthy: Expr }
  | { all: Cond[] }
  | { any: Cond[] };

/**
 * A value expression. A scalar is itself, `field` reads a variable or a dotted path, `if` chooses `use` or `otherwise`, `plus` adds or
 * concatenates, `minus` subtracts, `call` calls a FEEL built-in function, `quantifier` tests some or every item of a list, a condition is a boolean, and `feel` is the raw FEEL escape
 * hatch for anything else.
 */
export type Expr =
  | Scalar
  | { feel: string; language?: string }
  | { field: string }
  | { if: Cond; use: Expr; otherwise: Expr }
  | { plus: Expr[] }
  | { minus: [Expr, Expr] }
  | { call: string; args: Expr[] }
  | { quantifier: "some" | "every"; variable: string; over: Expr; satisfies: Expr }
  | Cond;

export const Cond: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.strictObject({ field: z.string().min(1), op: z.enum(COMPARISONS), value: Scalar.optional() }),
    z.strictObject({ left: Expr, op: z.enum(COMPARE_OPS), right: Expr }),
    z.strictObject({ truthy: Expr }),
    z.strictObject({ all: z.array(Cond).min(1) }),
    z.strictObject({ any: z.array(Cond).min(1) })
  ])
);

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    Scalar,
    z.strictObject({ feel: z.string(), language: z.string().optional() }),
    z.strictObject({ field: z.string().min(1) }),
    z.strictObject({ if: Cond, use: Expr, otherwise: Expr }),
    z.strictObject({ plus: z.array(Expr).min(2) }),
    z.strictObject({ minus: z.tuple([Expr, Expr]) }),
    z.strictObject({ call: z.string().min(1), args: z.array(Expr) }),
    z.strictObject({ quantifier: z.enum(["some", "every"]), variable: z.string().min(1), over: Expr, satisfies: Expr }),
    Cond
  ])
);

/** One input entry: what the column's expression must match. An omitted entry matches anything. */
export const Cell = z.union([
  z.strictObject({ in: z.array(Scalar).min(1) }),
  z.strictObject({ notIn: z.array(Scalar).min(1) }),
  z.strictObject({ cmp: z.enum(["<", "<=", ">", ">="]), value: z.union([z.number(), z.string()]) }),
  z.strictObject({ feel: z.string(), language: z.string().optional() })
]);
export type Cell = z.infer<typeof Cell>;

const CaseTypeId = z.string().min(1);

/** Per-case-type replacement of a column's properties. A `null` removes a property the other case types have. */
const InputOverride = z.strictObject({
  label: z.string().nullable().optional(),
  variable: z.string().nullable().optional(),
  typeRef: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  allowedValues: z.string().nullable().optional(),
  expression: Expr.optional()
});

const OutputOverride = z.strictObject({ label: z.string().nullable().optional(), typeRef: z.string().nullable().optional() });

export const InputColumn = z.strictObject({
  key: z.string().min(1),
  label: z.string().optional(),
  variable: z.string().optional(),
  typeRef: z.string().optional(),
  language: z.string().optional(),
  /** The text of the column's list of allowed values, such as `"C100","FL401"`. */
  allowedValues: z.string().optional(),
  expression: Expr.optional(),
  only: z.array(CaseTypeId).optional(),
  overrides: z.record(CaseTypeId, InputOverride).optional()
});
export type InputColumn = z.infer<typeof InputColumn>;

export const OutputColumn = z.strictObject({
  name: z.string().min(1),
  label: z.string().optional(),
  typeRef: z.string().optional(),
  only: z.array(CaseTypeId).optional(),
  overrides: z.record(CaseTypeId, OutputOverride).optional()
});
export type OutputColumn = z.infer<typeof OutputColumn>;

export const Row = z.strictObject({
  description: z.string().optional(),
  only: z.array(CaseTypeId).optional(),
  when: z.record(z.string(), Cell).optional(),
  returns: z.record(z.string(), Expr).optional()
});
export type Row = z.infer<typeof Row>;

/**
 * A named literal-expression decision a table reads, such as the latest referral's task title. It carries a variable named
 * like itself unless `variable` names another or is false for none.
 */
export const Helper = z.strictObject({
  name: z.string().min(1),
  variable: z.union([z.string().min(1), z.literal(false)]).optional(),
  typeRef: z.string().optional(),
  language: z.string().optional(),
  historyTimeToLive: z.string().optional(),
  expression: Expr,
  only: z.array(CaseTypeId).optional(),
  overrides: z
    .record(
      CaseTypeId,
      z.strictObject({
        expression: Expr.optional(),
        /** Absent inherits the helper's; `null` is a variable named like the helper. */
        variable: z
          .union([z.string().min(1), z.literal(false)])
          .nullable()
          .optional(),
        typeRef: z.string().nullable().optional(),
        language: z.string().nullable().optional(),
        historyTimeToLive: z.string().nullable().optional()
      })
    )
    .optional()
});
export type Helper = z.infer<typeof Helper>;

/** `decision` is "table" for the main decision table or a helper's name. */
export const Dependency = z.strictObject({
  decision: z.string().min(1),
  requires: z.string().min(1),
  only: z.array(CaseTypeId).optional()
});
export type Dependency = z.infer<typeof Dependency>;

export const DecisionOverride = z.strictObject({
  name: z.string().optional(),
  hitPolicy: z.enum(HIT_POLICIES).optional(),
  aggregation: z.enum(AGGREGATIONS).nullable().optional(),
  historyTimeToLive: z.string().nullable().optional()
});

export const Decision = z.strictObject({
  /** The case types that have this kind of decision, when not all of them do. */
  only: z.array(CaseTypeId).optional(),
  name: z.string().min(1),
  hitPolicy: z.enum(HIT_POLICIES),
  aggregation: z.enum(AGGREGATIONS).optional(),
  historyTimeToLive: z.string().optional(),
  overrides: z.record(CaseTypeId, DecisionOverride).optional(),
  inputs: z.array(InputColumn),
  outputs: z.array(OutputColumn).min(1),
  rows: z.array(Row),
  helpers: z.array(Helper).optional(),
  dependencies: z.array(Dependency).optional()
});
export type Decision = z.infer<typeof Decision>;

export const CaseType = z.strictObject({ id: CaseTypeId, displayName: z.string().optional() });

export const Service = z.strictObject({
  /** The segment of each DMN's key between the kind and the case type, such as `employment`. */
  slug: z.string().min(1),
  jurisdiction: z.string().optional(),
  serviceCode: z.string().optional(),
  displayName: z.string().optional()
});

export const Spec = z.strictObject({
  version: z.literal(1),
  service: Service,
  caseTypes: z.array(CaseType).min(1),
  decisions: z.strictObject({
    initiation: Decision.optional(),
    configuration: Decision.optional(),
    permissions: Decision.optional(),
    completion: Decision.optional(),
    cancellation: Decision.optional(),
    "task-types": Decision.optional(),
    "allowed-days": Decision.optional()
  })
});
export type Spec = z.infer<typeof Spec>;

/** Checks the cross references the shape alone cannot: case types, column keys, output names and helper names. */
export function validateSpec(spec: Spec): string[] {
  const problems: string[] = [];
  const caseTypes = new Set(spec.caseTypes.map((c) => c.id));
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.service.slug)) {
    problems.push(`service slug ${spec.service.slug}: only letters, digits, "_", "." and "-" are allowed, as it becomes part of a decision id and file name`);
  }
  const ids = spec.caseTypes.map((c) => c.id);
  for (const id of ids.filter((x, i) => ids.indexOf(x) !== i)) {
    problems.push(`case type ${id} is listed more than once`);
  }
  for (const { id } of spec.caseTypes) {
    if (!/^[A-Za-z0-9_.]+$/.test(id)) {
      problems.push(
        `case type ${id}: only letters, digits, "_" and "." are allowed, as it becomes part of a decision id and file name, where "-" ends the service slug`
      );
    }
  }
  const known = (where: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      if (!caseTypes.has(id)) {
        problems.push(`${where}: unknown case type ${id}`);
      }
    }
  };
  for (const [kind, decision] of Object.entries(spec.decisions)) {
    if (!decision) {
      continue;
    }
    const inputKeys = new Map(decision.inputs.map((c) => [c.key, c]));
    const outputNames = new Map(decision.outputs.map((c) => [c.name, c]));
    if (inputKeys.size !== decision.inputs.length) {
      problems.push(`${kind}: duplicate input key`);
    }
    if (outputNames.size !== decision.outputs.length) {
      problems.push(`${kind}: duplicate output name`);
    }
    known(`${kind}.overrides`, Object.keys(decision.overrides ?? {}));
    known(kind, decision.only);
    const own = decision.only ?? [...caseTypes];
    const within = (where: string, only: string[] | undefined) => {
      for (const id of only ?? []) {
        if (decision.only && caseTypes.has(id) && !decision.only.includes(id)) {
          problems.push(`${where}: ${id} is not a case type of ${kind}`);
        }
      }
    };
    for (const id of own) {
      const override = decision.overrides?.[id];
      const hitPolicy = override?.hitPolicy ?? decision.hitPolicy;
      const aggregation = override?.aggregation === undefined ? decision.aggregation : override.aggregation;
      if (aggregation && hitPolicy !== "COLLECT") {
        problems.push(`${kind}: ${id} has aggregation ${aggregation} with hit policy ${hitPolicy}, and only COLLECT aggregates`);
      }
      if (!decision.outputs.some((o) => o.only === undefined || o.only.includes(id))) {
        problems.push(`${kind}: ${id} has no outputs`);
      }
    }
    for (const column of [...decision.inputs, ...decision.outputs]) {
      known(`${kind} column`, column.only);
      within(`${kind} column`, column.only);
      known(`${kind} column overrides`, Object.keys(column.overrides ?? {}));
    }
    decision.rows.forEach((row, index) => {
      const where = `${kind} row ${index + 1}`;
      known(where, row.only);
      within(where, row.only);
      for (const key of Object.keys(row.when ?? {})) {
        const column = inputKeys.get(key);
        if (!column) {
          problems.push(`${where}: unknown input ${key}`);
        } else {
          for (const id of row.only ?? own) {
            if (column.only && !column.only.includes(id)) {
              problems.push(`${where}: input ${key} does not exist for ${id}`);
            }
          }
        }
      }
      for (const name of Object.keys(row.returns ?? {})) {
        const column = outputNames.get(name);
        if (!column) {
          problems.push(`${where}: unknown output ${name}`);
        } else {
          for (const id of row.only ?? own) {
            if (column.only && !column.only.includes(id)) {
              problems.push(`${where}: output ${name} does not exist for ${id}`);
            }
          }
        }
      }
    });
    const helperNames = new Set((decision.helpers ?? []).map((h) => h.name));
    const sharing = new Map<string, Array<string[] | undefined>>();
    for (const helper of decision.helpers ?? []) {
      if (helper.name === "table") {
        problems.push(`${kind}: a helper cannot be named table, which stands for the main decision in a dependency`);
      }
      known(`${kind} helper ${helper.name}`, helper.only);
      within(`${kind} helper ${helper.name}`, helper.only);
      known(`${kind} helper ${helper.name} overrides`, Object.keys(helper.overrides ?? {}));
      sharing.set(helper.name, [...(sharing.get(helper.name) ?? []), helper.only]);
    }
    for (const [name, onlys] of sharing) {
      const claimed = onlys.flatMap((only) => only ?? own);
      if (onlys.length > 1 && new Set(claimed).size !== claimed.length) {
        problems.push(`${kind}: helper ${name} is defined more than once for the same case type`);
      }
    }
    for (const dependency of decision.dependencies ?? []) {
      known(`${kind} dependency ${dependency.decision} -> ${dependency.requires}`, dependency.only);
      within(`${kind} dependency ${dependency.decision} -> ${dependency.requires}`, dependency.only);
      if (dependency.decision !== "table" && !helperNames.has(dependency.decision)) {
        problems.push(`${kind}: dependency from unknown decision ${dependency.decision}`);
      }
      if (!helperNames.has(dependency.requires)) {
        problems.push(`${kind}: dependency on unknown helper ${dependency.requires}`);
      }
      const present = (name: string, id: string) => (decision.helpers ?? []).some((h) => h.name === name && (h.only === undefined || h.only.includes(id)));
      for (const id of dependency.only ?? own) {
        if (
          helperNames.has(dependency.requires) &&
          (dependency.decision === "table" || present(dependency.decision, id)) &&
          !present(dependency.requires, id)
        ) {
          problems.push(`${kind}: ${dependency.decision} requires helper ${dependency.requires}, which ${id} does not have`);
        }
      }
    }
  }
  return problems;
}
