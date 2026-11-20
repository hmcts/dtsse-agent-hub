import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ET_SHEETS } from "./__fixtures__/et-sheets.ts";
import { ENVIRONMENT_EXCLUDES, readDefinitionDir, variablesFrom } from "./definition-files.ts";
import { readCcdDefinition } from "./lifecycle.ts";
import { lifecycleReport } from "./lifecycle-command.ts";

const placeholder = (name: string): string => `$\{${name}}`;

const write = (dir: string, path: string, rows: unknown) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(rows));
};

function etLayout() {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-ccd-"));
  write(dir, "CaseType/CaseType.json", ET_SHEETS.CaseType);
  write(dir, "State/State.json", ET_SHEETS.State);
  write(dir, "CaseEvent/CaseEvent.json", ET_SHEETS.CaseEvent.slice(0, 5));
  write(dir, "CaseEvent/CaseEvent-WA.json", ET_SHEETS.CaseEvent.slice(5));
  write(dir, "CaseEvent/CaseEvent-prod.json", [{ CaseTypeID: "ET_EnglandWales", ID: "prodOnly" }]);
  write(dir, "CaseEvent/CaseEvent-RetainAndDispose-nonprod.json", [{ CaseTypeID: "ET_EnglandWales", ID: "nonprodOnly" }]);
  write(dir, "AuthorisationCaseEvent/AuthorisationCaseEvent.json", [{ ID: "ignored" }]);
  write(dir, "notes.json", { not: "rows" });
  return dir;
}

describe("readDefinitionDir", () => {
  it("should join the files of a sheet and leave the other environment's out when sheets are one directory each", () => {
    const sheets = readDefinitionDir(etLayout(), { exclude: ENVIRONMENT_EXCLUDES.nonprod });
    expect(Object.keys(sheets).sort()).toEqual(["CaseEvent", "CaseType", "State"]);
    expect(sheets.CaseEvent?.map((e) => (e as { ID: string }).ID)).toContain("nonprodOnly");
    expect(sheets.CaseEvent?.map((e) => (e as { ID: string }).ID)).not.toContain("prodOnly");
    expect(readDefinitionDir(etLayout(), { exclude: ENVIRONMENT_EXCLUDES.prod }).CaseEvent?.map((e) => (e as { ID: string }).ID)).toContain("prodOnly");
  });

  it("should read the published row of an event when its prod and nonprod rows sit in different files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-dup-"));
    const row = { CaseTypeID: "ET_EnglandWales", ID: "disposeCase", "PreConditionState(s)": "Accepted;Rejected", PostConditionState: "Closed" };
    write(dir, "CaseType/CaseType.json", ET_SHEETS.CaseType);
    write(dir, "CaseEvent/CaseEvent-prod.json", [{ ...row, Publish: "Y" }]);
    write(dir, "CaseEvent/CaseEvent-RetainAndDispose-nonprod.json", [row]);
    const published = (environment: "prod" | "nonprod") =>
      readCcdDefinition(readDefinitionDir(dir, { exclude: ENVIRONMENT_EXCLUDES[environment] }))[0]?.events.map((e) => [e.id, e.publish]);
    expect(published("prod")).toEqual([["disposeCase", true]]);
    expect(published("nonprod")).toEqual([["disposeCase", false]]);
  });

  it("should name a sheet by the first folder of a file's path when the files sit in subfolders, as the processor does", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-sub-"));
    write(dir, "CaseType.json", ET_SHEETS.CaseType);
    write(dir, "State.json", ET_SHEETS.State);
    write(dir, "CaseEvent/Camunda/NotificationEventsHearing.json", ET_SHEETS.CaseEvent.slice(0, 3));
    write(dir, "CaseEvent/User/Events.json", ET_SHEETS.CaseEvent.slice(3));
    write(dir, "CaseEvent/User/One.json", { CaseTypeID: "ET_EnglandWales", ID: "single" });
    write(dir, "Other/CaseEvent.json", [{ ID: "ignored" }]);
    const sheets = readDefinitionDir(dir);
    expect(Object.keys(sheets).sort()).toEqual(["CaseEvent", "CaseType", "State"]);
    expect(sheets.CaseEvent).toHaveLength(ET_SHEETS.CaseEvent.length + 1);
  });

  it("should leave out a file when any segment of its path matches an exclusion pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-ex-"));
    write(dir, "CaseEvent/a.json", [{ ID: "a" }]);
    write(dir, "CaseEvent/b-preview.json", [{ ID: "b" }]);
    write(dir, "CaseEvent/c-ignore.json", [{ ID: "c" }]);
    write(dir, "CaseEvent/skipped-dir/d.json", [{ ID: "d" }]);
    write(dir, "CaseEvent/UserProfile.json", [{ ID: "e" }]);
    const ids = (exclude: string[]) => (readDefinitionDir(dir, { exclude }).CaseEvent as Array<{ ID: string }>).map((r) => r.ID);
    expect(ids(["*-preview.json", "*-ignore.json", "skipped-dir", "USERPROFILE.json"])).toEqual(["a"]);
    expect(ids([])).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("should exclude nothing when no patterns are given", () => {
    const ids = (readDefinitionDir(etLayout()).CaseEvent as Array<{ ID: string }>).map((e) => e.ID);
    expect(ids).toEqual(expect.arrayContaining(["prodOnly", "nonprodOnly"]));
  });

  it("should replace NAME placeholders from the variables before parsing, as the processor does", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-var-"));
    write(dir, "CaseEvent/a.json", [
      { CaseTypeID: placeholder("CCD_DEF_CASE_TYPE_ID"), ID: "a", Publish: placeholder("CCD_DEF_PUBLISH"), Description: placeholder("NOT_READ") }
    ]);
    const [row] = readDefinitionDir(dir, { variables: { CCD_DEF_CASE_TYPE_ID: "FinancialRemedyMVP2", CCD_DEF_PUBLISH: "Y" } }).CaseEvent as Array<
      Record<string, string>
    >;
    expect(row).toMatchObject({ CaseTypeID: "FinancialRemedyMVP2", Publish: "Y", Description: placeholder("NOT_READ") });
  });

  it("should name the file and the variable when a column the reader needs is left as an unset placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-unset-"));
    write(dir, "CaseEvent/a.json", [{ CaseTypeID: "X", ID: "a", Publish: placeholder("CCD_DEF_PUBLISH") }]);
    expect(() => readDefinitionDir(dir)).toThrow(/CaseEvent\/a\.json: Publish is \$\{CCD_DEF_PUBLISH\}, which is not set: pass --var CCD_DEF_PUBLISH=<value>/);
  });

  it("should offer the environment's CCD_DEF variables to the substitution", () => {
    expect(variablesFrom({ CCD_DEF_A: "1", HOME: "/x", CCD_DEF_B: undefined })).toEqual({ CCD_DEF_A: "1" });
  });

  it("should name the file and row when a row does not fit the sheet", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-shape-"));
    write(dir, "CaseType.json", ET_SHEETS.CaseType);
    write(dir, "CaseEvent/a.json", [{ CaseTypeID: "X", ID: "a" }, { CaseTypeID: "X" }]);
    const sources: Record<string, string[]> = {};
    const sheets = readDefinitionDir(dir, { sources });
    expect(() => readCcdDefinition(sheets, undefined, (sheet, index) => sources[sheet]?.[index] ?? "?")).toThrow(/CaseEvent\/a\.json row 2: ID /);
  });

  it("should name the file when its JSON does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-bad-"));
    mkdirSync(join(dir, "CaseEvent"));
    writeFileSync(join(dir, "CaseEvent", "Broken.json"), "[{");
    expect(() => readDefinitionDir(dir)).toThrow(/CaseEvent\/Broken\.json: /);
  });

  it("should not follow a symlink when walking the definition", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-link-"));
    const outside = mkdtempSync(join(tmpdir(), "wa-spec-outside-"));
    write(outside, "CaseEvent.json", [{ ID: "outside" }]);
    write(dir, "CaseType.json", ET_SHEETS.CaseType);
    symlinkSync(outside, join(dir, "CaseEvent"));
    expect(Object.keys(readDefinitionDir(dir))).toEqual(["CaseType"]);
  });
});

describe("lifecycleReport", () => {
  const specPath = (dir: string, caseTypes: string[]) => {
    const path = join(dir, "spec.yaml");
    writeFileSync(
      path,
      `version: 1
service: {slug: employment}
caseTypes: [${caseTypes.map((id) => `{id: ${id}}`).join(", ")}]
decisions:
  initiation:
    name: i
    hitPolicy: COLLECT
    inputs: [{key: eventId}]
    outputs: [{name: taskId}]
    rows:
      - when: {eventId: {in: [et1Vetting]}}
        returns: {taskId: T}
`
    );
    return path;
  };

  it("should print the overlay as YAML of the case types the spec lists when no case type is named", () => {
    const dir = etLayout();
    const out = lifecycleReport({ definitionDir: dir, specPath: specPath(dir, ["et_englandwales"]) });
    expect(out).toContain("ET_EnglandWales:");
    expect(out).toContain("states: 7");
    expect(out).toContain("et1Vetting");
  });

  it("should print JSON of the named case type when --format is json", () => {
    const dir = etLayout();
    const out = JSON.parse(lifecycleReport({ definitionDir: dir, specPath: specPath(dir, ["et_englandwales"]), caseType: "ET_ENGLANDWALES", format: "json" }));
    expect(out.ET_EnglandWales.warnings).toEqual(["et1Vetting creates tasks but is not Publish: Y, so Work Allocation never sees it"]);
  });

  it("should fail when the definition has no case type the spec lists or the one named", () => {
    const dir = etLayout();
    expect(() => lifecycleReport({ definitionDir: dir, specPath: specPath(dir, ["other"]) })).toThrow("none of the spec's case types");
    expect(() => lifecycleReport({ definitionDir: dir, specPath: specPath(dir, ["other"]), caseType: "nope" })).toThrow("does not list the case type nope");
  });
});
