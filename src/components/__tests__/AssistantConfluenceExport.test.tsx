/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import type { ConfluenceExportView } from "@/assistant/confluence";
import type { DefaultConfluencePage } from "@/assistant/export-defaults";
import type { LookupResponse } from "@/assistant/lookups";
import { ArtefactPanel } from "@/components/assistant/ArtefactPanel";
import { AtlassianSearch, LOOKUP_AFTER_MS, shortCrumb, WAKING_RETRY_MS } from "@/components/assistant/AtlassianSearch";
import type { ExportToConfluenceAction } from "@/components/assistant/ConfluenceExport";
import { openingDestination } from "@/components/assistant/ExportFooter";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const CONNECTED: JiraAccess = { connected: true, login: null };
const PAGE = {
  id: "280959611",
  title: "Design notes",
  space_id: "280952876",
  space_key: "CCD",
  space_name: "Core Case Data",
  ancestors: ["Core Case Data", "Guides"],
  url: "https://hmcts.atlassian.net/wiki/spaces/CCD/pages/280959611"
};
const DEFAULT_PAGE: DefaultConfluencePage = {
  id: "100",
  title: "Team space",
  space_id: "280952876",
  space_key: "CCD",
  space_name: "Core Case Data",
  ancestors: ["Core Case Data"]
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

function snapshot(overrides: Partial<ArtefactSnapshot> = {}): ArtefactSnapshot {
  return { title: "Story", markdown: "# Original", version: 2, updatedBy: "user", ...overrides };
}

function answering(...answers: LookupResponse[]) {
  const queue = [...answers];
  return vi.fn<LookUp>(async () => queue.shift() ?? answers.at(-1) ?? { status: "done", results: [] });
}

function panel({
  exported = { status: "none" },
  exportTo = vi.fn<ExportToConfluenceAction>(async () => ({ ok: true })),
  defaultPage = null,
  lookUp = answering({ status: "done", results: [PAGE] }),
  jira = true
}: {
  exported?: ConfluenceExportView;
  exportTo?: ExportToConfluenceAction;
  defaultPage?: DefaultConfluencePage | null;
  lookUp?: LookUp;
  jira?: boolean;
} = {}) {
  return (
    <ArtefactPanel
      conversationId={CONVERSATION}
      artefact={snapshot()}
      productLabel="CCD"
      save={vi.fn(async () => ({ ok: true as const, saved: true as const, version: 99 }))}
      onClose={() => undefined}
      narrow={false}
      jira={
        jira
          ? {
              exported: { status: "done", project: "VIBE", key: "VIBE-1", url: "https://hmcts.atlassian.net/browse/VIBE-1" },
              access: CONNECTED,
              exportTo: vi.fn()
            }
          : undefined
      }
      confluence={{ exported, access: CONNECTED, exportTo, defaultPage, lookUp }}
    />
  );
}

function publishButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Publish to Confluence/ }) as HTMLButtonElement;
}

async function typeAndWait(label: string | RegExp, value: string): Promise<void> {
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
  });
}

describe("Confluence export in the document panel", () => {
  it("should open on Confluence when the document is already in Jira, and say Jira is done", () => {
    render(panel());

    expect((screen.getByRole("radio", { name: /Confluence page/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Jira backlog/ }).parentElement?.textContent).toContain("(done)");
  });

  it("should start from the built-in AI Resources page, and publish under it, when the person has no default", async () => {
    const exportTo = vi.fn<ExportToConfluenceAction>(async () => ({ ok: true }));
    render(panel({ exportTo }));

    expect(screen.getByRole("button", { name: "Change the Confluence page, now AI Resources" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(publishButton());
    });

    expect(exportTo).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      parent: {
        id: "286130747",
        title: "AI Resources",
        space_id: "286130187",
        space_key: "CATHAI",
        space_name: "Court and Tribunal Hearings (CaTH) AI Project"
      }
    });
  });

  it("should publish under the page the person found by searching, within the default space first", async () => {
    vi.useFakeTimers();
    const exportTo = vi.fn<ExportToConfluenceAction>(async () => ({ ok: true }));
    const lookUp = answering({ status: "done", results: [PAGE] });
    render(panel({ exportTo, lookUp, defaultPage: DEFAULT_PAGE }));

    fireEvent.click(screen.getByRole("button", { name: "Change the Confluence page, now Team space" }));
    await typeAndWait(/Search Confluence/, "design");
    expect(screen.getByRole("option").textContent).toContain("Design notes");
    fireEvent.click(screen.getByRole("option"));
    await act(async () => {
      fireEvent.click(publishButton());
    });

    expect(lookUp).toHaveBeenCalledWith({ kind: "confluence_page", query: "design", space: "CCD" }, expect.any(AbortSignal));
    expect(exportTo).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      parent: { id: PAGE.id, title: PAGE.title, space_id: PAGE.space_id, space_key: "CCD", space_name: "Core Case Data" }
    });
    expect(screen.getByText("Creating page…")).toBeTruthy();
  });

  it("should show the page with a link to it, and no way to publish again, when the export is done", () => {
    render(
      panel({
        exported: {
          status: "done",
          pageId: "9",
          pageTitle: "Story",
          url: "https://hmcts.atlassian.net/wiki/spaces/CCD/pages/9",
          parentTitle: "Guides",
          spaceName: "CCD"
        },
        jira: false
      })
    );

    expect(screen.getByText("✓ Created Story")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View in Confluence" }).getAttribute("href")).toBe("https://hmcts.atlassian.net/wiki/spaces/CCD/pages/9");
    expect(screen.getByText("In Confluence")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Publish to Confluence/ })).toBeNull();
  });

  it("should show why and offer the export again when it failed", () => {
    render(panel({ exported: { status: "failed", place: null, error: "Confluence did not answer in time. Try again." }, defaultPage: DEFAULT_PAGE }));

    expect(screen.getByRole("alert").textContent).toBe("Confluence did not answer in time. Try again.");
    expect(publishButton().disabled).toBe(false);
  });

  it("should show only the Confluence export, with no choice of destination, when the panel has no Jira props", () => {
    render(panel({ jira: false }));

    expect(screen.queryByRole("radio")).toBeNull();
    expect(publishButton()).toBeTruthy();
  });
});

describe("the export footer accessibility", () => {
  it("should raise no WCAG A or AA violations with the Confluence search showing results", async () => {
    vi.useFakeTimers();
    const { container } = render(panel({ defaultPage: DEFAULT_PAGE }));
    fireEvent.click(screen.getByRole("button", { name: /Change the Confluence page/ }));
    await typeAndWait(/Search Confluence/, "design");
    vi.useRealTimers();

    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } }
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  }, 20_000);
});

describe("AtlassianSearch", () => {
  function search(lookUp: LookUp, access: JiraAccess = CONNECTED, scope: { key: string; name: string } | null = null) {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <AtlassianSearch
        kind="confluence_page"
        label="Find a page"
        placeholder=""
        scope={scope}
        access={access}
        lookUp={lookUp}
        onPick={onPick}
        onCancel={onCancel}
      />
    );
    return { onPick, onCancel, view };
  }

  it("should search once for a burst of typing, and not at all for a single letter", async () => {
    vi.useFakeTimers();
    const lookUp = answering({ status: "done", results: [] });
    search(lookUp);

    await typeAndWait("Find a page", "d");
    fireEvent.change(screen.getByRole("combobox", { name: "Find a page" }), { target: { value: "de" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Find a page" }), { target: { value: "des" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
    });

    expect(lookUp).toHaveBeenCalledTimes(1);
    expect(lookUp).toHaveBeenCalledWith({ kind: "confluence_page", query: "des", space: null }, expect.any(AbortSignal));
    expect(screen.getByText("No pages match that.")).toBeTruthy();
  });

  it("should say the assistant is starting and search again by itself when it is waking", async () => {
    vi.useFakeTimers();
    const lookUp = answering({ status: "waking" }, { status: "done", results: [PAGE] });
    search(lookUp);

    await typeAndWait("Find a page", "design");
    expect(screen.getByText(/Your assistant is starting/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WAKING_RETRY_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
    });

    expect(lookUp).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option").textContent).toContain("Design notes");
  });

  it("should offer the Atlassian sign-in when twg is signed out, and ask the pod to start it", async () => {
    vi.useFakeTimers();
    const lookUp = answering({ status: "signed_out" }, { status: "signing_in" });
    search(lookUp);

    await typeAndWait("Find a page", "design");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Atlassian" }));
    });

    expect(lookUp).toHaveBeenLastCalledWith({ kind: "confluence_page", query: "design", space: null, signIn: true }, expect.any(AbortSignal));
    expect(screen.getByText(/Sign in to Atlassian with the code below/)).toBeTruthy();
  });

  it("should move through the results with the arrows and pick with Enter, and close on Escape", async () => {
    vi.useFakeTimers();
    const second = { ...PAGE, id: "2", title: "Second" };
    const { onPick, onCancel } = search(answering({ status: "done", results: [PAGE, second] }));

    await typeAndWait("Find a page", "design");
    const box = screen.getByRole("combobox", { name: "Find a page" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]?.id);
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Escape" });

    expect(onPick).toHaveBeenCalledWith(second);
    expect(onCancel).toHaveBeenCalled();
  });

  it("should search all of Confluence once the person widens it from the default space", async () => {
    vi.useFakeTimers();
    const lookUp = answering({ status: "done", results: [] });
    search(lookUp, CONNECTED, { key: "CCD", name: "Core Case Data" });

    await typeAndWait("Find a page", "design");
    fireEvent.click(screen.getByRole("checkbox", { name: "Only in Core Case Data" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
    });

    expect(lookUp.mock.calls.map(([request]) => request.space)).toEqual(["CCD", null]);
  });
});

describe("shortCrumb and openingDestination", () => {
  it("should leave out the middle of a long breadcrumb when it is shown on one line", () => {
    expect(shortCrumb(["A", "B", "C"])).toBe("A › B › C");
    expect(shortCrumb(["A", "B", "C", "D", "E"])).toBe("A › … › D › E");
  });

  it("should open on an export in progress, else the one not yet done", () => {
    const none = { status: "none" } as const;
    expect(openingDestination(none, none)).toBe("jira");
    expect(openingDestination(none, { status: "pending", parentTitle: "P", spaceName: "S" })).toBe("confluence");
    expect(openingDestination({ status: "pending", project: "VIBE" }, { status: "pending", parentTitle: "P", spaceName: "S" })).toBe("jira");
  });
});
