import { describe, expect, it } from "vitest";
import type { Decision, Expr, Row, Spec } from "../schema.ts";
import { ET_SHEETS } from "./__fixtures__/et-sheets.ts";
import { type Lifecycle, readCcdDefinition } from "./lifecycle.ts";
import { overlayTasks } from "./overlay.ts";

const decision = (rows: Row[], inputs: string[], outputs: string[], extra: Partial<Decision> = {}): Decision => ({
  name: "d",
  hitPolicy: "COLLECT",
  inputs: inputs.map((key) => ({ key })),
  outputs: outputs.map((name) => ({ name })),
  rows,
  ...extra
});

const specWith = (decisions: { initiation?: Row[]; completion?: Row[]; cancellation?: Row[] }, caseTypes = ["et_englandwales"]): Spec => ({
  version: 1,
  service: { slug: "employment" },
  caseTypes: caseTypes.map((id) => ({ id })),
  decisions: {
    initiation: decision(decisions.initiation ?? [], ["eventId", "postEventState"], ["taskId", "processCategories"]),
    completion: decision(decisions.completion ?? [], ["eventID"], ["taskType", "completionMode"]),
    cancellation: decision(decisions.cancellation ?? [], ["fromState", "event", "state"], ["action", "processCategories"])
  }
});

const vetting: Row[] = [
  { when: { eventId: { in: ["SUBMIT_CASE_DRAFT"] }, postEventState: { in: ["Submitted"] } }, returns: { taskId: "Et1Vetting", processCategories: "Vetting" } },
  { when: { eventId: { in: ["initiateCase"] } }, returns: { taskId: "Et1Vetting", processCategories: "Vetting" } }
];
const [et] = readCcdDefinition(ET_SHEETS) as [Lifecycle];

describe("overlayTasks", () => {
  it("should list the events that create, complete and cancel a task when the spec names them", () => {
    const spec = specWith({
      initiation: vetting,
      completion: [{ when: { eventID: { in: ["preAcceptanceCase"] } }, returns: { taskType: "Et1Vetting", completionMode: "Auto" } }],
      cancellation: [{ when: { event: { in: ["disposeCase"] } }, returns: { action: "Cancel", processCategories: "Vetting" } }]
    });
    const { events, warnings } = overlayTasks(et, spec);
    expect(events.SUBMIT_CASE_DRAFT?.creates).toEqual(["Et1Vetting"]);
    expect(events.initiateCase?.creates).toEqual(["Et1Vetting"]);
    expect(events.preAcceptanceCase?.completes).toEqual(["Et1Vetting"]);
    expect(events.disposeCase?.cancels).toEqual(["Et1Vetting"]);
    expect(warnings).toEqual([]);
  });

  it("should list a reconfiguring event and no cancel when the action is Reconfigure", () => {
    const spec = specWith({
      initiation: vetting,
      cancellation: [{ when: { event: { in: ["disposeCase"] } }, returns: { action: "Reconfigure" } }]
    });
    const { events } = overlayTasks(et, spec);
    expect(events.disposeCase).toEqual({ creates: [], completes: [], cancels: [], reconfigures: ["Et1Vetting"] });
  });

  it("should not list an event twice when two rows name it for one task", () => {
    const spec = specWith({ initiation: [...vetting, ...vetting] });
    expect(overlayTasks(et, spec).events.initiateCase?.creates).toEqual(["Et1Vetting"]);
  });

  it("should ignore rows of other case types and a decision of other case types when they are scoped away", () => {
    const base = specWith({ initiation: [{ ...vetting[0], only: ["other"] } as Row], completion: vetting });
    base.decisions.completion = { ...(base.decisions.completion as Decision), only: ["other"] };
    expect(overlayTasks(et, base).events).toEqual({});
  });

  it("should warn once per event when a creating, completing or cancelling event is not published", () => {
    const spec = specWith({
      initiation: [{ when: { eventId: { in: ["et1Vetting"] } }, returns: { taskId: "T", processCategories: "C" } }],
      completion: [{ when: { eventID: { in: ["et1Vetting"] } }, returns: { taskType: "T" } }],
      cancellation: [{ when: { event: { in: ["caseTransferECM"] } }, returns: { action: "Cancel", processCategories: "C" } }]
    });
    expect(overlayTasks(et, spec).warnings).toEqual([
      "et1Vetting creates and completes tasks but is not Publish: Y, so Work Allocation never sees it",
      "caseTransferECM cancels tasks but is not Publish: Y, so Work Allocation never sees it"
    ]);
  });

  it("should warn of an event or state the definition does not have when the spec names it", () => {
    const spec = specWith({
      initiation: [{ when: { eventId: { in: ["requestSupport"] }, postEventState: { in: ["Nowhere"] } }, returns: { taskId: "T" } }],
      completion: [{ when: { eventID: { in: ["gone"] } }, returns: { taskType: "T" } }],
      cancellation: [{ when: { event: { in: ["initiateCase"] }, fromState: { in: ["Lost"] }, state: { in: ["Vetted"] } }, returns: { action: "Warn" } }]
    });
    const { events, warnings } = overlayTasks(et, spec);
    expect(warnings).toEqual([
      "the spec names the event requestSupport, which ET_EnglandWales does not define",
      "the spec names the event gone, which ET_EnglandWales does not define",
      "the spec names the state Nowhere, which ET_EnglandWales does not define",
      "the spec names the state Lost, which ET_EnglandWales does not define"
    ]);
    expect(events).toEqual({});
  });

  it("should warn when the state a task is created in is not one the event leaves the case in", () => {
    const spec = specWith({
      initiation: [{ when: { eventId: { in: ["SUBMIT_CASE_DRAFT"] }, postEventState: { in: ["Vetted"] } }, returns: { taskId: "T", processCategories: "C" } }]
    });
    expect(overlayTasks(et, spec).warnings).toEqual(["task T is created on SUBMIT_CASE_DRAFT in Vetted, which the definition leaves in Submitted"]);
  });

  it("should warn when a cancel event cannot start from any state the task can be in", () => {
    const lifecycle: Lifecycle = {
      caseType: "X",
      states: ["A", "B", "C"].map((id) => ({ id, name: id })),
      events: [
        { id: "start", name: "start", preStates: [], postState: "A", publish: true },
        { id: "move", name: "move", preStates: ["A"], postState: "B", publish: true },
        { id: "reopen", name: "reopen", preStates: ["C"], postState: "A", publish: true },
        { id: "stop", name: "stop", preStates: ["C"], postState: "*", publish: true },
        { id: "end", name: "end", preStates: ["B"], postState: "*", publish: true }
      ]
    };
    const spec = specWith(
      {
        initiation: [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T", processCategories: "Cat" } }],
        cancellation: [
          { when: { event: { in: ["stop"] } }, returns: { action: "Cancel", processCategories: "Cat" } },
          { when: { event: { in: ["end"] } }, returns: { action: "Cancel", processCategories: "Cat" } }
        ]
      },
      ["x"]
    );
    expect(overlayTasks(lifecycle, spec).warnings).toEqual(["stop cancels task T from C, but the task exists only in A, B"]);
  });

  it("should not warn about a cancel event when the task can be created in any state or the event starts from any", () => {
    const lifecycle: Lifecycle = {
      caseType: "X",
      states: [{ id: "A", name: "A" }],
      events: [
        { id: "start", name: "start", preStates: [], postState: "*", publish: true },
        { id: "stop", name: "stop", preStates: ["A"], postState: "A", publish: true },
        { id: "any", name: "any", preStates: "*", postState: "A", publish: true }
      ]
    };
    const spec = specWith(
      {
        initiation: [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T" } }],
        cancellation: [{ when: { event: { in: ["stop", "any"] } }, returns: { action: "Cancel" } }]
      },
      ["x"]
    );
    const { events, warnings } = overlayTasks(lifecycle, spec);
    expect(warnings).toEqual([]);
    expect(events.stop?.cancels).toEqual(["T"]);
  });

  it("should warn that the spec has no case type when the lifecycle's is not one of its own", () => {
    expect(overlayTasks(et, specWith({}, ["other"]))).toEqual({ events: {}, warnings: ["the spec has no case type ET_EnglandWales"] });
  });

  it("should list a computed task under its event and leave a row alone when its event is a FEEL cell", () => {
    const spec = specWith({
      initiation: [
        { when: { eventId: { feel: "contains(x)" } }, returns: { taskId: "T" } },
        { when: { eventId: { in: ["initiateCase"] } }, returns: { taskId: { field: "x" } } }
      ]
    });
    expect(overlayTasks(et, spec)).toEqual({
      events: { initiateCase: { creates: ["computed task"], completes: [], cancels: [], reconfigures: [] } },
      warnings: []
    });
  });

  it("should read the event column under whichever spelling the spec's table uses", () => {
    const spec = specWith({ completion: [{ when: { eventId: { in: ["preAcceptanceCase"] } }, returns: { taskType: "Et1Vetting" } }] });
    expect(overlayTasks(et, spec).events.preAcceptanceCase?.completes).toEqual(["Et1Vetting"]);
  });

  it("should reach every state from an event whose post-state the callback chooses when a cancel event starts from a later state", () => {
    const lifecycle: Lifecycle = {
      caseType: "X",
      states: ["A", "B"].map((id) => ({ id, name: id })),
      events: [
        { id: "start", name: "start", preStates: [], postState: "A", publish: true },
        { id: "jump", name: "jump", preStates: ["A"], postState: "*", postStateFromCallback: true, publish: true },
        { id: "stop", name: "stop", preStates: ["B"], postState: "A", publish: true }
      ]
    };
    const spec = specWith(
      {
        initiation: [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T", processCategories: "C" } }],
        cancellation: [{ when: { event: { in: ["stop"] } }, returns: { action: "Cancel", processCategories: "C" } }]
      },
      ["x"]
    );
    expect(overlayTasks(lifecycle, spec).warnings).toEqual([]);
  });

  it("should list a computed-category cancellation as a possible cancel of every task it may match and warn of nothing else", () => {
    const spec = specWith({
      initiation: [
        { when: { eventId: { in: ["initiateCase"] } }, returns: { taskId: "Plain", processCategories: "Vetting" } },
        { when: { eventId: { in: ["SUBMIT_CASE_DRAFT"] } }, returns: { taskId: "Referral", processCategories: { field: "CURRENT_REFERRAL" } } }
      ],
      cancellation: [{ when: { event: { in: ["disposeCase"] } }, returns: { action: "Cancel", processCategories: { feel: "x" } } }]
    });
    const { events, warnings } = overlayTasks(et, spec);
    expect(events.disposeCase).toEqual({ creates: [], completes: [], cancels: [], reconfigures: [], mayCancel: ["Plain", "Referral"] });
    expect(warnings).toEqual([]);
  });

  it("should not warn that the state of a task's creation differs when the event may leave the case where it is", () => {
    const lifecycle: Lifecycle = {
      caseType: "X",
      states: ["A", "B"].map((id) => ({ id, name: id })),
      events: [{ id: "orders", name: "orders", preStates: ["A", "B"], postState: "B", otherPostStates: ["*"], publish: true }]
    };
    const spec = specWith({ initiation: [{ when: { eventId: { in: ["orders"] }, postEventState: { in: ["A"] } }, returns: { taskId: "T" } }] }, ["x"]);
    expect(overlayTasks(lifecycle, spec).warnings).toEqual([]);
  });

  const chain: Lifecycle = {
    caseType: "X",
    states: ["A", "B", "C"].map((id) => ({ id, name: id })),
    events: [
      { id: "start", name: "start", preStates: [], postState: "A", publish: true },
      { id: "stop", name: "stop", preStates: ["B", "C"], postState: "A", publish: true }
    ]
  };

  it("should start a task in every state when the row that creates it has an event cell that cannot be read", () => {
    const spec = specWith(
      {
        initiation: [{ when: { eventId: { feel: "contains(x)" } }, returns: { taskId: "T", processCategories: "Cat" } }],
        cancellation: [{ when: { event: { in: ["stop"] } }, returns: { action: "Cancel", processCategories: "Cat" } }]
      },
      ["x"]
    );
    const { events, warnings } = overlayTasks(chain, spec);
    expect(warnings).toEqual([]);
    expect(events.stop?.cancels).toEqual(["T"]);
  });

  it("should cancel every task when a cancellation row's process category is null", () => {
    const spec = specWith(
      {
        initiation: [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T", processCategories: null } }],
        cancellation: [{ when: { event: { in: ["stop"] } }, returns: { action: "Cancel", processCategories: null } }]
      },
      ["x"]
    );
    expect(overlayTasks(chain, spec).events).toEqual({
      start: { creates: ["T"], completes: [], cancels: [], reconfigures: [] },
      stop: { creates: [], completes: [], cancels: ["T"], reconfigures: [] }
    });
  });

  it("should warn of a state in a cancellation row's fromState, state or toState that the definition lacks", () => {
    const spec = specWith(
      { cancellation: [{ when: { fromState: { in: ["Gone1"] }, state: { in: ["Gone2"] }, toState: { in: ["Gone3"] } }, returns: { action: "Cancel" } }] },
      ["x"]
    );
    expect(overlayTasks(chain, spec).warnings).toEqual([
      "the spec names the state Gone1, which X does not define",
      "the spec names the state Gone2, which X does not define",
      "the spec names the state Gone3, which X does not define"
    ]);
  });

  it("should check a cancel event from the states its row's fromState leaves it when the row names them", () => {
    const initiation: Row[] = [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T", processCategories: "Cat" } }];
    const row = (fromState: string): Row => ({
      when: { event: { in: ["stop"] }, fromState: { in: [fromState] } },
      returns: { action: "Cancel", processCategories: "Cat" }
    });
    expect(overlayTasks(chain, specWith({ initiation, cancellation: [row("B")] }, ["x"])).warnings).toEqual([
      "stop cancels task T from B, but the task exists only in A"
    ]);
    expect(overlayTasks(chain, specWith({ initiation, cancellation: [row("A")] }, ["x"])).warnings).toEqual([
      "a cancellation row from A can never fire for stop, which starts from B, C"
    ]);
  });

  it("should leave out an event with no task, and list an event a computed-category row cancels or reconfigures", () => {
    const spec = specWith({
      initiation: [{ when: { eventId: { in: ["initiateCase"] } }, returns: { taskId: "T", processCategories: "Cat" } }],
      cancellation: [
        { when: { event: { in: ["disposeCase"] } }, returns: { action: "Warn" } },
        { when: { event: { in: ["caseTransferECM"] } }, returns: { action: "Cancel", processCategories: { feel: "x" } } },
        { when: { event: { in: ["et1Vetting"] } }, returns: { action: "Reconfigure", processCategories: { feel: "x" } } }
      ]
    });
    const { events, warnings } = overlayTasks(et, spec);
    expect(events.caseTransferECM?.mayCancel).toEqual(["T"]);
    expect(events.et1Vetting?.reconfigures).toEqual(["T"]);
    expect(Object.keys(events)).toEqual(["initiateCase", "caseTransferECM", "et1Vetting"]);
    expect(warnings).toEqual([
      "caseTransferECM may cancel tasks but is not Publish: Y, so Work Allocation never sees it",
      "et1Vetting reconfigures tasks but is not Publish: Y, so Work Allocation never sees it"
    ]);
  });

  it("should list a computed task type under the event that completes it", () => {
    const spec = specWith({ completion: [{ when: { eventID: { in: ["preAcceptanceCase"] } }, returns: { taskType: { field: "x" } } }] });
    expect(overlayTasks(et, spec).events.preAcceptanceCase?.completes).toEqual(["computed task"]);
  });

  it("should warn of a category cancellation only when none of the tasks of the category can be in the states it cancels from", () => {
    const lifecycle: Lifecycle = {
      caseType: "X",
      states: ["A", "B", "C"].map((id) => ({ id, name: id })),
      events: [
        { id: "startA", name: "startA", preStates: [], postState: "A", publish: true },
        { id: "startB", name: "startB", preStates: [], postState: "B", publish: true },
        { id: "stop", name: "stop", preStates: ["A", "C"], postState: "*", publish: true }
      ]
    };
    const create = (event: string, taskId: string): Row => ({ when: { eventId: { in: [event] } }, returns: { taskId, processCategories: "Cat" } });
    const cancel: Row = { when: { event: { in: ["stop"] } }, returns: { action: "Cancel", processCategories: "Cat" } };
    expect(overlayTasks(lifecycle, specWith({ initiation: [create("startA", "T1"), create("startB", "T2")], cancellation: [cancel] }, ["x"])).warnings).toEqual(
      []
    );
    expect(overlayTasks(lifecycle, specWith({ initiation: [create("startB", "T2"), create("startB", "T3")], cancellation: [cancel] }, ["x"])).warnings).toEqual(
      ["stop cancels tasks T2, T3 from A, C, but they exist only in B"]
    );
  });

  it("should match a literal category against a computed one in both directions, as a possible cancel", () => {
    const either = (when: Row["returns"]): Row => ({ when: { eventId: { in: ["initiateCase"] } }, returns: { taskId: "T", ...when } });
    const cond = { if: { field: "x", op: "exists" as const }, use: "Vetting", otherwise: "Other" };
    const cancel = (processCategories: Expr): Row => ({ when: { event: { in: ["disposeCase"] } }, returns: { action: "Cancel", processCategories } });
    const run = (initiation: Row, cancellation: Row) =>
      overlayTasks(et, specWith({ initiation: [initiation], cancellation: [cancellation] })).events.disposeCase;
    expect(run(either({ processCategories: cond }), cancel("Vetting"))).toMatchObject({ cancels: [], mayCancel: ["T"] });
    expect(run(either({ processCategories: "Vetting" }), cancel(cond))).toMatchObject({ cancels: [], mayCancel: ["T"] });
    expect(run(either({ processCategories: "Vetting" }), cancel("Hearing"))).toBeUndefined();
  });

  it("should say an about-to-submit callback may move the case when the event or a state-changing event has one", () => {
    const withCallback = (lifecycle: Lifecycle): Lifecycle => ({
      ...lifecycle,
      events: lifecycle.events.map((e) => ({ ...e, aboutToSubmitCallback: true as const }))
    });
    const created = specWith({
      initiation: [{ when: { eventId: { in: ["SUBMIT_CASE_DRAFT"] }, postEventState: { in: ["Vetted"] } }, returns: { taskId: "T", processCategories: "C" } }]
    });
    expect(overlayTasks(withCallback(et), created).warnings).toEqual([
      "task T is created on SUBMIT_CASE_DRAFT in Vetted, which the definition leaves in Submitted unless SUBMIT_CASE_DRAFT's about-to-submit callback moves the case"
    ]);
    const cancelled = specWith(
      {
        initiation: [{ when: { eventId: { in: ["start"] } }, returns: { taskId: "T", processCategories: "Cat" } }],
        cancellation: [{ when: { event: { in: ["stop"] }, fromState: { in: ["B"] } }, returns: { action: "Cancel", processCategories: "Cat" } }]
      },
      ["x"]
    );
    expect(overlayTasks(withCallback(chain), cancelled).warnings).toEqual([
      "stop cancels task T from B, but the task exists only in A unless an about-to-submit callback moves the case"
    ]);
  });
});
