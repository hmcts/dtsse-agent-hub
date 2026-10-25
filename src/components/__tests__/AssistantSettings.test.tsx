/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import { MAX_TEMPLATE_BODY, MAX_TEMPLATES, type SavedTemplate, TEMPLATES_FULL } from "@/assistant/templates";
import { type AssistantPlugins, AssistantSettings, FOCUSABLE } from "@/components/assistant/SettingsDialog";
import type { AssistantTemplates } from "@/components/assistant/TemplateSettings";
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

function open(props: Partial<Parameters<typeof AssistantSettings>[0]> = {}): void {
  render(<AssistantSettings connections={data(ALL_SIGNED_IN)} {...props} />);
  fireEvent.click(cog());
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
 * The dialog's own focusable controls, in tab order: its close button, the appearance choices, then any others. Asked
 * for with the dialog's own `FOCUSABLE`, so a section adding a kind of control the focus trap does not know about
 * fails here rather than passing against a second copy of the list.
 */
function stops(): HTMLElement[] {
  return [...screen.getByRole("dialog").querySelectorAll<HTMLElement>(FOCUSABLE)];
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

  it("should move focus into the dialog when it opens", () => {
    open();

    expect(document.activeElement).toBe(stops()[0]);
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
    document.body.focus();

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
    const rows = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");

    expect(rows).toHaveLength(KINDS.length);
    expect(screen.getByRole("list", { name: "Connections" }).textContent).not.toContain("CLAUDE.md");
  });

  it("should say why it cannot list the sign-ins, rather than show none, when the hub cannot read them", () => {
    render(<AssistantSettings connections={{ kinds: KINDS, statuses: [], logins: [], unavailable: "the credentials Key Vault is not configured" }} />);

    fireEvent.click(cog());

    expect(screen.getByText("the credentials Key Vault is not configured")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });

  it("should offer the appearance alone when it has no sign-ins to list", () => {
    open({ connections: undefined });

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });

  it("should explain what a person should do, without saying the assistant is broken, when a sign-in needs attention", () => {
    open({ connections: data(["azure", "bedrock", "atlassian"]) });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("GitHub needs your attention")).toBeTruthy();
    expect(within(dialog).getByText(/You can carry on chatting/)).toBeTruthy();
  });

  it("should show no warning inside the dialog when every sign-in it prompts about is connected", () => {
    open();

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
  it("should show nothing at all when the hub offers none and the assistant loads none", () => {
    open({ plugins: plugins({ available: [] }) });

    expect(screen.queryByRole("form", { name: FORM })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Team tools" })).toBeNull();
  });

  // `assistantPluginsData` gives nothing when `VIRTUAL_AGENT_PLUGINS` is malformed, rather than an empty list: the
  // hub cannot then tell which of the person's plugins it still offers, so a section would mislabel every one of them.
  // The rest of the dialog still renders, because the Assistant is someone's whole chat surface.
  it("should show nothing at all when the page passes no plugins", () => {
    open({ plugins: undefined });

    expect(screen.queryByRole("heading", { name: "Team tools" })).toBeNull();
    expect(screen.queryByText(/No longer offered/)).toBeNull();
  });

  it("should still offer the appearance and the connections when there are no team tools to show", () => {
    open({ plugins: undefined });

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should describe each tool in the hub's own words, with its name underneath, when it opens", () => {
    open({ plugins: plugins() });
    const items = within(screen.getByRole("form", { name: FORM })).getAllByRole("listitem");

    expect(items.map((item) => item.textContent)).toEqual(["PCS team workflowspcs", "dtsse"]);
  });

  it("should tick the tools the assistant already loads when it opens", () => {
    open({ plugins: plugins({ checked: ["pcs"] }) });

    expect((screen.getByRole("checkbox", { name: /pcs/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /dtsse/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("should say a save restarts the assistant and keeps the chats when its pod is up", () => {
    open({ plugins: plugins() });

    expect(screen.getByText(/Saving restarts your assistant; your chats are kept\./)).toBeTruthy();
  });

  it("should say the assistant picks them up at its next start when its pod is not up", () => {
    open({ plugins: plugins({ podRunning: false }) });

    expect(screen.getByText(/Your assistant loads them the next time it starts\./)).toBeTruthy();
    expect(screen.queryByText(/Saving restarts/)).toBeNull();
  });

  it("should send the assistant's own id and the newly ticked names to the hub's plugins action when saved", async () => {
    const save = ok();
    open({ plugins: plugins({ checked: ["pcs"], save }) });

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
    open({ plugins: plugins({ checked: ["pcs"], save }) });

    fireEvent.click(screen.getByRole("checkbox", { name: /pcs/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: FORM }));
    });

    expect((save.mock.calls[0] as unknown as [FormData])[0].getAll("plugins")).toEqual([]);
  });

  it("should keep a ticked tool the hub no longer offers, so the person can untick it", () => {
    open({ plugins: plugins({ checked: ["civil", "pcs"] }) });

    expect((screen.getByRole("checkbox", { name: /civil/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("No longer offered. Untick it to stop using it.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).value)).toEqual(["pcs", "dtsse", "civil"]);
  });

  it("should keep its own tools in the dialog's focus trap when it is open", () => {
    open({ plugins: plugins() });
    const items = stops();

    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Save team tools" }));
  });
});

function saved(name: string, text = `${name} prompt`): SavedTemplate {
  return { id: `t-${name.toLowerCase()}`, name, text };
}

function saveOk() {
  return vi.fn(async () => ({ ok: true as const, id: "t-new", confirmation: `"Stand-up" is saved, and is in the + menu of every chat` }));
}

function templates(overrides: Partial<AssistantTemplates> = {}): AssistantTemplates {
  return { mine: [], save: saveOk(), remove: vi.fn(async () => ({ ok: true as const, confirmation: "Your template is deleted" })), ...overrides };
}

const ADD = "Save a new template";

function submit(form: string): Promise<void> {
  return act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: form }));
  });
}

describe("the Assistant's own templates", () => {
  it("should show nothing at all when the page passes no templates", () => {
    open({ templates: undefined });

    expect(screen.queryByRole("heading", { name: "Your templates" })).toBeNull();
    expect(screen.queryByRole("form", { name: ADD })).toBeNull();
  });

  it("should still offer the appearance and the connections when the templates section is not shown", () => {
    open({ templates: undefined });

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should say the person has saved none, and still offer the form, when their list is empty", () => {
    open({ templates: templates() });

    expect(screen.getByText("You have not saved any yet.")).toBeTruthy();
    expect(screen.getByRole("form", { name: ADD })).toBeTruthy();
  });

  it("should list each saved template with its prompt when it opens", () => {
    open({ templates: templates({ mine: [saved("Stand-up"), saved("Retro")] }) });
    const rows = within(screen.getByRole("list", { name: "Your templates" })).getAllByRole("listitem");

    expect(rows.map((row) => row.textContent)).toEqual(["Stand-upStand-up promptEditDelete", "RetroRetro promptEditDelete"]);
  });

  it("should send the name and the prompt, and no id, to the save action when the person adds one", async () => {
    const save = saveOk();
    open({ templates: templates({ save }) });

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: " Stand-up " } });
    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "What I did yesterday:" } });
    await submit(ADD);

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("name"), sent.get("body")]).toEqual([null, " Stand-up ", "What I did yesterday:"]);
    expect(screen.getByRole("status").textContent).toContain("is in the + menu of every chat");
  });

  it("should open the form on a template, and send its id, when the person edits one", async () => {
    const save = saveOk();
    open({ templates: templates({ mine: [saved("Stand-up")], save }) });

    fireEvent.click(screen.getByRole("button", { name: "Edit Stand-up" }));
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("Stand-up");
    expect((screen.getByLabelText("What it fills the message box with") as HTMLTextAreaElement).value).toBe("Stand-up prompt");
    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "Changed" } });
    await submit("Save your changes to Stand-up");

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("name"), sent.get("body")]).toEqual(["t-stand-up", "Stand-up", "Changed"]);
  });

  it("should go back to adding, with the fields empty, when the person cancels an edit", () => {
    open({ templates: templates({ mine: [saved("Stand-up")] }) });

    fireEvent.click(screen.getByRole("button", { name: "Edit Stand-up" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("form", { name: ADD })).toBeTruthy();
    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
  });

  it("should empty the fields after a save, so the next template is not written over the last one", async () => {
    open({ templates: templates() });

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Stand-up" } });
    await submit(ADD);

    expect((screen.getByLabelText("Template name") as HTMLInputElement).value).toBe("");
  });

  it("should send the template's id to the delete action when the person deletes one", async () => {
    const remove = vi.fn(async () => ({ ok: true as const, confirmation: "Your template is deleted" }));
    open({ templates: templates({ mine: [saved("Stand-up"), saved("Retro")], remove }) });

    await submit("Delete Retro");

    expect((remove.mock.calls[0] as unknown as [FormData])[0].get("id")).toBe("t-retro");
  });

  it("should show the save action's own refusal, rather than deciding for itself, when it refuses", async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: `you already have a template called "Stand-up"` }));
    open({ templates: templates({ save }) });

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Stand-up" } });
    await submit(ADD);

    expect(screen.getByRole("alert").textContent).toBe(`you already have a template called "Stand-up"`);
  });

  it("should count what the person has against the cap when it opens", () => {
    open({ templates: templates({ mine: [saved("Stand-up")] }) });

    expect(screen.getByText(`1 of ${MAX_TEMPLATES} templates`)).toBeTruthy();
  });

  // The cap is refused in the store's own sentence, so what is read here is what a POST skipping this screen is told.
  it("should refuse another in the store's own words, and offer no form, when the person is at the cap", () => {
    const mine = Array.from({ length: MAX_TEMPLATES }, (_, index) => saved(`Template ${index}`));
    open({ templates: templates({ mine }) });

    expect(screen.getByText(TEMPLATES_FULL)).toBeTruthy();
    expect(screen.queryByRole("form", { name: ADD })).toBeNull();
  });

  it("should still let the person change one of the ones they have when they are at the cap", () => {
    const mine = Array.from({ length: MAX_TEMPLATES }, (_, index) => saved(`Template ${index}`));
    open({ templates: templates({ mine }) });

    fireEvent.click(screen.getByRole("button", { name: "Edit Template 3" }));

    expect(screen.getByRole("form", { name: "Save your changes to Template 3" })).toBeTruthy();
    expect(screen.queryByText(TEMPLATES_FULL)).toBeNull();
  });

  it("should say how far over the cap a prompt is, in the same count the store checks, while the person types", () => {
    open({ templates: templates() });

    fireEvent.change(screen.getByLabelText("What it fills the message box with"), { target: { value: "x".repeat(MAX_TEMPLATE_BODY + 5) } });

    expect(screen.getByText(/4,005 of 4,000 characters: 5 too many/)).toBeTruthy();
    expect(screen.getByLabelText("What it fills the message box with").getAttribute("aria-invalid")).toBe("true");
  });

  it("should say the templates sit above the built-in ones, which the + menu cannot show, when it opens", () => {
    open({ templates: templates() });

    expect(screen.getByText(/above the built-in templates/)).toBeTruthy();
  });

  it("should keep its own fields in the dialog's focus trap when it is open", () => {
    open({ templates: templates({ mine: [saved("Stand-up")] }) });
    const items = stops();

    expect(items).toContain(screen.getByLabelText("What it fills the message box with"));
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Save template" }));
  });

  // Two rows of Edit and Delete say which template they belong to, so a screen reader is not read four of one name.
  it("should name the Edit and Delete of each row after its own template when it opens", () => {
    open({ templates: templates({ mine: [saved("Stand-up"), saved("Retro")] }) });
    const section = screen.getByRole("list", { name: "Your templates" });

    expect(
      within(section)
        .getAllByRole("button")
        .map((control) => control.getAttribute("aria-label"))
    ).toEqual(["Edit Stand-up", "Delete Stand-up", "Edit Retro", "Delete Retro"]);
  });
});
