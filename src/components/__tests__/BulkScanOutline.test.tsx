/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkScanEditorView } from "@/bulk-scan/editor-view";
import { BulkScanEditor } from "@/components/assistant/BulkScanEditor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ version: 2 }), { status: 201 }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const field = (over: object) => ({ role: "field", label: "", inputType: "text", mandatory: "optional", keys: [], ccd: [], rules: [], todo: [], ...over });

const VERSIONS = [
  { version: 1, savedBy: "Ann", savedAt: "2026-11-19T10:00:00Z", signedOffBy: null, signedOffAt: null },
  { version: 2, savedBy: "Ann", savedAt: "2026-11-20T10:00:00Z", signedOffBy: "Bo", signedOffAt: "2026-11-21T10:00:00Z" }
];

const view = (over: object = {}) =>
  ({
    id: "s1",
    name: "T210",
    version: 2,
    spec: {
      form: { name: "T210", formType: "T210" },
      sections: [
        {
          id: "1",
          title: "Appeal",
          fields: [
            field({ id: "1.1", label: "Reference number", keys: ["reference"], ccd: ["refCcd"], mandatory: "mandatory" }),
            field({
              id: "1.2",
              label: "Review date",
              keys: ["dateDay"],
              todo: ["TODO: check the format"],
              review: [{ about: "key", reason: "guessed", confidence: "low" }],
              logicText: "If blank then error"
            }),
            field({ id: "1.3", label: "Appeal type", keys: ["type"], mandatory: "conditional" })
          ]
        },
        {
          id: "2",
          title: "Decision",
          fields: [field({ id: "2.1", label: "Decision date", keys: ["decisionDay"], review: [{ about: "ccd", reason: "r", confidence: "medium" }] })]
        }
      ],
      composes: [],
      pageOrder: [],
      expectedDocuments: []
    },
    versions: VERSIONS,
    scenarios: [],
    keys: [],
    sample: {},
    targets: ["fis"],
    simulatorProblem: null,
    ...over
  }) as unknown as BulkScanEditorView;

function setup(over: object = {}) {
  const user = userEvent.setup();
  render(<BulkScanEditor view={view(over)} signOff={vi.fn()} />);
  return user;
}

const line = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id.replace(".", "\\.")} `) });
const outlineLines = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-outline-item"));

describe("the outline", () => {
  it("should open the first field and mark it as current when the editor loads", () => {
    setup();
    expect(line("1.1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "1.1 Reference number" })).toBeTruthy();
  });

  it("should show a field's details and highlight its line when the line is clicked", async () => {
    const user = setup();
    await user.click(line("2.1"));

    expect(line("2.1").getAttribute("aria-current")).toBe("true");
    expect(line("1.1").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "2.1 Decision date" })).toBeTruthy();
    expect((screen.getByLabelText("Label") as HTMLTextAreaElement).value).toBe("Decision date");
  });

  it("should name each line's id, label, type, badge and open markers when a screen reader reads it", () => {
    setup();
    expect(line("1.2").textContent).toContain("Review date");
    expect(within(line("1.2")).getByRole("img", { name: "1 review marker" })).toBeTruthy();
    expect(within(line("1.2")).getByRole("img", { name: "1 TODO" })).toBeTruthy();
    expect(within(line("1.2")).getByRole("img", { name: "Unparsed English" })).toBeTruthy();
    expect(within(line("1.1")).queryByRole("img")).toBeNull();
    expect(within(line("1.1")).getByText("Mandatory")).toBeTruthy();
    expect(within(line("1.3")).getByText("Mandatory if…")).toBeTruthy();
  });

  it("should move focus between lines with the arrow keys and open one with Enter when the keys are pressed", async () => {
    const user = setup();
    line("1.1").focus();

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(line("1.2"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(line("1.3"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(line("1.2"));
    await user.keyboard("{Enter}");
    expect(line("1.2").getAttribute("aria-current")).toBe("true");

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(outlineLines().at(-1));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(outlineLines()[0]);
  });

  it("should hide a section's fields when it is collapsed and show them when it is expanded", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Collapse section 1" }));
    expect(screen.queryByRole("button", { name: /^1\.2 / })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand section 1" }).getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Expand section 1" }));
    expect(line("1.2")).toBeTruthy();
  });

  it("should show the section's id, title and field count when a section is chosen", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /^1 Appeal/ }));

    expect(screen.getByRole("heading", { level: 2, name: "Section 1" })).toBeTruthy();
    expect((screen.getByLabelText("Section title") as HTMLInputElement).value).toBe("Appeal");
    expect(screen.getByText("3 fields")).toBeTruthy();
  });

  it("should offer reorder and removal only on the open field's line when a field is open", async () => {
    const user = setup();
    expect(screen.getByRole("button", { name: "Move 1.1 down" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move 1.2 down" })).toBeNull();
    expect((screen.getByRole("button", { name: "Move 1.1 up" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(line("1.3"));
    expect((screen.getByRole("button", { name: "Move 1.3 down" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("finding fields", () => {
  it("should keep only the fields that match when an id, label, key or CCD id is typed", async () => {
    const user = setup();
    const search = screen.getByRole("searchbox", { name: "Search fields" });

    await user.type(search, "refccd");
    expect(outlineLines().map((b) => b.textContent)).toEqual([expect.stringContaining("Appeal"), expect.stringContaining("Reference number")]);

    await user.clear(search);
    await user.type(search, "DECISIONDAY");
    expect(line("2.1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^1\.1 / })).toBeNull();
  });

  it("should say so when nothing matches", async () => {
    const user = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search fields" }), "zzz");
    expect(screen.getByRole("status").textContent).toBe("No fields match.");
  });

  it("should list the flagged fields as one flat list when Needs review is on, each with its section", async () => {
    const user = setup();
    const toggle = screen.getByRole("button", { name: /^Needs review \(2\)/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await user.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(outlineLines().map((b) => b.textContent)).toEqual([expect.stringContaining("Review date"), expect.stringContaining("Decision date")]);
    expect(within(line("1.2")).getByText("1 Appeal")).toBeTruthy();
    expect(within(line("2.1")).getByText("2 Decision")).toBeTruthy();

    await user.click(toggle);
    expect(line("1.1")).toBeTruthy();
  });

  it("should order the flagged fields by their lowest open confidence, low first, when Needs review is on", async () => {
    const marker = (confidence: string) => [{ about: "key", reason: "r", confidence }];
    const user = userEvent.setup();
    render(
      <BulkScanEditor
        view={view({
          spec: {
            form: { name: "T210", formType: "T210" },
            sections: [
              {
                id: "1",
                title: "A",
                fields: [
                  field({ id: "1.1", label: "High one", keys: ["a"], review: marker("high") }),
                  field({ id: "1.2", label: "Medium one", keys: ["b"], review: marker("medium") })
                ]
              },
              {
                id: "2",
                title: "B",
                fields: [
                  field({ id: "2.1", label: "Low one", keys: ["c"], review: marker("low") }),
                  field({ id: "2.2", label: "Todo one", keys: ["d"], todo: ["TODO: x"] })
                ]
              }
            ],
            composes: [],
            pageOrder: [],
            expectedDocuments: []
          }
        })}
        signOff={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /^Needs review/ }));

    expect(outlineLines().map((b) => b.textContent?.match(/(High|Medium|Low|Todo) one/)?.[0])).toEqual(["Low one", "Todo one", "Medium one", "High one"]);
  });

  it("should count down when a field's last marker is done while Needs review is on", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /^Needs review/ }));
    await user.click(line("2.1"));
    await user.click(screen.getByRole("button", { name: "Done: check 1" }));

    expect(screen.getByRole("button", { name: /^Needs review \(1\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^2\.1 / })).toBeNull();
  });

  it("should turn the filter on from the header's count when it is pressed", async () => {
    const user = setup();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(screen.getByRole("button", { name: "2 to review" }));

    expect(screen.getByRole("tab", { name: "Edit" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /^Needs review/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("sections that move or collapse", () => {
  it("should keep a collapsed section collapsed when it moves", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Collapse section 1" }));
    await user.click(screen.getByRole("button", { name: "Move section 1 down" }));

    expect(screen.getByRole("button", { name: "Expand section 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse section 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^2\.1 / })).toBeTruthy();
  });

  it("should keep the open field open when another section moves or is removed", async () => {
    const user = setup();
    await user.click(line("2.1"));
    await user.click(screen.getByRole("button", { name: "Move section 1 down" }));
    expect(line("2.1").getAttribute("aria-current")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Remove section 2" }));

    expect(line("2.1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "2.1 Decision date" })).toBeTruthy();
  });

  it("should open the section beside it when the removed section held the open field", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Remove section 1" }));
    expect(screen.getByRole("heading", { level: 2, name: "Section 1" })).toBeTruthy();
  });
});

describe("what stays with a section or field", () => {
  const twin = (over: object = {}) =>
    view({
      spec: {
        form: { name: "T210", formType: "T210" },
        sections: [
          {
            id: "1",
            title: "A",
            fields: [
              field({
                id: "1.1",
                label: "One",
                keys: ["k"],
                emits: [
                  { key: "k", value: "a1" },
                  { key: "k", value: "a2" }
                ]
              }),
              field({ id: "1.2", label: "Two", keys: ["k"], emits: [{ key: "k", value: "b1" }] })
            ]
          },
          { id: "1", title: "B", fields: [field({ id: "2.1", label: "Three", keys: ["z"] })] }
        ],
        composes: [],
        pageOrder: [],
        expectedDocuments: []
      },
      ...over
    });

  it("should show the next field's own allowed values when the field before it is removed", async () => {
    const user = userEvent.setup();
    render(<BulkScanEditor view={twin()} signOff={vi.fn()} />);
    expect((screen.getByLabelText("k value 2") as HTMLInputElement).value).toBe("a2");
    await user.click(screen.getByRole("button", { name: "Remove 1.1" }));

    expect((screen.getByLabelText("k value 1") as HTMLInputElement).value).toBe("b1");
    expect(screen.queryByLabelText("k value 2")).toBeNull();
  });

  it("should collapse only the section pressed when two sections share an id", async () => {
    const user = userEvent.setup();
    render(<BulkScanEditor view={twin()} signOff={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Collapse section 1" }));

    expect(screen.getByRole("button", { name: "Expand section 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse section 2" })).toBeTruthy();
  });

  it("should keep a section collapsed when its id is edited", async () => {
    const user = userEvent.setup();
    render(<BulkScanEditor view={twin()} signOff={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Collapse section 1" }));
    await user.click(screen.getByRole("button", { name: /^1 A/ }));
    await user.type(screen.getByLabelText("Section ID"), "9");

    expect(screen.getByRole("button", { name: "Expand section 1" })).toBeTruthy();
  });
});

describe("adding while a filter is on", () => {
  it("should clear the search and show the new field when a field is added with a search typed", async () => {
    const user = setup();
    const search = screen.getByRole("searchbox", { name: "Search fields" }) as HTMLInputElement;
    await user.type(search, "decision");
    await user.click(screen.getByRole("button", { name: "Add a field to section 2" }));

    expect(search.value).toBe("");
    expect(outlineLines().filter((b) => b.getAttribute("aria-current") === "true")).toHaveLength(1);
  });

  it("should turn Needs review off and show the new section when a section is added with it on", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /^Needs review/ }));
    await user.click(screen.getByRole("button", { name: "Add a section" }));

    expect(screen.getByRole("button", { name: /^Needs review/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Collapse section 3" })).toBeTruthy();
  });

  it("should clear the search when the header's count turns the filter on, so the list matches the count", async () => {
    const user = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search fields" }), "zzz");
    await user.click(screen.getByRole("button", { name: "2 to review" }));

    expect((screen.getByRole("searchbox", { name: "Search fields" }) as HTMLInputElement).value).toBe("");
    expect(outlineLines()).toHaveLength(2);
  });
});

describe("identical markers", () => {
  it("should list two identical TODOs and clear one at a time when each is marked done", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <BulkScanEditor
        view={view({
          spec: {
            form: { name: "T210", formType: "T210" },
            sections: [{ id: "1", title: "A", fields: [field({ id: "1.1", label: "One", keys: ["a"], todo: ["TODO: same", "TODO: same"] })] }],
            composes: [],
            pageOrder: [],
            expectedDocuments: []
          }
        })}
        signOff={vi.fn()}
      />
    );
    expect(screen.getAllByText(/same/)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Done: TODO 1" }));

    expect(screen.getAllByText(/same/)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("adding a field", () => {
  it("should open a collapsed section and show the new line when a field is added to it", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Collapse section 2" }));
    expect(screen.queryByRole("button", { name: /^2\.1 / })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add a field to section 2" }));

    expect(screen.getByRole("button", { name: "Collapse section 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^2\.1 / })).toBeTruthy();
    expect(outlineLines().filter((b) => b.getAttribute("aria-current") === "true")).toHaveLength(1);
  });
});

describe("fields a save refused", () => {
  it("should count a refused field as needing review in the outline and the header when a save is refused", async () => {
    const user = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad", issues: [{ path: "sections.0.fields.0.keys.0", message: "bad key" }] }), { status: 422 })
    );
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(screen.getByRole("button", { name: /^Save as version/ }));

    expect(await screen.findByRole("button", { name: /^Needs review \(3\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 to review" })).toBeTruthy();
  });

  it("should list the refused field and open its collapsed section when a filter would hide it", async () => {
    const user = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad", issues: [{ path: "sections.1.fields.0.keys.0", message: "bad key" }] }), { status: 422 })
    );
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(screen.getByRole("button", { name: "Collapse section 2" }));
    await user.click(screen.getByRole("button", { name: /^Save as version/ }));

    expect((await screen.findByRole("button", { name: "Collapse section 2" })).getAttribute("aria-expanded")).toBe("true");
    await user.type(screen.getByRole("searchbox", { name: "Search fields" }), "zzz");
    expect(line("2.1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^1\.1 / })).toBeNull();
  });
});

describe("the open field's heading", () => {
  it("should show a label once when the field has no id or key and the label has a padded first line", () => {
    render(
      <BulkScanEditor
        view={view({
          spec: {
            form: { name: "T210", formType: "T210" },
            sections: [{ id: "1", title: "A", fields: [field({ label: "  Solo  \nsecond line", inputType: "none" })] }],
            composes: [],
            pageOrder: [],
            expectedDocuments: []
          }
        })}
        signOff={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Solo" })).toBeTruthy();
  });
});

describe("the save bar", () => {
  const save = () => screen.getByRole("button", { name: /^Save as version/ }) as HTMLButtonElement;

  it("should be disabled and say there are no changes when nothing has been edited", () => {
    setup();
    expect(save().disabled).toBe(true);
    expect(save().textContent).toBe("Save as version 3");
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("should say Unsaved changes and enable saving when a field is edited", async () => {
    const user = setup();
    await user.type(screen.getByLabelText("Label"), "!");

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(save().disabled).toBe(false);
  });

  it("should post the whole spec with the version it was based on when it is saved", async () => {
    const user = setup();
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(save());

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/ui/assistant/bulk-scan/s1/versions");
    const body = JSON.parse(init.body);
    expect(body.baseVersion).toBe(2);
    expect(body.spec.sections[0].fields[0].label).toBe("Reference number!");
    expect(body.spec.sections).toHaveLength(2);
  });

  it("should show the engine's message and mark the field in the outline when a save is refused", async () => {
    const user = setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "the spec has errors", issues: [{ path: "sections.1.fields.0.keys.0", message: "bad key" }] }), { status: 422 })
    );
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(save());

    expect((await screen.findAllByText(/the spec has errors, marked in the outline/)).length).toBeGreaterThan(0);
    expect(within(line("2.1")).getByRole("img", { name: "1 error" })).toBeTruthy();
    await user.click(line("2.1"));
    expect(screen.getByText("keys.0: bad key")).toBeTruthy();
  });

  it("should show the engine's message when another version was saved first", async () => {
    const user = setup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "version 3 was saved since" }), { status: 409 }));
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(save());

    expect(await screen.findByText("version 3 was saved since")).toBeTruthy();
    expect(save().disabled).toBe(false);
  });

  it("should stay disabled and point to the latest version when an older one is open", async () => {
    const user = setup({ version: 1 });
    await user.type(screen.getByLabelText("Label"), "!");

    expect(save().disabled).toBe(true);
    expect(screen.getByText("This is not the latest version: open version 2 to change it.")).toBeTruthy();
  });
});

describe("the header and tabs", () => {
  it("should show the version, who signed it off and the form's details when the editor loads", () => {
    setup();
    const header = within(screen.getByRole("region", { name: "Form details" }));
    expect(header.getByText(/Version 2, saved by Ann/)).toBeTruthy();
    expect(header.getByText(/Signed off by Bo/)).toBeTruthy();
    expect((screen.getByLabelText("Form name") as HTMLInputElement).value).toBe("T210");
    expect(screen.getByLabelText("PO box")).toBeTruthy();
    expect(screen.getByLabelText("Case type (CCD case type id)")).toBeTruthy();
  });

  it("should show the UK day a version was saved on when it was saved after midnight BST", () => {
    setup({ versions: [{ ...VERSIONS[1], savedAt: "2026-07-01T23:30:00Z" }] });
    expect(within(screen.getByRole("region", { name: "Form details" })).getByText(/saved by Ann, 2 July 2026/)).toBeTruthy();
  });

  it("should switch panels with the arrow keys when a tab has focus", async () => {
    const user = setup();
    const edit = screen.getByRole("tab", { name: "Edit" });
    edit.focus();

    await user.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Simulate" }));
    expect(screen.getByRole("tabpanel", { name: "Simulate" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Edit" })).toBeNull();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tabpanel", { name: "Versions" })).toBeTruthy();
  });

  it("should keep the form's edits when another tab is opened and Edit is returned to", async () => {
    const user = setup();
    await user.type(screen.getByLabelText("Form name"), " v2");
    await user.click(screen.getByRole("tab", { name: "Download" }));
    expect(screen.getByRole("link", { name: "Exela SIP (.xlsx)" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Edit" }));

    expect((screen.getByLabelText("Form name") as HTMLInputElement).value).toBe("T210 v2");
  });
});
