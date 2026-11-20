import { Ajv as AjvR8 } from "ajv";
import { describe, expect, it } from "vitest";
import { fieldSchema, formSpecSchema, fieldSchema as fsR8, formSpecSchema as fssR8, formSpecSchema as fssX, fieldSchema as fsX } from "../schema.ts";
import { sscsSchema as sscsR8, sscsSchema, sscsSchema as sscsX } from "./sscs.ts";

describe("sscsSchema allowed values", () => {
  it("should accept listed values in any case when they are checked, as the Java validator and the TS expectations do, and nothing else", () => {
    const spec = formSpecSchema.parse({
      form: { formType: "X" },
      sections: [
        {
          id: "1",
          title: "",
          fields: [fieldSchema.parse({ keys: ["married"], emits: ["Yes", "No", "Yes, partly", ""].map((value) => ({ key: "married", value })) })]
        }
      ]
    });
    const property = (sscsSchema(spec) as { properties: Record<string, { pattern?: string; enum?: string[] }> }).properties.married;
    expect(property?.enum).toBeUndefined();
    const re = new RegExp(property?.pattern ?? "");
    for (const ok of ["Yes", "yes", "YES", "no", "Yes, partly", "yes, PARTLY", ""]) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ["maybe", "Yess", "Yes partly", "n"]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });
});

describe("sscs blank values", () => {
  it("should accept blank for a listed-value key when the sheet does not list blank, as Java and the expectations do", () => {
    const spec = fssX.parse({
      form: { formType: "X" },
      sections: [{ id: "1", title: "", fields: [fsX.parse({ keys: ["married"], emits: ["Yes", "No"].map((value) => ({ key: "married", value })) })] }]
    });
    const pattern = (sscsX(spec) as { properties: Record<string, { pattern: string }> }).properties.married?.pattern ?? "";
    expect(new RegExp(pattern).test("")).toBe(true);
    expect(new RegExp(pattern).test("yes")).toBe(true);
    expect(pattern).not.toContain("\\-");
  });
});

describe("sscs keys with both listed values and a regex", () => {
  it("should enforce both when a key has listed values and a regex, as the Java validator does", () => {
    const spec = fssR8.parse({
      form: { formType: "X" },
      sections: [
        { id: "1", title: "", fields: [fsR8.parse({ keys: ["code"], regex: "[A-Z]{3}", emits: ["ABC", "xyz"].map((value) => ({ key: "code", value })) })] }
      ]
    });
    const validate = new AjvR8({ strict: true, unicodeRegExp: true }).compile(sscsR8(spec) as object);
    expect(validate({ code: "ABC" })).toBe(true);
    expect(validate({ code: "xyz" })).toBe(false);
    expect(validate({ code: "DEF" })).toBe(false);
    expect(validate({ code: "" })).toBe(true);
  });
});
