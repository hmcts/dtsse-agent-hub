import { describe, expect, it } from "vitest";
import { ET_SHEETS } from "./__fixtures__/et-sheets.ts";
import { readCcdDefinition } from "./lifecycle.ts";

describe("readCcdDefinition", () => {
  const [lifecycle] = readCcdDefinition(ET_SHEETS);
  const event = (id: string) => lifecycle?.events.find((e) => e.id === id);

  it("should read the states and events of a case type when the sheets are ET's", () => {
    expect(readCcdDefinition(ET_SHEETS)).toHaveLength(1);
    expect(lifecycle?.caseType).toBe("ET_EnglandWales");
    expect(lifecycle?.states.map((s) => s.id)).toContain("AWAITING_SUBMISSION_TO_HMCTS");
    expect(lifecycle?.states.find((s) => s.id === "AWAITING_SUBMISSION_TO_HMCTS")?.name).toBe("Awaiting Submission to HMCTS");
    expect(event("SUBMIT_CASE_DRAFT")).toMatchObject({ preStates: ["AWAITING_SUBMISSION_TO_HMCTS"], postState: "Submitted", publish: true });
  });

  it("should leave the pre-states empty when an event creates the case", () => {
    expect(event("initiateCase")?.preStates).toEqual([]);
  });

  it("should read * for every state when the pre- or post-state is *", () => {
    expect(event("createReferral")).toMatchObject({ preStates: "*", postState: "*" });
  });

  it("should keep the states of a conditional post-state when it carries a condition and a priority", () => {
    expect(event("preAcceptanceCase")).toMatchObject({ preStates: ["Accepted", "Rejected", "Vetted"], postState: "Accepted", otherPostStates: ["Rejected"] });
  });

  it("should read an event as unpublished when it has no Publish column", () => {
    expect(event("et1Vetting")?.publish).toBe(false);
  });

  it("should refuse the definition when an event is defined twice for a case type", () => {
    const row = { CaseTypeID: "X", ID: "e" };
    expect(() => readCcdDefinition({ CaseType: [{ ID: "X" }], CaseEvent: [row, row] })).toThrow("event e of X is defined more than once");
  });

  it("should read nothing when the sheets are absent", () => {
    expect(readCcdDefinition({})).toEqual([]);
  });

  it("should name a state and an event by its id when it has no name", () => {
    const [only] = readCcdDefinition({
      CaseType: [{ ID: "X" }],
      State: [{ CaseTypeID: "X", ID: "S" }],
      CaseEvent: [{ CaseTypeID: "X", ID: "e", PostConditionState: "" }]
    });
    expect(only?.states).toEqual([{ id: "S", name: "S" }]);
    expect(only?.events).toEqual([{ id: "e", name: "e", preStates: [], postState: "*", publish: false }]);
  });
});
