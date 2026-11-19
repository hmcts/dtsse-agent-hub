import { describe, expect, it } from "vitest";
import { bulkScanEditorView } from "./editor-view.ts";

const record = (spec: unknown) => ({ id: "i", name: "T", version: 2, spec, versions: [] });
const good = { form: { name: "T", formType: "T" }, sections: [{ id: "1", title: "", fields: [{ id: "1", keys: ["k"], mandatory: "mandatory" }] }] };

describe("editor view", () => {
  it("should carry the spec with its notes, scenarios, keys and sample", () => {
    const view = bulkScanEditorView(record(good));
    expect(view).toMatchObject({ id: "i", version: 2, keys: ["k"] });
    expect(view.notes).toHaveLength(1);
    expect(view.scenarios.map((s) => s.name)).toContain("valid");
    expect(view.sample).toHaveProperty("k");
    expect(view.targets).toContain("nfdiv");
  });

  it("should refuse a stored version that no longer reads", () => {
    expect(() => bulkScanEditorView(record({ sections: "x" }))).toThrow(/no longer reads/);
  });
});
