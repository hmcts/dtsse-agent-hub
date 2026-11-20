import { readFileSync } from "node:fs";
import { type Model, parseModel, type Task } from "@hmcts-cft/wa-spec";
import { describe, expect, it } from "vitest";
import {
  boardGroups,
  briefAcrossCaseTypes,
  briefExpr,
  briefVal,
  cancelCategories,
  caseTypeIds,
  describeCancellation,
  describeCell,
  describeCompletion,
  describeCond,
  describeExpr,
  describeTaskRule,
  describeTrigger,
  grantConditions,
  groupByCaseType,
  isRawFeel,
  permissionColumns,
  permissionNames,
  reconfigureRules,
  resolveCompletions,
  resolvePermissions,
  resolveTriggers,
  resolveVal,
  rolesByCategory,
  rulesForTask,
  type TaskRule,
  taskCaseTypes,
  taskName,
  tasksUsingProfile,
  textParts
} from "./wa-builder-text.ts";

const et: Model = parseModel(readFileSync(new URL("../../packages/wa-spec/examples/et/model.yaml", import.meta.url), "utf8"));
const task = (id: string) => {
  const found = et.tasks.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no task ${id}`);
  }
  return found;
};

describe("describeCond and describeExpr", () => {
  it("should word a field comparison and an existence test when the condition is structured", () => {
    expect(describeCond({ field: "caseData.referCaseTo", op: "eq", value: "Admin" })).toBe('`caseData.referCaseTo` is "Admin"');
    expect(describeCond({ field: "caseData.claimant", op: "exists" })).toBe("`caseData.claimant` is set");
    expect(describeCond({ field: "x", op: "notExists" })).toBe("`x` is not set");
  });

  it("should join conditions with and, and bracket a nested or, when conditions are combined", () => {
    expect(
      describeCond({
        all: [{ field: "a", op: "exists" }, { any: [{ field: "b", op: "gt", value: 2 }, { truthy: { field: "c" } }] }]
      })
    ).toBe("`a` is set and (`b` is more than 2 or `c` is true)");
  });

  it("should word ET's case name default when it is an if with concatenation", () => {
    const caseName = et.defaults?.configuration?.find((attribute) => attribute.name === "caseName")?.value;
    expect(caseName).toBeDefined();
    expect(describeExpr(caseName ?? null)).toBe(
      'if `caseData.ethosCaseReference` is set, then `caseData.ethosCaseReference` + " - ", otherwise "" + if `caseData.claimant` is set, then `caseData.claimant`, otherwise "Unknown" + " v " + if `caseData.respondent` is set, then `caseData.respondent`, otherwise "Unknown"'
    );
  });

  it("should show raw FEEL as code, and know it is raw, when ET calculates a due date", () => {
    const days = resolveVal(task("ReviewReferralAdmin").due?.days, "et_englandwales", taskCaseTypes(et, task("ReviewReferralAdmin")))[0];
    expect(isRawFeel(days)).toBe(true);
    expect(describeExpr(days ?? null)).toMatch(/^`if \(caseData != null and caseData\.referralCollection/);
    expect(briefExpr(days)).toBe("calculated");
  });

  it("should give plain values as themselves when an expression is briefed", () => {
    expect(briefExpr(5)).toBe("5");
    expect(briefExpr(true)).toBe("true");
    expect(briefExpr(null)).toBe("–");
    expect(briefExpr(undefined)).toBe("");
  });
});

describe("textParts", () => {
  it("should mark the backticked spans as code when text mixes words and names", () => {
    expect(textParts("Created when `a` happens")).toEqual([
      { text: "Created when ", code: false },
      { text: "a", code: true },
      { text: " happens", code: false }
    ]);
  });
});

describe("describeCell", () => {
  it("should name one value, a list and a negation when cells are written the three ways", () => {
    expect(describeCell("a")).toBe("`a`");
    expect(describeCell(["a", "b", "c"])).toBe("one of `a`, `b` or `c`");
    expect(describeCell({ notIn: ["a"] })).toBe("not `a`");
  });
});

describe("a trigger, completion and cancellation of ET1 Vetting", () => {
  const vetting = task("Et1Vetting");

  it("should say each creating event leaves the case in Submitted when the task is created", () => {
    expect(resolveTriggers(et, vetting, "et_englandwales").map(describeTrigger)).toEqual([
      "Created when `SUBMIT_CASE_DRAFT` leaves the case in `Submitted`",
      "Created when `initiateCase` leaves the case in `Submitted`",
      "Created when `submitEt1Draft` leaves the case in `Submitted`",
      "Created when `createEcmCase` leaves the case in `Submitted`"
    ]);
  });

  it("should say the completion is automatic when the task is completed by an event", () => {
    expect(resolveCompletions(et, vetting, "et_scotland").map(describeCompletion)).toEqual(["Completed by `preAcceptanceCase` (auto)"]);
  });

  it("should say which events cancel it, by its category, when rules name the category", () => {
    expect(rulesForTask(et, vetting, "et_englandwales").map(describeTaskRule)).toEqual([
      'Cancelled when one of `disposeCase`, `rollbackMigrateCase` or `caseTransferECM` happens (categories "Vetting", "Processing", "Hearing", "Judgment", "Application", "Amendments" and "ArrangeSupport")'
    ]);
  });

  it("should find no cancelling rules when the task is not for that case type", () => {
    expect(rulesForTask(et, vetting, "et_englandwales_multiple")).toEqual([]);
  });

  it("should say which case types have no value when a value is set for only some of them", () => {
    const some: Task = { id: "T", due: { days: { value: 5, only: ["et_englandwales"] } } };
    expect(briefAcrossCaseTypes(et, some, (id) => briefVal(some.due?.days, id, caseTypeIds(et)))).toBe(
      "5 (et_englandwales); none (et_englandwales_multiple, et_scotland, et_scotland_multiple)"
    );
    expect(briefAcrossCaseTypes(et, some, () => "")).toBe("");
  });

  it("should find the reconfigure rules that name no category, or the task's, when the task is reconfigured", () => {
    expect(reconfigureRules(et, task("Et1Vetting"), "et_englandwales").map((r) => r.rule.id)).toContain("Reconfigure-addAmendHearing");
    const mixed = {
      ...et,
      cancellations: [
        { id: "a", events: "x", action: "Reconfigure", categories: ["Vetting"] },
        { id: "b", events: "x", action: "Reconfigure", categories: ["Other"] },
        { id: "c", events: "x", action: "Reconfigure", categories: [{ feel: "y" }] }
      ]
    } as Model;
    expect(reconfigureRules(mixed, task("Et1Vetting"), "et_scotland").map((r) => [r.rule.id, r.mayApply])).toEqual([
      ["a", false],
      ["c", true]
    ]);
  });

  it("should include the warning and the note when a rule warns", () => {
    expect(
      describeCancellation({ events: "x", action: "Warn", warning: { code: "TA01", text: "Mind the gap" }, categories: ["Vetting"], note: "Agreed with BA" })
    ).toBe('Warns when `x` happens (category "Vetting"), warning "TA01": "Mind the gap". Note: Agreed with BA');
  });

  it("should say what a trigger names and sets when it has an initial name and outputs", () => {
    expect(describeTrigger({ event: "a", postState: "S", initialName: "Name A", outputs: { workingDaysAllowed: 5 } })).toBe(
      'Created when `a` leaves the case in `S`, named "Name A", with workingDaysAllowed 5'
    );
  });

  it("should split permissions on commas when a list holds one comma-separated string", () => {
    expect(permissionNames(["Read,Own,Claim"])).toEqual(["Read", "Own", "Claim"]);
    expect(permissionNames("Read, Own")).toEqual(["Read", "Own"]);
  });

  it("should list a grant's authorisations, case access category and own category when they are set", () => {
    expect(grantConditions({ perms: "Read", authorisations: "294", caseAccessCategory: "civil", category: "CTSC" }, "JUDICIAL")).toEqual([
      "needs authorisation 294",
      "case access category civil",
      "counts as category CTSC"
    ]);
    expect(grantConditions({ perms: "Read", category: "ADMIN" }, "ADMIN")).toEqual([]);
  });

  it("should find a rule with no categories when it is for the task's case type, since it is about every task", () => {
    const every = { ...et, cancellations: [{ events: "withdraw", action: "Cancel", only: ["et_scotland"] }] } as Model;
    expect(rulesForTask(every, vetting, "et_scotland")).toEqual([{ rule: every.cancellations?.[0], mayApply: false }]);
    expect(rulesForTask(every, vetting, "et_englandwales")).toEqual([]);
  });

  it("should say a rule may apply when its category is calculated", () => {
    const computed = { ...et, cancellations: [{ events: "x", action: "Cancel", categories: [{ feel: "caseData.category" }] }] } as Model;
    expect(rulesForTask(computed, vetting, "et_scotland").map((r) => r.mayApply)).toEqual([true]);
    expect(describeTaskRule((rulesForTask(computed, vetting, "et_scotland") as [TaskRule])[0])).toMatch(/May apply/);
  });

  it("should say a rule may apply when the task's own category is calculated", () => {
    const named = { ...et, cancellations: [{ events: "x", action: "Cancel", categories: ["Elsewhere"] }] } as Model;
    expect(rulesForTask(named, task("ReviewReferralAdmin"), "et_englandwales").map((r) => r.mayApply)).toEqual([true]);
    expect(rulesForTask(named, vetting, "et_englandwales")).toEqual([]);
  });

  it("should say the task is not for multiples when its case types are listed", () => {
    expect(taskCaseTypes(et, vetting)).toEqual(["et_englandwales", "et_scotland"]);
  });
});

describe("a trigger with a condition", () => {
  it("should add the condition to the sentence when the creating event has a when", () => {
    const [first, second] = resolveTriggers(et, task("ReviewReferralAdmin"), "et_englandwales").map(describeTrigger);
    expect(first).toBe("Created when `createReferral` happens if `referCaseTo` is `Admin`");
    expect(second).toBe("Created when `updateReferral` happens if `updateReferCaseTo` is `Admin`");
  });

  it("should leave out an event that is only for another case type when the case type differs", () => {
    expect(resolveTriggers(et, task("ReviewReferralAdmin"), "et_scotland").map((t) => describeCell(t.event))).toEqual(["`createReferral`"]);
  });
});

describe("cancelCategories", () => {
  it("should say a category is calculated when it is built from case data", () => {
    expect(cancelCategories(et, task("ReviewReferralAdmin"), "et_englandwales").calculated).toBe(true);
    expect(cancelCategories(et, task("Et1Vetting"), "et_englandwales")).toEqual({ named: ["Vetting"], calculated: false });
  });

  it("should leave out the category of a trigger that is not for the case type when categories are scoped", () => {
    const scoped: Task = {
      id: "T",
      cancelCategory: "Base",
      create: [
        { event: "a", only: ["et_englandwales"], cancelCategory: "OnlyEw" },
        { event: "b", only: ["et_scotland"] }
      ]
    };
    expect(cancelCategories(et, scoped, "et_englandwales").named).toEqual(["OnlyEw"]);
    expect(cancelCategories(et, scoped, "et_scotland").named).toEqual(["Base"]);
  });
});

describe("groupByCaseType", () => {
  it("should group case types that agree and keep those that differ apart when a value varies", () => {
    const groups = groupByCaseType(["a", "b", "c"], (id) => (id === "c" ? 2 : 1));
    expect(groups).toEqual([
      { caseTypes: ["a", "b"], value: 1 },
      { caseTypes: ["c"], value: 2 }
    ]);
  });

  it("should group ET's case types by the default location each has when the location differs per case type", () => {
    const entries = et.defaults?.configuration?.filter((attribute) => attribute.name === "location") ?? [];
    const groups = groupByCaseType(caseTypeIds(et), (id) => {
      const entry = entries.find((attribute) => (attribute.only ?? caseTypeIds(et)).includes(id));
      return entry === undefined ? undefined : describeExpr(entry.value);
    });
    expect(groups.map((group) => group.caseTypes)).toEqual([["et_englandwales"], ["et_englandwales_multiple"], ["et_scotland", "et_scotland_multiple"]]);
    expect(groups.map((group) => group.value?.match(/"(\d+)"$/)?.[1])).toEqual(["369230", "21153", "368308"]);
  });
});

describe("resolvePermissions", () => {
  it("should resolve the profile's roles and add what every task grants when a task uses a profile", () => {
    const rows = resolvePermissions(et, task("Et1Vetting"), "et_englandwales");
    const admin = rows.find((row) => row.role === "hearing-centre-admin");
    expect(admin).toMatchObject({
      perms: ["Read", "Own", "Manage", "Claim", "Unclaim", "UnclaimAssign", "CompleteOwn"],
      priority: "4",
      autoAssign: "false",
      category: "ADMIN",
      source: "profile",
      profile: "adminAndCtscWorker"
    });
    expect(rows.find((row) => row.role === "task-supervisor")).toMatchObject({ source: "default", autoAssign: "false" });
    expect(rows.find((row) => row.role === "allocated-admin-caseworker")?.autoAssign).toBe("true");
  });

  it("should apply a per-task change on top of the profile when a task overrides, adds or removes", () => {
    const base = {
      ...task("Et1Vetting"),
      permissions: {
        profile: "adminWorker",
        remove: ["hearing-centre-team-leader"],
        override: { "hearing-centre-admin": { priority: 9 } },
        add: { ctsc: { perms: ["Read"] } }
      }
    };
    const rows = resolvePermissions(et, base, "et_englandwales");
    expect(rows.some((row) => row.role === "hearing-centre-team-leader")).toBe(false);
    expect(rows.find((row) => row.role === "hearing-centre-admin")).toMatchObject({ priority: "9", source: "changed" });
    expect(rows.find((row) => row.role === "ctsc")).toMatchObject({ perms: ["Read"], source: "added" });
  });

  it("should order the grid's columns as WA lists them when permissions are gathered", () => {
    expect(permissionColumns([{ perms: ["Cancel", "Read", "Zed"] }, { perms: ["Own", "Alpha"] }])).toEqual(["Read", "Own", "Cancel", "Alpha", "Zed"]);
  });
});

describe("the roles and the board", () => {
  it("should list the roles under their categories when roles are grouped", () => {
    const groups = rolesByCategory(et);
    expect(groups.map((g) => g.category)).toEqual(["ADMIN", "CTSC", "JUDICIAL", "LEGAL_OPERATIONS", "No category"]);
    expect(groups[4]?.roles).toEqual(["task-supervisor"]);
  });

  it("should list the tasks that use a profile when the profile is looked up", () => {
    expect(tasksUsingProfile(et, "adminWorker").length).toBeGreaterThan(0);
    expect(tasksUsingProfile(et, "adminAndCtscWorker").map((t) => t.id)).toContain("Et1Vetting");
  });

  it("should group every task by role category when no case type is chosen", () => {
    const groups = boardGroups(et, "roleCategory");
    expect(groups.map((g) => g.group)).toContain("ADMIN");
    expect(groups.flatMap((g) => g.tasks).some((t) => t.task.id === "Et1Vetting")).toBe(true);
  });

  it("should leave out tasks of other case types when one case type is chosen", () => {
    const ids = boardGroups(et, "workType", "et_scotland_multiple").flatMap((g) => g.tasks.map((t) => t.task.id));
    expect(ids).not.toContain("Et1Vetting");
    expect(ids).toContain("ReviewReferralAdminMultiple");
  });

  it("should name a task from its name when it has a plain one", () => {
    expect(taskName(et, task("Et1Vetting"))).toBe("ET1 Vetting");
  });
});
