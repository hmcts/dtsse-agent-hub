import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { fieldSchema, formSpecSchema } from "../schema.ts";
import { sscsSchema } from "./sscs.ts";

describe("the generated SSCS schema under a strict validator", () => {
  const spec = formSpecSchema.parse({
    form: { formType: "X" },
    sections: [
      {
        id: "1",
        title: "",
        fields: [
          fieldSchema.parse({ keys: ["answer"], emits: ["Yes", "No", "Not-sure (maybe)", "a.b/c"].map((value) => ({ key: "answer", value })) }),
          fieldSchema.parse({ keys: ["applicantEmail", "birthDay"] })
        ]
      }
    ]
  });
  const validate = new Ajv({ strict: true, unicodeRegExp: true }).compile(sscsSchema(spec) as object);

  it("should compile under ajv with the unicode flag and accept listed values in any case when the value is checked, and blank", () => {
    for (const answer of ["Yes", "yes", "NO", "not-sure (maybe)", "A.B/C", ""]) {
      expect(validate({ answer }), answer).toBe(true);
    }
    expect(validate({ answer: "maybe" })).toBe(false);
    expect(validate({ answer: "A-B/C" })).toBe(false);
    expect(validate({ applicantEmail: "Test@Example.com", birthDay: "31" })).toBe(true);
    expect(validate({ birthDay: "32" })).toBe(false);
  });
});
