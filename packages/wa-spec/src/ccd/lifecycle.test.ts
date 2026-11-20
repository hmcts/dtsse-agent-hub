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
    expect(() => readCcdDefinition({ CaseType: [{ ID: "X" }], CaseEvent: [row, row] })).toThrow(
      "event e of X is defined in CaseEvent row 1 and CaseEvent row 2"
    );
  });

  it("should check for repeated events only in the case types asked for", () => {
    const row = { CaseTypeID: "Y", ID: "e" };
    const files = { CaseType: [{ ID: "X" }, { ID: "Y" }], CaseEvent: [{ CaseTypeID: "X", ID: "e" }, row, row] };
    expect(readCcdDefinition(files, ["x"]).map((l) => l.caseType)).toEqual(["X"]);
    expect(() => readCcdDefinition(files, ["Y"])).toThrow("event e of Y is defined in CaseEvent row 2 and CaseEvent row 3");
  });

  it("should name both files of a repeated event and suggest excluding one when they differ by a variant suffix", () => {
    const row = { CaseTypeID: "X", ID: "e" };
    const files = { CaseType: [{ ID: "X" }], CaseEvent: [row, row] };
    const where = (_sheet: string, index: number) => `defs/CaseEvent/${["CaseEvent-prod.json", "CaseEvent-nonprod.json"][index]} row 1`;
    expect(() => readCcdDefinition(files, undefined, where)).toThrow(
      /defined in defs\/CaseEvent\/CaseEvent-prod\.json row 1 and defs\/CaseEvent\/CaseEvent-nonprod\.json row 1.*--env or --exclude/
    );
    const other = (_sheet: string, index: number) => `defs/CaseEvent/${["A.json", "B.json"][index]} row 1`;
    expect(() => readCcdDefinition(files, undefined, other)).not.toThrow(/--exclude/);
  });

  it("should flag an event whose about-to-submit callback URL is set", () => {
    const [only] = readCcdDefinition({
      CaseType: [{ ID: "X" }],
      CaseEvent: [
        { CaseTypeID: "X", ID: "a", PostConditionState: "S", CallBackURLAboutToSubmitEvent: "http://x/a" },
        { CaseTypeID: "X", ID: "b", PostConditionState: "S", CallBackURLAboutToSubmitEvent: "" }
      ]
    });
    expect(only?.events.map((e) => e.aboutToSubmitCallback)).toEqual([true, undefined]);
  });

  it("should read Publish as true when it is Y, Yes, T or True in any case", () => {
    const read = (Publish: string) =>
      readCcdDefinition({ CaseType: [{ ID: "X" }], CaseEvent: [{ CaseTypeID: "X", ID: "e", PostConditionState: "S", Publish }] })[0]?.events[0]?.publish;
    expect([read("Y"), read("True"), read("yes"), read("T"), read("N"), read("False"), read("f")]).toEqual([true, true, true, true, false, false, false]);
  });

  it("should keep a * beside named post-states as the case staying put", () => {
    const [only] = readCcdDefinition({ CaseType: [{ ID: "X" }], CaseEvent: [{ CaseTypeID: "X", ID: "e", PostConditionState: 'Paid(paid="Yes"):1;*' }] });
    expect(only?.events[0]).toMatchObject({ postState: "Paid", otherPostStates: ["*"] });
    expect(only?.events[0]?.postStateFromCallback).toBeUndefined();
  });

  it("should read nothing when the sheets are absent", () => {
    expect(readCcdDefinition({})).toEqual([]);
  });

  it("should name a state and an event by its id, and leave its post-state to the callback, when it has no name or post-state", () => {
    const [only] = readCcdDefinition({
      CaseType: [{ ID: "X" }],
      State: [{ CaseTypeID: "X", ID: "S" }],
      CaseEvent: [{ CaseTypeID: "X", ID: "e", PostConditionState: "" }]
    });
    expect(only?.states).toEqual([{ id: "S", name: "S" }]);
    expect(only?.events).toEqual([{ id: "e", name: "e", preStates: [], postState: "*", postStateFromCallback: true, publish: false }]);
  });
});
