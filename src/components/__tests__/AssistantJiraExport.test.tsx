/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import type { JiraExportView } from "@/assistant/jira";
import { ArtefactPanel } from "@/components/assistant/ArtefactPanel";
import { LOOKUP_AFTER_MS } from "@/components/assistant/AtlassianSearch";
import type { ExportToJiraAction, JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";
import type { LoginView } from "@/virtual-agents/logins";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const CONNECTED: JiraAccess = { connected: true, login: null };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function snapshot(overrides: Partial<ArtefactSnapshot> = {}): ArtefactSnapshot {
  return { title: "Story", markdown: "# Original", version: 2, updatedBy: "user", ...overrides };
}

function exporting(result: Awaited<ReturnType<ExportToJiraAction>> = { ok: true }) {
  return vi.fn<ExportToJiraAction>(async () => result);
}

function panel({
  artefact = snapshot(),
  exported = { status: "none" },
  access = CONNECTED,
  exportTo = exporting(),
  lookUp
}: {
  artefact?: ArtefactSnapshot;
  exported?: JiraExportView;
  access?: JiraAccess;
  exportTo?: ExportToJiraAction;
  lookUp?: LookUp;
} = {}) {
  return (
    <ArtefactPanel
      conversationId={CONVERSATION}
      artefact={artefact}
      productLabel="CCD"
      save={vi.fn(async () => ({ ok: true as const, saved: true as const, version: 99 }))}
      onClose={() => undefined}
      narrow={false}
      jira={{ exported, access, exportTo, lookUp }}
    />
  );
}

/** An export asked for a moment ago, so the sign-ins below are ones it is waiting on rather than an earlier one's. */
function pendingExport(requestedAt = new Date(Date.now() - 5000).toISOString()): JiraExportView {
  return { status: "pending", project: "VIBE", requestedAt };
}

function exportButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /export/i }) as HTMLButtonElement;
}

function atlassianLogin(overrides: Partial<LoginView> = {}): LoginView {
  return {
    kind: "atlassian",
    prompt: "device_code",
    userCode: "4BFC-CC3A",
    verificationUri: "https://auth.atlassian.com/oauth/activate?user_code=4BFC-CC3A",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    state: "pending",
    codeWaiting: false,
    ...overrides
  };
}

describe("Jira export in the document panel", () => {
  it("should offer the VIBE backlog and export to it when the document is saved", async () => {
    const exportTo = exporting();
    render(panel({ exportTo }));

    expect(screen.getByRole("button", { name: "Change the Jira project, now VIBE" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(exportButton());
    });

    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, project: "VIBE" });
    expect(screen.getByText("Creating ticket…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /export/i })).toBeNull();
  });

  it("should say the person will sign in to Atlassian when they have not connected Jira", () => {
    render(panel({ access: { connected: false, login: null } }));

    expect(exportButton().textContent).toContain("Connect Jira and export");
    expect(screen.getByText(/asked to sign in to Atlassian/)).toBeTruthy();
  });

  it("should not export a document nobody has written when the panel shows the starter outline", () => {
    render(panel({ artefact: snapshot({ version: 0, markdown: "", title: null }) }));

    expect(exportButton().disabled).toBe(true);
    expect(screen.getByText("Write the document to export it.")).toBeTruthy();
  });

  it("should wait for the document to save when it has unsaved changes", () => {
    vi.useFakeTimers();
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Document, in markdown" }), { target: { value: "# Changed" } });

    expect(exportButton().disabled).toBe(true);
    expect(screen.getByText("Waiting for the document to save.")).toBeTruthy();
  });

  it("should show the Atlassian code to enter when the export is waiting on a sign-in", () => {
    render(panel({ exported: pendingExport(), access: { connected: false, login: atlassianLogin() } }));

    expect(screen.getByText("Signing in to Atlassian…")).toBeTruthy();
    expect(screen.getByText("4BFC-CC3A")).toBeTruthy();
    expect(screen.getByRole("link", { name: "the Atlassian sign-in page" }).getAttribute("href")).toContain("auth.atlassian.com");
  });

  it.each(["expired", "failed"] as const)("should say the code expired, rather than show it, once the pod has %s the sign-in", (state) => {
    render(panel({ exported: pendingExport(), access: { connected: false, login: atlassianLogin({ state }) } }));

    expect(screen.getByRole("alert").textContent).toContain("expired before it was used, so no ticket was created");
    expect(screen.getByRole("alert").textContent).toContain("Export again for a fresh code");
    expect(screen.queryByText("4BFC-CC3A")).toBeNull();
    expect(screen.queryByText("Signing in to Atlassian…")).toBeNull();
  });

  it("should stop offering a code the moment its own time runs out, before the pod has said anything", () => {
    vi.useFakeTimers();
    render(
      panel({
        exported: pendingExport(),
        access: { connected: false, login: atlassianLogin({ expiresAt: new Date(Date.now() + 2000).toISOString() }) }
      })
    );
    expect(screen.getByText("4BFC-CC3A")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText("4BFC-CC3A")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Your assistant is relaying a fresh one");
    expect(screen.getByText("Signing in to Atlassian…")).toBeTruthy();
  });

  it("should not announce the last export's expired sign-in while a new export is in flight", () => {
    // Arrange: the row the finished export left behind is the same row this one reads, so the one thing that tells
    // them apart is that its code was already dead when this export was asked for.
    const stale = atlassianLogin({ state: "expired", expiresAt: new Date(Date.now() - 600_000).toISOString() });

    render(panel({ exported: pendingExport(new Date(Date.now() - 5000).toISOString()), access: { connected: false, login: stale } }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Creating ticket…")).toBeTruthy();
  });

  it("should announce an expired sign-in that this export is the one waiting on", () => {
    const own = atlassianLogin({ state: "expired", expiresAt: new Date(Date.now() - 1000).toISOString() });

    render(panel({ exported: pendingExport(new Date(Date.now() - 130_000).toISOString()), access: { connected: false, login: own } }));

    expect(screen.getByRole("alert").textContent).toContain("expired before it was used");
  });

  it("should say nothing about a sign-in when no export is waiting on one", () => {
    render(panel({ access: { connected: false, login: atlassianLogin({ state: "expired" }) } }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show the ticket in the backlog's place, and no way to export again, when the export is done", () => {
    render(panel({ exported: { status: "done", project: "VIBE", key: "VIBE-701", url: "https://hmcts.atlassian.net/browse/VIBE-701" } }));

    expect(screen.getByText(/Created/).textContent).toContain("VIBE-701");
    expect(screen.getByRole("link", { name: "View in Jira" }).getAttribute("href")).toBe("https://hmcts.atlassian.net/browse/VIBE-701");
    expect(screen.getByRole("link", { name: "Open ticket" }).getAttribute("target")).toBe("_blank");
    expect(screen.getByText("In Jira")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /export/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change the Jira project/ })).toBeNull();
    expect(screen.queryByText("Backlog")).toBeNull();
  });

  it("should show why and offer the export again when it failed", () => {
    render(panel({ exported: { status: "failed", project: "VIBE", error: "Jira did not answer in time. Try again." } }));

    expect(screen.getByRole("alert").textContent).toBe("Jira did not answer in time. Try again.");
    expect(exportButton().disabled).toBe(false);
  });

  it("should show the refusal and bring the button back when the action is refused", async () => {
    render(panel({ exportTo: exporting({ ok: false, error: "this document is already being exported" }) }));

    await act(async () => {
      fireEvent.click(exportButton());
    });

    expect(screen.getByRole("alert").textContent).toBe("this document is already being exported");
    expect(exportButton().disabled).toBe(false);
  });

  it("should leave the export out when the panel is given no Jira props", () => {
    render(
      <ArtefactPanel
        conversationId={CONVERSATION}
        artefact={snapshot()}
        productLabel="CCD"
        save={vi.fn(async () => ({ ok: true as const, saved: true as const, version: 99 }))}
        onClose={() => undefined}
        narrow={false}
      />
    );

    expect(screen.queryByRole("button", { name: /Change the Jira project/ })).toBeNull();
  });

  it("should put the backlog back as it was when the person cancels the project search", () => {
    render(panel());

    fireEvent.click(screen.getByRole("button", { name: /Change the Jira project/ }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search your Jira projects" }), { key: "Escape" });

    expect(screen.queryByRole("combobox", { name: "Search your Jira projects" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change the Jira project, now VIBE" })).toBeTruthy();
  });

  it("should export to a project the person searched their Jira for when they change it for this document", async () => {
    vi.useFakeTimers();
    const exportTo = exporting();
    const lookUp = vi.fn<LookUp>(async () => ({
      status: "done",
      results: [{ key: "PCS", name: "Possession claims", url: "https://hmcts.atlassian.net/browse/PCS" }]
    }));
    render(panel({ exportTo, lookUp }));

    fireEvent.click(screen.getByRole("button", { name: /Change the Jira project/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search your Jira projects" }), { target: { value: "possess" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search your Jira projects" }), { key: "Enter" });
    await act(async () => {
      fireEvent.click(exportButton());
    });

    expect(lookUp).toHaveBeenCalledWith({ kind: "jira_project", query: "possess", space: null }, expect.any(AbortSignal));
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, project: "PCS" });
  });
});
