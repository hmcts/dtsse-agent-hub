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

type User = ReturnType<typeof userEvent.setup>;

async function setup() {
  const user = userEvent.setup();
  render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
  return user;
}

/** Opens a field in the outline by its id. */
const open = (user: User, id: string) => user.click(screen.getByRole("button", { name: new RegExp(`^${id.replace(".", "\\.")} `) }));

async function saved(user: User) {
  await user.click(screen.getByRole("button", { name: "Save as version 2" }));
  return JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec as {
    sections: { id: string; title: string; fields: Record<string, unknown>[] }[];
  };
}

async function savedField(user: User, index: number) {
  const field = (await saved(user)).sections[0]?.fields[index];
  if (!field) {
    throw new Error("no such field");
  }
  return field;
}

const select = (user: User, name: string, value: string) => user.selectOptions(screen.getByLabelText(name), value);

describe("adding, removing and reordering", () => {
  it("should show the engine's refusal on the field when a field was added with an empty key", async () => {
    const user = await setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "the spec has errors", issues: [{ path: "sections.1.fields.1.keys.0", message: 'the key "" is bad' }] }), {
        status: 422
      })
    );

    await user.click(screen.getByRole("button", { name: "Add a field to section 2" }));
    await user.click(screen.getByRole("button", { name: "Save as version 2" }));

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec;
    expect(body.sections[1].fields[1]).toMatchObject({ keys: [""], inputType: "text", mandatory: "mandatory" });
    expect(await screen.findByText('keys.0: the key "" is bad')).toBeTruthy();
  });

  it("should drop the marks of the last save when fields move, since they would point at other fields", async () => {
    const user = await setup();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad", issues: [{ path: "sections.0.fields.1.regex", message: "not a regex" }] }), { status: 422 })
    );
    await open(user, "1.2");
    await user.type(screen.getByLabelText("Label"), "!");
    await user.click(screen.getByRole("button", { name: "Save as version 2" }));
    expect(await screen.findByText("regex: not a regex")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Move 1.2 up" }));

    expect(screen.queryByText("regex: not a regex")).toBeNull();
  });

  it("should remove and reorder fields and sections when their buttons are pressed", async () => {
    const user = await setup();

    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Move 1.2 up" }));
    await open(user, "1.3");
    await user.click(screen.getByRole("button", { name: "Remove 1.3" }));
    await user.click(screen.getByRole("button", { name: "Move section 2 up" }));
    await user.click(screen.getByRole("button", { name: "Add a section" }));
    await user.type(screen.getByLabelText("Section title"), "Third");

    const body = await saved(user);
    expect(body.sections.map((s) => s.id)).toEqual(["2", "1", "3"]);
    expect(body.sections[1]?.fields.map((f) => f.id)).toEqual(["1.2", "1.1"]);
    expect(body.sections[2]?.title).toBe("Third");
  });

  it("should keep the moved field open when its move button is pressed", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Move 1.2 down" }));
    expect(screen.getByRole("heading", { level: 2, name: /^1\.2 / })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^1\.2 / }).getAttribute("aria-current")).toBe("true");
  });

  it("should remove a section when its button is pressed", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Remove section 1" }));
    expect((await saved(user)).sections.map((s) => s.id)).toEqual(["2"]);
  });

  it("should take an id no section has when a section is added", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Add a section" }));
    expect((screen.getByLabelText("Section ID") as HTMLInputElement).value).toBe("3");
  });
});

describe("the question card", () => {
  it("should send the id, label, input type and mandatory as typed when they are changed", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.type(screen.getByLabelText("Label"), " of person");
    await user.clear(screen.getByLabelText("ID"));
    await user.type(screen.getByLabelText("ID"), "1.9");
    await select(user, "Input type", "date");
    await select(user, "Mandatory", "mandatory");

    expect(await savedField(user, 1)).toMatchObject({ id: "1.9", label: "Name of person", inputType: "date", mandatory: "mandatory" });
  });

  it("should name each input by a visible label when the card is shown", async () => {
    await setup();
    for (const name of ["ID", "Label", "Input type", "Mandatory", "Regex", "Min length", "Max length", "CCD ids"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });
});

describe("the keys card", () => {
  it("should send the regex and both lengths when they are typed side by side", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.type(screen.getByLabelText("Regex"), "^[[A-Z]+$");
    await user.type(screen.getByLabelText("Min length"), "2");
    await user.type(screen.getByLabelText("Max length"), "x9");

    expect(await savedField(user, 1)).toMatchObject({ regex: "^[A-Z]+$", minLength: 2, maxLength: 9 });
  });

  it("should split pasted text on spaces and commas into separate keys when the box is left", async () => {
    const user = await setup();
    await open(user, "1.2");
    const key = screen.getByLabelText("Key 1");
    await user.clear(key);
    await user.type(key, "alpha, beta  gamma");
    await user.tab();

    expect(((await savedField(user, 1)) as { keys: string[] }).keys).toEqual(["alpha", "beta", "gamma"]);
    expect(screen.getByLabelText("Key 3")).toBeTruthy();
  });

  it("should add and remove keys when their buttons are pressed", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.type(screen.getByLabelText("Key 2"), "surname{Enter}");
    await user.click(screen.getByRole("button", { name: "Remove key 1" }));

    expect(((await savedField(user, 1)) as { keys: string[] }).keys).toEqual(["surname"]);
  });
});

describe("a key box", () => {
  it("should keep the key and every condition that names it when the box is cleared and left", async () => {
    const user = await setup2();
    const key = screen.getByLabelText("Key 1") as HTMLInputElement;
    await user.clear(key);
    await user.tab();

    expect(key.value).toBe("left");
    expect((screen.getByRole("button", { name: "Save as version 2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should not mark the form changed when the text typed means the same keys", async () => {
    const user = await setup2();
    await user.type(screen.getByLabelText("Key 1"), " ");
    await user.tab();
    await user.type(screen.getByLabelText("CCD ids"), " ");
    await user.tab();

    expect((screen.getByRole("button", { name: "Save as version 2" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("removing a key", () => {
  it("should remove the key's emits and group option and its own conditions, leaving other fields' for the engine to refuse, when its button is pressed", async () => {
    const user = await setup2();
    await user.click(screen.getByRole("button", { name: "Remove key 1" }));

    const [pair, other] = await saved2(user);
    expect(pair?.keys).toEqual(["right"]);
    expect(pair?.emits.map((e: { key: string }) => e.key)).toEqual(["right"]);
    expect(pair).not.toHaveProperty("group");
    expect(pair?.rules[0]).not.toHaveProperty("when");
    expect(other?.required.when).toEqual({ left: { ticked: true } });
  });
});

describe("the where-it-goes card", () => {
  it("should send the CCD ids as words when the box is left", async () => {
    const user = await setup();
    const box = screen.getByLabelText("CCD ids");
    await user.clear(box);
    await user.type(box, "aCcd, bCcd");
    await user.tab();

    expect(((await savedField(user, 0)) as { ccd: string[] }).ccd).toEqual(["aCcd", "bCcd"]);
  });
});

describe("allowed values", () => {
  it("should send the exact strings typed when values are added one at a time", async () => {
    const user = await setup();
    const marriage = () => within(screen.getByRole("group", { name: "Allowed values of marriage" }));
    while (marriage().queryByRole("button", { name: "Remove marriage value 1" })) {
      await user.click(marriage().getByRole("button", { name: "Remove marriage value 1" }));
    }
    await user.click(screen.getByRole("button", { name: "Add a value for marriage" }));
    await user.keyboard("Yes");
    await user.click(screen.getByRole("button", { name: "Add a value for marriage" }));
    await user.keyboard(" No ");

    const blank = screen.getByLabelText("Blank allowed for marriage") as HTMLInputElement;
    expect(blank.checked).toBe(true);
    await user.click(blank);
    await user.click(blank);
    await user.click(blank);

    expect((screen.getByLabelText("marriage value 2") as HTMLInputElement).value).toBe(" No ");
    const field = (await savedField(user, 0)) as { emits: { key: string; value: string }[] };
    expect(field.emits.filter((e) => e.key === "marriage").map((e) => e.value)).toEqual(["Yes", " No "]);
    expect(field.emits.filter((e) => e.key === "civil").map((e) => e.value)).toEqual(["true", "false"]);
  });

  it("should list no value of a box that was added and left empty when the field is saved", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a value for name" }));
    await user.click(screen.getByRole("button", { name: "Add a value for name" }));
    await user.keyboard("Ann");

    const emits = ((await savedField(user, 1)) as { emits: { key: string; value: string }[] }).emits;
    expect(emits.filter((e) => e.key === "name").map((e) => e.value)).toEqual(["Ann", ""]);
  });
});

describe("allowed values after another change", () => {
  it("should show the values the new input type gives when a checkbox field becomes text", async () => {
    const user = await setup();
    expect((screen.getByLabelText("marriage value 1") as HTMLInputElement).value).toBe("true");
    await select(user, "Input type", "text");

    expect(screen.queryByLabelText("marriage value 1")).toBeNull();
    await select(user, "Input type", "checkbox");
    expect((screen.getByLabelText("marriage value 1") as HTMLInputElement).value).toBe("true");
  });
});

describe("typing a value that repeats a listed one", () => {
  it("should keep the box while Yes more is typed beside an existing Yes", async () => {
    const user = await setup2();
    const group = () => within(screen.getByRole("group", { name: "Allowed values of left" }));
    expect((group().getByLabelText("left value 1") as HTMLInputElement).value).toBe("Yes");
    await user.click(group().getByRole("button", { name: "Add a value for left" }));
    await user.keyboard("Yes");
    await user.keyboard(" more");

    expect((group().getByLabelText("left value 2") as HTMLInputElement).value).toBe("Yes more");
  });
});

describe("XoR groups", () => {
  it("should leave a blank key out of the group when the box is ticked with a blank key present", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: "Add a key" }));
    await user.click(screen.getByRole("checkbox", { name: /mutually exclusive/ }));

    const grouped = (await savedField(user, 0)) as { group: { size: number; options: { key: string }[] } };
    expect(grouped.group.options.map((o) => o.key)).toEqual(["marriage", "civil"]);
    expect(grouped.group.size).toBe(2);
  });

  it("should make a field's keys a group when the box is ticked, and ungroup them when it is cleared", async () => {
    const user = await setup();
    const box = screen.getByRole("checkbox", { name: /mutually exclusive/ }) as HTMLInputElement;

    await user.click(box);
    expect(box.checked).toBe(true);
    const grouped = (await savedField(user, 0)) as { group: unknown };
    expect(grouped.group).toEqual({ kind: "xor", size: 2, options: [{ key: "marriage" }, { key: "civil" }] });

    fetchMock.mockClear();
    await user.click(box);
    expect(box.checked).toBe(false);
    expect(await savedField(user, 0)).not.toHaveProperty("group");
  });

  it("should offer no group when a field has one key", async () => {
    const user = await setup();
    await open(user, "1.2");
    expect(screen.queryByRole("checkbox", { name: /mutually exclusive/ })).toBeNull();
  });
});

describe("conditional mandatory", () => {
  it("should set each kind of mandatory condition when the key and test are chosen", async () => {
    const user = await setup();
    await open(user, "1.2");
    await select(user, "Mandatory", "conditional");

    await user.click(screen.getByRole("button", { name: "Add a condition to mandatory condition" }));
    await select(user, "mandatory condition, condition 1 key", "civil");
    await select(user, "mandatory condition, condition 1 operator", "ticked");
    let required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil is ticked", when: { civil: { ticked: true } } });

    await select(user, "mandatory condition, condition 1 operator", "=");
    await user.type(screen.getByLabelText("mandatory condition, condition 1 value"), "Yes");
    fetchMock.mockClear();
    required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil = Yes", when: { civil: "Yes" } });

    await select(user, "mandatory condition, condition 1 operator", "filled");
    fetchMock.mockClear();
    required = ((await savedField(user, 1)) as { required: unknown }).required;
    expect(required).toEqual({ label: "civil is not blank", when: { civil: { not: null } } });
  });

  it("should only offer keys the form reads when a condition is built", async () => {
    const user = await setup();
    await open(user, "1.2");
    await select(user, "Mandatory", "conditional");
    await user.click(screen.getByRole("button", { name: "Add a condition to mandatory condition" }));

    const options = within(screen.getByLabelText("mandatory condition, condition 1 key")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining(["marriage", "civil", "name", "extra", "1.1 Kind"]));
    expect(options.map((o) => o.textContent)).not.toContain("nope");
  });

  it("should show the condition editor only when Mandatory if is chosen", async () => {
    const user = await setup();
    await open(user, "1.2");
    expect(screen.queryByRole("button", { name: "Add a condition to mandatory condition" })).toBeNull();
    await select(user, "Mandatory", "conditional");
    expect(screen.getByRole("button", { name: "Add a condition to mandatory condition" })).toBeTruthy();
    await select(user, "Mandatory", "optional");
    expect(screen.queryByRole("button", { name: "Add a condition to mandatory condition" })).toBeNull();
  });
});

describe("the rules sentence builder", () => {
  const branch = "branch 1";

  async function startRule(user: User) {
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.click(screen.getByRole("button", { name: `Add a condition to ${branch}` }));
  }

  it("should word the branch as the sheet will when it is built with a condition, an assignment, an outcome and a note", async () => {
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
      within(screen.getByRole("group", { name: "Transformation sheet logic" })).getByText(/If marriage is ticked, nameCcd = Wife \(warning\) \(WITH WARNING\)/)
    ).toBeTruthy();
    expect(screen.getByText("The transformation sheet will say:")).toBeTruthy();
    const rule = ((await savedField(user, 1)) as { rules: unknown[] }).rules[0];
    expect(rule).toEqual({ when: { marriage: { ticked: true } }, set: { nameCcd: "Wife" }, outcome: "warning", note: "(WITH WARNING)" });
  });

  it("should copy a key into a CCD field when the assignment is a copy", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.click(screen.getByRole("button", { name: `Add an assignment to ${branch}` }));

    await select(user, `${branch}, assignment 1 CCD field`, "nameCcd");
    await select(user, `${branch}, assignment 1 kind`, "copy");
    await select(user, `${branch}, assignment 1 key`, "name");

    expect(screen.getByText("nameCcd = name")).toBeTruthy();
    expect(((await savedField(user, 1)) as { rules: unknown[] }).rules[0]).toEqual({ set: { nameCcd: { from: "name" } } });
  });

  it("should remove an assignment when its button is pressed", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.click(screen.getByRole("button", { name: `Add an assignment to ${branch}` }));
    await user.click(screen.getByRole("button", { name: `Remove ${branch}, assignment 1` }));

    expect(((await savedField(user, 1)) as { rules: object[] }).rules).toEqual([{}]);
  });

  it("should give an OR alternative its own conditions when one is added", async () => {
    const user = await setup();
    await startRule(user);
    await user.click(screen.getByRole("button", { name: `Add an OR alternative to ${branch}` }));
    await select(user, `${branch}, alternative 2, condition 1 key`, "civil");
    await select(user, `${branch}, alternative 2, condition 1 operator`, "blank");

    expect(screen.getByText("Or when")).toBeTruthy();
    const rule = ((await savedField(user, 1)) as { rules: { whenAny: unknown[] }[] }).rules[0];
    expect(rule?.whenAny).toHaveLength(2);
    expect(rule?.whenAny[1]).toEqual({ civil: null });
  });

  it("should make a later branch the ELSE or the start of a new chain when its toggle is ticked", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    expect(screen.queryByLabelText("Starts a new chain: branch 1")).toBeNull();

    await user.click(screen.getByLabelText("ELSE: branch 2"));
    await select(user, "Outcome of branch 2", "exception");
    expect(screen.queryByRole("button", { name: "Add a condition to branch 2" })).toBeNull();
    await user.click(screen.getByLabelText("ELSE: branch 2"));
    await user.click(screen.getByLabelText("Starts a new chain: branch 2"));

    const rules = ((await savedField(user, 1)) as { rules: object[] }).rules;
    expect(rules).toEqual([{}, { outcome: "exception", independent: true }]);
  });

  it("should reorder and remove branches when their buttons are pressed", async () => {
    const user = await setup();
    await open(user, "1.2");
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.click(screen.getByRole("button", { name: "Add a branch" }));
    await user.type(screen.getByLabelText("Note of branch 2"), "second");

    await user.click(screen.getByRole("button", { name: "Move branch 2 up" }));
    expect((screen.getByLabelText("Note of branch 1") as HTMLInputElement).value).toBe("second");
    await user.click(screen.getByRole("button", { name: "Remove branch 2" }));

    expect(((await savedField(user, 1)) as { rules: object[] }).rules).toEqual([{ note: "second" }]);
  });

  it("should leave a branch that tests nothing when its last condition is removed", async () => {
    const user = await setup();
    await startRule(user);
    await user.click(screen.getByRole("button", { name: `Remove ${branch}, condition 1` }));
    expect(((await savedField(user, 1)) as { rules: object[] }).rules).toEqual([{}]);
  });

  it("should keep a field's unparsed English until it is removed when it is written as rules", async () => {
    const user = await setup();
    await open(user, "1.3");
    expect(screen.getByText("If marriage is ticked then copy it")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a branch" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Write as rules" }));
    expect(screen.getByText("If marriage is ticked then copy it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a branch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write as rules" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove English" }));

    expect(screen.queryByText("If marriage is ticked then copy it")).toBeNull();
    const field = (await savedField(user, 2)) as Record<string, unknown>;
    expect(field.rules).toEqual([{}]);
    expect(field).not.toHaveProperty("logicText");
  });
});

describe("the review card", () => {
  it("should remove a TODO when it is marked done", async () => {
    const user = await setup();
    await open(user, "1.3");
    await user.click(screen.getByRole("button", { name: "Done: TODO 1" }));
    expect(screen.queryByText(/logic not parsed into rules/)).toBeNull();
    expect(((await savedField(user, 2)) as { todo: string[] }).todo).toEqual([]);
  });

  it("should show the reason and confidence of a review marker and remove it when it is marked done", async () => {
    const user = await setup();
    await open(user, "1.3");
    expect(screen.getByText(/Check the key/)).toBeTruthy();
    expect(screen.getByText(/low confidence/)).toBeTruthy();
    expect(screen.getByText(/guessed/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Done: check 1" }));

    expect(screen.queryByText(/Check the key/)).toBeNull();
    expect(await savedField(user, 2)).not.toHaveProperty("review");
  });

  it("should leave the field open and drop its card when its last marker is cleared", async () => {
    const user = await setup();
    await open(user, "1.3");
    await user.click(screen.getByRole("button", { name: "Done: TODO 1" }));
    await user.click(screen.getByRole("button", { name: "Done: check 1" }));

    expect(screen.queryByRole("heading", { name: "Review" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /^1\.3 / })).toBeTruthy();
    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });
});

const VIEW2 = {
  ...VIEW,
  spec: {
    form: { name: "D8", formType: "D8" },
    sections: [
      { id: "1", title: "A", fields: [] },
      {
        id: "3",
        title: "B",
        fields: [
          field({
            id: "5.1",
            label: "Pair",
            keys: ["left", "right"],
            ccd: ["pairCcd"],
            inputType: "checkbox",
            group: {
              kind: "xor",
              size: 2,
              options: [
                { key: "left", label: "Left one" },
                { key: "right", label: "Right one" }
              ]
            },
            emits: [
              { key: "left", value: "Yes" },
              { key: "left", value: "" },
              { key: "right", value: "No" }
            ],
            rules: [{ when: { left: "Yes" }, set: { pairCcd: { from: "right" } }, outcome: "warning" }]
          }),
          field({
            id: "5.2",
            label: "Other",
            keys: ["other"],
            mandatory: "conditional",
            required: { label: "Optional if the form is joint", when: { left: { ticked: true } } },
            ccd: ["otherCcd"],
            rules: [
              { when: { left: "true" }, set: { otherCcd: "false" }, action: "also tell the caseworker" },
              { when: { right: true }, set: { otherCcd: true } }
            ]
          })
        ]
      }
    ],
    composes: [],
    pageOrder: [],
    expectedDocuments: []
  }
} as unknown as BulkScanEditorView;

async function setup2() {
  const user = userEvent.setup();
  render(<BulkScanEditor view={VIEW2} signOff={vi.fn()} />);
  return user;
}

async function saved2(user: User) {
  await user.click(screen.getByRole("button", { name: "Save as version 2" }));
  return JSON.parse(fetchMock.mock.calls[0]?.[1].body).spec.sections[1].fields as Record<string, any>[];
}

describe("retyping a key", () => {
  it("should carry its allowed values, group label and rules to the new spelling when the key is retyped and the box left", async () => {
    const user = await setup2();
    const key = screen.getByLabelText("Key 1");

    await user.clear(key);
    await user.type(key, "leftHand");
    await user.tab();

    const [pair, other] = await saved2(user);
    expect(pair?.keys).toEqual(["leftHand", "right"]);
    expect(pair?.emits.filter((e: { key: string }) => e.key === "leftHand").map((e: { value: string }) => e.value)).toEqual(["Yes", ""]);
    expect(pair?.group.options[0]).toEqual({ key: "leftHand", label: "Left one" });
    expect(pair?.rules[0].when).toEqual({ leftHand: "Yes" });
    expect(other?.required.when).toEqual({ leftHand: { ticked: true } });
    expect(other?.rules[0].when).toEqual({ leftHand: "true" });
  });

  it("should keep the group and its labels when a key is cleared and retyped before the box is left", async () => {
    const user = await setup2();
    const key = screen.getByLabelText("Key 1");

    await user.clear(key);
    await user.type(key, "x");
    expect((screen.getByRole("checkbox", { name: /mutually exclusive/ }) as HTMLInputElement).checked).toBe(true);
    await user.clear(key);
    await user.type(key, "left");
    await user.tab();
    await user.type(screen.getByLabelText("Label"), "!");

    const [pair] = await saved2(user);
    expect(pair?.group).toEqual({
      kind: "xor",
      size: 2,
      options: [
        { key: "left", label: "Left one" },
        { key: "right", label: "Right one" }
      ]
    });
  });

  it("should send the key when Enter is pressed in the box", async () => {
    const user = await setup2();
    const save = screen.getByRole("button", { name: "Save as version 2" }) as HTMLButtonElement;
    await user.type(screen.getByLabelText("Key 1"), "X");
    expect(save.disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(save.disabled).toBe(false);
  });
});

describe("blank for a free-text key", () => {
  it("should leave the blank box ticked and disabled when the key lists no values", async () => {
    const user = await setup2();
    expect((screen.getByLabelText("Blank allowed for left") as HTMLInputElement).disabled).toBe(false);
    await open(user, "5.2");
    const blank = screen.getByLabelText("Blank allowed for other") as HTMLInputElement;
    expect([blank.checked, blank.disabled]).toEqual([true, true]);
  });
});

describe("the mandatory wording", () => {
  it("should keep the sheet's wording when the condition is changed and when it is removed", async () => {
    const user = await setup2();
    await open(user, "5.2");

    await select(user, "mandatory condition, condition 1 operator", "filled");
    await user.click(screen.getByRole("button", { name: "Remove mandatory condition, condition 1" }));

    const [, other] = await saved2(user);
    expect(other?.required).toEqual({ label: "Optional if the form is joint" });
  });
});

describe("a branch's unparsed English", () => {
  it("should remove the action when its button is pressed, keeping the branch's conditions", async () => {
    const user = await setup2();
    await open(user, "5.2");
    expect(screen.getByText(/English the importer could not read: also tell the caseworker/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove the English of branch 1" }));

    expect(screen.queryByText(/English the importer could not read/)).toBeNull();
    const [, other] = await saved2(user);
    expect(other?.rules[0]).toEqual({ when: { left: "true" }, set: { otherCcd: "false" } });
  });
});

describe("values that look like true, false or null", () => {
  it("should keep a stored text and a stored boolean as they are when only the outcome is changed", async () => {
    const user = await setup2();
    await open(user, "5.2");
    await select(user, "Outcome of branch 2", "warning");

    const [, other] = await saved2(user);
    expect(other?.rules[0].when).toEqual({ left: "true" });
    expect(other?.rules[0].set).toEqual({ otherCcd: "false" });
    expect(other?.rules[1].when).toEqual({ right: true });
    expect(other?.rules[1].set).toEqual({ otherCcd: true });
  });

  it("should store the typed value only when the box beside it is ticked, after the value is typed", async () => {
    const user = await setup2();
    await open(user, "5.2");
    const value = screen.getByLabelText("branch 2, condition 1 value");

    await user.clear(value);
    await user.type(value, "false");
    const asValue = screen.getByLabelText("branch 2, condition 1: false is the value, not the word") as HTMLInputElement;
    expect(asValue.checked).toBe(false);
    await user.click(asValue);

    const [, other] = await saved2(user);
    expect(other?.rules[1].when).toEqual({ right: false });
  });
});

describe("a new section", () => {
  it("should take an id no section has when it is added", async () => {
    const user = await setup2();
    await user.click(screen.getByRole("button", { name: "Add a section" }));
    expect((screen.getByLabelText("Section ID") as HTMLInputElement).value).toBe("4");
    await user.click(screen.getByRole("button", { name: /^3 B/ }));
    expect((screen.getByLabelText("Section ID") as HTMLInputElement).value).toBe("3");
  });
});

describe("a refresh while editing", () => {
  const newer = (over: object = {}): BulkScanEditorView =>
    ({
      ...VIEW,
      version: 2,
      versions: [{ ...VIEW.versions[0], version: 2 }, ...VIEW.versions],
      ...over
    }) as unknown as BulkScanEditorView;

  async function editedLabel(user: User): Promise<void> {
    await open(user, "1.2");
    await user.type(screen.getByLabelText("Label"), "!");
  }

  it("should keep unsaved edits and save them against the version they started from when a newer latest version arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    await editedLabel(user);

    rerender(<BulkScanEditor view={newer()} signOff={vi.fn()} />);
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Name!");
    await user.click(screen.getByRole("button", { name: "Save as version 3" }));

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).baseVersion).toBe(1);
  });

  it("should start afresh when the version asked for changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    await editedLabel(user);

    rerender(<BulkScanEditor view={newer({ version: 1 })} requested={1} signOff={vi.fn()} />);
    await open(user, "1.2");

    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Name");
  });

  it("should start afresh when the form changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BulkScanEditor view={VIEW} signOff={vi.fn()} />);
    await editedLabel(user);

    rerender(<BulkScanEditor view={{ ...VIEW, id: "s2" }} signOff={vi.fn()} />);
    await open(user, "1.2");

    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Name");
  });
});
