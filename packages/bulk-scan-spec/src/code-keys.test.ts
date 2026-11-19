import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { javaPojoKeys, loadCodeKeys } from "./code-keys.ts";
import { classifyDrift } from "./drift.ts";

describe("fis code keys", () => {
  it("should read each fis key once when the form and transform YAML both name it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fis-"));
    writeFileSync(join(dir, "application-t-form.yaml"), "uk:\n  mandatoryFields:\n    - Applicant_Name\n    - other\n");
    writeFileSync(join(dir, "application-t-transform.yaml"), "uk:\n  caseDataFields:\n    ccd: Applicant_Name\n");
    const keys = loadCodeKeys("fis", dir).map((k) => k.key);
    expect(keys).toEqual(["Applicant_Name", "other"]);
    const report = classifyDrift([{ key: "applicant_name", readable: true, ids: ["1"] }], [{ key: "Applicant_Name" }, { key: "Applicant_Name" }]);
    expect(report.caseOnly).toHaveLength(1);
    expect(report.likelyRenamed).toHaveLength(0);
    expect(report.codeOnly).toEqual([]);
  });
});

describe("javaPojoKeys", () => {
  it("should read fields under their @JsonProperty name when they have one, and skip static and transient fields, methods and comments", () => {
    const keys = javaPojoKeys(`
      class A {
        static final private String CONSTANT = "x";
        @JsonProperty("aliased") @Deprecated private String field;
        @JsonProperty(value = "named")
        protected final String other;
        public String pub;
        private transient String skipped;
        private String plain; // a comment with private String ghost;
        // was @JsonProperty("oldName")
        private String current;
        void method() { String local = "x"; private String notAField; }
        private String last;
      }`);
    expect(keys).toEqual([
      { key: "aliased", alias: { field: "field" } },
      { key: "named", alias: { field: "other" } },
      { key: "pub" },
      { key: "plain" },
      { key: "current" },
      { key: "last" }
    ]);
  });
});
