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

const select = () => screen.getByLabelText("Service and CCD case type (optional)") as HTMLSelectElement;

describe("the case type picker", () => {
  it("should say why the fields could not be read and read them again on Try again", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = {
      kind: "ccd.case-type-fields",
      answer: { status: "failed", kind: "x", error: "generation_failed", detail: "generateCCDConfig failed in apps/nfdiv/nfdiv-case-api." }
    };
    const onPicked = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={onPicked} onCleared={vi.fn()} />);

    await waitFor(() => expect(select().disabled).toBe(false));
    await userEvent.selectOptions(select(), "nfdiv/NFD");
    expect((await screen.findByRole("alert")).textContent).toContain("generateCCDConfig failed");
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "done", kind: "x", result: { fields: ROWS, total: 2, omitted: 0 } } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onPicked).toHaveBeenCalled());
  });

  it("should list the workspace's case types by service and fetch the fields of the one chosen", async () => {
    fetchMock.mockImplementation(podJobs());
    const onPicked = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={onPicked} onCleared={vi.fn()} />);

    await waitFor(() => expect(select().disabled).toBe(false));
    expect([...select().querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["nfdiv", "sptribs"]);
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    await waitFor(() => expect(onPicked).toHaveBeenCalled());
    expect(asked.at(-1)).toEqual({ kind: "ccd.case-type-fields", args: { case_type: "CriminalInjuriesCompensation", product: "sptribs" } });
    expect(onPicked.mock.calls[0]?.[0]).toMatchObject({ product: "sptribs", caseType: "CriminalInjuriesCompensation", config: "config-generator", rows: ROWS });
  });

  it("should clear the choice when no case type is chosen again", async () => {
    fetchMock.mockImplementation(podJobs());
    const onCleared = vi.fn();
    render(<BulkScanCaseTypePicker conversationId="c1" selected={{ product: "nfdiv", caseType: "NFD" }} onPicked={vi.fn()} onCleared={onCleared} />);

    await waitFor(() => expect(select().disabled).toBe(false));
    await userEvent.selectOptions(select(), "");

    expect(onCleared).toHaveBeenCalled();
  });

  it("should say how many fields were left out when the answer could not hold them all", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[1] = { kind: "ccd.case-type-fields", answer: { status: "done", kind: "x", result: { fields: ROWS, total: 9000, omitted: 40 } } };
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    await waitFor(() => expect(select().disabled).toBe(false));
    await userEvent.selectOptions(select(), "nfdiv/NFD");

    expect(await screen.findByText(/40 were left out/)).toBeTruthy();
  });

  it("should say the assistant needs an update, and offer no retry, when its client has no handler for the job", async () => {
    fetchMock.mockImplementation(podJobs({ status: "unsupported" }));
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("needs an update");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("should show the pod's words and try the list again when it fails", async () => {
    fetchMock.mockImplementation(podJobs());
    answers[0] = {
      kind: "ccd.case-types",
      answer: { status: "failed", kind: "x", error: "script_missing", detail: "Your workspace has no CCD case type tool yet." }
    };
    render(<BulkScanCaseTypePicker conversationId="c1" selected={null} onPicked={vi.fn()} onCleared={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Your workspace has no CCD case type tool yet.");
    answers[0] = { kind: "ccd.case-types", answer: { status: "done", kind: "x", result: { case_types: CASE_TYPES } } };
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(select().disabled).toBe(false));
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
    form: { name: "F", formType: "F1" },
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

  it("should show nothing for a row with no case type match", () => {
    render(<Row initial={spec({})} />);

    expect(screen.queryByText(/Existing|New|Unsure/)).toBeNull();
  });

  it("should badge an existing row", () => {
    render(<Row initial={spec({ ccd: ["cicCaseEmail"], ccdMatch: { status: "existing" } })} />);

    expect(screen.getByText("Existing")).toBeTruthy();
  });

  it("should offer an unsure row's candidates and make the one chosen existing", async () => {
    render(<Row initial={spec(unsure)} />);

    expect(screen.getByText("Unsure")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Case field for Email address"), "cicCaseApplicantEmailAddress");

    expect(screen.getByText("Existing")).toBeTruthy();
    expect(screen.queryByLabelText("Case field for Email address")).toBeNull();
  });

  it("should make an unsure row new with the proposed id, which is then typed over and given another type", async () => {
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
  it("should send the fields the pod found with the form", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanUpload podConversationId="c1" />);

    await waitFor(() => expect(select().disabled).toBe(false));
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

  it("should offer no definition upload and let the form start with no case type", async () => {
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

  it("should match the rows against the case type chosen, keep the ids already set, and count what is new and unsure", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanEditor view={view({ ccd: [] })} signOff={vi.fn()} podConversationId="c1" />);

    await waitFor(() => expect(select().disabled).toBe(false));
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect(await screen.findByText("0 new case fields to add, 1 to choose")).toBeTruthy();
    expect(screen.getByText("Unsure")).toBeTruthy();
    expect(screen.getByText(/choose which case field this is/)).toBeTruthy();
  });

  it("should refresh the status of a CCD id the person set without changing it", async () => {
    fetchMock.mockImplementation(podJobs());
    render(<BulkScanEditor view={view({ ccd: ["cicCaseEmail"] })} signOff={vi.fn()} podConversationId="c1" />);

    await waitFor(() => expect(select().disabled).toBe(false));
    await userEvent.selectOptions(select(), "sptribs/CriminalInjuriesCompensation");

    expect(await screen.findByText("Existing")).toBeTruthy();
    expect(screen.getByDisplayValue("cicCaseEmail")).toBeTruthy();
  });
});
