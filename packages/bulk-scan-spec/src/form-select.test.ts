import { describe, expect, it } from "vitest";
import { requireOneForm, selectForms } from "./form-select.ts";
import type { Bundle } from "./schema.ts";
import { formSpecSchema } from "./schema.ts";

describe("selectForms", () => {
  const bundle: Bundle = { forms: [formSpecSchema.parse({ form: { name: "A" } }), formSpecSchema.parse({ form: { name: "B" } })] };
  it("should pick the numbered form and refuse a number when it is out of range or not whole", () => {
    expect(selectForms(bundle, undefined)).toHaveLength(2);
    expect(selectForms(bundle, "2").map((f) => f.form.name)).toEqual(["B"]);
    for (const bad of ["0", "3", "x", "1.5", ""]) {
      expect(() => selectForms(bundle, bad)).toThrow(/--form/);
    }
  });
});

describe("requireOneForm", () => {
  it("should accept a lone form, and demand --form when a bundle has several", () => {
    const one = { forms: [formSpecSchema.parse({ form: { name: "A" } })] };
    const two = { forms: [formSpecSchema.parse({ form: { name: "A" } }), formSpecSchema.parse({ form: { name: "B" } })] };
    expect(requireOneForm(one, undefined).form.name).toBe("A");
    expect(requireOneForm(two, "2").form.name).toBe("B");
    expect(() => requireOneForm(two, undefined)).toThrow(/--form/);
  });
});
