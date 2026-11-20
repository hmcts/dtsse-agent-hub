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

const VIEW = {
  id: "s1",
  name: "D8",
  version: 1,
  spec: {
    form: { name: "D8", formType: "D8" },
    sections: [
      {
        id: "1",
        title: "About",
        fields: [
          field({ id: "1.1", label: "Kind", keys: ["marriage", "civil"], inputType: "checkbox", ccd: ["kindCcd", "otherCcd"] }),
          field({ id: "1.2", label: "Name", keys: ["name"], ccd: ["nameCcd"] }),
          field({
            id: "1.3",
            label: "Reason",
            keys: ["reason"],
            logicText: "If marriage is ticked then copy it",
            todo: ["TODO: logic not parsed into rules (prose)"],
            review: [{ about: "key", reason: "guessed", confidence: "low" }]
          })
        ]
      },
      { id: "2", title: "More", fields: [field({ id: "2.1", label: "Extra", keys: ["extra"] })] }
    ],
    composes: [],
    pageOrder: [],
    expectedDocuments: []
  },
  versions: [{ version: 1, savedBy: "Ann", savedAt: "2026-11-19T10:00:00Z", signedOffBy: null, signedOffAt: null }],
  scenarios: [],
  keys: [],
  sample: {},
  targets: ["fis"],
  simulatorProblem: null
} as unknown as BulkScanEditorView;

async function setup() {
  const user = userEvent.setup();
  render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
  return user;
}

async function saved(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save as a new version" }));
  return JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec as {
    sections: { id: string; title: string; fields: Record<string, unknown>[] }[];
  };
}

async function savedField(user: ReturnType<typeof userEvent.setup>, index: number) {
  const field = (await saved(user)).sections[0]?.fields[index];
  if (!field) {
    throw new Error("no such field");
  }
  return field;
}

const select = (user: ReturnType<typeof userEvent.setup>, name: string, value: string) => user.selectOptions(screen.getByLabelText(name), value);

describe("adding, removing and reordering", () => {
  it("should add a field that starts optional text with an empty key, and show the engine's refusal on its row", async () => {
    const user = await setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "the spec has errors", issues: [{ path: "sections.1.fields.1.keys.0", message: 'the key "" is bad' }] }), {
        status: 422
      })
    );

    await user.click(screen.getByRole("button", { name: "Add a field to section 2" }));
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec;
    expect(body.sections[1].fields[1]).toMatchObject({ keys: [""], inputType: "text", mandatory: "optional" });
    expect(await screen.findByText('keys.0: the key "" is bad')).toBeTruthy();
  });

  it("should drop the marks of the last save once rows move, since they would point at other rows", async () => {
    const user = await setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad", issues: [{ path: "sections.0.fields.1.regex", message: "not a regex" }] }), { status: 422 })
    );
    await user.type(screen.getByLabelText("Label of 1.2"), "!");
    await user.click(screen.getByRole("button", { name: "Save as a new version" }));
    expect(await screen.findByText("regex: not a regex")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Move 1.2 up" }));

    expect(screen.queryByText("regex: not a regex")).toBeNull();
  });

  it("should remove and reorder fields and sections", async () => {
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Move 1.2 up" }));
    await user.click(screen.getByRole("button", { name: "Remove 1.3" }));
    await user.click(screen.getByRole("button", { name: "Move section 2 up" }));
    await user.click(screen.getByRole("button", { name: "Add a section" }));
    await user.type(screen.getByLabelText("Title of section 3"), "Third");

    const body = await saved(user);
    expect(body.sections.map((s) => s.id)).toEqual(["2", "1", "3"]);
    expect(body.sections[1]?.fields.map((f) => f.id)).toEqual(["1.2", "1.1"]);
    expect(body.sections[2]?.title).toBe("Third");
  });

  it("should remove a section", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Remove section 1" }));
    expect((await saved(user)).sections.map((s) => s.id)).toEqual(["2"]);
  });
});

describe("allowed values", () => {
  it("should send the exact strings typed, one per line, and whether blank is allowed", async () => {
    const user = await setup();
    const box = screen.getByLabelText("Allowed values of marriage in 1.1") as HTMLTextAreaElement;

    const blank = screen.getByLabelText("Blank is allowed for marriage in 1.1") as HTMLInputElement;

    await user.clear(box);
    await user.type(box, "Yes{Enter}No{Enter}");
    expect(blank.checked).toBe(true);
    await user.click(blank);
    await user.click(blank);
    await user.click(blank);

    expect(box.value).toBe("Yes\nNo\n");
    const field = (await savedField(user, 0)) as { emits: { key: string; value: string }[] };
    expect(field.emits.filter((e) => e.key === "marriage").map((e) => e.value)).toEqual(["Yes", "No"]);
    expect(field.emits.filter((e) => e.key === "civil").map((e) => e.value)).toEqual(["true", "false"]);
  });
});

describe("XoR groups", () => {
  it("should make a field's keys a group and ungroup them again", async () => {
    const user = await setup();
    const box = screen.getByLabelText(/keys of 1.1 are a mutually exclusive group/) as HTMLInputElement;

    await user.click(box);
    expect(box.checked).toBe(true);
    const grouped = (await savedField(user, 0)) as { group: unknown };
    expect(grouped.group).toEqual({ kind: "xor", size: 2, options: [{ key: "marriage" }, { key: "civil" }] });

    fetchMock.mockClear();
    await user.click(box);
    expect(box.checked).toBe(false);
    expect(await savedField(user, 0)).not.toHaveProperty("group");
  });

  it("should offer no group for a field with one key", async () => {
    await setup();
    expect(screen.queryByLabelText(/keys of 1.2 are a mutually exclusive group/)).toBeNull();
  });
});

describe("conditional mandatory", () => {
  it("should set key is ticked, key = value and key is not blank, choosing the key from the form's keys", async () => {
    const user = await setup();
    await select(user, "Mandatory of 1.2", "conditional");

    await user.click(screen.getByRole("button", { name: "Add a condition to mandatory condition of 1.2" }));
    await select(user, "mandatory condition of 1.2, condition 1 key", "civil");
    await select(user, "mandatory condition of 1.2, condition 1 operator", "ticked");
    let required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil is ticked", when: { civil: { ticked: true } } });

    await select(user, "mandatory condition of 1.2, condition 1 operator", "=");
    await user.type(screen.getByLabelText("mandatory condition of 1.2, condition 1 value"), "Yes");
    fetchMock.mockClear();
    required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil = Yes", when: { civil: "Yes" } });

    await select(user, "mandatory condition of 1.2, condition 1 operator", "filled");
    fetchMock.mockClear();
    required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil is not blank", when: { civil: { not: null } } });
  });

  it("should only offer keys the form reads, so a condition cannot name another", async () => {
    const user = await setup();
    await select(user, "Mandatory of 1.2", "conditional");
    await user.click(screen.getByRole("button", { name: "Add a condition to mandatory condition of 1.2" }));

    const options = within(screen.getByLabelText("mandatory condition of 1.2, condition 1 key")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining(["marriage", "civil", "name", "extra", "1.1 Kind"]));
    expect(options.map((o) => o.textContent)).not.toContain("nope");
  });
});

describe("rules", () => {
  const branch = "branch 1 of 1.2";

  async function startRule(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    await user.click(screen.getByRole("button", { name: `Add a condition to ${branch}` }));
  }

  it("should build a branch with a condition, an assignment, an outcome and a note, and word it as the sheet will", async () => {
    const user = await setup();
    await startRule(user);

    await select(user, `${branch}, condition 1 key`, "marriage");
    await select(user, `${branch}, condition 1 operator`, "ticked");
    await user.click(screen.getByRole("button", { name: `Add an assignment to ${branch}` }));
    await select(user, `${branch}, assignment 1 CCD field`, "nameCcd");
    await user.type(screen.getByLabelText(`${branch}, assignment 1 value`), "Wife");
    await select(user, `Outcome of ${branch}`, "warning");
    await user.type(screen.getByLabelText(`Note of ${branch}`), "(WITH WARNING)");

    expect(
      within(screen.getByRole("group", { name: "Logic of 1.2" })).getByText(/If marriage is ticked, nameCcd = Wife \(warning\) \(WITH WARNING\)/)
    ).toBeTruthy();
    const rule = ((await savedField(user, 1)) as { rules: unknown[] }).rules[0];
    expect(rule).toEqual({ when: { marriage: { ticked: true } }, set: { nameCcd: "Wife" }, outcome: "warning", note: "(WITH WARNING)" });
  });

  it("should copy a key into a CCD field", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    await user.click(screen.getByRole("button", { name: `Add an assignment to ${branch}` }));

    await select(user, `${branch}, assignment 1 CCD field`, "nameCcd");
    await select(user, `${branch}, assignment 1 kind`, "copy");
    await select(user, `${branch}, assignment 1 key`, "name");

    expect(screen.getByText("nameCcd = name")).toBeTruthy();
    expect(((await savedField(user, 1)) as { rules: unknown[] }).rules[0]).toEqual({ set: { nameCcd: { from: "name" } } });
  });

  it("should add an OR alternative, each with its own conditions", async () => {
    const user = await setup();
    await startRule(user);
    await user.click(screen.getByRole("button", { name: `Add an OR alternative to ${branch}` }));
    await select(user, `${branch}, alternative 2, condition 1 key`, "civil");
    await select(user, `${branch}, alternative 2, condition 1 operator`, "blank");

    expect(screen.getByText("OR")).toBeTruthy();
    const rule = ((await savedField(user, 1)) as { rules: { whenAny: unknown[] }[] }).rules[0];
    expect(rule?.whenAny).toHaveLength(2);
    expect(rule?.whenAny[1]).toEqual({ civil: null });
  });

  it("should make a later branch the ELSE, or the start of a new chain", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    expect(screen.queryByLabelText("Starts a new chain: branch 1 of 1.2")).toBeNull();

    await user.click(screen.getByLabelText("ELSE: branch 2 of 1.2"));
    await select(user, "Outcome of branch 2 of 1.2", "exception");
    expect(screen.queryByRole("button", { name: "Add a condition to branch 2 of 1.2" })).toBeNull();
    await user.click(screen.getByLabelText("ELSE: branch 2 of 1.2"));
    await user.click(screen.getByLabelText("Starts a new chain: branch 2 of 1.2"));

    const rules = ((await savedField(user, 1)) as { rules: object[] }).rules;
    expect(rules).toEqual([{}, { outcome: "exception", independent: true }]);
  });

  it("should reorder and remove branches", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    await user.click(screen.getByRole("button", { name: "Add a branch to 1.2" }));
    await user.type(screen.getByLabelText("Note of branch 2 of 1.2"), "second");

    await user.click(screen.getByRole("button", { name: "Move branch 2 of 1.2 up" }));
    expect((screen.getByLabelText("Note of branch 1 of 1.2") as HTMLInputElement).value).toBe("second");
    await user.click(screen.getByRole("button", { name: "Remove branch 2 of 1.2" }));

    expect(((await savedField(user, 1)) as { rules: object[] }).rules).toEqual([{ note: "second" }]);
  });

  it("should remove a condition, leaving a branch that tests nothing", async () => {
    const user = await setup();
    await startRule(user);
    await user.click(screen.getByRole("button", { name: `Remove ${branch}, condition 1` }));
    expect(((await savedField(user, 1)) as { rules: object[] }).rules).toEqual([{}]);
  });

  it("should show a field's unparsed English with a way to write it as rules, and keep it until it is removed", async () => {
    const user = await setup();
    expect(screen.getByText("If marriage is ticked then copy it")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a branch to 1.3" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Write 1.3 as rules" }));
    expect(screen.getByText("If marriage is ticked then copy it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a branch to 1.3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write 1.3 as rules" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove the English of 1.3" }));

    expect(screen.queryByText("If marriage is ticked then copy it")).toBeNull();
    const field = (await savedField(user, 2)) as Record<string, unknown>;
    expect(field.rules).toEqual([{}]);
    expect(field).not.toHaveProperty("logicText");
  });
});

describe("clearing TODOs and review markers", () => {
  it("should remove a TODO once it is marked done", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Done: TODO 1 of 1.3" }));
    expect(screen.queryByText(/logic not parsed into rules/)).toBeNull();
    expect(((await savedField(user, 2)) as { todo: string[] }).todo).toEqual([]);
  });

  it("should remove a review marker from the checklist, which then goes", async () => {
    const user = await setup();
    expect(screen.getByRole("heading", { name: /Review checklist \(1 guesses/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Done: 1.3 Reason key" }));

    expect(screen.queryByRole("heading", { name: /Review checklist/ })).toBeNull();
    expect(await savedField(user, 2)).not.toHaveProperty("review");
  });

  it("should keep a field's details open after its last marker is cleared", async () => {
    const user = await setup();
    const details = () => screen.getByText("Rules and notes for 1.3").closest("details");
    expect(details()?.open).toBe(true);

    await user.click(screen.getByRole("button", { name: "Done: TODO 1 of 1.3" }));
    await user.click(screen.getByRole("button", { name: "Done: check 1 of 1.3" }));

    expect(details()?.open).toBe(true);
  });

  it("should remove a review marker from the field's own row", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Done: check 1 of 1.3" }));
    expect(screen.queryByText(/Check the key/)).toBeNull();
  });
});
