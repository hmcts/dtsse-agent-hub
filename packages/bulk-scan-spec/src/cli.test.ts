import { spawnSync } from "node:child_process";
import { existsSync as existsX, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
