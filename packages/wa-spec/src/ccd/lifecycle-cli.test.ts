import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ET_SHEETS } from "./__fixtures__/et-sheets.ts";

const placeholder = (name: string): string => `$\{${name}}`;
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", cwd: fileURLToPath(new URL("../..", import.meta.url)) });

const SPEC = `version: 1
service: {slug: employment}
caseTypes: [{id: et_englandwales}]
decisions:
  initiation:
    name: i
    hitPolicy: COLLECT
    inputs: [{key: eventId}]
    outputs: [{name: taskId}]
    rows:
      - when: {eventId: {in: [et1Vetting]}}
        returns: {taskId: T}
`;

describe("cli lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-lifecycle-"));
  for (const [sheet, rows] of Object.entries(ET_SHEETS)) {
    mkdirSync(join(dir, "def", sheet), { recursive: true });
    writeFileSync(join(dir, "def", sheet, `${sheet}.json`), JSON.stringify(rows));
  }
  writeFileSync(join(dir, "spec.yaml"), SPEC);

  it("should print the overlay as JSON when the format is json", () => {
    const result = run("lifecycle", join(dir, "def"), "--spec", join(dir, "spec.yaml"), "--format", "json", "--case-type", "ET_EnglandWales", "--env", "prod");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ET_EnglandWales.events.et1Vetting.creates).toEqual(["T"]);
  });

  it("should print YAML when no format is given", () => {
    const result = run("lifecycle", join(dir, "def"), "--spec", join(dir, "spec.yaml"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ET_EnglandWales:");
  });

  it("should give the same warnings with and without --case-type when the case type is the only one listed", () => {
    const warnings = (...extra: string[]) =>
      JSON.parse(run("lifecycle", join(dir, "def"), "--spec", join(dir, "spec.yaml"), "--format", "json", ...extra).stdout).ET_EnglandWales.warnings;
    expect(warnings()).toEqual(warnings("--case-type", "ET_EnglandWales"));
    expect(warnings()).toEqual(["et1Vetting creates tasks but is not Publish: Y, so Work Allocation never sees it"]);
  });

  it("should leave out the files the --exclude patterns match, comma separated or repeated", () => {
    const def = join(dir, "def2");
    for (const [sheet, rows] of Object.entries(ET_SHEETS)) {
      mkdirSync(join(def, sheet), { recursive: true });
      writeFileSync(join(def, sheet, `${sheet}.json`), JSON.stringify(rows));
    }
    writeFileSync(join(def, "CaseEvent", "CaseEvent-preview.json"), JSON.stringify([{ CaseTypeID: "ET_EnglandWales", ID: "initiateCase" }]));
    const base = ["lifecycle", def, "--spec", join(dir, "spec.yaml"), "--format", "json"];
    expect(run(...base).status).toBe(2);
    expect(run(...base, "--exclude", "*-preview.json,*-prod.json").status).toBe(0);
    expect(run(...base, "--exclude", "*-prod.json", "--exclude", "*-preview.json").status).toBe(0);
  });

  it("should replace placeholders from --var and name an unset one", () => {
    const def = join(dir, "def3");
    mkdirSync(join(def, "CaseEvent"), { recursive: true });
    writeFileSync(
      join(def, "CaseEvent", "a.json"),
      JSON.stringify([{ CaseTypeID: "ET_EnglandWales", ID: "et1Vetting", Publish: placeholder("CCD_DEF_PUBLISH") }])
    );
    mkdirSync(join(def, "CaseType"), { recursive: true });
    writeFileSync(join(def, "CaseType", "a.json"), JSON.stringify(ET_SHEETS.CaseType));
    const base = ["lifecycle", def, "--spec", join(dir, "spec.yaml"), "--format", "json"];
    const unset = run(...base);
    expect(unset.status).toBe(2);
    expect(unset.stderr).toContain("CCD_DEF_PUBLISH");
    const set = run(...base, "--var", "CCD_DEF_PUBLISH=Y");
    expect(set.status).toBe(0);
    expect(JSON.parse(set.stdout).ET_EnglandWales.warnings).toEqual([]);
    expect(run(...base, "--var", "NOEQUALS").status).toBe(2);
  });

  it("should exit 2 when --env or --format is not one of its values, or both --env and --exclude are given, or the case type is not in the spec", () => {
    const base = ["lifecycle", join(dir, "def"), "--spec", join(dir, "spec.yaml")];
    expect(run(...base, "--env", "staging").status).toBe(2);
    expect(run(...base, "--format", "xml").status).toBe(2);
    expect(run(...base, "--env", "prod", "--exclude", "x").status).toBe(2);
    const missing = run(...base, "--case-type", "ET_Scotland");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("the spec does not list the case type ET_Scotland");
  });

  it("should print the usage and exit 2 when the spec is missing", () => {
    expect(run("lifecycle", join(dir, "def")).status).toBe(2);
  });
});
