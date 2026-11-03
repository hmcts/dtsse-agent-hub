/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import type { ConfluenceExportView } from "@/assistant/confluence";
import type { GithubExportView, GithubProjectChoice } from "@/assistant/github";
import type { LookupResponse } from "@/assistant/lookups";
import { ArtefactPanel } from "@/components/assistant/ArtefactPanel";
import { LOOKUP_AFTER_MS } from "@/components/assistant/AtlassianSearch";
import type { ExportToConfluenceAction } from "@/components/assistant/ConfluenceExport";
import { ExportFooter, openingDestination, ticketsOffered } from "@/components/assistant/ExportFooter";
import type { ExportToGithubAction } from "@/components/assistant/GithubExport";
import type { LookUp } from "@/components/assistant/lookupClient";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const ROADMAP: GithubProjectChoice = { owner: "hmcts", number: 12, title: "CFT roadmap" };
const DONE = { status: "done", repo: "hmcts/cft-workspace", number: 42, url: "https://github.com/hmcts/cft-workspace/issues/42" } as const;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function snapshot(overrides: Partial<ArtefactSnapshot> = {}): ArtefactSnapshot {
  return { title: "Story", markdown: "# Original", version: 2, updatedBy: "user", ...overrides };
}

function exporting(result: Awaited<ReturnType<ExportToGithubAction>> = { ok: true }) {
  return vi.fn<ExportToGithubAction>(async () => result);
}

/** Answers a repository search with two repositories and a Project search with the owner's one board. */
function searching(): ReturnType<typeof vi.fn<LookUp>> {
  return vi.fn<LookUp>(
    async (request): Promise<LookupResponse> =>
      request.kind === "github_repo"
        ? {
            status: "done",
            results: [
              { full_name: "hmcts/ccd-data-store-api", description: "Store/search cases", url: "https://github.com/hmcts/ccd-data-store-api" },
              { full_name: "other/ccd-tool", description: null, url: "https://github.com/other/ccd-tool" }
            ]
          }
        : { status: "done", results: [{ owner: request.owner as string, number: 12, title: "CFT roadmap" }] }
  );
}

function panel({
  artefact = snapshot(),
  exported = { status: "none" },
  exportTo = exporting(),
  defaultRepo = null,
  defaultProject = null,
  lookUp = searching(),
  confluence
}: {
  artefact?: ArtefactSnapshot;
  exported?: GithubExportView;
  exportTo?: ExportToGithubAction;
  defaultRepo?: string | null;
  defaultProject?: GithubProjectChoice | null;
  lookUp?: LookUp;
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
      github={{ exported, exportTo, defaultRepo, defaultProject, lookUp }}
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

async function search(box: string, text: string): Promise<void> {
  fireEvent.change(screen.getByRole("combobox", { name: box }), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
  });
}

describe("the document's GitHub export", () => {
  it("should start from the person's default repository and Project and create the issue there", async () => {
    // Arrange
    const exportTo = exporting();
    render(panel({ exportTo, defaultRepo: "hmcts/cft-workspace", defaultProject: ROADMAP }));

    // Act
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(screen.getByText("hmcts/cft-workspace")).toBeTruthy();
    expect(screen.getByText("CFT roadmap")).toBeTruthy();
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/cft-workspace", project: ROADMAP });
    expect(screen.getByText("Creating issue…").getAttribute("role")).toBe("status");
  });

  it("should keep the default Project when the repository's owner is written in another case", () => {
    render(panel({ defaultRepo: "HMCTS/cft-workspace", defaultProject: ROADMAP }));

    expect(screen.getByText("CFT roadmap")).toBeTruthy();
  });

  it("should leave out a default Project that is not the repository owner's", () => {
    render(panel({ defaultRepo: "other/repo", defaultProject: ROADMAP }));

    expect(screen.queryByText("CFT roadmap")).toBeNull();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("should ask for a repository, and offer no Project, when the person has no default", () => {
    render(panel());

    expect(createButton().disabled).toBe(true);
    expect(screen.getByText("Choose the repository the issue goes in.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose the GitHub repository" })).toBeTruthy();
    expect(screen.queryByText("Project")).toBeNull();
  });

  it("should create the issue in a repository found by searching the person's GitHub", async () => {
    // Arrange
    vi.useFakeTimers();
    const exportTo = exporting();
    const lookUp = searching();
    render(panel({ exportTo, lookUp }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Choose the GitHub repository" }));
    await search("Search your GitHub repositories", "ccd data");
    fireEvent.click(screen.getByRole("option", { name: /hmcts\/ccd-data-store-api/ }));
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(lookUp).toHaveBeenCalledWith({ kind: "github_repo", query: "ccd data", space: null, owner: null }, expect.any(AbortSignal));
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/ccd-data-store-api", project: null });
  });

  it("should offer a typed owner/name first, as it stands, even when the search does not find it", async () => {
    // Arrange
    vi.useFakeTimers();
    const exportTo = exporting();
    render(panel({ exportTo, lookUp: vi.fn<LookUp>(async () => ({ status: "done", results: [] })) }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Choose the GitHub repository" }));
    await search("Search your GitHub repositories", "https://github.com/someone/elsewhere");
    fireEvent.click(screen.getByRole("option", { name: /someone\/elsewhere/ }));
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "someone/elsewhere", project: null });
  });

  it("should search the repository owner's Projects and put the issue on the one picked", async () => {
    // Arrange
    vi.useFakeTimers();
    const exportTo = exporting();
    const lookUp = searching();
    render(panel({ exportTo, lookUp, defaultRepo: "hmcts/cft-workspace" }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Choose a GitHub Project to add the issue to" }));
    await search("Search hmcts's GitHub Projects", "roadmap");
    fireEvent.click(screen.getByRole("option", { name: /CFT roadmap/ }));
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(lookUp).toHaveBeenCalledWith({ kind: "github_project", query: "roadmap", space: null, owner: "hmcts" }, expect.any(AbortSignal));
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/cft-workspace", project: ROADMAP });
  });

  it("should take the Project off when the person picks a repository of another owner's", async () => {
    // Arrange
    vi.useFakeTimers();
    const exportTo = exporting();
    render(panel({ exportTo, defaultRepo: "hmcts/cft-workspace", defaultProject: ROADMAP }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Change the GitHub repository, now hmcts/cft-workspace" }));
    await search("Search your GitHub repositories", "ccd");
    fireEvent.click(screen.getByRole("option", { name: /other\/ccd-tool/ }));
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(screen.queryByText("CFT roadmap")).toBeNull();
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "other/ccd-tool", project: null });
  });

  it("should add the issue to no Project when the person removes the default one", async () => {
    const exportTo = exporting();
    render(panel({ exportTo, defaultRepo: "hmcts/cft-workspace", defaultProject: ROADMAP }));

    fireEvent.click(screen.getByRole("button", { name: "Add it to no Project" }));
    await act(async () => {
      fireEvent.click(createButton());
    });

    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/cft-workspace", project: null });
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

  it("should show the issue and its Project, and a banner linking to it, when the export is done", () => {
    render(panel({ exported: { ...DONE, project: ROADMAP, projectError: null } }));

    expect(screen.queryByRole("button", { name: "Create GitHub issue" })).toBeNull();
    expect(screen.getByText("On GitHub")).toBeTruthy();
    expect(screen.getByText(/· CFT roadmap/)).toBeTruthy();
    expect(screen.getByText(/on CFT roadmap/)).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open issue" }) as HTMLAnchorElement).href).toBe(DONE.url);
    expect((screen.getByRole("link", { name: "View on GitHub" }) as HTMLAnchorElement).href).toBe(DONE.url);
  });

  it("should say the issue is not on the Project, and why, when adding it failed", () => {
    render(panel({ exported: { ...DONE, project: ROADMAP, projectError: "your GitHub sign-in needs the project scope" } }));

    expect(screen.getByRole("alert").textContent).toBe("It is not on CFT roadmap: your GitHub sign-in needs the project scope.");
    expect(screen.queryByText(/· CFT roadmap/)).toBeNull();
  });

  it("should show the repository and no way to change it or export again while the export is pending", () => {
    render(panel({ exported: { status: "pending", repo: "hmcts/cft-workspace", project: null, requestedAt: new Date().toISOString() } }));

    expect(screen.getByText("hmcts/cft-workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Change the GitHub repository/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create GitHub issue" })).toBeNull();
  });

  it("should show why and offer the export again, to the same place, when it failed", async () => {
    // Arrange
    const exportTo = exporting();
    render(panel({ exportTo, exported: { status: "failed", repo: "hmcts/nope", project: null, error: "GitHub refused the issue: no such repository" } }));

    // Act
    expect(screen.getByRole("alert").textContent).toBe("GitHub refused the issue: no such repository");
    await act(async () => {
      fireEvent.click(createButton());
    });

    // Assert
    expect(exportTo).toHaveBeenCalledWith({ conversationId: CONVERSATION, repo: "hmcts/nope", project: null });
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

describe("ticketsOffered", () => {
  const none = { status: "none" };
  const done = { status: "done" };
  const pending = { status: "pending" };
  const failed = { status: "failed" };

  it("should offer only the person's own tool for a document with no ticket", () => {
    expect(ticketsOffered("github", none, none)).toEqual({ jira: false, github: true });
    expect(ticketsOffered("jira", none, failed)).toEqual({ jira: true, github: false });
  });

  it("should show the ticket the document has in the other tool, and offer no second one", () => {
    expect(ticketsOffered("github", done, none)).toEqual({ jira: true, github: false });
    expect(ticketsOffered("jira", none, pending)).toEqual({ jira: false, github: true });
  });

  it("should offer the person's own tool again when the other tool's export failed", () => {
    expect(ticketsOffered("github", failed, none)).toEqual({ jira: false, github: true });
  });
});

describe("the footer with a ticket in each tool", () => {
  it("should offer both, ticked, beside Confluence", () => {
    render(
      <ExportFooter
        conversationId={CONVERSATION}
        jira={{
          exported: { status: "done", project: "VIBE", key: "VIBE-1", url: "https://hmcts.atlassian.net/browse/VIBE-1" },
          access: { connected: true, login: null },
          exportTo: vi.fn(async () => ({ ok: true as const }))
        }}
        github={{ exported: { ...DONE, project: null, projectError: null }, exportTo: exporting() }}
        confluence={{
          exported: { status: "none" },
          access: { connected: true, login: null },
          exportTo: vi.fn<ExportToConfluenceAction>(async () => ({ ok: true }))
        }}
        saved
        written
      />
    );

    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["jira", "github", "confluence"]);
    expect((screen.getByRole("radio", { name: /Confluence page/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText("(done)")).toHaveLength(2);
  });
});

describe("openingDestination with GitHub", () => {
  const none = { status: "none" } as const;

  it("should open on GitHub when the person's ticket tool is GitHub and nothing is in progress", () => {
    expect(openingDestination(none, none, "github")).toBe("github");
  });

  it("should open on Confluence once the GitHub issue is done", () => {
    expect(openingDestination({ ...DONE, project: null, projectError: null }, none, "github")).toBe("confluence");
  });

  it("should open on GitHub while its export is pending", () => {
    expect(openingDestination({ status: "pending", repo: "hmcts/x", project: null, requestedAt: "2026-11-02T10:00:00.000Z" }, none, "github")).toBe("github");
  });
});
