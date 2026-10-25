/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import type { AssistantClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import { type AssistantPlugins, AssistantSettings, FOCUSABLE } from "@/components/assistant/SettingsDialog";
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
 * The dialog's own focusable controls, in tab order: its close button, the appearance choices, then any others. It
 * asks the dialog which they are, so a control the trap has been left out of is a control missing here too.
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

async function submit(name: string): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name }));
  });
}

describe("the Assistant's CLAUDE.md", () => {
  it("should show nothing at all when the page passes no CLAUDE.md", () => {
    open({ claudeMd: undefined });

    expect(screen.queryByRole("heading", { name: "Your CLAUDE.md" })).toBeNull();
    expect(screen.queryByRole("form", { name: SAVE_FORM })).toBeNull();
  });

  it("should still offer the appearance, the connections and the team tools beside it when it is shown", () => {
    open({ claudeMd: claudeMd(), plugins: plugins() });

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    expect(screen.getByRole("form", { name: FORM })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your CLAUDE.md" })).toBeTruthy();
  });

  // Every pod writes the file before each start of Claude, so a chat that is already running keeps what it started
  // with. People read a settings dialog as being about the chat they opened it from, which is the misunderstanding
  // this wording is here to stop.
  it("should say the notes are used by all of their chats, and when a change reaches one, whenever it is shown", () => {
    open({ claudeMd: claudeMd() });

    const section = screen.getByRole("region", { name: "Your CLAUDE.md" });
    expect(section.textContent).toContain("They apply to all of your chats, not only this one.");
    expect(section.textContent).toContain("A chat picks up a change when its session next starts, so a chat already running keeps the notes it started with.");
  });

  it("should fill the editor with the default and say none of theirs is stored when the person has saved none", () => {
    open({ claudeMd: claudeMd() });

    expect(notes().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByText("This is the default. Nothing of yours is stored yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: RESET_FORM })).toBeNull();
  });

  it("should fill the editor with their own text, and say when it was saved, when one is stored", () => {
    open({ claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me\n\nI work on PCS.", updatedAt: "2026-10-05T09:00:00.000Z" } }) });

    expect(notes().value).toBe("# Me\n\nI work on PCS.");
    expect(screen.queryByText("This is the default. Nothing of yours is stored yet.")).toBeNull();
    expect(screen.getByRole("form", { name: RESET_FORM })).toBeTruthy();
  });

  it("should send the edited text to the save action, and confirm it, when the person saves", async () => {
    const save = saved(SAVED);
    open({ claudeMd: claudeMd({ save }) });

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
    open({ claudeMd: claudeMd({ save }) });

    await submit(SAVE_FORM);

    expect(screen.getByRole("alert").textContent).toBe(refused);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should put the default back in the editor, and confirm it, when the person resets a stored one", async () => {
    const reset = saved(RESET);
    open({ claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me\n\nI work on PCS.", updatedAt: null }, reset }) });

    await submit(RESET_FORM);

    expect(reset).toHaveBeenCalled();
    expect(notes().value).toBe(DEFAULT_CLAUDE_MD);
    expect(screen.getByRole("status").textContent).toBe(RESET);
  });

  it("should count the text against the store's own limit, and mark the field invalid, when there is too much of it", () => {
    open({ claudeMd: claudeMd() });

    fireEvent.change(notes(), { target: { value: "a".repeat(MAX_CLAUDE_MD_CHARACTERS + 5) } });

    expect(screen.getByText("20,005 of 20,000 characters: 5 too many")).toBeTruthy();
    expect(notes().getAttribute("aria-invalid")).toBe("true");
  });

  it("should count what the person has written, and not mark it invalid, while it is within the limit", () => {
    open({ claudeMd: claudeMd() });

    fireEvent.change(notes(), { target: { value: "🚀🚀" } });

    expect(screen.getByText("2 of 20,000 characters")).toBeTruthy();
    expect(notes().getAttribute("aria-invalid")).toBe("false");
  });

  it("should say why, rather than show an editor, when the hub cannot read the person's CLAUDE.md", () => {
    open({ claudeMd: claudeMd({ settings: { available: false, reason: "the credentials Key Vault is not configured" } }) });

    expect(screen.getByText(/the credentials Key Vault is not configured/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: SAVE_FORM })).toBeNull();
  });

  it("should describe the editor to a screen reader by its label, how it stands and its count, when it is shown", () => {
    open({ claudeMd: claudeMd() });
    const described = (notes().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);

    expect(described).toEqual(["This is the default. Nothing of yours is stored yet.", `${DEFAULT_CLAUDE_MD.length} of 20,000 characters`]);
  });

  // A markdown editor is a textarea, which the trap's list of tab stops has to name: one left out of it is a control
  // Tab can reach and the wrap cannot account for, and the dialog is modal.
  it("should keep its editor and its buttons among the dialog's own tab stops when it is open", () => {
    open({ claudeMd: claudeMd({ settings: { available: true, stored: true, text: "# Me", updatedAt: null } }) });
    const items = stops();

    expect(items).toContain(notes());
    expect(items.at(-1)).toBe(screen.getByRole("button", { name: "Reset to the default" }));
  });

  it("should wrap focus from its last control back to the start of the dialog when the person tabs off the end", () => {
    open({ claudeMd: claudeMd() });
    const items = stops();
    items.at(-1)?.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(items.at(-1)).toBe(screen.getByRole("button", { name: SAVE_FORM }));
    expect(document.activeElement).toBe(items[0]);
  });
});
