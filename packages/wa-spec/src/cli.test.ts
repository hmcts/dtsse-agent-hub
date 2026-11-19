import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { byCodePoint } from "./merge.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-"));
  const input = join(dir, "dmn");
  mkdirSync(input);
  writeFileSync(join(input, "wa-task-completion-demo-ct_a.dmn"), sampleDmn("ct_a"));
  writeFileSync(join(input, "wa-task-completion-demo-ct_b.dmn"), sampleDmn("ct_b", { extraRule: true }));
  return { dir, input };
}

const bin = fileURLToPath(new URL("../bin/wa-spec", import.meta.url));

describe("cli", () => {
  it("should import, generate and find no difference when the DMNs round-trip", () => {
    const { dir, input } = workspace();
    const imported = run("import", input, "-o", join(dir, "spec.yaml"), "--report", join(dir, "report.md"), "--jurisdiction", "DEMO");
    expect(imported.status).toBe(0);
    expect(readFileSync(join(dir, "spec.yaml"), "utf8")).toContain("jurisdiction: DEMO");
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("# Import coverage");
    expect(run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out")).status).toBe(0);
    const diff = run("diff", input, join(dir, "out"));
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain("no differences");
  });

  it("should exit 1 and list the difference when a generated file is changed", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"));
    const changed = join(dir, "out", "wa-task-completion-demo-ct_a.dmn");
    writeFileSync(changed, readFileSync(changed, "utf8").replace('"Auto"', '"Manual"'));
    const diff = run("diff", join(input, "wa-task-completion-demo-ct_a.dmn"), changed);
    expect(diff.status).toBe(1);
    expect(diff.stdout).toContain("only in second");
  });

  it("should resolve relative paths against the caller's directory when run through the bin script", () => {
    const { dir } = workspace();
    const here = (...args: string[]) => spawnSync(bin, args, { encoding: "utf8", cwd: dir });
    expect(here("import", "dmn", "-o", "out/spec.yaml").status).toBe(0);
    expect(here("generate", "out/spec.yaml", "-o", "gen").status).toBe(0);
    const diff = here("diff", "dmn", "gen");
    expect(diff.stdout).toContain("no differences");
    expect(diff.status).toBe(0);
  });

  it("should write the layout beside the spec and generate the original ids from it when the spec was imported", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    expect(readFileSync(join(dir, "spec.layout.yaml"), "utf8")).toContain("version: 1");
    run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"));
    expect(readFileSync(join(dir, "out", "wa-task-completion-demo-ct_a.dmn"), "utf8")).toBe(
      readFileSync(join(input, "wa-task-completion-demo-ct_a.dmn"), "utf8")
    );
  });

  it("should compare a file with the file of the same name in a directory when one side is a directory", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"));
    const file = join(input, "wa-task-completion-demo-ct_b.dmn");
    const same = run("diff", file, join(dir, "out"));
    expect(same.stdout).toContain("no differences");
    expect(run("diff", join(dir, "out"), file).status).toBe(0);
    const changed = join(dir, "out", "wa-task-completion-demo-ct_b.dmn");
    writeFileSync(changed, readFileSync(changed, "utf8").replace('"Auto"', '"Manual"'));
    const different = run("diff", file, join(dir, "out"));
    expect(different.status).toBe(1);
    expect(different.stdout).not.toContain("ct_a");
  });

  it("should exit 2 and say what is missing when the directory has no file of the file's name", () => {
    const { dir, input } = workspace();
    mkdirSync(join(dir, "empty"));
    const result = run("diff", join(input, "wa-task-completion-demo-ct_a.dmn"), join(dir, "empty"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has no file named wa-task-completion-demo-ct_a.dmn");
  });

  it("should show the rows for a task when asked", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    const shown = run("show", join(dir, "spec.yaml"), "Review");
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("completion");
  });

  it("should print usage and exit 2 when the command is unknown or arguments are missing", () => {
    expect(run("bogus").status).toBe(2);
    const missing = run("generate");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("wa-spec generate");
    expect(execFileSync(process.execPath, ["--import", "tsx", cli, "help"], { encoding: "utf8" })).toContain("wa-spec import");
  });
});

describe("cli errors", () => {
  it("should exit 2 and print the message when a spec cannot be read", () => {
    const { dir } = workspace();
    writeFileSync(join(dir, "bad.yaml"), "version: 2\n");
    const result = run("generate", join(dir, "bad.yaml"), "-o", join(dir, "out"));
    expect(result.status).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("should exit 2 when the import cannot be turned into a valid spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-"));
    const input = join(dir, "dmn");
    mkdirSync(input);
    writeFileSync(join(input, "wa-task-completion-my svc-ct_c.dmn"), sampleDmn("ct_c"));
    const result = run("import", input, "-o", join(dir, "spec.yaml"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid spec");
  });
});

describe("cli generate and stale files", () => {
  it("should list task DMNs the spec no longer has and leave them when --prune is not given", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "wa-task-completion-demo-ct_old.dmn"), "<definitions/>");
    writeFileSync(join(dir, "out", "other.dmn"), "<definitions/>");
    const result = run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("wa-task-completion-demo-ct_old.dmn");
    expect(result.stderr).not.toContain("other.dmn");
    expect(readdirSync(join(dir, "out"))).toContain("wa-task-completion-demo-ct_old.dmn");
  });

  it("should delete them when --prune is given and only them", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "wa-task-completion-demo-ct_old.dmn"), "<definitions/>");
    writeFileSync(join(dir, "out", "other.dmn"), "<definitions/>");
    const result = run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"), "--prune");
    expect(result.stderr).toContain("removed: wa-task-completion-demo-ct_old.dmn");
    expect(readdirSync(join(dir, "out")).sort(byCodePoint)).toEqual(["other.dmn", "wa-task-completion-demo-ct_a.dmn", "wa-task-completion-demo-ct_b.dmn"]);
  });
});

describe("cli generate pruning scope", () => {
  it("should remove only files of this service whose kind and case type the spec no longer generates when --prune is given", () => {
    const { dir, input } = workspace();
    run("import", input, "-o", join(dir, "spec.yaml"));
    mkdirSync(join(dir, "out"));
    const names = [
      "wa-task-completion-demo-ct_old.dmn",
      "wa-task-completion-other-ct_a.dmn",
      "wa-task-bogus-demo-ct_a.dmn",
      "wa-task-initiation-demo-ct_a.dmn"
    ];
    for (const name of names) {
      writeFileSync(join(dir, "out", name), "<definitions/>");
    }
    run("generate", join(dir, "spec.yaml"), "-o", join(dir, "out"), "--prune");
    expect(readdirSync(join(dir, "out")).sort(byCodePoint)).toEqual([
      "wa-task-bogus-demo-ct_a.dmn",
      "wa-task-completion-demo-ct_a.dmn",
      "wa-task-completion-demo-ct_b.dmn",
      "wa-task-completion-other-ct_a.dmn"
    ]);
  });

  it("should not fail when nothing is generated and the output directory does not exist", () => {
    const { dir } = workspace();
    const empty = join(dir, "empty.yaml");
    writeFileSync(empty, "version: 1\nservice:\n  slug: demo\ncaseTypes:\n  - id: ct_a\ndecisions: {}\n");
    const result = run("generate", empty, "-o", join(dir, "missing"));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
