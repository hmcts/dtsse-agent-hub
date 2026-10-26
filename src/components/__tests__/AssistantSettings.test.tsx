/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import { MAX_TEMPLATE_BODY, MAX_TEMPLATES, type SavedTemplate, TEMPLATES_FULL } from "@/assistant/templates";
import type { AssistantClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import { type AssistantPlugins, AssistantSettings, FOCUSABLE } from "@/components/assistant/SettingsDialog";
import type { AssistantTemplates } from "@/components/assistant/TemplateSettings";
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

const KINDS: CredentialKind[] = ["github", "azure", "bedrock", "jenkins", "atlassian"];
const ALL_SIGNED_IN: CredentialKind[] = ["github", "azure", "bedrock", "atlassian"];

function status(kind: CredentialKind, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored: true, accountLabel, updatedAt: "2026-10-24T09:00:00.000Z", updatedVia: "pod" };
}

function login(kind: CredentialKind, state: LoginState, expiresAt = new Date(Date.now() + 600_000).toISOString()): LoginView {
  return { kind, prompt: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresAt, state, codeWaiting: false };
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
  render(<AssistantSettings connections={data(ALL_SIGNED_IN)} {...props} />);
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
  render(<AssistantSettings connections={data(ALL_SIGNED_IN)} {...props} />, { container: root });
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
    render(<AssistantSettings connections={data(ALL_SIGNED_IN)} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it.each([
    ["github", "GitHub needs your attention"],
    ["azure", "Azure needs your attention"]
  ] as const)("should warn that %s needs attention when it alone is not connected", (missing, warning) => {
    render(<AssistantSettings connections={data(ALL_SIGNED_IN.filter((kind) => kind !== missing))} />);

    expect(cog().getAttribute("aria-label")).toBe(`Settings. ${warning}`);
  });

  it("should name all three when the needed sign-ins are missing and the optional one has lapsed", () => {
    render(<AssistantSettings connections={data(["bedrock"], [login("atlassian", "expired")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub, Azure and Atlassian need your attention");
  });

  it("should not nag about Atlassian when the person has simply never set it up", () => {
    render(<AssistantSettings connections={data(["github", "azure", "bedrock"])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it.each(["expired", "failed"] as const)("should warn about Atlassian once its sign-in has %s", (state) => {
    render(<AssistantSettings connections={data(["github", "azure", "bedrock"], [login("atlassian", state)])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. Atlassian needs your attention");
  });

  it("should not say a sign-in needs attention while it is only being refreshed behind a working one", () => {
    render(<AssistantSettings connections={data(ALL_SIGNED_IN, [login("github", "pending")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should mark the cog with a visible exclamation, not colour alone, when a sign-in needs attention", () => {
    render(<AssistantSettings connections={data(["azure", "bedrock", "atlassian"])} />);

    expect(cog().textContent).toBe("!");
  });

  it("should warn when a sign-in is still waiting for the person", () => {
    render(<AssistantSettings connections={data(["azure", "bedrock", "atlassian"], [login("github", "pending")])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings. GitHub needs your attention");
  });

  it("should not warn when only model access and a Jenkins token are missing", () => {
    render(<AssistantSettings connections={data(["github", "azure", "atlassian"])} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  it("should not warn when it has no sign-ins to report on", () => {
    render(<AssistantSettings />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
  });

  it("should not warn when the hub cannot read the person's credentials, since nobody could act on it", () => {
    render(<AssistantSettings connections={data([], [], "the credentials Key Vault is not configured")} />);

    expect(cog().getAttribute("aria-label")).toBe("Settings");
    expect(cog().textContent).toBe("");
  });

  it("should show no dialog until the person opens it", () => {
    render(<AssistantSettings connections={data(ALL_SIGNED_IN)} />);

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
        connections={{
          kinds: KINDS,
          statuses: [status("github", "alice@hmcts.net"), status("bedrock")],
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
      "AzAzureYour HMCTS account, for pipelines and environmentsWaiting for you",
      "AIAI model accessYour Amazon Bedrock API keyConnected",
      "JJenkinsBuilds and pipelines on Jenkins (optional)Last sign-in failed",
      "AAtlassianJira tickets and Confluence pages (optional)Sign-in expired"
    ]);
  });

  it("should never list a CLAUDE.md or a git identity as a connection when they are among the kinds", () => {
    render(<AssistantSettings connections={{ kinds: [...KINDS, "claude_md", "git_identity"], statuses: [], logins: [], unavailable: null }} />);
    fireEvent.click(cog());
    go("Connections");
    const rows = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");

    expect(rows).toHaveLength(KINDS.length);
    expect(screen.getByRole("list", { name: "Connections" }).textContent).not.toContain("CLAUDE.md");
  });

  it("should say why it cannot list the sign-ins, rather than show none, when the hub cannot read them", () => {
    render(<AssistantSettings connections={{ kinds: KINDS, statuses: [], logins: [], unavailable: "the credentials Key Vault is not configured" }} />);

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
    open({ connections: data(["azure", "bedrock", "atlassian"]) }, "Connections");
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
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Save template" }));
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

    expect(sections()).toEqual(["Appearance", "Claude.md", "Tools", "Connections", "Templates"]);
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    go("Connections");
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    for (const [section, form, last] of [
      ["Tools", "Change your assistant's team tools", "Save team tools"],
      ["Claude.md", "Save your CLAUDE.md", "Save your CLAUDE.md"],
      ["Templates", "Save a new template", "Save template"]
    ] as const) {
      go(section);
      const items = stops();
      expect(items).toContain(screen.getByRole("form", { name: form }).querySelector("button[type='submit']"));
      expect(items.at(-1)).toBe(screen.getByRole("button", { name: last }));
    }
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

    expect(sections()).toEqual(["Appearance", "Claude.md", "Tools", "Connections"]);
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
  return { plugins: plugins(), claudeMd: claudeMd(), templates: templates({ mine: [row("Stand-up")] }) };
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
function narrow(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  });
}

function wideAgain(): void {
  Reflect.deleteProperty(window, "matchMedia");
}

describe("the Assistant's settings navigation", () => {
  afterEach(wideAgain);

  it("should gather the sections under the headings they belong to when it opens", () => {
    open(everything());

    expect(sections()).toEqual(["Appearance", "Claude.md", "Tools", "Connections", "Templates"]);
    expect(nav().textContent).toBe("GeneralAppearanceAgentClaude.mdToolsConnectionsTemplates");
  });

  // A tablist owns tabs and nothing else, so the two group headings are shown rather than announced, and the panel's
  // own heading is what says in full what a short label like "Tools" stands for.
  it("should keep its group headings out of what a screen reader is read when it opens", () => {
    open(everything());

    expect(within(nav()).getAllByRole("tab")).toHaveLength(5);
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
    ["ArrowDown", "Claude.md"],
    ["End", "Templates"]
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
    tabs()[4]?.focus();

    fireEvent.keyDown(tabs()[4]!, { key: "ArrowDown" });

    expect(document.activeElement?.textContent).toBe("Appearance");
  });

  it("should wrap from the first section to the last when the person arrows off the start", () => {
    open(everything());

    fireEvent.keyDown(tabs()[0]!, { key: "ArrowUp" });

    expect(document.activeElement?.textContent).toBe("Templates");
  });

  // Every panel here is a form. Opening whichever section the arrows reach would throw away half-typed notes on the
  // way past, so arrows move focus and Enter or Space is what opens one.
  it("should leave the open section alone, until the person presses Enter, while they arrow past it", () => {
    open(everything());

    fireEvent.keyDown(tabs()[0]!, { key: "ArrowDown" });

    expect(selected()).toBe("Appearance");
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();

    fireEvent.click(document.activeElement as HTMLElement);

    expect(selected()).toBe("Claude.md");
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
    ).toEqual(["Appearance", "Claude.md", "Tools", "Connections", "Templates"]);
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
 * An axe audit of the dialog itself, which has none anywhere else: the Assistant's end-to-end audit covers only the
 * new-chat and getting-ready screens, because every other surface needs a pod and the dialog's cog is underneath the
 * getting-ready screen until one is running. Run here it costs a render, and it is the check that the navigation's
 * tablist, its panel and the group headings hold together rather than only looking as though they do.
 *
 * Colour is not audited here — jsdom has no layout and no computed colour — so contrast stays the end-to-end run's.
 */
async function auditOpenDialog(section?: string): Promise<void> {
  const root = document.createElement("div");
  root.className = "asst-theme";
  root.dataset.theme = "dark";
  document.body.append(root);
  render(<AssistantSettings connections={data(ALL_SIGNED_IN)} {...everything()} />, { container: root });
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
