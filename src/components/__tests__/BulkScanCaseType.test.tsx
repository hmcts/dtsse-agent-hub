/**
 * @vitest-environment jsdom
 */

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseCandidate, chooseNew, editNewField } from "@/bulk-scan/case-type";
import { BulkScanCaseTypePicker, NO_CHAT } from "@/components/assistant/BulkScanCaseTypePicker";
import { BulkScanCcdStatus } from "@/components/assistant/BulkScanCcdStatus";
import { BulkScanDetail } from "@/components/assistant/BulkScanDetail";
import { BulkScanEditor } from "@/components/assistant/BulkScanEditor";
import { BulkScanUpload } from "@/components/assistant/BulkScanUpload";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const CASE_TYPES = [
  { product: "sptribs", service: "sptribs", case_type: "CriminalInjuriesCompensation", config: "config-generator" },
  { product: "nfdiv", service: "nfdiv", case_type: "NFD", config: "config-generator" }
];
const ROWS = [
  { ID: "cicCaseEmail", Label: "Subject's email address", FieldType: "Email" },
  { ID: "cicCaseApplicantEmailAddress", Label: "Applicant's email address", FieldType: "Email" }
];

type Answer = { kind: string; answer: object };
let answers: Answer[] = [];
let asked: { kind: string; args: unknown }[] = [];
let pending: Record<string, object> = {};

/** The hub's pod job routes: a POST starts a job and answers its kind's canned answer on the first read. */
function podJobs(request: { status?: string } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/ui/assistant/pod-jobs/") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { kind: string; args: unknown };
      asked.push(body);
      if (request.status !== undefined) {
        return Response.json({ status: request.status });
      }
      const id = `job-${asked.length}`;
      pending[id] = answers.find((a) => a.kind === body.kind)?.answer ?? { status: "failed", error: "failed" };
      return Response.json({ status: "pending", job_id: id });
    }
    if (url.startsWith("/api/ui/assistant/pod-jobs/")) {
      const id = url.split("/").pop() as string;
      return Response.json({ job_id: id, ...(pending[id] as object) });
    }
    return Response.json({ ids: ["abc"] }, { status: 201 });
  });
}

const fetchMock = vi.fn();
beforeEach(() => {
  answers = [
    { kind: "ccd.case-types", answer: { status: "done", kind: "ccd.case-types", result: { case_types: CASE_TYPES } } },
    { kind: "ccd.case-type-fields", answer: { status: "done", kind: "ccd.case-type-fields", result: { fields: ROWS, total: 3, omitted: 0 } } }
  ];
  asked = [];
  pending = {};
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  push.mockReset();
});

/** The list is asked for when the person opens the picker, not when the page loads. */
async function openPicker(): Promise<void> {
  await userEvent.click(select());
  await waitFor(() => expect(select().querySelectorAll("option").length).toBeGreaterThan(1));
}

const select = () => screen.getByLabelText("Case type") as HTMLSelectElement;

describe("the case type picker", () => {
  it("should ask for nothing until the person opens it, and once for the page, when it is rendered", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual([]);
    await openPicker();
    await userEvent.click(select());
    await userEvent.tab();
    await userEvent.click(select());
    expect(asked.filter((a) => a.kind === "ccd.case-types")).toHaveLength(1);
  });

  it.each(["script_missing", "tool_missing", "not_cloned", "unknown_case_type"])(
    "should offer no Try again when the failure is %s, which would fail the same way",
    async (error) => {
      fetchMock.mockImplementation(podJobs());
      answers[0] = { kind: "ccd.case-types", answer: { status: "failed", kind: "x", error, detail: "it will not work" } };
      render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

      await userEvent.click(select());

      expect((await screen.findByRole("alert")).textContent).toContain("it will not work");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    }
  );

  it("should read the fields again when Try again is pressed after a failure that says why", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = {
      kind: "ccd.case-type-fields",
      answer: { status: "failed", kind: "x", error: "generation_failed", detail: "generateCCDConfig failed in apps/nfdiv/nfdiv-case-api." }
    };
    const onPicked = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={onPicked} onCleared={vi.fn()} />);

    await openPicker();
    await userEvent.selectOptions(select(), "nfdiv/NFD");
    expect((await screen.findByRole("alert")).textContent).toContain("generateCCDConfig failed");
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "done", kind: "x", result: { fields: ROWS, total: 2, omitted: 0 } } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onPicked).toHaveBeenCalled());
  });

  it("should list the workspace's case types by service and fetch the fields when one is chosen", async () => {
    fetchMock.mockImplementation(podJobs());
    const onPicked = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={onPicked} onCleared={vi.fn()} />);

    await openPicker();
    expect([...select().querySelectorAll("option")].map((o) => o.textContent)).toEqual(["No case type", "nfdiv: NFD", "sptribs: CriminalInjuriesCompensation"]);
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    await waitFor(() => expect(onPicked).toHaveBeenCalled());
    expect(asked.at(-1)).toEqual({ kind: "ccd.case-type-fields", args: { case_type: "CriminalInjuriesCompensation", product: "sptribs" } });
    expect(onPicked.mock.calls[0]?.[0]).toMatchObject({ product: "sptribs", caseType: "CriminalInjuriesCompensation", config: "config-generator", rows: ROWS });
  });

  it("should clear the choice when no case type is chosen again", async () => {
    fetchMock.mockImplementation(podJobs());
    const onCleared = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={{ product: "nfdiv", caseType: "NFD" }} onPicked={vi.fn()} onCleared={onCleared} />);

    await openPicker();
    await userEvent.selectOptions(select(), "");

    expect(onCleared).toHaveBeenCalled();
  });

  it("should show an id typed earlier as the selected case type and clear it when no case type is chosen", async () => {
    fetchMock.mockImplementation(podJobs());
    const onCleared = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={{ product: "", caseType: "CIC" }} onPicked={vi.fn()} onCleared={onCleared} />);

    expect(select().value).toBe("CIC");
    expect(screen.getByRole("option", { name: "CIC (typed earlier)" })).toBeTruthy();
    await userEvent.selectOptions(select(), "");

    expect(onCleared).toHaveBeenCalled();
  });

  it("should say how many fields were left out when the answer could not hold them all", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "done", kind: "x", result: { fields: ROWS, total: 9000, omitted: 40 } } };
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    await openPicker();
    await userEvent.selectOptions(select(), "nfdiv/NFD");

    expect(await screen.findByText(/40 were left out/)).toBeTruthy();
  });

  it("should say the assistant needs an update, and offer no retry, when its client has no handler for the job", async () => {
    fetchMock.mockImplementation(podJobs({ status: "unsupported" }));
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    await userEvent.click(select());
    expect((await screen.findByRole("alert")).textContent).toContain("needs an update");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("should show the pod's words and try the list again when it fails", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[0] = {
      kind: "ccd.case-types",
      answer: { status: "failed", kind: "x", error: "unreadable", detail: "Your workspace has no CCD case type tool yet." }
    };
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    await userEvent.click(select());
    expect((await screen.findByRole("alert")).textContent).toContain("Your workspace has no CCD case type tool yet.");
    answers[0] = { kind: "ccd.case-types", answer: { status: "done", kind: "x", result: { case_types: CASE_TYPES } } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await openPicker();
  });

  it("should say a chat is needed, and ask for nothing, when the person has none on their assistant", () => {
    render(<BulkScanCaseTypePicker conversationId={null} selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    expect(screen.getByText(NO_CHAT)).toBeTruthy();
    expect(select().disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function spec(over: object): FormSpec {
  return {
    form: { name: "F", formType: "F1", source: "pdf" },
    sections: [
      {
        id: "1",
        title: "S",
        fields: [{ role: "field", label: "Email address", inputType: "text", mandatory: "optional", keys: ["email"], ccd: [], rules: [], todo: [], ...over }]
      }
    ],
    composes: [],
    pageOrder: [],
    expectedDocuments: []
  } as unknown as FormSpec;
}

/** The status component on its own, driven by the editing functions the editor uses. */
function Row({ initial }: Readonly<{ initial: FormSpec }>) {
  const [current, setCurrent] = useState(initial);
  const field = current.sections[0]?.fields[0] as never;
  return (
    <BulkScanCcdStatus
      field={field}
      name="Email address"
      onChooseCandidate={(id) => setCurrent(chooseCandidate(current, 0, 0, id))}
      onChooseNew={() => setCurrent(chooseNew(current, 0, 0))}
      onEditNew={(patch) => setCurrent(editNewField(current, 0, 0, patch))}
    />
  );
}

describe("the new field's id input", () => {
  it("should hand the id up only when the person leaves the box or presses Enter, so a partial id cannot change the row", async () => {
    const onEditNew = vi.fn();
    const field = { ccdMatch: { status: "new", newField: { id: "x", type: "Text" } }, ccd: ["x"] } as never;
    render(<BulkScanCcdStatus field={field} name="Email" onChooseCandidate={vi.fn()} onChooseNew={vi.fn()} onEditNew={onEditNew} />);

    const input = screen.getByLabelText("New case field id for Email");
    await userEvent.clear(input);
    await userEvent.type(input, "applicantEm");
    expect(onEditNew).not.toHaveBeenCalled();
    await userEvent.type(input, "ail{Enter}");

    expect(onEditNew).toHaveBeenCalledWith({ id: "applicantEmail" });
  });
});

describe("the CCD status of a row", () => {
  const unsure = {
    ccd: [],
    ccdMatch: {
      status: "unsure",
      candidates: [
        { id: "cicCaseEmail", type: "Email" },
        { id: "cicCaseApplicantEmailAddress", type: "Email" }
      ],
      newField: { id: "cicCaseEmailAddress", type: "Email" }
    }
  };

  it("should show nothing when a row has no case type match", () => {
    render(<Row initial={spec({})} />);

    expect(screen.queryByText(/Existing|New|Unsure/)).toBeNull();
  });

  it("should badge the row when it is existing", () => {
    render(<Row initial={spec({ ccd: ["cicCaseEmail"], ccdMatch: { status: "existing" } })} />);

    expect(screen.getByText("Existing")).toBeTruthy();
  });

  it("should make the candidate chosen existing when an unsure row offers candidates", async () => {
    render(<Row initial={spec(unsure)} />);

    expect(screen.getByText("Unsure")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Case field for Email address"), "cicCaseApplicantEmailAddress");

    expect(screen.getByText("Existing")).toBeTruthy();
    expect(screen.queryByLabelText("Case field for Email address")).toBeNull();
  });

  it("should type over the proposed id and give another type when an unsure row is made new", async () => {
    render(<Row initial={spec(unsure)} />);

    await userEvent.selectOptions(screen.getByLabelText("Case field for Email address"), "Add cicCaseEmailAddress as a new field");
    expect(screen.getByText("New")).toBeTruthy();
    const id = screen.getByLabelText("New case field id for Email address") as HTMLInputElement;
    expect(id.value).toBe("cicCaseEmailAddress");
    await userEvent.clear(id);
    await userEvent.type(id, "cicCaseContactEmail");
    await userEvent.selectOptions(screen.getByLabelText("New case field type for Email address"), "Text");

    expect((screen.getByLabelText("New case field id for Email address") as HTMLInputElement).value).toBe("cicCaseContactEmail");
    expect((screen.getByLabelText("New case field type for Email address") as HTMLSelectElement).value).toBe("Text");
  });
});

describe("the upload with a case type picked", () => {
  it("should send the fields the pod found with the form when a case type is picked", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanUpload podConversationId="c1" />);

    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");
    await waitFor(() => expect(asked.at(-1)?.kind).toBe("ccd.case-type-fields"));
    await userEvent.upload(screen.getByLabelText(/^Form:/), new File(["x"], "t210.pdf"));
    await userEvent.click(screen.getByRole("button", { name: "Start the form" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/assistant/bulk-scan/abc"));
    const body = fetchMock.mock.calls.find((call) => call[0] === "/api/ui/assistant/bulk-scan")?.[1].body as FormData;
    expect(body.get("caseType")).toBe("CriminalInjuriesCompensation");
    expect(body.get("product")).toBe("sptribs");
    expect(body.get("config")).toBe("config-generator");
    expect(JSON.parse(String(body.get("fields")))).toEqual(ROWS);
  });

  it("should keep the form from starting while the case type's fields are loading, and say why", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "pending" } };
    render(<BulkScanUpload podConversationId="c1" />);

    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect((screen.getByRole("button", { name: "Start the form" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Waiting for the case type's fields/)).toBeTruthy();
    for (const id of Object.keys(pending)) {
      pending[id] = { status: "done", kind: "ccd.case-type-fields", result: { fields: ROWS, total: 2, omitted: 0 } };
    }
    await waitFor(() => expect((screen.getByRole("button", { name: "Start the form" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
  });

  it("should let the form start with no case type when none is picked, and offer no definition upload", async () => {
    fetchMock.mockImplementation(podJobs({ status: "unsupported" }));
    render(<BulkScanUpload podConversationId="c1" />);

    expect(screen.queryByLabelText(/CCD definition/)).toBeNull();
    await userEvent.upload(screen.getByLabelText(/^Form:/), new File(["x"], "t210.pdf"));
    await userEvent.click(screen.getByRole("button", { name: "Start the form" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = fetchMock.mock.calls.find((call) => call[0] === "/api/ui/assistant/bulk-scan")?.[1].body as FormData;
    expect(body.has("fields")).toBe(false);
  });
});

describe("the editor's case type", () => {
  const view = (over: object) =>
    ({
      id: "s1",
      name: "F",
      version: 1,
      spec: spec(over),
      versions: [{ version: 1, savedBy: "A", savedAt: "2026-11-19T10:00:00Z", signedOffBy: null, signedOffAt: null }],
      scenarios: [],
      keys: [],
      sample: {},
      targets: [],
      simulatorProblem: "off"
    }) as never;

  it("should match the rows, keep the ids already set and count what is new and unsure when a case type is chosen", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanEditor view={view({ ccd: [] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);

    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect(await screen.findByText("0 new case fields to add, 1 to choose")).toBeTruthy();
    expect(screen.getByText("Unsure")).toBeTruthy();
    expect(screen.getByRole("img", { name: "CCD field still to choose" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 to review/ })).toBeTruthy();
  });

  it("should keep what was typed while the fields were being fetched when they arrive", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "pending" } };
    render(<BulkScanEditor view={view({ id: "1.1", ccd: [] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);

    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");
    const label = screen.getByLabelText("Label") as HTMLTextAreaElement;
    await userEvent.type(label, " (edited)");
    for (const id of Object.keys(pending)) {
      pending[id] = { status: "done", kind: "ccd.case-type-fields", result: { fields: ROWS, total: 2, omitted: 0 } };
    }

    expect(await screen.findByText("Unsure", {}, { timeout: 5000 })).toBeTruthy();
    expect((screen.getByLabelText("Label") as HTMLTextAreaElement).value).toBe("Email address (edited)");
  });

  it("should offer no way to type a case type id, in the editor or on the upload page", async () => {
    fetchMock.mockImplementation(podJobs());
    const { unmount } = render(<BulkScanEditor view={view({ id: "1.1", ccd: [] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);
    await openPicker();
    expect(screen.queryByText(/type a case type id/i)).toBeNull();
    unmount();

    render(<BulkScanUpload podConversationId={null} />);
    expect(screen.queryByText(/type a case type id/i)).toBeNull();
  });

  it("should lay the header's case type out like the form's other labelled inputs", () => {
    render(<BulkScanEditor view={view({ id: "1.1", ccd: [] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);

    const caseType = screen.getByLabelText("Case type");
    const formName = screen.getByLabelText("Form name");
    for (const label of ["Case type", "Form name"]) {
      expect(screen.getByText(label).className).toContain("text-xs font-medium");
    }
    for (const klass of ["px-2.5", "py-1.5", "text-[13px]"]) {
      expect(caseType.className).toContain(klass);
      expect(formName.className).toContain(klass);
    }
  });

  it("should show the one picker, with its counts, and no typed id when the form's case type is in the list", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanEditor view={view({ id: "1.1", ccd: [] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);

    expect(screen.queryByText(/to add/)).toBeNull();
    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect(await screen.findByText(/new case fields to add/)).toBeTruthy();
    expect(select().selectedOptions[0]?.textContent).toBe("sptribs: CriminalInjuriesCompensation");
  });

  it("should refresh the status of a CCD id without changing it when the person set it", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanEditor view={view({ ccd: ["cicCaseEmail"] })} signOff={vi.fn()} handToAssistant={vi.fn()} podConversationId="c1" />);

    await openPicker();
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect(await screen.findByText("Existing")).toBeTruthy();
    expect(screen.getByDisplayValue("cicCaseEmail")).toBeTruthy();
  });
});

describe("typing a case type field id into the CCD ids", () => {
  const proposed = { ccd: ["cicCaseTitle"], ccdMatch: { status: "new", newField: { id: "cicCaseTitle", type: "Text" } } };
  const withIds = (over: object, ids?: string[]): FormSpec => {
    const base = spec(over);
    return { ...base, form: { ...base.form, ...(ids ? { ccdFieldIds: ids } : {}) } } as FormSpec;
  };

  function Detail({ initial }: Readonly<{ initial: FormSpec }>) {
    const [current, setCurrent] = useState(initial);
    return <BulkScanDetail spec={current} ids={[]} selection={{ section: 0, field: 0 }} issues={new Map()} onSpec={setCurrent} />;
  }

  it("should make a new row an existing one and remove its new field editors when the id is one of the case type's", async () => {
    render(<Detail initial={withIds(proposed, ["applicantTitle", "cicCaseTitle"])} />);

    const box = screen.getByLabelText("CCD ids");
    await userEvent.clear(box);
    await userEvent.type(box, " applicantTitle {Enter}");

    expect(screen.getByText("Existing")).toBeTruthy();
    expect((screen.getByLabelText("CCD ids") as HTMLInputElement).value).toBe("applicantTitle");
    expect(screen.queryByLabelText("New case field id for Email address")).toBeNull();
  });

  it("should offer the case type's ids as suggestions for the CCD ids", () => {
    const { container } = render(<Detail initial={withIds(proposed, ["applicantTitle", "cicCaseTitle"])} />);

    const list = container.querySelector("datalist");
    expect(screen.getByLabelText("CCD ids").getAttribute("list")).toBe(list?.id);
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["applicantTitle", "cicCaseTitle"]);
  });

  it("should offer no suggestions when the form has no case type fields", () => {
    const { container } = render(<Detail initial={withIds(proposed)} />);

    expect(container.querySelector("datalist")).toBeNull();
    expect(screen.getByLabelText("CCD ids").getAttribute("list")).toBeNull();
  });
});
