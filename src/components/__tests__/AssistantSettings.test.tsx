/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import type { AssistantMemory } from "@/assistant/memory";
import { CONVERSATION_MEMORY_BYTES, type MemoryUse } from "@/assistant/memory-report";
import { TEMPLATES, type Template } from "@/assistant/starters";
import { checkTemplate, MAX_TEMPLATE_BODY, MAX_TEMPLATES, type SavedTemplate, TEMPLATES_FULL } from "@/assistant/templates";
import type { UploadsOnDisk } from "@/assistant/upload-disk";
import { MAX_REPORTED_FILES, type PodFile, type UploadsDisk } from "@/assistant/upload-report";
import type { FormAction } from "@/components/ActionForm";
import { LOOKUP_AFTER_MS } from "@/components/assistant/AtlassianSearch";
import type { AssistantClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import type { AssistantExportDefaults } from "@/components/assistant/ExportSettings";
import type { AssistantFiles } from "@/components/assistant/FileSettings";
import { SETTINGS_TWO_PANE_MIN_WIDTH } from "@/components/assistant/layout";
import type { AssistantModelSetting } from "@/components/assistant/ModelSettings";
import { type AssistantPlugins, AssistantSettings, FOCUSABLE } from "@/components/assistant/SettingsDialog";
import type { AssistantSize } from "@/components/assistant/SizeSettings";
import { type AssistantTemplates, copyName } from "@/components/assistant/TemplateSettings";
import { DEFAULT_CLAUDE_MD, MAX_CLAUDE_MD_CHARACTERS } from "@/credentials/claude-md";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginState, LoginView } from "@/virtual-agents/logins";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/assistant" }));
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  // biome-ignore lint/suspicious/noDocumentCookie: clears what the appearance switch under test wrote, the way it wrote it
  document.cookie = "asst_theme=; Path=/; Max-Age=0";
});

const KINDS: CredentialKind[] = ["github", "azure", "claude", "jenkins", "atlassian"];
const ALL_SIGNED_IN: CredentialKind[] = ["github", "azure", "claude", "atlassian"];

/** When a stored credential was saved, and a sign-in either side of it, so the two can be ordered on purpose. */
const STORED_AT = "2026-10-24T09:00:00.000Z";
const BEFORE_STORED = "2026-10-23T09:00:00.000Z";
const AFTER_STORED = "2026-10-24T15:00:00.000Z";

function status(kind: CredentialKind, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored: true, accountLabel, updatedAt: STORED_AT, updatedVia: "pod" };
}

function login(kind: CredentialKind, state: LoginState, expiresAt = new Date(Date.now() + 600_000).toISOString(), updatedAt = BEFORE_STORED): LoginView {
  return {
    kind,
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresAt,
    state,
    updatedAt,
    codeWaitingUntil: null
  };
}

function data(stored: CredentialKind[], logins: LoginView[] = [], unavailable: string | null = null): ConnectionsData {
  return { kinds: KINDS, statuses: stored.map((kind) => status(kind)), logins, unavailable };
}

function cog(): HTMLElement {
  return screen.getByRole("button", { name: /^Settings/ });
}

/** The dialog's own navigation, which is a vertical tablist beside whichever section it has open. */
function nav(): HTMLElement {
  return screen.getByRole("tablist", { name: "Settings sections" });
}

/** Every section the navigation offers, in the order it offers them. */
function sections(): string[] {
  return within(nav())
    .getAllByRole("tab")
    .map((tab) => tab.textContent ?? "");
}

/** Opens the section the navigation calls `label`, as clicking it does. */
function go(label: string): void {
  fireEvent.click(within(nav()).getByRole("tab", { name: label }));
}

/**
 * Opens the dialog, and the section named after it. The dialog opens on the first section its navigation offers, so
 * a test of any other one says which it is about.
 */
function open(props: Partial<Parameters<typeof AssistantSettings>[0]> = {}, section?: string): void {
  render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} {...props} />);
  fireEvent.click(cog());
  if (section !== undefined) {
    go(section);
  }
}

/**
 * The cog as a page has it: inside the element the `--asst-*` colours are declared on, which the Assistant's layout
 * puts inside the body. The dialog has to be rendered inside this element to inherit them.
 */
function themed(props: Partial<Parameters<typeof AssistantSettings>[0]> = {}, theme = "system"): HTMLElement {
  const root = document.createElement("div");
  root.className = "asst-theme";
  root.dataset.theme = theme;
  document.body.append(root);
  render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} {...props} />, { container: root });
  return root;
}

/**
 * The dialog's own focusable controls, in tab order: its close button, the appearance choices, then any others. It
 * asks the dialog which they are, so a control the trap has been left out of is a control missing here too.
 */
function stops(): HTMLElement[] {
  return [...screen.getByRole("dialog").querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/** Submits the named form and waits for the action it posts to. Shared by every section that has one. */
async function submit(name: string): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name }));
  });
}

describe("the Assistant's settings cog", () => {
  it("should offer settings and no warning when every sign-in it prompts about is connected", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should warn that GitHub needs attention when it alone is not connected", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN.filter((kind) => kind !== "github"))} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub needs your attention");
  });

  // Azure is in the background, as Jenkins is: never connecting it is a choice, so the cog says nothing about it.
  it("should not warn about Azure when it alone is not connected", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN.filter((kind) => kind !== "azure"))} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should name both when GitHub is missing and the optional one has lapsed", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["claude"], [login("atlassian", "expired")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub and Atlassian need your attention");
  });

  it("should not nag about Atlassian when the person has simply never set it up", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["github", "azure", "claude"])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it.each(["expired", "failed"] as const)("should warn about Atlassian once its sign-in has %s", (state) => {
    render(<AssistantSettings now={Date.now()} connections={data(["github", "azure", "claude"], [login("atlassian", state)])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. Atlassian needs your attention");
  });

  // A relayed code is a wait on the person whatever is stored behind it: only they can enter it, and the badge is
  // the one thing that says so to somebody who has sent the getting-ready screen away.
  it("should say a sign-in needs attention while a code is waiting behind a working one", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN, [login("github", "pending")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub needs your attention");
    expect(cog().textContent).toBe("!");
  });

  // The badge for a lapsed optional sign-in is reachable only because a stored credential is not on its own counted
  // as connected: a credential outlives the sign-in that failed to replace it, so storage alone would clear the mark.
  it("should say Atlassian needs attention when a stored sign-in is the one a later sign-in lapsed over", () => {
    const stale = login("atlassian", "expired", new Date(Date.now() - 600_000).toISOString(), AFTER_STORED);
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN, [stale])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. Atlassian needs your attention");
    expect(cog().textContent).toBe("!");
  });

  /**
   * Being stored is what silences the connections banner, so a stored value whose sign-in has since lapsed is a
   * state no other surface says anything about — which is what the badge is for, whatever the kind.
   */
  it.each([
    ["jenkins", "Jenkins"],
    ["claude", "Claude"]
  ] as const)("should say %s needs attention when a stored value is what a later sign-in lapsed over", (kind, name) => {
    const stale = login(kind, "expired", new Date(Date.now() - 600_000).toISOString(), AFTER_STORED);
    render(<AssistantSettings now={Date.now()} connections={data([...ALL_SIGNED_IN, kind], [stale])} />);

    expect(cog().getAttribute("aria-label")).toBe(`Settings. ${name} needs your attention`);
  });

  // The badge sends the person to the ask above their chats, and `signInPrompt` raises none for a code they have
  // already sent back — so a mark here would point at nothing.
  it("should say nothing needs attention while a code the person sent back is still to be collected", () => {
    const sent = {
      ...login("github", "pending"),
      prompt: "paste_code" as const,
      userCode: null,
      codeWaitingUntil: new Date(Date.now() + 60_000).toISOString()
    };
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN, [sent])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  /**
   * The cog's name and badge are in the HTML, so they have to be read against the clock the page was built with:
   * `Date.now()` here would be the server's in the document and the browser's in the first render, and a deadline
   * falling between the two is a mark that appears or disappears as the page hydrates.
   *
   * Told apart by a relay that began before the credential was saved, which is the one state the two answers differ
   * on: live, it is a code waiting for the person; run out, the save is the newer fact and the sign-in reads as
   * connected. So a cog reading its own clock would be silent where the page it was built for had something to say.
   */
  it("should read the sign-ins against the clock the page was built with", () => {
    const built = Date.now() - 4 * 60_000;
    const relayed = login("github", "pending", new Date(built + 1000).toISOString(), new Date(built - 60_000).toISOString());
    const stored: CredentialStatus = { kind: "github", stored: true, accountLabel: null, updatedAt: new Date(built - 30_000).toISOString(), updatedVia: "pod" };
    const connections = { kinds: KINDS, statuses: [stored, ...ALL_SIGNED_IN.map((kind) => status(kind))], logins: [relayed], unavailable: null };

    const html = renderToString(<AssistantSettings now={built} connections={connections} />);

    expect(html).toContain('aria-label="Settings. GitHub needs your attention"');
  });

  // And the browser's own as it takes over, so a mark the page was built with does not outlast what it was about.
  it("should read the sign-ins again once the browser has taken the page over", () => {
    const built = Date.now() - 4 * 60_000;
    const relayed = login("github", "pending", new Date(built + 1000).toISOString(), new Date(built - 60_000).toISOString());
    const stored: CredentialStatus = { kind: "github", stored: true, accountLabel: null, updatedAt: new Date(built - 30_000).toISOString(), updatedVia: "pod" };

    render(
      <AssistantSettings
        now={built}
        connections={{ kinds: KINDS, statuses: [stored, ...ALL_SIGNED_IN.map((kind) => status(kind))], logins: [relayed], unavailable: null }}
      />
    );

    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  it("should not say Atlassian needs attention when a sign-in failed before their credential was stored", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN, [login("atlassian", "failed", undefined, BEFORE_STORED)])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should mark the cog with a visible exclamation, not colour alone, when a sign-in needs attention", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["azure", "claude", "atlassian"])} />);

    expect(cog().textContent).toBe("!");
  });

  it("should warn when a sign-in is still waiting for the person", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["azure", "claude", "atlassian"], [login("github", "pending")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub needs your attention");
  });

  it("should not warn when only model access and a Jenkins token are missing", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["github", "azure", "atlassian"])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  it("should not warn when it has no sign-ins to report on", () => {
    render(<AssistantSettings now={Date.now()} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  it("should not warn when the hub cannot read the person's credentials, since nobody could act on it", () => {
    render(<AssistantSettings now={Date.now()} connections={data([], [], "the credentials Key Vault is not configured")} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should show no dialog until the person opens it", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cog().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the Assistant's settings dialog", () => {
  it("should open a labelled modal dialog when the person clicks the cog", () => {
    open();
    const dialog = screen.getByRole("dialog");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("heading", { level: 2, name: "Settings" }).id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(cog().getAttribute("aria-expanded")).toBe("true");
  });

  it("should close and put focus back on the cog when the person presses Escape", () => {
    open();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(cog());
  });

  it("should close and put focus back on the cog when the person clicks the page behind it", () => {
    open();
    const [backdrop] = screen.getAllByRole("button", { name: "Close settings" });

    fireEvent.click(backdrop!);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(cog());
  });

  it("should close and put focus back on the cog when the person uses its close button", () => {
    open();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close settings" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(cog());
  });

  // The navigation rather than the close button, so what has focus says where in the settings the person is.
  it("should move focus to the section it opens on when it opens", () => {
    open();

    expect(document.activeElement).toBe(within(nav()).getByRole("tab", { name: "Appearance" }));
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("should wrap focus back to the start when the person tabs off the end of the dialog", () => {
    open();
    const items = stops();
    items.at(-1)?.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(items[0]);
  });

  it("should wrap focus to the end when the person shift-tabs off the start of the dialog", () => {
    open();
    const items = stops();
    items[0]?.focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(items.at(-1));
  });

  it("should pull focus back into the dialog when it is somewhere else entirely", () => {
    open();
    const items = stops();
    (document.activeElement as HTMLElement).blur();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(items[0]);
  });

  it("should leave focus alone when the person tabs between the dialog's own controls", () => {
    open();
    const items = stops();
    items[1]?.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(items[1]);
  });

  it("should ignore a key that is neither Escape nor Tab when the dialog is open", () => {
    open();

    fireEvent.keyDown(document, { key: "a" });

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  // Every Assistant colour is `oklch(var(--asst-x))`, and those properties are declared on `.asst-theme`. A dialog
  // rendered beside that element rather than inside it inherits none of them and loses every background and border.
  it("should render inside the element the theme's colours are declared on when it opens", () => {
    const root = themed();
    fireEvent.click(cog());

    expect(root.contains(screen.getByRole("dialog"))).toBe(true);
    root.remove();
  });

  it("should keep Escape from reaching the page behind it, which would take the sidebar's drawer with it", () => {
    open();
    let reachedWindow = false;
    const listener = () => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", listener);

    fireEvent.keyDown(document, { key: "Escape" });
    window.removeEventListener("keydown", listener);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reachedWindow).toBe(false);
  });

  it("should start the appearance switch from the appearance the page is showing when it is reopened", () => {
    const root = themed({}, "system");
    fireEvent.click(cog());
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(cog());

    expect(root.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Match my device" }).getAttribute("aria-checked")).toBe("false");
    root.remove();
  });

  it("should offer the appearance the person chose, and switch it, from its new home in the dialog", () => {
    const page = document.createElement("div");
    page.className = "asst-theme";
    page.dataset.theme = "system";
    document.body.append(page);
    open({ theme: "system" });
    const appearance = within(screen.getByRole("dialog")).getByRole("radiogroup", { name: "Appearance" });

    fireEvent.click(within(appearance).getByRole("radio", { name: "Dark" }));

    expect(page.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("asst_theme=dark");
    page.remove();
  });

  it("should start the appearance switch from the person's stored choice when it opens", () => {
    open({ theme: "light" });

    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it("should list each sign-in and where it stands when it opens", () => {
    render(
      <AssistantSettings
        now={Date.now()}
        connections={{
          kinds: KINDS,
          statuses: [status("github", "alice@hmcts.net"), status("claude")],
          logins: [login("azure", "pending"), login("atlassian", "expired"), login("jenkins", "failed")],
          unavailable: null
        }}
      />
    );
    fireEvent.click(cog());
    go("Connections");
    const rows = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");

    expect(rows.map((row) => row.textContent)).toEqual([
      "GGitHubalice@hmcts.netConnected",
      "AzAzureYour HMCTS account, for pipelines and environments (optional)Waiting for you",
      "CClaudeYour Claude licenceConnected",
      "JJenkinsBuilds and pipelines on Jenkins (optional)Last sign-in failed",
      "AAtlassianJira tickets and Confluence pages (optional)Sign-in expired"
    ]);
  });

  it("should never list a CLAUDE.md or a git identity as a connection when they are among the kinds", () => {
    render(
      <AssistantSettings now={Date.now()} connections={{ kinds: [...KINDS, "claude_md", "git_identity"], statuses: [], logins: [], unavailable: null }} />
    );
    fireEvent.click(cog());
    go("Connections");
    const rows = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");

    expect(rows).toHaveLength(KINDS.length);
    expect(screen.getByRole("list", { name: "Connections" }).textContent).not.toContain("CLAUDE.md");
  });

  it("should say why it cannot list the sign-ins, rather than show none, when the hub cannot read them", () => {
    render(
      <AssistantSettings
        now={Date.now()}
        connections={{ kinds: KINDS, statuses: [], logins: [], unavailable: "the credentials Key Vault is not configured" }}
      />
    );

    fireEvent.click(cog());
    go("Connections");

    expect(screen.getByText("the credentials Key Vault is not configured")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });

  // Nothing to say about the sign-ins is a section the navigation does not offer at all, rather than an empty one:
  // the dialog is a list of places to go, and one that leads nowhere is worse than one that is not there.
  it("should offer the appearance alone, and no Connections section, when it has no sign-ins to list", () => {
    open({ connections: undefined });

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(sections()).toEqual(["Appearance"]);
  });

  it("should explain what a person should do, without saying the assistant is broken, when a sign-in needs attention", () => {
    open({ connections: data(["azure", "claude", "atlassian"]) }, "Connections");
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("GitHub needs your attention")).toBeTruthy();
    expect(within(dialog).getByText(/You can carry on chatting/)).toBeTruthy();
  });

  it("should show no warning inside the dialog when every sign-in it prompts about is connected", () => {
    open({}, "Connections");

    expect(screen.queryByText(/needs your attention/)).toBeNull();
  });
});

const ASSISTANT_ID = "0f8a6a1e-0000-4000-8000-000000000001";
const OFFERED = [
  { name: "pcs", description: "PCS team workflows" },
  { name: "dtsse", description: "" }
];

function ok() {
  return vi.fn(async () => ({ ok: true as const, confirmation: "Your assistant is restarting with its new plugins" }));
}

function plugins(overrides: Partial<AssistantPlugins> = {}): AssistantPlugins {
  return { assistantId: ASSISTANT_ID, available: OFFERED, checked: [], podRunning: true, save: ok(), ...overrides };
}

const FORM = "Change your assistant's team tools";

function connectWith(overrides: Partial<{ running: boolean; reconnect: FormAction }> = {}) {
  return { assistantId: ASSISTANT_ID, running: true, reconnect: ok(), ...overrides };
}

function azureRow(): HTMLElement {
  const row = within(screen.getByRole("list", { name: "Connections" }))
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText("Azure", { exact: true }) !== null);
  if (row === undefined) {
    throw new Error("no Azure row");
  }
  return row;
}

describe("connecting Azure from the Assistant's settings", () => {
  it("should offer to connect Azure when it is not connected", () => {
    open({ connections: data(["github", "claude"]), connect: connectWith() }, "Connections");

    expect(within(azureRow()).getByText("Not connected")).toBeTruthy();
    expect(within(azureRow()).getByRole("button", { name: "Connect Azure" }).textContent).toBe("Connect");
  });

  it("should restart the assistant to ask for the sign-in when the person confirms the connect", async () => {
    const reconnect = ok();
    open({ connections: data(["github", "claude"]), connect: connectWith({ reconnect }) }, "Connections");

    fireEvent.click(within(azureRow()).getByRole("button", { name: "Connect Azure" }));
    expect(screen.getByText("Restart your assistant so it asks you to sign in to Azure? Your chats are kept.")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(within(azureRow()).getByRole("form", { name: "Connect Azure" }));
    });

    const sent = (reconnect.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("kind")]).toEqual([ASSISTANT_ID, "azure"]);
  });

  it("should say the sign-in is asked for at the next start when the assistant is stopped", () => {
    open({ connections: data(["github", "claude"]), connect: connectWith({ running: false }) }, "Connections");

    fireEvent.click(within(azureRow()).getByRole("button", { name: "Connect Azure" }));

    expect(screen.getByText("Have your assistant ask you to sign in to Azure? It is stopped, so it asks when it next starts.")).toBeTruthy();
  });

  it("should put the question away again when the person cancels", () => {
    open({ connections: data(["github", "claude"]), connect: connectWith() }, "Connections");

    fireEvent.click(within(azureRow()).getByRole("button", { name: "Connect Azure" }));
    fireEvent.click(within(azureRow()).getByRole("button", { name: "Cancel" }));

    expect(within(azureRow()).queryByRole("form")).toBeNull();
    expect(within(azureRow()).getByRole("button", { name: "Connect Azure" })).toBeTruthy();
  });

  it("should offer to sign in again, and say the saved sign-in goes, when a stored Azure sign-in has lapsed", () => {
    open(
      {
        connections: data(["github", "claude", "azure"], [login("azure", "failed", new Date(Date.now() - 600_000).toISOString(), new Date().toISOString())]),
        connect: connectWith()
      },
      "Connections"
    );

    fireEvent.click(within(azureRow()).getByRole("button", { name: "Connect Azure" }));

    expect(screen.getByText(/^Delete your saved Azure sign-in, which all your virtual agents use, and restart your assistant/)).toBeTruthy();
    expect(within(azureRow()).getByRole("button", { name: "Sign in to Azure" })).toBeTruthy();
  });

  it("should offer no connect when Azure is connected", () => {
    open({ connections: data(["github", "claude", "azure"]), connect: connectWith() }, "Connections");

    expect(within(azureRow()).queryByRole("button")).toBeNull();
  });

  it("should offer no connect while a code the person asked for is waiting for them", () => {
    open({ connections: data(["github", "claude"], [login("azure", "pending")]), connect: connectWith() }, "Connections");

    expect(within(azureRow()).queryByRole("button")).toBeNull();
  });

  it("should offer a connect for nothing but Azure", () => {
    open({ connections: data([]), connect: connectWith() }, "Connections");

    const buttons = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Connect Azure"]);
  });

  it("should only say where Azure stands when the page gives no way to connect it", () => {
    open({ connections: data(["github", "claude"]) }, "Connections");

    expect(within(azureRow()).queryByRole("button")).toBeNull();
  });
});

describe("the Assistant's team tools", () => {
  it("should offer no Tools section when the hub offers none and the assistant loads none", () => {
    open({ plugins: plugins({ available: [] }) });

    expect(sections()).not.toContain("Tools");
    expect(screen.queryByRole("form", { name: FORM })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Team tools" })).toBeNull();
  });

  // `assistantPluginsData` gives nothing when `VIRTUAL_AGENT_PLUGINS` is malformed, rather than an empty list: the
  // hub cannot then tell which of the person's plugins it still offers, so a section would mislabel every one of them.
  // The rest of the dialog still renders, because the Assistant is someone's whole chat surface.
  it("should show nothing at all when the page passes no plugins", () => {
    open({ plugins: undefined });

    expect(sections()).not.toContain("Tools");
    expect(screen.queryByRole("heading", { name: "Team tools" })).toBeNull();
    expect(screen.queryByText(/No longer offered/)).toBeNull();
  });

  it("should still offer the appearance and the connections when there are no team tools to show", () => {
    open({ plugins: undefined });

    expect(sections()).toEqual(["Appearance", "Connections"]);
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    go("Connections");
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should describe each tool in the hub's own words, with its name underneath, when it opens", () => {
    open({ plugins: plugins() }, "Tools");
    const items = within(screen.getByRole("form", { name: FORM })).getAllByRole("listitem");

    expect(items.map((item) => item.textContent)).toEqual(["PCS team workflowspcs", "dtsse"]);
  });

  it("should tick the tools the assistant already loads when it opens", () => {
    open({ plugins: plugins({ checked: ["pcs"] }) }, "Tools");

    expect((screen.getByRole("checkbox", { name: /pcs/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /dtsse/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("should say a save restarts the assistant and keeps the chats when its pod is up", () => {
    open({ plugins: plugins() }, "Tools");

    expect(screen.getByText(/Saving restarts your assistant; your chats are kept\./)).toBeTruthy();
  });

  it("should say the assistant picks them up at its next start when its pod is not up", () => {
    open({ plugins: plugins({ podRunning: false }) }, "Tools");

    expect(screen.getByText(/Your assistant loads them the next time it starts\./)).toBeTruthy();
    expect(screen.queryByText(/Saving restarts/)).toBeNull();
  });

  it("should send the assistant's own id and the newly ticked names to the hub's plugins action when saved", async () => {
    const save = ok();
    open({ plugins: plugins({ checked: ["pcs"], save }) }, "Tools");

    fireEvent.click(screen.getByRole("checkbox", { name: /dtsse/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: FORM }));
    });

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.getAll("plugins")]).toEqual([ASSISTANT_ID, ["pcs", "dtsse"]]);
    expect(screen.getByRole("status").textContent).toBe("Your assistant is restarting with its new plugins");
  });

  it("should send no tools when the person unticks every one", async () => {
    const save = ok();
    open({ plugins: plugins({ checked: ["pcs"], save }) }, "Tools");

    fireEvent.click(screen.getByRole("checkbox", { name: /pcs/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: FORM }));
    });

    expect((save.mock.calls[0] as unknown as [FormData])[0].getAll("plugins")).toEqual([]);
  });

  it("should keep a ticked tool the hub no longer offers, so the person can untick it", () => {
    open({ plugins: plugins({ checked: ["civil", "pcs"] }) }, "Tools");

    expect((screen.getByRole("checkbox", { name: /civil/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("No longer offered. Untick it to stop using it.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).value)).toEqual(["pcs", "dtsse", "civil"]);
  });

  it("should keep its own tools in the dialog's focus trap when it is open", () => {
    open({ plugins: plugins() }, "Tools");
    const items = stops();

    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Save team tools" }));
  });
});

function row(name: string, text = `${name} prompt`): SavedTemplate {
  return { id: `t-${name.toLowerCase()}`, name, text };
}

function saveOk() {
  return vi.fn(async () => ({ ok: true as const, id: "t-new", confirmation: `"Stand-up" is saved, and is in the + menu of every chat` }));
}

function templates(overrides: Partial<AssistantTemplates> = {}): AssistantTemplates {
  return { mine: [], save: saveOk(), remove: vi.fn(async () => ({ ok: true as const, confirmation: "Your template is deleted" })), ...overrides };
}

const ADD = "Save a new template";

/** One of the built-in templates, which every test of them reads by its place in the list. */
function builtIn(index: number): Template {
  const built = TEMPLATES[index];
  if (built === undefined) {
    throw new Error(`there is no built-in template at ${index}`);
  }
  return built;
}

/** The built-in list is below the form, so its last Copy is the section's last stop in the focus trap. */
const LAST_COPY = `Copy ${TEMPLATES.at(-1)?.name} to your templates`;

describe("the Assistant's own templates", () => {
  it("should show nothing at all when the page passes no templates", () => {
    open({ templates: undefined });

    expect(sections()).not.toContain("Templates");
    expect(screen.queryByRole("heading", { name: "Your templates" })).toBeNull();
    expect(screen.queryByRole("form", { name: ADD })).toBeNull();
  });

  it("should still offer the appearance and the connections when the templates section is not shown", () => {
    open({ templates: undefined });

    expect(sections()).toEqual(["Appearance", "Connections"]);
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    go("Connections");
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should say the person has saved none, and still offer the form, when their list is empty", () => {
    open({ templates: templates() }, "Templates");

    expect(screen.getByText("You have not saved any yet.")).toBeTruthy();
    expect(screen.getByRole("form", { name: ADD })).toBeTruthy();
  });

  it("should list each saved template with its prompt when it opens", () => {
    open({ templates: templates({ mine: [row("Stand-up"), row("Retro")] }) }, "Templates");
    const rows = within(screen.getByRole("list", { name: "Your templates" })).getAllByRole("listitem");

    expect(rows.map((row) => row.textContent)).toEqual(["Stand-upStand-up promptEditDelete", "RetroRetro promptEditDelete"]);
  });

  it("should send the name and the prompt, and no id, to the save action when the person adds one", async () => {
    const save = saveOk();
    open({ templates: templates({ save }) }, "Templates");

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: " Stand-up " } });
    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "What I did yesterday:" } });
    await submit(ADD);

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("name"), sent.get("body")]).toEqual([null, " Stand-up ", "What I did yesterday:"]);
    expect(screen.getByRole("status").textContent).toContain("is in the + menu of every chat");
  });

  it("should open the form on a template, and send its id, when the person edits one", async () => {
    const save = saveOk();
    open({ templates: templates({ mine: [row("Stand-up")], save }) }, "Templates");

    fireEvent.click(screen.getByRole("button", { name: "Edit Stand-up" }));
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("Stand-up");
    expect((screen.getByLabelText("What it fills the message box with") as HTMLTextAreaElement).value).toBe("Stand-up prompt");
    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "Changed" } });
    await submit("Save your changes to Stand-up");

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("name"), sent.get("body")]).toEqual(["t-stand-up", "Stand-up", "Changed"]);
  });

  it("should go back to adding, with the fields empty, when the person cancels an edit", () => {
    open({ templates: templates({ mine: [row("Stand-up")] }) }, "Templates");

    fireEvent.click(screen.getByRole("button", { name: "Edit Stand-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("form", { name: ADD })).toBeTruthy();
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
  });

  it("should empty the fields after a save, so the next template is not written over the last one", async () => {
    open({ templates: templates() }, "Templates");

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Stand-up" } });
    await submit(ADD);

    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
  });

  it("should send the template's id to the delete action when the person deletes one", async () => {
    const remove = vi.fn(async () => ({ ok: true as const, confirmation: "Your template is deleted" }));
    open({ templates: templates({ mine: [row("Stand-up"), row("Retro")], remove }) }, "Templates");

    await submit("Delete Retro");

    expect((remove.mock.calls[0] as unknown as [FormData])[0].get("id")).toBe("t-retro");
  });

  it("should show the save action's own refusal, rather than deciding for itself, when it refuses", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: `you already have a template called "Stand-up"` }));
    open({ templates: templates({ save }) }, "Templates");

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Stand-up" } });
    await submit(ADD);

    expect(screen.getByRole("alert").textContent).toBe(`you already have a template called "Stand-up"`);
  });

  it("should count what the person has against the cap when it opens", () => {
    open({ templates: templates({ mine: [row("Stand-up")] }) }, "Templates");

    expect(screen.getByText(`1 of ${MAX_TEMPLATES} templates`)).toBeTruthy();
  });

  // The cap is refused in the store's own sentence, so what is read here is what a POST skipping this screen is told.
  it("should refuse another in the store's own words, and offer no form, when the person is at the cap", () => {
    const mine = Array.from({ length: MAX_TEMPLATES }, (_, index) => row(`Template ${index}`));
    open({ templates: templates({ mine }) }, "Templates");

    expect(screen.getByText(TEMPLATES_FULL)).toBeTruthy();
    expect(screen.queryByRole("form", { name: ADD })).toBeNull();
  });

  it("should still let the person change one of the ones they have when they are at the cap", () => {
    const mine = Array.from({ length: MAX_TEMPLATES }, (_, index) => row(`Template ${index}`));
    open({ templates: templates({ mine }) }, "Templates");

    fireEvent.click(screen.getByRole("button", { name: "Edit Template 3" }));

    expect(screen.getByRole("form", { name: "Save your changes to Template 3" })).toBeTruthy();
    expect(screen.queryByText(TEMPLATES_FULL)).toBeNull();
  });

  it("should say how far over the cap a prompt is, in the same count the store checks, while the person types", () => {
    open({ templates: templates() }, "Templates");

    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "x".repeat(MAX_TEMPLATE_BODY + 5) } });

    expect(screen.getByText(/4,005 of 4,000 characters: 5 too many/)).toBeTruthy();
    expect(screen.getByLabelText("What it fills the message box with").getAttribute("aria-invalid")).toBe("true");
  });

  it("should say the templates sit above the built-in ones, which the + menu cannot show, when it opens", () => {
    open({ templates: templates() }, "Templates");

    expect(screen.getByText(/above the built-in templates/)).toBeTruthy();
  });

  it("should keep its own fields in the dialog's focus trap when it is open", () => {
    open({ templates: templates({ mine: [row("Stand-up")] }) }, "Templates");
    const items = stops();

    expect(items).toContain(screen.getByLabelText("What it fills the message box with"));
    expect(items).toContain(screen.getByRole("button", { name: "Save template" }));
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: LAST_COPY }));
  });

  it("should list every built-in template with a View and a Copy when it opens", () => {
    open({ templates: templates() }, "Templates");
    const list = screen.getByRole("list", { name: "Built-in templates" });

    expect(within(list).getAllByRole("listitem")).toHaveLength(TEMPLATES.length);
    expect(
      within(list)
        .getAllByRole("button")
        .map((control) => control.getAttribute("aria-label"))
    ).toEqual(TEMPLATES.flatMap((built) => [`View ${built.name}`, `Copy ${built.name} to your templates`]));
  });

  it("should show a built-in's whole prompt, and hide it again, when the person views it", () => {
    open({ templates: templates() }, "Templates");
    const built = builtIn(0);
    const view = screen.getByRole("button", { name: `View ${built.name}` });
    const panel = document.getElementById(view.getAttribute("aria-controls") ?? "") as HTMLElement;

    expect([view.getAttribute("aria-expanded"), panel.hidden]).toEqual(["false", true]);
    fireEvent.click(view);
    expect([view.getAttribute("aria-expanded"), panel.hidden, panel.textContent]).toEqual(["true", false, built.text]);
    fireEvent.click(screen.getByRole("button", { name: `Hide ${built.name}` }));
    expect(panel.hidden).toBe(true);
  });

  it("should open the form on a copy of a built-in, focused, and save it as a new one, when the person copies it", async () => {
    const save = saveOk();
    open({ templates: templates({ save }) }, "Templates");
    const built = builtIn(2);

    fireEvent.click(screen.getByRole("button", { name: `Copy ${built.name} to your templates` }));
    const name = screen.getByLabelText("Template name") as HTMLInputElement;
    expect([name.value, (screen.getByLabelText("What it fills the message box with") as HTMLTextAreaElement).value]).toEqual([copyName(built), built.text]);
    expect(document.activeElement).toBe(name);
    await submit(ADD);

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("name"), sent.get("body")]).toEqual([null, copyName(built), built.text]);
  });

  it("should start again from the built-in when the person copies the same one twice", () => {
    open({ templates: templates() }, "Templates");
    const built = builtIn(0);

    fireEvent.click(screen.getByRole("button", { name: `Copy ${built.name} to your templates` }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: `Copy ${built.name} to your templates` }));

    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe(copyName(built));
  });

  it("should go back to adding, with the fields empty, when the person cancels a copy", () => {
    open({ templates: templates() }, "Templates");

    fireEvent.click(screen.getByRole("button", { name: `Copy ${builtIn(0).name} to your templates` }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("should still show the built-ins, but offer no Copy, when the person is at the cap", () => {
    const mine = Array.from({ length: MAX_TEMPLATES }, (_, index) => row(`Template ${index}`));
    open({ templates: templates({ mine }) }, "Templates");

    expect(screen.getByRole("button", { name: `View ${builtIn(0).name}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /to your templates$/ })).toBeNull();
  });

  // Every copy's name must save as it is, and `checkTemplate` refuses a built-in's own name.
  it("should give every copy a name that is not a built-in's and fits the cap when it names them", () => {
    for (const built of TEMPLATES) {
      expect(checkTemplate({ name: copyName(built), body: built.text }).ok).toBe(true);
    }
  });

  // Two rows of Edit and Delete say which template they belong to, so a screen reader is not read four of one name.
  it("should name the Edit and Delete of each row after its own template when it opens", () => {
    open({ templates: templates({ mine: [row("Stand-up"), row("Retro")] }) }, "Templates");
    const section = screen.getByRole("list", { name: "Your templates" });

    expect(
      within(section)
        .getAllByRole("button")
        .map((control) => control.getAttribute("aria-label"))
    ).toEqual(["Edit Stand-up", "Delete Stand-up", "Edit Retro", "Delete Retro"]);
  });

  // Every section is still reachable from one navigation, and each one is still in the focus trap once it is open:
  // the section that was added last must not be the only one left working.
  it("should offer every section the page passes, each in the focus trap, when they are all passed", () => {
    open({ plugins: plugins(), claudeMd: claudeMd(), templates: templates({ mine: [row("Stand-up")] }) });

    expect(sections()).toEqual(["Appearance", "Connections", "Templates", "Claude.md", "Tools"]);
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    go("Connections");
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    for (const [section, form, last] of [
      ["Tools", "Change your assistant's team tools", "Save team tools"],
      ["Claude.md", "Save your CLAUDE.md", "Save your CLAUDE.md"],
      ["Templates", "Save a new template", LAST_COPY]
    ] as const) {
      go(section);
      const items = stops();
      expect(items).toContain(screen.getByRole("form", { name: form }).querySelector("button[type='submit']"));
      expect(items.at(-1)).toBe(screen.getByRole("button", { name: last }));
    }
  });
});

const MODEL_FORM = "Choose the model your chats run on";

function modelSetting(overrides: Partial<AssistantModelSetting> = {}): AssistantModelSetting {
  return {
    model: "sonnet",
    honoured: true,
    save: vi.fn(async () => ({ ok: true as const, confirmation: "Sonnet saved as the model for your chats" })),
    ...overrides
  };
}

/** The radio the form shows as the one in force. */
function checkedModel(): string | null {
  const form = screen.getByRole("form", { name: MODEL_FORM });
  return (
    within(form)
      .getAllByRole("radio")
      .find((radio) => (radio as HTMLInputElement).checked)
      ?.getAttribute("value") ?? null
  );
}

function modelPanel(): HTMLElement {
  return screen.getByRole("region", { name: "Model" });
}

describe("the Assistant's model", () => {
  it("should offer no Model section when the page passes none", () => {
    open({ model: undefined });

    expect(sections()).not.toContain("Model");
    expect(screen.queryByRole("heading", { name: "Model" })).toBeNull();
  });

  it("should offer Sonnet and Opus, with what each is for and no version, when it is shown", () => {
    open({ model: modelSetting() }, "Model");
    const choices = within(screen.getByRole("form", { name: MODEL_FORM })).getAllByRole("radio");

    expect(choices.map((choice) => choice.getAttribute("value"))).toEqual(["sonnet", "opus"]);
    expect(modelPanel().textContent).toContain("Fast and capable, for most work");
    expect(modelPanel().textContent).toContain("The most thorough, for harder problems");
    expect(modelPanel().textContent).not.toMatch(/\d/);
  });

  it("should check the model the person is on when it is shown", () => {
    open({ model: modelSetting({ model: "opus" }) }, "Model");

    expect((within(screen.getByRole("form", { name: MODEL_FORM })).getByRole("radio", { name: /^Opus/ }) as HTMLInputElement).checked).toBe(true);
  });

  // One setting for every chat, which people read a settings dialog as being about the chat they opened it from.
  it("should say it applies to all of their chats, and when a change reaches one, whenever it is shown", () => {
    open({ model: modelSetting() }, "Model");

    expect(modelPanel().textContent).toContain("This applies to all of your chats");
    expect(modelPanel().textContent).toContain("takes the change with your next message");
  });

  it("should save the model the person picks and say so when they submit it", async () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "Opus saved as the model for your chats" }));
    open({ model: modelSetting({ save }) }, "Model");

    fireEvent.click(within(screen.getByRole("form", { name: MODEL_FORM })).getByRole("radio", { name: /^Opus/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: MODEL_FORM }));
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0] as unknown as [FormData])[0].get("model")).toBe("opus");
    expect(screen.getByRole("status").textContent).toBe("Opus saved as the model for your chats");
  });

  // A refused save stored nothing, so the pick never became the choice: leaving it checked beside the refusal would
  // show a selection that is not in force.
  it("should say why and put the radios back to the stored choice when the save is refused", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: "pick a model from the list" }));
    open({ model: modelSetting({ save }) }, "Model");

    fireEvent.click(within(screen.getByRole("form", { name: MODEL_FORM })).getByRole("radio", { name: /^Opus/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: MODEL_FORM }));
    });

    expect(screen.getByRole("alert").textContent).toBe("pick a model from the list");
    expect(checkedModel()).toBe("sonnet");
  });

  // Another tab, or the page's own revalidation, changes the stored choice under an open dialog.
  it("should follow the stored choice when the server sends another one while the dialog is open", () => {
    const { rerender } = render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} model={modelSetting()} />);
    fireEvent.click(cog());
    go("Model");
    expect(checkedModel()).toBe("sonnet");

    rerender(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} model={modelSetting({ model: "opus" })} />);

    expect(checkedModel()).toBe("opus");
  });

  it("should say the assistant takes the choice at its next start, and still offer it, when its pod cannot honour it", () => {
    open({ model: modelSetting({ honoured: false }) }, "Model");

    expect(modelPanel().textContent).toContain("Your assistant picks your choice up the next time it starts");
    expect(
      within(screen.getByRole("form", { name: MODEL_FORM }))
        .getAllByRole("radio")
        .every((radio) => !(radio as HTMLInputElement).disabled)
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Save model" })).toBeTruthy();
  });

  it("should say nothing about the next start when its pod honours the choice now", () => {
    open({ model: modelSetting({ honoured: true }) }, "Model");

    expect(modelPanel().textContent).not.toContain("next time it starts");
  });

  it("should sit under Agent, above the CLAUDE.md, and leave the other sections reachable when it is shown", () => {
    open({ model: modelSetting(), claudeMd: claudeMd(), plugins: plugins() }, "Model");

    expect(sections()).toEqual(["Appearance", "Connections", "Model", "Claude.md", "Tools"]);
    expect(screen.getByRole("heading", { name: "Model" })).toBeTruthy();
    go("Claude.md");
    expect(screen.getByRole("heading", { name: "Your CLAUDE.md" })).toBeTruthy();
  });
});

const SAVED = "Your CLAUDE.md is saved. Each agent uses it from its next Claude start";
const RESET = "Your CLAUDE.md is back to the default";
const SAVE_FORM = "Save your CLAUDE.md";
const RESET_FORM = "Reset your CLAUDE.md to the default";

function saved(confirmation: string) {
  return vi.fn(async () => ({ ok: true as const, confirmation }));
}

function claudeMd(overrides: Partial<AssistantClaudeMd> = {}): AssistantClaudeMd {
  return {
    settings: { available: true, stored: false, text: DEFAULT_CLAUDE_MD, updatedAt: null },
    save: saved(SAVED),
    reset: saved(RESET),
    ...overrides
  };
}

function notes(): HTMLTextAreaElement {
  return screen.getByLabelText("CLAUDE.md") as HTMLTextAreaElement;
}

describe("the Assistant's CLAUDE.md", () => {
  it("should show nothing at all when the page passes no CLAUDE.md", () => {
    open({ claudeMd: undefined });

    expect(sections()).not.toContain("Claude.md");
    expect(screen.queryByRole("heading", { name: "Your CLAUDE.md" })).toBeNull();
    expect(screen.queryByRole("form", { name: SAVE_FORM })).toBeNull();
  });

  // The navigation's own label is the person's word for it; the section's heading is the file's.
  it("should sit under Agent, beside the tools, and leave the other sections reachable when it is shown", () => {
    open({ claudeMd: claudeMd(), plugins: plugins() }, "Claude.md");

    expect(sections()).toEqual(["Appearance", "Connections", "Claude.md", "Tools"]);
    expect(screen.getByRole("heading", { name: "Your CLAUDE.md" })).toBeTruthy();
    go("Tools");
    expect(screen.getByRole("form", { name: FORM })).toBeTruthy();
    go("Appearance");
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
  });

  // Every pod writes the file before each start of Claude, so a chat that is already running keeps what it started
  // with. People read a settings dialog as being about the chat they opened it from, which is the misunderstanding
  // this wording is here to stop.
  it("should say the notes are used by all of their chats, and when a change reaches one, whenever it is shown", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");

    const section = screen.getByRole("region", { name: "Your CLAUDE.md" });
    expect(section.textContent).toContain("They apply to all of your chats, not only this one.");
    expect(section.textContent).toContain("A chat picks up a change when its session next starts, so a chat already running keeps the notes it started with.");
  });

  it("should fill the editor with the default and say none of theirs is stored when the person has saved none", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");

    expect(notes().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByText("This is the default. Nothing of yours is stored yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: RESET_FORM })).toBeNull();
  });

  it("should fill the editor with their own text, and say when it was saved, when one is stored", () => {
    open(
      { claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me\n\nI work on PCS.", updatedAt: "2026-10-05T09:00:00.000Z" } }) },
      "Claude.md"
    );

    expect(notes().value).toBe("# Me\n\nI work on PCS.");
    expect(screen.queryByText("This is the default. Nothing of yours is stored yet.")).toBeNull();
    expect(screen.getByRole("form", { name: RESET_FORM })).toBeTruthy();
  });

  it("should send the edited text to the save action, and confirm it, when the person saves", async () => {
    const save = saved(SAVED);
    open({ claudeMd: claudeMd({ save }) }, "Claude.md");

    fireEvent.change(notes(), { target: { value: "# Me\n\nAlways British English." } });
    await submit(SAVE_FORM);

    expect((save.mock.calls[0] as unknown as [FormData])[0].get("value")).toBe("# Me\n\nAlways British English.");
    expect(screen.getByRole("status").textContent).toBe(SAVED);
    expect(refresh).toHaveBeenCalled();
  });

  // The store owns what is acceptable, so the reason has to be its words: a generic "that could not be saved" would
  // leave someone with no idea which character or how much text to take out.
  it("should word the store's own reason when the save is refused", async () => {
    const refused = "your CLAUDE.md can only hold printable text, tabs and new lines";
    const save = vi.fn(async () => ({ ok: false as const, error: refused }));
    open({ claudeMd: claudeMd({ save }) }, "Claude.md");

    await submit(SAVE_FORM);

    expect(screen.getByRole("alert").textContent).toBe(refused);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should put the default back in the editor, and confirm it, when the person resets a stored one", async () => {
    const reset = saved(RESET);
    open({ claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me\n\nI work on PCS.", updatedAt: null }, reset }) }, "Claude.md");

    await submit(RESET_FORM);

    expect(reset).toHaveBeenCalled();
    expect(notes().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByRole("status").textContent).toBe(RESET);
  });

  it("should count the text against the store's own limit, and mark the field invalid, when there is too much of it", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");

    fireEvent.change(notes(), { target: { value: "a".repeat(MAX_CLAUDE_MD_CHARACTERS + 5) } });

    expect(screen.getByText("20,005 of 20,000 characters: 5 too many")).toBeTruthy();
    expect(notes().getAttribute("aria-invalid")).toBe("true");
  });

  it("should count what the person has written, and not mark it invalid, while it is within the limit", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");

    fireEvent.change(notes(), { target: { value: "🚀🚀" } });

    expect(screen.getByText("2 of 20,000 characters")).toBeTruthy();
    expect(notes().getAttribute("aria-invalid")).toBe("false");
  });

  it("should say why, rather than show an editor, when the hub cannot read the person's CLAUDE.md", () => {
    open({ claudeMd: claudeMd({ settings: { available: false, reason: "the credentials Key Vault is not configured" } }) }, "Claude.md");

    expect(screen.getByText(/the credentials Key Vault is not configured/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: SAVE_FORM })).toBeNull();
  });

  it("should describe the editor to a screen reader by its label, how it stands and its count, when it is shown", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");
    const described = (notes().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);

    expect(described).toEqual(["This is the default. Nothing of yours is stored yet.", `${DEFAULT_CLAUDE_MD.length} of 20,000 characters`]);
  });

  // A markdown editor is a textarea, which the trap's list of tab stops has to name: one left out of it is a control
  // Tab can reach and the wrap cannot account for, and the dialog is modal.
  it("should keep its editor and its buttons among the dialog's own tab stops when it is open", () => {
    open({ claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me", updatedAt: null } }) }, "Claude.md");
    const items = stops();

    expect(items).toContain(notes());
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Reset to the default" }));
  });

  it("should wrap focus from its last control back to the start of the dialog when the person tabs off the end", () => {
    open({ claudeMd: claudeMd() }, "Claude.md");
    const items = stops();
    items.at(-1)?.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(items.at(-1)).toBe(screen.getByRole("button", { name: SAVE_FORM }));
    expect(document.activeElement).toBe(items[0]);
  });
});

/** The whole dialog, which is what a person has when they open it: the navigation and every section it offers. */
function everything(): Partial<Parameters<typeof AssistantSettings>[0]> {
  return { plugins: plugins(), model: modelSetting(), claudeMd: claudeMd(), templates: templates({ mine: [row("Stand-up")] }), files: files(), size: size() };
}

function tabs(): HTMLElement[] {
  return within(nav()).getAllByRole("tab");
}

function selected(): string {
  return tabs().find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? "";
}

/**
 * The dialog as a narrow screen has it. `useTwoPane` reads the viewport, and jsdom has no `matchMedia` at all, so a
 * test of the narrow interface is a test that defines one — which is also what says plainly which interface it is
 * about.
 */
/** The `change` listeners `useTwoPane` has registered, so a test can take the screen across the breakpoint. */
let resized: (() => void)[] = [];

/**
 * A viewport of `width`, answering the dialog's own `min-width` query and dispatching `change` when it moves — so a
 * test of a resize exercises the listener rather than only the first read. jsdom has no `matchMedia` at all, which is
 * why every other test here takes the hook's fallback and is wide.
 */
function viewport(width: number): (next: number) => void {
  let current = width;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      // A getter, as a real `MediaQueryList` has: the hook keeps the object and reads `matches` again inside its
      // `change` handler, so a plain property would freeze the answer at the width the dialog opened on.
      get matches() {
        return current >= SETTINGS_TWO_PANE_MIN_WIDTH;
      },
      media: query,
      addEventListener: (_event: string, listener: () => void) => resized.push(listener),
      removeEventListener: (_event: string, listener: () => void) => {
        resized = resized.filter((other) => other !== listener);
      }
    })
  });
  return (next: number) => {
    current = next;
    for (const listener of [...resized]) {
      listener();
    }
  };
}

/** The dialog as a 390×844 screen has it. */
function narrow(): void {
  viewport(390);
}

function wideAgain(): void {
  Reflect.deleteProperty(window, "matchMedia");
  resized = [];
}

describe("the Assistant's settings navigation", () => {
  afterEach(wideAgain);

  it("should gather the sections under the headings they belong to when it opens", () => {
    open(everything());

    expect(sections()).toEqual(["Appearance", "Connections", "Templates", "Model", "Claude.md", "Tools", "Size", "Files"]);
    expect(nav().textContent).toBe("GeneralAppearanceConnectionsTemplatesAgentModelClaude.mdToolsSizeFiles");
  });

  // A tablist owns tabs and nothing else, so the two group headings are shown rather than announced, and the panel's
  // own heading is what says in full what a short label like "Tools" stands for.
  it("should keep its group headings out of what a screen reader is read when it opens", () => {
    open(everything());

    expect(within(nav()).getAllByRole("tab")).toHaveLength(8);
    for (const group of ["General", "Agent"]) {
      expect(within(nav()).getByText(group).getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("should open on the first section it offers, and relate it to the panel beside it, when it opens", () => {
    open(everything());
    const panel = screen.getByRole("tabpanel");

    expect(selected()).toBe("Appearance");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs()[0]?.id);
    expect(tabs()[0]?.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("should show only the section the person opens, and not the one they left, when they choose another", () => {
    open(everything());

    go("Templates");

    expect(selected()).toBe("Templates");
    expect(screen.getByRole("heading", { name: "Your templates" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Appearance" })).toBeNull();
  });

  it.each([
    ["ArrowDown", "Connections"],
    ["End", "Files"]
  ] as const)("should move focus down the navigation with %s when a section has focus", (key, expected) => {
    open(everything());

    fireEvent.keyDown(tabs()[0]!, { key });

    expect(document.activeElement?.textContent).toBe(expected);
  });

  it.each([
    ["ArrowUp", "Appearance"],
    ["Home", "Appearance"]
  ] as const)("should move focus back up the navigation with %s when a later section has focus", (key, expected) => {
    open(everything());
    tabs()[1]?.focus();

    fireEvent.keyDown(tabs()[1]!, { key });

    expect(document.activeElement?.textContent).toBe(expected);
  });

  it("should wrap from the last section to the first when the person arrows off the end", () => {
    open(everything());
    const last = tabs().length - 1;
    tabs()[last]?.focus();

    fireEvent.keyDown(tabs()[last]!, { key: "ArrowDown" });

    expect(document.activeElement?.textContent).toBe("Appearance");
  });

  it("should wrap from the first section to the last when the person arrows off the start", () => {
    open(everything());

    fireEvent.keyDown(tabs()[0]!, { key: "ArrowUp" });

    expect(document.activeElement?.textContent).toBe("Files");
  });

  // Every panel here is a form. Opening whichever section the arrows reach would throw away half-typed notes on the
  // way past, so arrows move focus and Enter or Space is what opens one.
  it("should leave the open section alone, until the person presses Enter, while they arrow past it", () => {
    open(everything());

    fireEvent.keyDown(tabs()[0]!, { key: "ArrowDown" });

    expect(selected()).toBe("Appearance");
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();

    fireEvent.click(document.activeElement as HTMLElement);

    expect(selected()).toBe("Connections");
  });

  // A roving tabindex: every section but the one with focus is deliberately not a tab stop, so `FOCUSABLE` must not
  // count them — the wrap would otherwise be measured from a button Tab can never land on.
  it("should put exactly one of its sections in the dialog's tab stops when it is open", () => {
    open(everything());

    expect(stops().filter((item) => item.getAttribute("role") === "tab")).toEqual([tabs()[0]]);
  });

  it("should keep the trap across both panes, wrapping from the open section's last control, when it is open", () => {
    open(everything(), "Templates");
    const items = stops();

    expect(items[0]).toBe(within(screen.getByRole("dialog")).getByRole("button", { name: "Close settings" }));
    expect(items[1]).toBe(within(nav()).getByRole("tab", { name: "Templates" }));
    expect(items).toContain(screen.getByRole("tabpanel"));
    items.at(-1)?.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(items[0]);
  });

  // Connections is a list and nothing else, so without a focusable panel a keyboard could not reach or scroll it.
  it("should make the panel itself a tab stop when the section it holds has no control of its own", () => {
    open({}, "Connections");
    const items = stops();

    expect(items.at(-1)).toBe(screen.getByRole("tabpanel"));
  });
});

describe("the Assistant's settings on a narrow screen", () => {
  afterEach(wideAgain);

  it("should offer the sections as a list, with nothing open, when there is no room for two panes", () => {
    narrow();
    open(everything());

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Settings sections" }))
        .getAllByRole("button")
        .map((item) => item.textContent)
    ).toEqual(["Appearance", "Connections", "Templates", "Model", "Claude.md", "Tools", "Size", "Files"]);
    expect(screen.queryByRole("radiogroup", { name: "Appearance" })).toBeNull();
  });

  it("should replace the list with the section, and put focus in it, when the person opens one", () => {
    narrow();
    open(everything());

    fireEvent.click(screen.getByRole("button", { name: "Claude.md" }));

    expect(screen.queryByRole("list", { name: "Settings sections" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Your CLAUDE.md" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to settings" }));
  });

  it("should put the list back, and focus in it, when the person goes back from a section", () => {
    narrow();
    open(everything());
    fireEvent.click(screen.getByRole("button", { name: "Templates" }));

    fireEvent.click(screen.getByRole("button", { name: "Back to settings" }));

    expect(screen.getByRole("list", { name: "Settings sections" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your templates" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Appearance" }));
  });

  it("should keep the open section in the dialog's own focus trap when there is only one pane", () => {
    narrow();
    open(everything());
    fireEvent.click(screen.getByRole("button", { name: "Templates" }));
    const items = stops();

    expect(items).toContain(screen.getByRole("button", { name: "Back to settings" }));
    items.at(-1)?.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(items[0]);
  });

  it("should still close on Escape, and put focus back on the cog, when a section is open", () => {
    narrow();
    open(everything());
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(cog());
  });
});

/**
 * A phone turned on its side crosses the breakpoint with the dialog open — 390×844 becomes 844×390 — so the two
 * interfaces have to hand over rather than start again.
 */
describe("the Assistant's settings across a change of width", () => {
  afterEach(wideAgain);

  function notes(): HTMLTextAreaElement {
    return screen.getByLabelText("CLAUDE.md") as HTMLTextAreaElement;
  }

  it("should keep what the person has typed in a section when the screen becomes too narrow for two panes", () => {
    const resize = viewport(1024);
    open(everything(), "Claude.md");
    fireEvent.change(notes(), { target: { value: "# Me\n\nHalf a thought" } });

    act(() => resize(390));

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to settings" })).toBeTruthy();
    expect(notes().value).toBe("# Me\n\nHalf a thought");
  });

  it("should keep what the person has typed when a narrow screen becomes wide enough for two panes", () => {
    const resize = viewport(390);
    open(everything());
    fireEvent.click(screen.getByRole("button", { name: "Claude.md" }));
    fireEvent.change(notes(), { target: { value: "# Me\n\nHalf a thought" } });

    act(() => resize(1024));

    expect(within(nav()).getByRole("tab", { name: "Claude.md" }).getAttribute("aria-selected")).toBe("true");
    expect(notes().value).toBe("# Me\n\nHalf a thought");
  });

  // The element focus was on goes with the navigation that is replaced, and focus would otherwise fall to the body —
  // outside the trap, with nothing to read.
  it.each([
    [1024, 390, "Back to settings"],
    [390, 1024, "Claude.md"]
  ])("should move focus to the navigation of whichever interface is showing when the width changes from %i to %i", (from, to, entry) => {
    const resize = viewport(from);
    open(everything());
    if (from === 390) {
      fireEvent.click(screen.getByRole("button", { name: "Claude.md" }));
    } else {
      go("Claude.md");
    }

    act(() => resize(to));

    expect(document.activeElement).toBe(screen.getByRole(to === 390 ? "button" : "tab", { name: entry }));
  });

  it("should keep the trap working, with the panel still in it, after the width has changed", () => {
    const resize = viewport(1024);
    open(everything(), "Templates");

    act(() => resize(390));
    const items = stops();
    items.at(-1)?.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(items).toContain(screen.getByRole("button", { name: "Back to settings" }));
    expect(document.activeElement).toBe(items[0]);
  });
});

/**
 * An axe audit of the dialog itself, which has none anywhere else: the Assistant's end-to-end audit opens
 * `/assistant` and never the cog, because the dialog's cog is underneath the getting-ready screen until a pod is
 * running. Run here it costs tens of milliseconds, and it is what checks that the navigation's tablist, its panel
 * and the relations between them hold together rather than only look as though they do.
 *
 * **It is structural and name-based only, and must not be read as "the dialog is accessible."** jsdom has no layout
 * and no computed colour, so `color-contrast` is turned off rather than silently inapplicable — and since nothing
 * end to end ever opens this dialog, its contrast, including `text-asst-error` on `bg-asst-hover`, is audited
 * **nowhere**. Nor does this catch everything structural: a non-`tab` child of a tablist passes it even with the
 * `aria-hidden` taken off, which is why the group headings have a test of their own.
 */
async function auditOpenDialog(section?: string): Promise<void> {
  const root = document.createElement("div");
  root.className = "asst-theme";
  root.dataset.theme = "dark";
  document.body.append(root);
  render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} {...everything()} />, { container: root });
  fireEvent.click(cog());
  if (section !== undefined) {
    go(section);
  }
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } }
  });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(" ")}`)).toEqual([]);
  root.remove();
}

describe("the Assistant's settings accessibility", () => {
  afterEach(wideAgain);

  for (const section of ["Appearance", "Claude.md", "Tools", "Connections", "Templates"]) {
    it(`should raise no WCAG A or AA violations with ${section} open`, async () => {
      await auditOpenDialog(section);
    }, 20_000);
  }

  it("should raise no WCAG A or AA violations on the section list of a narrow screen", async () => {
    narrow();
    await auditOpenDialog();
    wideAgain();
  }, 20_000);
});

const REPORTED_AT = "2026-10-29T09:00:00.000Z";

function podFile(overrides: Partial<PodFile> = {}): PodFile {
  return {
    uploadId: "0f8a6a1e-0000-4000-8000-000000000001",
    name: "bundle.pdf",
    bytes: 2 * 1024 * 1024,
    conversationId: "0f8a6a1e-0000-4000-8000-0000000000c1",
    conversationTitle: "Possession claim",
    deleting: false,
    ...overrides
  };
}

const ON_DISK: UploadsDisk = {
  reported: true,
  uploadsBytes: 2_254_857_830,
  volumeUsedBytes: 30_477_004_800,
  volumeTotalBytes: 34_359_738_368,
  at: REPORTED_AT,
  stopped: false
};

function files(overrides: Partial<UploadsOnDisk> = {}, actions: Partial<Pick<AssistantFiles, "remove" | "removeAll">> = {}): AssistantFiles {
  return {
    view: { disk: ON_DISK, files: [podFile()], filesTotal: 1, deleting: 0, ...overrides },
    remove: vi.fn(async () => ({ ok: true as const, confirmation: "Your assistant deletes that file within 10 minutes, the next time it checks." })),
    removeAll: vi.fn(async () => ({
      ok: true as const,
      confirmation: "Your assistant deletes all 1 of its files within 10 minutes, the next time it checks."
    })),
    ...actions
  };
}

const DELETE_ALL = "Delete every file your assistant is holding";

describe("the Assistant's files", () => {
  it("should show nothing at all when the page passes no files", () => {
    open({ files: undefined });

    expect(sections()).not.toContain("Files");
    expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();
  });

  it("should offer Files as its own section, after the agent's own, when the page passes it", () => {
    open({ ...everything(), files: files() });

    expect(sections()).toEqual(["Appearance", "Connections", "Templates", "Model", "Claude.md", "Tools", "Size", "Files"]);
  });

  // Two figures, never one: the uploads are a share of a volume the repository clones are on too, and the second
  // number is the one that explains why something has started going wrong.
  it("should give the files' size and the whole disk's, dated, when the assistant has reported", () => {
    open({ files: files() }, "Files");
    const section = screen.getByRole("region", { name: "Files" });

    expect(section.textContent).toContain("2.1 GB of files");
    expect(section.textContent).toContain("On a disk that is 28.4 GB of 32 GB full");
    expect(section.textContent).toContain("Last reported");
  });

  it("should list each file with its size and the chat it belongs to when it opens", () => {
    open({ files: files({ files: [podFile(), podFile({ uploadId: "u2", name: "notes.txt", bytes: 4096, conversationTitle: "Rent arrears" })] }) }, "Files");
    const rows = within(screen.getByRole("list", { name: "Files on your assistant" })).getAllByRole("listitem");

    expect(rows.map((row) => row.textContent)).toEqual(["bundle.pdf2 MB · Possession claimDelete", "notes.txt4 KB · Rent arrearsDelete"]);
  });

  it("should send the file's id to the delete action when the person deletes one", async () => {
    const remove = vi.fn(async () => ({ ok: true as const, confirmation: "Your assistant deletes that file within 10 minutes, the next time it checks." }));
    open({ files: files({}, { remove }) }, "Files");

    await submit("Delete bundle.pdf");

    expect((remove.mock.calls[0] as unknown as [FormData])[0].get("id")).toBe("0f8a6a1e-0000-4000-8000-000000000001");
    expect(screen.getByRole("status").textContent).toContain("within 10 minutes");
  });

  // Irreversible in one submit — the hub's bytes for every one of these files go with it — so it is asked for, in the
  // shape this repo already asks before deleting a single chat.
  it("should post nothing until the person confirms deleting them all", () => {
    const removeAll = vi.fn(async () => ({ ok: true as const, confirmation: "done" }));
    open({ files: files({}, { removeAll }) }, "Files");

    expect(screen.queryByRole("form", { name: DELETE_ALL })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete every file" }));

    expect(removeAll).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: DELETE_ALL })).toBeTruthy();
  });

  it("should name how many files it is about, and take the decision, when it asks", async () => {
    const removeAll = vi.fn(async () => ({ ok: true as const, confirmation: "Your assistant deletes all 2 of its files within 10 minutes." }));
    open({ files: files({ files: [podFile(), podFile({ uploadId: "u2", name: "notes.txt" })] }, { removeAll }) }, "Files");

    fireEvent.click(screen.getByRole("button", { name: "Delete every file" }));

    expect(screen.getByText("Delete all 2 files your assistant is holding? This cannot be undone.")).toBeTruthy();
    expect(document.activeElement).toBe(within(screen.getByRole("form", { name: DELETE_ALL })).getByRole("button", { name: "Delete every file" }));

    await submit(DELETE_ALL);

    expect(removeAll).toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("deletes all 2 of its files");
  });

  it("should put the question away, having posted nothing, when the person cancels", () => {
    const removeAll = vi.fn(async () => ({ ok: true as const, confirmation: "done" }));
    open({ files: files({}, { removeAll }) }, "Files");
    fireEvent.click(screen.getByRole("button", { name: "Delete every file" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("form", { name: DELETE_ALL })).toBeNull();
    expect(removeAll).not.toHaveBeenCalled();
  });

  // A "delete all" that quietly left gigabytes on the assistant's volume, or that implied the chat's own download
  // still worked, would be worse than no button: the copy has to say which copy goes and which stays — and it says
  // so before the button, so it can be read without committing to find out.
  it("should say which copy is removed and what the chat keeps, before the delete-everything button", () => {
    open({ files: files() }, "Files");
    const section = screen.getByRole("region", { name: "Files" });

    expect(section.textContent).toContain("removes your assistant's copy, which is what takes up the space");
    expect(section.textContent).toContain("Each chat still shows that a file was attached");
    expect(section.textContent).toContain("can no longer be downloaded back from the chat");
  });

  it("should offer no delete-everything button when the assistant is holding nothing", () => {
    open({ files: files({ files: [], filesTotal: 0, disk: { ...ON_DISK, uploadsBytes: 0 } }) }, "Files");

    expect(screen.getByText("Your assistant is holding no files.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete every file" })).toBeNull();
  });

  // A size with nothing to name it is the rows having gone with a deleted chat. Saying "holding no files" under a
  // byte total would be the contradiction this section exists to avoid.
  it("should explain a size it cannot name, rather than claim no files, when the rows have gone", () => {
    open({ files: files({ files: [], filesTotal: 3 }) }, "Files");
    const section = screen.getByRole("region", { name: "Files" });

    expect(section.textContent).toContain("2.1 GB of files");
    expect(section.textContent).toContain("files from chats you have deleted");
    expect(section.textContent).not.toContain("holding no files");
  });

  // Not "deleted": until the assistant's next report says the file is gone, all the hub knows is that it asked.
  it("should say a file is waiting for the assistant, and offer no second delete, once one is asked for", () => {
    open({ files: files({ files: [podFile({ deleting: true })], deleting: 1 }) }, "Files");
    const row = within(screen.getByRole("list", { name: "Files on your assistant" })).getByRole("listitem");

    expect(row.textContent).toContain("Waiting for your assistant");
    expect(screen.queryByRole("button", { name: "Delete bundle.pdf" })).toBeNull();
    expect(screen.getByText("1 file is waiting for your assistant to delete.")).toBeTruthy();
  });

  it("should say how many are waiting when more than one has been asked for", () => {
    open({ files: files({ deleting: 3 }) }, "Files");

    expect(screen.getByText("3 files are waiting for your assistant to delete.")).toBeTruthy();
  });

  // Zero would read as "you have no files", which is the one thing the section must never say when it cannot tell.
  it.each([
    ["older_client", "running an older version that cannot tell us what it is holding"],
    ["not_running", "stopped, so nothing has been able to look at its disk"],
    ["waiting", "has not reported yet"]
  ] as const)("should say it cannot tell, rather than show an empty disk, when the reason is %s", (reason, said) => {
    open({ files: files({ disk: { reported: false, reason }, files: [] }) }, "Files");
    const section = screen.getByRole("region", { name: "Files" });

    expect(section.textContent).toContain(said);
    expect(section.textContent).not.toContain("0 bytes");
    expect(section.textContent).not.toContain("holding no files");
  });

  it("should still say the figures are from a stopped assistant when it has stopped since reporting", () => {
    open({ files: files({ disk: { ...ON_DISK, stopped: true } }) }, "Files");

    expect(screen.getByRole("region", { name: "Files" }).textContent).toContain("Your assistant is stopped. Last reported");
  });

  it("should say how much of the list it is showing when the assistant holds more than a report carries", () => {
    open({ files: files({ filesTotal: 231 }) }, "Files");

    expect(screen.getByText("The largest 1 of 231 are listed. The size above is of everything.")).toBeTruthy();
  });

  // At exactly the cap nothing was cut, so a sentence about a shortened list would be about files all on the screen.
  it("should claim no shortened list when the assistant holds exactly as many as a report carries", () => {
    const many = Array.from({ length: MAX_REPORTED_FILES }, (_, index) => podFile({ uploadId: `u${index}` }));
    open({ files: files({ files: many, filesTotal: MAX_REPORTED_FILES }) }, "Files");

    expect(screen.queryByText(/are listed/)).toBeNull();
  });

  it("should show the action's own refusal, rather than deciding for itself, when a delete is refused", async () => {
    const refused = "Your assistant is running an older version that cannot delete its files yet. It can the next time it starts.";
    const remove = vi.fn(async () => ({ ok: false as const, error: refused }));
    open({ files: files({}, { remove }) }, "Files");

    await submit("Delete bundle.pdf");

    expect(screen.getByRole("alert").textContent).toBe(refused);
  });

  it("should keep its own controls in the dialog's focus trap when it is open", () => {
    open({ files: files() }, "Files");
    const items = stops();

    expect(items).toContain(screen.getByRole("button", { name: "Delete bundle.pdf" }));
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Delete every file" }));
  });

  it("should raise no WCAG A or AA violations with Files open", async () => {
    await auditOpenDialog("Files");
  }, 20_000);
});

describe("the Assistant's Jira and Confluence defaults", () => {
  const PROJECT = { key: "PCS", name: "Possession claims", url: "https://hmcts.atlassian.net/browse/PCS" };

  function exportsSettings(overrides: Partial<AssistantExportDefaults> = {}): AssistantExportDefaults {
    return {
      defaults: { jira: null, confluence: null },
      save: vi.fn(async (input: { jira: unknown; confluence: unknown }) => ({ ok: true as const, defaults: input as AssistantExportDefaults["defaults"] })),
      access: { connected: true, login: null },
      lookUp: vi.fn(async () => ({ status: "done" as const, results: [PROJECT] })),
      ...overrides
    };
  }

  it("should offer the section only when the page passes the defaults", () => {
    open({ exports: exportsSettings() });

    expect(sections()).toContain("Jira & Confluence");
  });

  it("should save a Jira project the person found by searching their own Jira", async () => {
    vi.useFakeTimers();
    const exports = exportsSettings();
    open({ exports }, "Jira & Confluence");

    fireEvent.click(within(screen.getByRole("group", { name: "Jira backlog" })).getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByRole("combobox", { name: /default backlog/ }), { target: { value: "possess" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOOKUP_AFTER_MS);
    });
    fireEvent.click(screen.getByRole("option"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    });
    vi.useRealTimers();

    expect(exports.save).toHaveBeenCalledWith({ jira: { key: "PCS", name: "Possession claims" }, confluence: null });
    expect(screen.getByText("Your defaults are saved")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("should clear a default and save nothing until something has changed", async () => {
    const exports = exportsSettings({ defaults: { jira: { key: "VIBE", name: "Vibe" }, confluence: null } });
    open({ exports }, "Jira & Confluence");

    expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    });

    expect(exports.save).toHaveBeenCalledWith({ jira: null, confluence: null });
    const jira = within(screen.getByRole("group", { name: "Jira backlog" }));
    const confluence = within(screen.getByRole("group", { name: "Confluence page" }));
    expect(jira.getByText("VIBE")).toBeTruthy();
    expect(jira.getByText("(default)")).toBeTruthy();
    expect(jira.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(confluence.getByText("AI Resources")).toBeTruthy();
    expect(confluence.getByText("(default)")).toBeTruthy();
    expect(confluence.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("should raise no WCAG A or AA violations with the section open", async () => {
    const root = document.createElement("div");
    root.className = "asst-theme";
    document.body.append(root);
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} exports={exportsSettings()} />, { container: root });
    fireEvent.click(cog());
    go("Jira & Confluence");
    fireEvent.click(within(screen.getByRole("group", { name: "Confluence page" })).getByRole("button", { name: "Change" }));

    const results = await axe.run(root, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      rules: { "color-contrast": { enabled: false } }
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    root.remove();
  }, 20_000);
});

const GIB = 1024 ** 3;
const LIMIT = 8 * GIB;

/**
 * A memory report whose non-reclaimable figure leaves `headroom` under the limit, which is what the threshold is
 * about.
 *
 * **Both figures that count page cache are pinned at the limit** — `currentBytes` and `peakBytes` — and neither may
 * raise the warning on its own: a pod that has merely read its workspace clone sits at its ceiling on both of them,
 * and `memory.peak` never falls while the pod lives. So every expectation below that no warning is shown is also a
 * check that the rule reads `anonBytes` and nothing else.
 */
function use(headroom: number, overrides: Partial<Extract<MemoryUse, { reported: true }>> = {}): MemoryUse {
  return {
    reported: true,
    limitBytes: LIMIT,
    currentBytes: LIMIT,
    peakBytes: LIMIT,
    anonBytes: LIMIT - headroom,
    at: REPORTED_AT,
    stopped: false,
    ...overrides
  };
}

const CHANGE_FORM = "Change the size of your assistant";

function size(overrides: Partial<AssistantMemory> = {}, save: FormAction = vi.fn(async () => ({ ok: true as const, confirmation: "done" }))): AssistantSize {
  return {
    view: {
      use: use(4 * CONVERSATION_MEMORY_BYTES),
      size: "small",
      // A pod reporting the cap of the size it is on, which is the ordinary case; the tests that care pass their own.
      capacity: { now: 4, fromRestart: undefined },
      openChats: 1,
      rollsPod: true,
      refusal: undefined,
      ...overrides
    },
    assistantId: "0f8a6a1e-0000-4000-8000-0000000000aa",
    save
  };
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Size" });
}

describe("the Assistant's size", () => {
  it("should show nothing at all when the page passes no size", () => {
    open({ files: files(), size: undefined });

    expect(sections()).not.toContain("Size");
    expect(screen.queryByRole("heading", { name: "Size" })).toBeNull();
  });

  it("should offer Size under Agent, after the tools, when the page passes it", () => {
    open(everything());

    expect(sections()).toEqual(["Appearance", "Connections", "Templates", "Model", "Claude.md", "Tools", "Size", "Files"]);
  });

  // The figures a person reads, not a read-back of the constants they come from.
  it("should say the size it is on with what that size gives", () => {
    open({ size: size() }, "Size");

    expect(panel().textContent).toContain("You are on small: 4 chats at once, 4Gi–8Gi of memory.");
    expect(panel().textContent).not.toContain("from its next restart");
  });

  // The figure the pod enforces, not the size's cap. A cap is in the pod template, so a deploy that raises it leaves
  // every running pod on the old one, and at its cap the pod stops an idle session to make room rather than queueing
  // — so offering the higher figure here would invite someone to end a chat they never closed.
  it("should say what the pod runs now, and what a restart would change it to, when it is behind its size's cap", () => {
    open({ size: size({ capacity: { now: 3, fromRestart: 4 } }) }, "Size");

    expect(panel().textContent).toContain("You are on small: 3 chats at once, 4Gi–8Gi of memory. It holds 4 chats at once from its next restart.");
  });

  // A pod that has not reported gets no current figure at all: the cap is what it will be given, not what it has.
  it("should claim no current figure, and name the cap a restart gives, when the pod has reported nothing", () => {
    open({ size: size({ capacity: { now: undefined, fromRestart: 4 } }) }, "Size");

    expect(panel().textContent).toContain("You are on small, with 4Gi–8Gi of memory. It holds 4 chats at once from its next restart.");
    // The dropdown still describes each size's cap, which is what a change would give; nothing says the pod's own.
    expect(panel().textContent).not.toContain("You are on small:");
  });

  // The peak leads because it is the fuller account of what the pod has had to hold; the figure beside it is the part
  // that cannot be reclaimed, which is what the warning is computed from and what a chat adds to.
  it("should give the peak against the limit, what it is holding of that, and when the pod last looked", () => {
    open({ size: size({ use: use(4 * CONVERSATION_MEMORY_BYTES) }) }, "Size");

    expect(panel().textContent).toContain("8 GB of 8 GB at its busiest");
    expect(panel().textContent).toContain("Holding 5.4 GB right now");
    expect(panel().textContent).toContain("Last reported");
  });

  // The sentence used to carry its own number, which left it telling someone a chat costs one thing while the
  // warning was computed from another. In gigabytes to two places, not `describeSize`'s tenth of a megabyte, which
  // would claim a precision the one measurement behind the figure cannot support.
  it("should say what a chat costs from the same figure the warning uses when the pod has reported", () => {
    open({ size: size({ use: use(4 * CONVERSATION_MEMORY_BYTES) }) }, "Size");

    expect(panel().textContent).toContain("about 0.65 GB of it for each chat open.");
  });

  it("should say the figures will not move while the assistant is stopped", () => {
    open({ size: size({ use: use(4 * CONVERSATION_MEMORY_BYTES, { stopped: true }) }) }, "Size");

    expect(panel().textContent).toContain("Your assistant is stopped. Last reported");
  });

  // The section must not say "4 chats at once" in the same breath as "Your assistant is stopped", which is what
  // `chatCapacity` giving a stopped pod no `now` is for.
  it("should claim no current chats beside the sentence saying the assistant is stopped", () => {
    const stopped = { use: use(4 * CONVERSATION_MEMORY_BYTES, { stopped: true }), capacity: { now: undefined, fromRestart: 4 } };
    open({ size: size(stopped) }, "Size");

    expect(panel().textContent).toContain("Your assistant is stopped. Last reported");
    expect(panel().textContent).toContain("You are on small, with 4Gi–8Gi of memory. It holds 4 chats at once from its next restart.");
    expect(panel().textContent).not.toContain("You are on small:");
  });

  // Zero would read as an idle pod, which is the one thing the section must never say when it cannot tell.
  it.each([
    ["older_client", "running an older version that cannot tell us how much memory it is using"],
    ["not_running", "stopped, so there is nothing using memory and nothing to report"],
    ["waiting", "has not reported its memory yet"]
  ] as const)("should say it cannot tell, rather than show a figure, when the reason is %s", (reason, said) => {
    open({ size: size({ use: { reported: false, reason } }) }, "Size");

    expect(panel().textContent).toContain(said);
    expect(panel().textContent).not.toContain("at its busiest");
  });

  it.each(["older_client", "not_running", "waiting"] as const)("should raise no warning when it cannot tell (%s)", (reason) => {
    open({ size: size({ use: { reported: false, reason } }) }, "Size");

    expect(panel().textContent).not.toContain("low on memory");
    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  // The threshold: exactly one conversation's worth of headroom still has room for the chat about to be opened.
  it("should raise no warning when what it cannot reclaim leaves room for exactly one more chat", () => {
    open({ size: size({ use: use(CONVERSATION_MEMORY_BYTES) }) }, "Size");

    expect(panel().textContent).not.toContain("low on memory");
  });

  it("should warn, and name the size to move to, when what it cannot reclaim leaves a byte less than one more chat", () => {
    open({ size: size({ use: use(CONVERSATION_MEMORY_BYTES - 1), openChats: 3 }) }, "Size");

    expect(panel().textContent).toContain("Your assistant is low on memory");
    expect(panel().textContent).toContain("Move up to medium below for 8Gi–16Gi of memory and 6 chats at once. Closing a chat frees about 0.65 GB of it.");
  });

  // A pod's chats cannot reach this threshold, so closing one is given as a quantity and never as the remedy.
  it("should not tell the person to close a chat when it warns", () => {
    open({ size: size({ use: use(0), openChats: 1 }) }, "Size");

    expect(panel().textContent).toContain("Move up to medium below");
    expect(panel().textContent).not.toContain("close a chat you have finished with");
  });

  it("should offer no bigger size on the largest size there is when a chat is open", () => {
    open({ size: size({ use: use(0), size: "large", openChats: 3 }) }, "Size");

    expect(panel().textContent).toContain("This is the largest size there is. Closing a chat frees about 0.65 GB of it.");
    expect(panel().textContent).not.toContain("Move up to");
  });

  // With nothing open, what closing a chat would free is a fact about nothing.
  it("should leave the per-chat figure out on the largest size when no chat is open", () => {
    open({ size: size({ use: use(0), size: "large", openChats: 0 }) }, "Size");

    expect(panel().textContent).toContain("Your assistant is low on memory");
    expect(panel().textContent).not.toContain("Closing a chat");
    expect(panel().textContent).not.toContain("Move up to");
  });

  // One mark on the cog, however many reasons: a second badge beside the sign-ins one would be two things competing
  // to be noticed and neither read.
  it("should carry its warning on the one settings cog, naming both reasons when a sign-in needs attention too", () => {
    render(<AssistantSettings now={Date.now()} connections={data(["azure", "claude", "atlassian"])} size={size({ use: use(0) })} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub needs your attention. Your assistant is low on memory");
    expect(cog().textContent).toBe("!");
  });

  it("should carry its warning alone when every sign-in is connected", () => {
    render(<AssistantSettings now={Date.now()} connections={data(ALL_SIGNED_IN)} size={size({ use: use(0) })} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. Your assistant is low on memory");
  });

  it("should offer every size with its chats and memory, and start on the one it is", () => {
    open({ size: size() }, "Size");
    const select = screen.getByLabelText("Choose a size") as HTMLSelectElement;

    expect([...select.options].map((option) => option.textContent)).toEqual([
      "small — 4 chats at once, 4Gi–8Gi of memory",
      "medium — 6 chats at once, 8Gi–16Gi of memory",
      "large — 8 chats at once, 16Gi–32Gi of memory"
    ]);
    expect(select.value).toBe("small");
    expect(panel().textContent).toContain("This is the size you are on.");
  });

  // A change restarts the pod, so what it ends is said before the person commits, not after.
  it("should post nothing, and say what a change ends, until the person confirms", () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "done" }));
    open({ size: size({ openChats: 3 }, save) }, "Size");

    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Change to medium? Your assistant restarts, which stops all 3 chats you have open.")).toBeTruthy();
    expect(panel().textContent).toContain("Only what one of them was working on at the moment you change is lost");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change size and restart" }));
  });

  it.each([
    [1, "the one chat you have open"],
    [0, "whatever it is working on"]
  ])("should count the chats a change ends when %i are open", (openChats, said) => {
    open({ size: size({ openChats }) }, "Size");

    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "large" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to large" }));

    expect(screen.getByText(`Change to large? Your assistant restarts, which stops ${said}.`)).toBeTruthy();
  });

  it("should promise the new size at the next start, and not a restart, when no pod is up", () => {
    open({ size: size({ rollsPod: false }) }, "Size");

    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    expect(screen.getByText("Change to medium? Your assistant starts at the new size the next time you use it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change size" })).toBeTruthy();
  });

  it("should send the assistant's id and the size chosen when the person confirms", async () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "Restarting at medium." }));
    open({ size: size({}, save) }, "Size");
    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    await submit(CHANGE_FORM);

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("size")]).toEqual(["0f8a6a1e-0000-4000-8000-0000000000aa", "medium"]);
    expect(screen.getByRole("status").textContent).toBe("Restarting at medium.");
  });

  it("should put the question away, having posted nothing, when the person cancels", () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "done" }));
    open({ size: size({}, save) }, "Size");
    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Change to medium" })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  // A different size is a different question, so an answer already on the screen stops being the one asked.
  it("should take the question back when the person changes the size they are asking about", () => {
    open({ size: size() }, "Size");
    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "large" } });

    expect(screen.queryByRole("button", { name: "Change size and restart" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change to large" })).toBeTruthy();
  });

  it("should show the action's own refusal, rather than deciding for itself, when a change is refused", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: "that virtual agent is being deleted" }));
    open({ size: size({}, save) }, "Size");
    fireEvent.change(screen.getByLabelText("Choose a size"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Change to medium" }));

    await submit(CHANGE_FORM);

    expect(screen.getByRole("alert").textContent).toBe("that virtual agent is being deleted");
  });

  it("should say why, and offer no form, when the size cannot be changed at all", () => {
    open({ size: size({ refusal: "that virtual agent is being deleted" }) }, "Size");

    expect(panel().textContent).toContain("The size cannot be changed just now: that virtual agent is being deleted.");
    expect(screen.queryByRole("form", { name: CHANGE_FORM })).toBeNull();
  });

  it("should keep its own controls in the dialog's focus trap when it is open", () => {
    open({ size: size() }, "Size");
    const items = stops();

    expect(items).toContain(screen.getByLabelText("Choose a size"));
    expect(items.at(-1)).toBe(screen.getByLabelText("Choose a size"));
  });

  it("should raise no WCAG A or AA violations with Size open", async () => {
    await auditOpenDialog("Size");
  }, 20_000);
});
