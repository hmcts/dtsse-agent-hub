import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ET_SHEETS } from "./__fixtures__/et-sheets.ts";

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

  it("should give the same warnings with and without --case-type when it is given a repo root holding stale fixtures", () => {
    const repo = join(dir, "repo");
    for (const [sheet, rows] of Object.entries(ET_SHEETS)) {
      mkdirSync(join(repo, "definitions", "json", sheet), { recursive: true });
      writeFileSync(join(repo, "definitions", "json", sheet, `${sheet}.json`), JSON.stringify(rows));
    }
    mkdirSync(join(repo, "src", "test", "fixtures"), { recursive: true });
    writeFileSync(join(repo, "src", "test", "fixtures", "CaseEvent.json"), JSON.stringify([{ CaseTypeID: "ET_EnglandWales", ID: "et1Vetting" }]));
    const warnings = (...extra: string[]) =>
      JSON.parse(run("lifecycle", repo, "--spec", join(dir, "spec.yaml"), "--format", "json", ...extra).stdout).ET_EnglandWales.warnings;
    expect(warnings()).toEqual(warnings("--case-type", "ET_EnglandWales"));
    expect(warnings()).toEqual(["et1Vetting creates tasks but is not Publish: Y, so Work Allocation never sees it"]);
  });

  it("should print the usage and exit 2 when the spec is missing", () => {
    expect(run("lifecycle", join(dir, "def")).status).toBe(2);
  });
});
