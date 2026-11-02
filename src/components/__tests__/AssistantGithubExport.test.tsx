/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import type { ConfluenceExportView } from "@/assistant/confluence";
import type { GithubExportView } from "@/assistant/github";
import { ArtefactPanel } from "@/components/assistant/ArtefactPanel";
import type { ExportToConfluenceAction } from "@/components/assistant/ConfluenceExport";
import { openingDestination } from "@/components/assistant/ExportFooter";
import type { ExportToGithubAction } from "@/components/assistant/GithubExport";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function snapshot(overrides: Partial<ArtefactSnapshot> = {}): ArtefactSnapshot {
  return { title: "Story", markdown: "# Original", version: 2, updatedBy: "user", ...overrides };
}

function exporting(result: Awaited<ReturnType<ExportToGithubAction>> = { ok: true }) {
  return vi.fn<ExportToGithubAction>(async () => result);
}

function panel({
  artefact = snapshot(),
  exported = { status: "none" },
  exportTo = exporting(),
  defaultRepo = null,
  confluence
}: {
  artefact?: ArtefactSnapshot;
  exported?: GithubExportView;
  exportTo?: ExportToGithubAction;
  defaultRepo?: string | null;
  confluence?: ConfluenceExportView;
} = {}) {
  return (
    <ArtefactPanel
      conversationId={CONVERSATION}
      artefact={artefact}
      productLabel="CCD"
      save={vi.fn(async () => ({ ok: true as const, saved: true as const, version: 99 }))}
      onClose={() => undefined}
      narrow={false}
      github={{ exported, exportTo, defaultRepo }}
      confluence={
        confluence === undefined
          ? undefined
          : { exported: confluence, access: { connected: true, login: null }, exportTo: vi.fn<ExportToConfluenceAction>(async () => ({ ok: true })) }
      }
    />
  );
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create GitHub issue" }) as HTMLButtonElement;
}

function repoField(): HTMLInputElement {
  return screen.getByLabelText("Repository") as HTMLInputElement;
}

describe("the document's GitHub export", () => {
  it("should start from the person's default repository and create the issue there when the document is saved", async () => {
    // Arrange
    const exportTo = exporting();
    render(panel({ exportTo, defaultRepo: "hmcts/cft-workspace" }));

    // Act
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(repoField().value).toBe("hmcts/cft-workspace");
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/cft-workspace" });
    expect(screen.getByText("Creating issue…").getAttribute("role")).toBe("status");
  });

  it("should wait for a repository when the person has no default", () => {
    render(panel());

    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Name the repository as owner/name, such as hmcts/cft-workspace.")).toBeTruthy();
  });

  it("should create the issue in a repository typed for this document, read from a pasted link", async () => {
    // Arrange
    const exportTo = exporting();
    render(panel({ exportTo, defaultRepo: "hmcts/cft-workspace" }));

    // Act
    fireEvent.change(repoField(), { target: { value: " https://github.com/hmcts/dtsse-agent-hub " } });
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/dtsse-agent-hub" });
  });

  it("should not export a document nobody has written when the panel shows the starter outline", () => {
    render(panel({ artefact: snapshot({ version: 0, markdown: "", title: null }), defaultRepo: "hmcts/cft-workspace" }));

    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Write the document to export it.")).toBeTruthy();
  });

  it("should wait for the document to save when it has unsaved changes", () => {
    // Arrange
    render(panel({ defaultRepo: "hmcts/cft-workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Act
    fireEvent.change(screen.getByLabelText("Document, in markdown"), { target: { value: "# Changed" } });

    // Assert
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Waiting for the document to save.")).toBeTruthy();
  });

  it("should show the issue in the repository's place, and a banner linking to it, when the export is done", () => {
    render(panel({ exported: { status: "done", repo: "hmcts/cft-workspace", number: 42, url: "https://github.com/hmcts/cft-workspace/issues/42" } }));

    expect(screen.queryByRole("button", { name: "Create GitHub issue" })).toBeNull();
    expect(screen.queryByLabelText("Repository")).toBeNull();
    expect(screen.getByText("On GitHub")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open issue" }) as HTMLAnchorElement).href).toBe("https://github.com/hmcts/cft-workspace/issues/42");
    expect((screen.getByRole("link", { name: "View on GitHub" }) as HTMLAnchorElement).href).toBe("https://github.com/hmcts/cft-workspace/issues/42");
  });

  it("should show the repository and no way to export again while the export is pending", () => {
    render(panel({ exported: { status: "pending", repo: "hmcts/cft-workspace", requestedAt: new Date().toISOString() } }));

    expect(repoField().value).toBe("hmcts/cft-workspace");
    expect(repoField().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Create GitHub issue" })).toBeNull();
  });

  it("should show why and offer the export again when it failed", () => {
    render(panel({ exported: { status: "failed", repo: "hmcts/nope", error: "GitHub refused the issue: no such repository" } }));

    expect(screen.getByRole("alert").textContent).toBe("GitHub refused the issue: no such repository");
    expect(repoField().value).toBe("hmcts/nope");
    expect(createButton().disabled).toBe(false);
  });

  it("should show the refusal and bring the button back when the action is refused", async () => {
    // Arrange
    render(panel({ exportTo: exporting({ ok: false, error: "this document is already being exported" }), defaultRepo: "hmcts/cft-workspace" }));

    // Act
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("this document is already being exported");
    expect(createButton().disabled).toBe(false);
  });

  it("should offer GitHub issue beside Confluence page when the panel has both", () => {
    // Arrange
    render(panel({ defaultRepo: "hmcts/cft-workspace", confluence: { status: "none" } }));

    // Act
    const options = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);

    // Assert
    expect(options).toEqual(["github", "confluence"]);
    expect(screen.getByText("GitHub issue")).toBeTruthy();
    expect(screen.queryByText("Jira backlog")).toBeNull();
  });
});

describe("openingDestination with GitHub", () => {
  const none = { status: "none" } as const;

  it("should open on GitHub when the person's ticket tool is GitHub and nothing is in progress", () => {
    expect(openingDestination(none, none, "github")).toBe("github");
  });

  it("should open on Confluence once the GitHub issue is done", () => {
    expect(openingDestination({ status: "done", repo: "hmcts/x", number: 1, url: "https://github.com/hmcts/x/issues/1" }, none, "github")).toBe("confluence");
  });

  it("should open on GitHub while its export is pending", () => {
    expect(openingDestination({ status: "pending", repo: "hmcts/x", requestedAt: "2026-11-02T10:00:00.000Z" }, none, "github")).toBe("github");
  });
});
