/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { type Model, parseModel } from "@hmcts-cft/wa-spec";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionTick, Placeholder, requestedVersion, ViewTabs, versionQuery, YesNo } from "@/components/assistant/WaBuilderParts";
import { WaBuilderRoles } from "@/components/assistant/WaBuilderRoles";
import { WaBuilderServiceList } from "@/components/assistant/WaBuilderServiceList";
import { WaBuilderSetup } from "@/components/assistant/WaBuilderSetup";
import { WaBuilderTaskBoard } from "@/components/assistant/WaBuilderTaskBoard";
import { WaBuilderTaskDetail } from "@/components/assistant/WaBuilderTaskDetail";

afterEach(cleanup);

const et: Model = parseModel(readFileSync(`${process.cwd()}/packages/wa-spec/examples/et/model.yaml`, "utf8"));
const task = (id: string) => {
  const found = et.tasks.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no task ${id}`);
  }
  return found;
};

describe("the builder's views", () => {
  it("should list each service with its latest version and a link to it when services are held", () => {
    render(
      <WaBuilderServiceList services={[{ service: "employment", displayName: "Employment", latestVersion: 3, updatedAt: new Date("2026-11-19T10:00:00Z") }]} />
    );

    expect(screen.getByRole("link", { name: "Employment" }).getAttribute("href")).toBe("/assistant/wa-builder/employment");
    const row = screen.getByRole("row", { name: /Employment/ });
    expect(within(row).getByText("3")).toBeDefined();
    expect(row.querySelector("time")?.getAttribute("title")).toContain("19 November 2026 at 10:00");
  });

  it("should say so when no service is held", () => {
    render(<WaBuilderServiceList services={[]} />);

    expect(screen.getByText(/No service has its Work Allocation configuration/)).toBeDefined();
  });

  it("should show the service's identity and its defaults when setup is opened", () => {
    render(<WaBuilderSetup model={et} />);

    expect(screen.getByText("EMPLOYMENT")).toBeDefined();
    expect(screen.getByText("BHA1")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Settings every task has" })).toBeDefined();
    expect(screen.getByRole("row", { name: /task-supervisor/ })).toBeDefined();
  });

  it("should show a profile as a grid with a tick for each permission and the tasks that use it when roles are opened", () => {
    render(<WaBuilderRoles model={et} service="employment" version={2} />);

    const grid = screen.getByRole("region", { name: "Permissions of the adminWorker profile" });
    const row = within(grid).getByRole("row", { name: /allocated-admin-caseworker/ });
    expect(within(row).getAllByText("✓").length).toBe(7);
    expect(within(row).getByText("2")).toBeDefined();
    const used = screen.getAllByRole("link", { name: "ET1 Vetting" });
    expect(used.length).toBeGreaterThan(0);
    expect(used[0]?.getAttribute("href")).toBe("/assistant/wa-builder/employment/tasks/Et1Vetting?version=2");
  });

  it("should group tasks under a heading each and filter them when the board has a case type", () => {
    render(<WaBuilderTaskBoard model={et} service="employment" by="roleCategory" caseType="et_scotland_multiple" />);

    expect(screen.getByRole("heading", { name: /ADMIN/ })).toBeDefined();
    expect(screen.queryByRole("link", { name: "ET1 Vetting" })).toBeNull();
    expect(screen.getAllByRole("link", { name: /Review Multiples Referral/ }).length).toBeGreaterThan(0);
  });

  it("should write the task in sentences, with calculated values as a code block, when a task is opened", () => {
    render(<WaBuilderTaskDetail model={et} task={task("ReviewReferralAdmin")} />);

    expect(screen.getByRole("heading", { name: "When it is created" })).toBeDefined();
    const created = screen.getByRole("heading", { name: "When it is created" }).closest("section");
    expect(created?.textContent).toContain("Created when createReferral happens if referCaseTo is Admin");
    expect(screen.getAllByText(/Only for/).length).toBeGreaterThan(0);
    const due = screen.getByRole("heading", { name: "Due date" }).closest("section");
    expect(due?.querySelector("pre")?.textContent).toMatch(/caseData\.referralCollection/);
  });

  it("should name the case types a value is for when they differ", () => {
    render(<WaBuilderTaskDetail model={et} task={task("ReviewReferralAdmin")} />);

    expect(screen.getAllByText("Only for et_englandwales").length).toBeGreaterThan(0);
  });

  it("should keep the version in each task link, and give each group its own heading id, when the board is for a version", () => {
    render(<WaBuilderTaskBoard model={et} service="employment" version={4} by="workType" caseType="et_scotland" />);

    expect(screen.getAllByRole("link", { name: "ET1 Vetting" })[0]?.getAttribute("href")).toBe(
      "/assistant/wa-builder/employment/tasks/Et1Vetting?version=4&by=workType&caseType=et_scotland"
    );
    const ids = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^wa-group-\d+$/.test(id))).toBe(true);
  });

  it("should show what a grant applies only when, and the task's names, when a task has them", () => {
    const model = {
      ...et,
      roles: { judge: { category: "JUDICIAL" } },
      permissionProfiles: { p: { judge: { perms: ["Read,Own"], authorisations: "294", caseAccessCategory: "civil", category: "CTSC" } } },
      defaults: undefined
    } as Model;
    const named = { ...task("Et1Vetting"), permissions: "p", initialName: "Et1 Vetting" };
    render(<WaBuilderTaskDetail model={model} task={named} />);

    const grid = screen.getByRole("region", { name: "Task permissions" });
    expect(within(grid).getByRole("row", { name: /judge/ }).textContent).toContain(
      "needs authorisation 294; case access category civil; counts as category CTSC"
    );
    expect(within(grid).getAllByText("✓").length).toBe(2);
    expect(screen.getByText("Name when created")).toBeDefined();
    expect(screen.getByText("Et1 Vetting")).toBeDefined();
  });

  it("should say which filter found no task when the board is empty", () => {
    const empty = { ...et, tasks: [] } as Model;
    const { rerender } = render(<WaBuilderTaskBoard model={empty} service="employment" by="roleCategory" />);
    expect(screen.getByText("No task is configured.")).toBeDefined();
    rerender(<WaBuilderTaskBoard model={empty} service="employment" by="roleCategory" caseType="et_scotland" />);
    expect(screen.getByText("No task is configured for et_scotland.")).toBeDefined();
  });

  it("should label major and minor priority when the board shows a task's priority", () => {
    render(<WaBuilderTaskBoard model={et} service="employment" by="roleCategory" />);
    expect(screen.getAllByText("major 5000, minor 500").length).toBeGreaterThan(0);
  });

  it("should show a calculated setting as itself, not as No, when a setting is not a plain boolean", () => {
    render(
      <>
        <YesNo value="true" />|<YesNo value="false" />|<YesNo value="calculated" />
      </>
    );

    expect(document.body.textContent).toBe("Yes|No|calculated");
  });

  it("should read a tick as Yes and its absence as No when a permission is or is not held", () => {
    render(
      <>
        <PermissionTick has />
        <PermissionTick has={false} />
      </>
    );

    expect(screen.getByText("Yes")).toBeDefined();
    expect(screen.getByText("No")).toBeDefined();
  });

  it("should read a version from the query only when it is a positive whole number", () => {
    expect(requestedVersion({ version: "3" })).toBe(3);
    expect(requestedVersion({ version: ["2", "5"] })).toBe(2);
    expect(requestedVersion({ version: "0" })).toBeUndefined();
    expect(requestedVersion({ version: "x" })).toBeUndefined();
    expect(requestedVersion({})).toBeUndefined();
    expect(versionQuery(undefined, "?")).toBe("");
    expect(versionQuery(3, "&")).toBe("&version=3");
  });

  it("should link each view and mark the current one when a service is open", () => {
    render(<ViewTabs service="employment" current="roles" version={3} />);

    expect(screen.getByRole("link", { name: "Roles and permissions" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Task board" }).getAttribute("href")).toBe("/assistant/wa-builder/employment?view=tasks&version=3");
  });

  it("should show a placeholder with nothing in it when a view is built later", () => {
    render(<Placeholder title="Simulator">Not built yet.</Placeholder>);

    expect(screen.getByRole("heading", { name: "Simulator" })).toBeDefined();
    expect(screen.getByText("Not built yet.")).toBeDefined();
  });
});
