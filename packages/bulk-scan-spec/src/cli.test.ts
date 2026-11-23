import { spawnSync } from "node:child_process";
import { existsSync as existsX, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makePdf, SAMPLE_FORM } from "./__fixtures__/make-pdf.ts";
import { formSpecSchema } from "./schema.ts";

const CLI = join(import.meta.dirname, "cli.ts");

function run(...args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

describe("cli on a bundle with several forms", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const spec = join(dir, "spec.json");
  writeFileSync(
    spec,
    JSON.stringify({ forms: [formSpecSchema.parse({ form: { name: "A", formType: "A" } }), formSpecSchema.parse({ form: { name: "B", formType: "B" } })] })
  );

  it.each([
    ["drift", ["--pattern", "fis", "--code", dir]],
    ["codegen", ["--target", "fis", "--out", join(dir, "out")]]
  ])("should refuse %s instead of taking the first form when --form is missing", (command, rest) => {
    const result = run(command as string, "--spec", spec, ...(rest as string[]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--form");
  });

  it("should still run codegen when --form names one", () => {
    const result = run("codegen", "--spec", spec, "--target", "orchestrator", "--out", join(dir, "out2"), "--form", "2");
    expect(result.status).toBe(0);
  });
});

describe("cli codegen for every target", () => {
  it("should write the new case fields once, not once per target", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-new-"));
    const spec = join(dir, "spec.json");
    writeFileSync(
      spec,
      JSON.stringify({
        forms: [
          formSpecSchema.parse({
            form: { name: "A", formType: "A", ccdCaseTypeId: "T" },
            sections: [
              {
                id: "1",
                title: "S",
                fields: [{ label: "Place", keys: ["place"], ccd: ["place"], ccdMatch: { status: "new", newField: { id: "place", type: "Text" } } }]
              }
            ]
          })
        ]
      })
    );

    const result = run("codegen", "--spec", spec, "--target", "all", "--out", join(dir, "out"));

    expect(result.status).toBe(0);
    expect(result.stdout.match(/new-ccd-fields\.json/g)).toHaveLength(1);
    expect(existsX(join(dir, "out", "new-ccd-fields.json"))).toBe(true);
  });
});

describe("cli generate validates before writing", () => {
  it("should not write the SIP when --transform cannot be satisfied", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-gen-"));
    const spec = join(dir, "spec.json");
    writeFileSync(
      spec,
      JSON.stringify({ forms: [formSpecSchema.parse({ form: { name: "A", formType: "A" } }), formSpecSchema.parse({ form: { name: "B", formType: "B" } })] })
    );
    const sip = join(dir, "out.xlsx");
    const result = run("generate", "--spec", spec, "--sip", sip, "--transform", join(dir, "t.xlsx"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--form");
    expect(existsX(sip)).toBe(false);
  });
});

describe("the cli command line", () => {
  const run = (...args: string[]) => spawnSync("node", [join(import.meta.dirname, "cli.ts"), ...args], { encoding: "utf8" });

  it("should print the usage and exit 2 when the command is an Object.prototype member", () => {
    const result = run("constructor");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });

  it("should print a message without a stack trace when an option has no value", () => {
    const result = run("import", "--transform");
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).toContain("argument missing");
  });
});

describe("cli option parsing", () => {
  const exec = (...args: string[]) => spawnSync("node", [join(import.meta.dirname, "cli.ts"), ...args], { encoding: "utf8" });

  it("should accept --option=value when the value is attached", () => {
    const result = exec("import", "--transform=/nonexistent/file.xlsx", "--out=/tmp/never.json");
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("unknown option");
    expect(result.stderr).toContain("/nonexistent/file.xlsx");
  });

  it("should name an unknown option and print the usage when it is not one the commands take", () => {
    const result = exec("import", "--transfrom", "x.xlsx");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--transfrom");
    expect(result.stderr).toContain("usage");
  });
});

describe("cli from-pdf", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-pdf-"));

  it("should write a draft that reuses keys from a house-style spec and print the review checklist", async () => {
    const pdf = await makePdf("form", SAMPLE_FORM);
    const house = join(dir, "house.json");
    writeFileSync(
      house,
      JSON.stringify({ forms: [formSpecSchema.parse({ form: {}, sections: [{ id: "1", title: "", fields: [{ keys: ["soleOrApplicant1FirstName"] }] }] })] })
    );
    const ccd = join(dir, "CaseField.json");
    writeFileSync(ccd, JSON.stringify([{ ID: "applicant1FirstName", FieldType: "Text" }]));
    const out = join(dir, "draft.json");
    const result = run("from-pdf", "--pdf", pdf, "--house-style", house, "--ccd", ccd, "--out", out);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("review checklist");
    expect(result.stdout).toContain("soleOrApplicant1FirstName");
    expect(JSON.parse(readFileSync(out, "utf8")).forms[0].sections[1].fields[0].ccd).toEqual(["applicant1FirstName"]);
  });

  it("should take house keys from service code when --pattern names it", async () => {
    const java = join(dir, "OcrDataFields.java");
    writeFileSync(java, "class OcrDataFields { private String soleOrApplicant1FirstName; }");
    const result = run("from-pdf", "--pdf", await makePdf("form", SAMPLE_FORM), "--house-style", java, "--pattern", "nfdiv", "--out", join(dir, "code.json"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matches existing key soleOrApplicant1FirstName");
  });

  it("should write the draft and a prompt file when the PDF has no form fields", async () => {
    const out = join(dir, "flat.json");
    const result = run("from-pdf", "--pdf", await makePdf("flat", [{ texts: [{ text: "Printed form", x: 40, y: 700 }] }]), "--out", out);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).needsReview.prompt).toBe(join(dir, "flat.prompt.md"));
    expect(readFileSync(join(dir, "flat.prompt.md"), "utf8")).toContain("Printed form");
  });

  it("should refuse an unknown --pattern", async () => {
    const result = run(
      "from-pdf",
      "--pdf",
      await makePdf("form", SAMPLE_FORM),
      "--house-style",
      join(dir, "x"),
      "--pattern",
      "bogus",
      "--out",
      join(dir, "y.json")
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--pattern must be one of");
  });

  it("should leave generate, codegen and drift to refuse a draft with no fields read", async () => {
    const out = join(dir, "flat2.json");
    run("from-pdf", "--pdf", await makePdf("flat", [{ texts: [{ text: "Printed", x: 40, y: 700 }] }]), "--out", out);
    const result = run("codegen", "--spec", out, "--target", "fis", "--out", join(dir, "gen"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needsReview");
  });

  it("should refuse without --pdf", () => {
    const result = run("from-pdf", "--out", join(dir, "x.json"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--pdf");
  });
});
