import { describe, expect, it } from "vitest";
import { allFields, bundleSchema, fieldSchema, formSpecSchema, ruleSchema } from "./schema.ts";

describe("spec schema", () => {
  it("should default a field to an optional text field with no keys when nothing is given", () => {
    const field = fieldSchema.parse({});
    expect(field).toMatchObject({ role: "field", inputType: "text", mandatory: "optional", keys: [], ccd: [], rules: [], todo: [] });
  });

  it("should accept a rule that sets one field from another when it does not set a literal, and one that does", () => {
    expect(ruleSchema.parse({ when: { a: true, b: { not: null } }, set: { x: "yes", y: { from: "a" } }, outcome: "success" })).toBeTruthy();
  });

  it("should reject an outcome when it is not success, warning or exception", () => {
    expect(() => ruleSchema.parse({ outcome: "error" })).toThrow();
  });

  it("should reject an input type when the sheets do not know it", () => {
    expect(() => fieldSchema.parse({ inputType: "radio" })).toThrow();
  });

  it("should accept a form when it has no sections, and list the fields of every section in order", () => {
    expect(formSpecSchema.parse({ form: {} }).sections).toEqual([]);
    const spec = formSpecSchema.parse({
      form: { name: "D8" },
      sections: [
        { id: "1", title: "One", fields: [{ id: "1.1" }, { id: "1.2" }] },
        { id: "2", title: "Two", fields: [{ id: "2.1" }] }
      ]
    });
    expect(allFields(spec).map((f) => f.id)).toEqual(["1.1", "1.2", "2.1"]);
  });

  it("should allow a bundle when it has an overview and several forms", () => {
    const bundle = bundleSchema.parse({
      overview: { serviceName: "Divorce", contacts: [{ name: "A" }] },
      forms: [{ form: { name: "D8" } }, { form: { name: "D84" } }]
    });
    expect(bundle.forms).toHaveLength(2);
  });
});
