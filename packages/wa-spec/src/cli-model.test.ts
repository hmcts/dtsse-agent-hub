import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { sampleDmn } from "./__fixtures__/dmn.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });

function imported() {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-model-"));
  const input = join(dir, "dmn");
  mkdirSync(input);
  writeFileSync(join(input, "wa-task-completion-demo-ct_a.dmn"), sampleDmn("ct_a"));
  writeFileSync(join(input, "wa-task-completion-demo-ct_b.dmn"), sampleDmn("ct_b", { extraRule: true }));
  expect(run("import", input, "-o", join(dir, "spec.yaml")).status).toBe(0);
  return { dir, input };
}

describe("cli model commands", () => {
  it("should lift a spec, compile it back equal and generate the same DMNs from the model when the layout sits beside the spec", () => {
    const { dir, input } = imported();
    const lifted = run("lift", join(dir, "spec.yaml"), "-o", join(dir, "model.yaml"), "--report", join(dir, "lift.md"));
    expect(lifted.status).toBe(0);
    expect(lifted.stdout).toContain("compiles back equal");
    expect(readFileSync(join(dir, "model.yaml"), "utf8")).toContain("kind: wa-model");
    expect(readFileSync(join(dir, "model.yaml"), "utf8")).toContain("layout: spec.layout.yaml");
    expect(existsSync(join(dir, "model.order.yaml"))).toBe(true);
    expect(readFileSync(join(dir, "lift.md"), "utf8")).toContain("# Lift report");

    expect(run("compile", join(dir, "model.yaml"), "-o", join(dir, "again", "spec.yaml")).status).toBe(0);
    const same = run("diff", join(dir, "again", "spec.yaml"), join(dir, "spec.yaml"));
    expect(same.status).toBe(0);
    expect(same.stdout).toContain("no differences");
    expect(existsSync(join(dir, "again", "spec.layout.yaml"))).toBe(true);

    expect(run("generate", join(dir, "model.yaml"), "-o", join(dir, "out")).status).toBe(0);
    expect(run("diff", input, join(dir, "out")).stdout).toContain("no differences");
  });

  it("should compare a model with a spec as specs and report a difference when the model is edited", () => {
    const { dir } = imported();
    run("lift", join(dir, "spec.yaml"), "-o", join(dir, "model.yaml"));
    const model = join(dir, "model.yaml");
    writeFileSync(model, readFileSync(model, "utf8").replace("taskType: Review", "taskType: Other"));
    const diff = run("diff", model, join(dir, "spec.yaml"));
    expect(diff.status).toBe(1);
    expect(diff.stdout).toContain("taskType");
  });

  it("should refuse to compile a file that is not a model when given a spec", () => {
    const { dir } = imported();
    const compiled = run("compile", join(dir, "spec.yaml"), "-o", join(dir, "x.yaml"));
    expect(compiled.status).toBe(2);
    expect(compiled.stderr).toContain("is not a model");
  });

  it("should list and prune the task DMNs the compiled model no longer generates when generating from a model", () => {
    const { dir } = imported();
    run("lift", join(dir, "spec.yaml"), "-o", join(dir, "model.yaml"));
    const out = join(dir, "out");
    mkdirSync(out);
    const stale = join(out, "wa-task-completion-demo-ct_gone.dmn");
    writeFileSync(stale, "<definitions/>");
    const listed = run("generate", join(dir, "model.yaml"), "-o", out);
    expect(listed.status).toBe(0);
    expect(listed.stderr).toContain("wa-task-completion-demo-ct_gone.dmn");
    expect(existsSync(stale)).toBe(true);
    const pruned = run("generate", join(dir, "model.yaml"), "-o", out, "--prune");
    expect(pruned.stderr).toContain("removed: wa-task-completion-demo-ct_gone.dmn");
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(out, "wa-task-completion-demo-ct_a.dmn"))).toBe(true);
  });
});

describe("cli model options", () => {
  it("should record the layout given to lift in the model, relative to the model file, and refuse a missing one", () => {
    const { dir } = imported();
    mkdirSync(join(dir, "m"));
    expect(run("lift", join(dir, "spec.yaml"), "-o", join(dir, "m", "model.yaml"), "--layout", join(dir, "spec.layout.yaml")).status).toBe(0);
    expect(readFileSync(join(dir, "m", "model.yaml"), "utf8")).toContain("layout: ../spec.layout.yaml");
    const missing = run("lift", join(dir, "spec.yaml"), "-o", join(dir, "n.yaml"), "--layout", join(dir, "none.yaml"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("does not exist");
  });

  it("should honour --ignore-rule-order when diffing two YAML specs with the same rows in another order", () => {
    const { dir } = imported();
    const reversed = parse(readFileSync(join(dir, "spec.yaml"), "utf8"));
    reversed.decisions.completion.rows.reverse();
    writeFileSync(join(dir, "reversed.yaml"), stringify(reversed));
    expect(run("diff", join(dir, "spec.yaml"), join(dir, "reversed.yaml")).status).toBe(1);
    const relaxed = run("diff", join(dir, "spec.yaml"), join(dir, "reversed.yaml"), "--ignore-rule-order");
    expect(relaxed.status).toBe(0);
    expect(relaxed.stdout).toContain("no differences");
  });
});
