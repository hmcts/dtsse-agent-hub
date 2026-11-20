/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkScanEditorView } from "@/bulk-scan/editor-view";
import { BulkScanDownloads } from "@/components/assistant/BulkScanDownloads";
import { BulkScanEditor } from "@/components/assistant/BulkScanEditor";
import { BulkScanList } from "@/components/assistant/BulkScanList";
import { BulkScanSimulator } from "@/components/assistant/BulkScanSimulator";
import { BulkScanUpload } from "@/components/assistant/BulkScanUpload";
import { BulkScanVersions } from "@/components/assistant/BulkScanVersions";

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("bulk scan upload", () => {
  const choose = (file: File) => fireEvent.change(screen.getByLabelText(/PDF or spreadsheet/), { target: { files: [file] } });

  it("should send the file with its name and open the first spec when it is read", async () => {
    fetchMock.mockResolvedValue(reply(201, { ids: ["abc", "def"] }));
    render(<BulkScanUpload />);

    choose(new File(["x"], "My form.xlsx"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/assistant/bulk-scan/abc"));
    expect(fetchMock.mock.calls[0]?.[1].headers["x-file-name"]).toBe("My%20form.xlsx");
  });

  it("should show the reason when the file is refused", async () => {
    fetchMock.mockResolvedValue(reply(422, { error: "the PDF has no AcroForm fields" }));
    render(<BulkScanUpload />);

    choose(new File(["x"], "a.pdf"));

    expect((await screen.findByRole("alert")).textContent).toBe("the PDF has no AcroForm fields");
    expect(push).not.toHaveBeenCalled();
  });

  it("should say so when the request fails outright, and when the answer has no reason", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(reply(500, {}));
    render(<BulkScanUpload />);

    choose(new File(["x"], "a.pdf"));
    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection");
    choose(new File(["x"], "a.pdf"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be uploaded"));
  });
});

describe("bulk scan list", () => {
  const specs = [{ id: "s1", name: "D8", version: 2, savedAt: "2026-11-19T10:00:00Z", signedOff: true }];

  it("should say there are none when there are none", () => {
    render(<BulkScanList specs={[]} remove={vi.fn()} />);
    expect(screen.getByText(/no forms yet/)).toBeTruthy();
  });

  it("should link each form with its version and sign-off state, and delete only after a second press", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, confirmation: "gone" });
    render(<BulkScanList specs={specs} remove={remove} />);

    expect(screen.getByRole("link", { name: "D8" }).getAttribute("href")).toBe("/assistant/bulk-scan/s1");
    expect(screen.getByText("Signed off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete D8" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Delete D8 and all its versions/ }));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    const sent = remove.mock.calls[0]?.[0] as FormData;
    expect(sent.get("id")).toBe("s1");
  });

  it("should show why a delete was refused, or failed", async () => {
    const remove = vi.fn().mockResolvedValueOnce({ ok: false, error: "not yours" }).mockRejectedValueOnce(new Error("net"));
    render(<BulkScanList specs={specs} remove={remove} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete D8" }));
    fireEvent.click(screen.getByRole("button", { name: /and all its versions/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("not yours");
    fireEvent.click(screen.getByRole("button", { name: "Delete D8" }));
    fireEvent.click(screen.getByRole("button", { name: /and all its versions/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe("not yours"));
  });
});

const VERSIONS = [
  { version: 2, savedBy: "Ann", savedAt: "2026-11-19T10:00:00Z", signedOffBy: null, signedOffAt: null },
  { version: 1, savedBy: "Bob", savedAt: "2026-11-18T10:00:00Z", signedOffBy: "Ann", signedOffAt: "2026-11-18T12:00:00Z" }
];

describe("bulk scan versions", () => {
  it("should list who saved and signed off each version and link the others", () => {
    render(<BulkScanVersions specId="s1" viewing={2} versions={VERSIONS} signOff={vi.fn()} />);

    expect(screen.getByText("Version 2 (viewing)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Version 1" }).getAttribute("href")).toBe("/assistant/bulk-scan/s1?version=1");
    expect(screen.getByText(/Signed off by Ann/)).toBeTruthy();
  });

  it("should sign off the version being viewed", async () => {
    const signOff = vi.fn().mockResolvedValue({ ok: true, confirmation: "done" });
    render(<BulkScanVersions specId="s1" viewing={2} versions={VERSIONS} signOff={signOff} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign off version 2" }));

    await waitFor(() => expect(signOff).toHaveBeenCalled());
    const form = signOff.mock.calls[0]?.[0] as FormData;
    expect([form.get("id"), form.get("version")]).toEqual(["s1", "2"]);
  });

  it("should offer no sign-off for a version that has one, and show a refusal or a failure", async () => {
    const signOff = vi.fn().mockResolvedValueOnce({ ok: false, error: "already" }).mockRejectedValueOnce(new Error("net"));
    const { rerender } = render(<BulkScanVersions specId="s1" viewing={1} versions={VERSIONS} signOff={signOff} />);
    expect(screen.queryByRole("button", { name: /Sign off/ })).toBeNull();

    rerender(<BulkScanVersions specId="s1" viewing={2} versions={VERSIONS} signOff={signOff} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign off version 2" }));
    expect((await screen.findByRole("alert")).textContent).toBe("already");
    fireEvent.click(screen.getByRole("button", { name: "Sign off version 2" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe("already"));
  });
});

describe("bulk scan downloads", () => {
  it("should link the SIP and transformation sheet of the version, and the code of the chosen target", () => {
    render(<BulkScanDownloads specId="s1" version={3} targets={["fis", "nfdiv"]} />);

    expect(screen.getByRole("link", { name: /Exela SIP/ }).getAttribute("href")).toBe("/api/ui/assistant/bulk-scan/s1/download?version=3&kind=sip");
    expect(screen.getByRole("link", { name: /transformation sheet/ }).getAttribute("href")).toContain("kind=transformation");
    expect(screen.getByRole("link", { name: /nfdiv code/ }).getAttribute("href")).toBe(
      "/api/ui/assistant/bulk-scan/s1/download?version=3&kind=code&target=nfdiv&package=com.example.bulkscan"
    );
    fireEvent.change(screen.getByLabelText("Code for"), { target: { value: "fis" } });
    expect(screen.getByRole("link", { name: /fis code/ }).getAttribute("href")).not.toContain("package=");
    expect(screen.queryByLabelText("Java package")).toBeNull();
  });
});

const SIM = {
  data: { a: "1" },
  expected: {
    validation: "warning",
    validateOcr: "WARNINGS",
    transformation: "case-created-with-warnings",
    basis: ["a mandatory and empty: warning", "b: success"],
    unchecked: ["2.5"]
  },
  case_data: { ccdA: "x", address: { PostTown: "Y" } }
};

describe("bulk scan simulator", () => {
  const props = {
    specId: "s1",
    version: 2,
    scenarios: [{ name: "valid", kind: "valid" as const, description: "every key filled" }],
    keys: ["a", "b"],
    sample: { a: "", b: "q" }
  };

  it("should run a picked scenario and show its outcome, why, and CCD data, filling the values in", async () => {
    fetchMock.mockResolvedValue(reply(200, SIM));
    render(<BulkScanSimulator {...props} />);

    fireEvent.change(screen.getByLabelText("Scenario"), { target: { value: "valid" } });

    expect(await screen.findByText("WARNINGS")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ version: 2, scenario: "valid" });
    expect(screen.getByText("a mandatory and empty: warning")).toBeTruthy();
    expect(screen.queryByText("b: success")).toBeNull();
    expect(screen.getByText(/Not checked.*2\.5/)).toBeTruthy();
    expect(screen.getByText("A case is created, carrying the warnings")).toBeTruthy();
    expect(screen.getByText('{"PostTown":"Y"}')).toBeTruthy();
    expect((screen.getByLabelText("Value of a") as HTMLInputElement).value).toBe("1");
  });

  it("should run the values as edited", async () => {
    fetchMock.mockResolvedValue(reply(200, SIM));
    render(<BulkScanSimulator {...props} />);

    fireEvent.change(screen.getByLabelText("Value of b"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Run these values" }));

    await screen.findByText("WARNINGS");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({ version: 2, data: { a: "", b: "edited" } });
  });

  it("should say there is no case data for an exception record, and nothing flagged when nothing was", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { ...SIM, expected: { ...SIM.expected, validation: "exception", transformation: "exception-record", basis: [], unchecked: [] } })
    );
    render(<BulkScanSimulator {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Run these values" }));

    expect(await screen.findByText(/becomes an exception record\.$/)).toBeTruthy();
    expect(screen.getByText("Nothing was flagged.")).toBeTruthy();
  });

  it("should say nothing is set when the spec sets no CCD field, and show a refusal or a failure", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { ...SIM, case_data: {} }))
      .mockResolvedValueOnce(reply(404, { error: "gone" }))
      .mockRejectedValueOnce(new Error("net"));
    render(<BulkScanSimulator {...props} />);
    const run = () => fireEvent.click(screen.getByRole("button", { name: "Run these values" }));

    run();
    expect(await screen.findByText(/sets no CCD field/)).toBeTruthy();
    run();
    expect((await screen.findByRole("alert")).textContent).toBe("gone");
    run();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Check your connection"));
  });
});

const VIEW: BulkScanEditorView = {
  id: "s1",
  name: "T1",
  version: 1,
  spec: {
    form: { name: "T1", formType: "T1" },
    sections: [
      {
        id: "1",
        title: "About",
        fields: [
          {
            id: "1.1",
            role: "field",
            label: "Kind",
            inputType: "checkbox",
            mandatory: "conditional",
            required: { label: "joint" },
            group: { kind: "xor", size: 2, options: [{ key: "a" }, { key: "b" }] },
            keys: ["a", "b"],
            ccd: [],
            rules: [],
            todo: ["decide the outcome"],
            review: [{ about: "group", reason: "looked like a pair", confidence: "low" }]
          },
          { id: "1.2", role: "field", label: "Name", inputType: "text", mandatory: "optional", keys: ["name"], ccd: [], rules: [], todo: [] }
        ]
      }
    ],
    composes: [],
    pageOrder: [],
    expectedDocuments: []
  },
  notes: [
    { rules: "If a = true then kind = x", casePath: "1 success", allowed: ["a: true | false"] },
    { rules: "", casePath: "", allowed: [] }
  ],
  versions: [{ ...VERSIONS[1]!, signedOffBy: null, signedOffAt: null }],
  scenarios: [],
  keys: [],
  sample: {},
  targets: ["fis"],
  simulatorProblem: null
};

describe("bulk scan editor", () => {
  it("should show each field's rules, group, allowed values, TODOs and review markers", () => {
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);

    expect(screen.getByText("If a = true then kind = x")).toBeTruthy();
    expect(screen.getByText("decide the outcome")).toBeTruthy();
    expect(screen.getByText(/Check the group \(low confidence\)/)).toBeTruthy();
    expect(screen.getByText("a, b")).toBeTruthy();
    expect(screen.getByText("a: true | false")).toBeTruthy();
    expect(screen.getByText("joint")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Review checklist \(1 guesses/ })).toBeTruthy();
    expect(screen.queryByText(/Rules and notes for 1.2/)).toBeNull();
  });

  it("should save only after a change, as the next version, and go to it", async () => {
    fetchMock.mockResolvedValue(reply(201, { version: 2 }));
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save as a new version" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Label of 1.2"), { target: { value: "Full name" } });
    fireEvent.change(screen.getByLabelText("Maximum length of 1.2"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Keys of 1.2"), { target: { value: "name, other" } });
    fireEvent.change(screen.getByLabelText("CCD ids of 1.2"), { target: { value: "ccdName" } });
    fireEvent.change(screen.getByLabelText("Form type (document_sub_type)"), { target: { value: "T2" } });
    fireEvent.click(save);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/assistant/bulk-scan/s1"));
    const sent = JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec;
    expect(sent.form.formType).toBe("T2");
    expect(sent.sections[0].fields[1]).toMatchObject({ label: "Full name", maxLength: 40, keys: ["name", "other"], ccd: ["ccdName"] });
  });

  it("should mark the rows the schema refused, and keep the person's edits", async () => {
    fetchMock.mockResolvedValue(
      reply(422, {
        error: "the spec has errors",
        issues: [
          { path: "sections.0.fields.1.keys.0", message: "Too small" },
          { path: "sections", message: "bad key" }
        ]
      })
    );
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Label of 1.2"), { target: { value: "Full name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));

    expect(await screen.findByText("keys.0: Too small")).toBeTruthy();
    expect(screen.getByText("sections: bad key")).toBeTruthy();
    expect(screen.getByText("the spec has errors, marked in the rows below")).toBeTruthy();
    expect((screen.getByLabelText("Label of 1.2") as HTMLInputElement).value).toBe("Full name");
    expect(push).not.toHaveBeenCalled();
  });

  it("should say so when the save does not reach the server", async () => {
    fetchMock.mockRejectedValue(new Error("net"));
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("PO box"), { target: { value: "PO 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));

    expect((await screen.findByText(/Check your connection/)).textContent).toContain("Check your connection");
    within(document.body).getByText(/not saved/);
  });

  it("should offer an input type and mandatory choice per field", () => {
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Input type of 1.2"), { target: { value: "date" } });
    fireEvent.change(screen.getByLabelText("Mandatory of 1.2"), { target: { value: "mandatory" } });
    fireEvent.change(screen.getByLabelText("Regex of 1.2"), { target: { value: "^x$" } });
    fireEvent.change(screen.getByLabelText("ID of 1.2"), { target: { value: "1.3" } });

    expect((screen.getByLabelText("Input type of 1.3") as HTMLSelectElement).value).toBe("date");
    expect((screen.getByLabelText("Regex of 1.3") as HTMLInputElement).value).toBe("^x$");
  });
});

describe("typing into the editor", () => {
  it("should keep what is typed in the keys and CCD ids boxes, separators included, and send the words", async () => {
    fetchMock.mockResolvedValue(reply(201, { version: 2 }));
    const user = userEvent.setup();
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    const keys = screen.getByLabelText("Keys of 1.2") as HTMLInputElement;

    await user.clear(keys);
    await user.type(keys, "name, other");
    await user.type(screen.getByLabelText("CCD ids of 1.2"), "ccdA ccdB");

    expect(keys.value).toBe("name, other");
    expect((screen.getByLabelText("CCD ids of 1.2") as HTMLInputElement).value).toBe("ccdA ccdB");
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));
    const field = JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec.sections[0].fields[1];
    expect([field.keys, field.ccd]).toEqual([
      ["name", "other"],
      ["ccdA", "ccdB"]
    ]);
  });

  it("should take digits only in the maximum length box, so it is never not a number", async () => {
    fetchMock.mockResolvedValue(reply(201, { version: 2 }));
    const user = userEvent.setup();
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    const max = screen.getByLabelText("Maximum length of 1.2") as HTMLInputElement;

    await user.type(max, "4x2");
    expect(max.value).toBe("42");
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec.sections[0].fields[1].maxLength).toBe(42);
  });

  it("should send the version the edit started from, and refuse to save an older version over the later ones", async () => {
    fetchMock.mockResolvedValue(reply(201, { version: 4 }));
    const user = userEvent.setup();
    const { rerender } = render(<BulkScanEditor view={{ ...VIEW, version: 3, versions: [{ ...VERSIONS[0]!, version: 3 }] }} signOff={vi.fn()} />);
    await user.type(screen.getByLabelText("Label of 1.2"), "!");
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).baseVersion).toBe(3);

    cleanup();
    render(<BulkScanEditor view={{ ...VIEW, version: 1, versions: VERSIONS }} signOff={vi.fn()} />);
    await user.type(screen.getByLabelText("Label of 1.2"), "!");
    expect((screen.getByRole("button", { name: "Save as a new version" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/open version 2 to change it/i)).toBeTruthy();
  });

  it("should show the refusal when another save got there first", async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "this form has a newer version: reload the page" }));
    const user = userEvent.setup();
    render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);

    await user.type(screen.getByLabelText("Label of 1.2"), "!");
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));

    expect((await screen.findByText(/newer version/)).textContent).toContain("reload");
  });
});
