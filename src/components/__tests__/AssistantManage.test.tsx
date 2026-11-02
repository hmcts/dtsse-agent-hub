/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import type { FormAction } from "@/components/ActionForm";
import type { AssistantAgentSettings } from "@/components/assistant/AgentSettings";
import type { AssistantGitIdentity } from "@/components/assistant/GitIdentitySettings";
import { AssistantSettings } from "@/components/assistant/SettingsDialog";
import type { AssistantTokens } from "@/components/assistant/TokenSettings";
import type { CredentialKind } from "@/credentials/names";
import type { AssistantAgent } from "@/web/data";

/** The sections of the Assistant's settings that manage the virtual agent it runs on, and the person's own values. */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/assistant" }));
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const ID = "0f8a6a1e-0000-4000-8000-000000000001";
const VPN_3000 = "https://va-0f8a6a1e-3000.preview.platform.hmcts.net";
const VIEWER_3000 = `https://agent-hub-viewer.example/${ID}/3000/`;

function connections(stored: CredentialKind[], kinds: CredentialKind[] = ["github", "claude", "jenkins"]): ConnectionsData {
  return {
    route: "own-licence",
    kinds,
    statuses: stored.map((kind) => ({ kind, stored: true, accountLabel: null, updatedAt: "2026-10-24T09:00:00.000Z", updatedVia: "web" })),
    logins: [],
    unavailable: null
  };
}

function ok(confirmation?: string) {
  return vi.fn<FormAction>(async () => ({ ok: true as const, ...(confirmation === undefined ? {} : { confirmation }) }));
}

function agent(overrides: Partial<AssistantAgent> = {}): AssistantAgent {
  return { id: ID, name: "assistant", desired: "running", status: "running", statusDetail: null, exposedPorts: [], localOnlyPorts: [], ...overrides };
}

function agentSettings(overrides: Partial<AssistantAgent> = {}, actions: Partial<Omit<AssistantAgentSettings, "agent">> = {}): AssistantAgentSettings {
  return { agent: agent(overrides), rename: ok("Renamed"), restart: ok("Restarting. Your chats are kept."), ...actions };
}

function git(stored = false, actions: Partial<Omit<AssistantGitIdentity, "settings">> = {}): AssistantGitIdentity {
  return {
    settings: { available: true, stored, identity: stored ? { name: "Alice Example", email: "alice@example.com" } : {} },
    save: ok("Your git identity is saved"),
    clear: ok(),
    ...actions
  };
}

function tokens(actions: Partial<AssistantTokens> = {}): AssistantTokens {
  return { save: ok("Your Jenkins API token is stored"), remove: ok(), ...actions };
}

function nav(): HTMLElement {
  return screen.getByRole("tablist", { name: "Settings sections" });
}

function open(props: Partial<Parameters<typeof AssistantSettings>[0]> = {}, section?: string): void {
  render(<AssistantSettings now={Date.now()} connections={connections(["github", "claude"])} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
  if (section !== undefined) {
    fireEvent.click(within(nav()).getByRole("tab", { name: section }));
  }
}

async function submit(name: string): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name }));
  });
}

function sent(action: ReturnType<typeof ok>): FormData {
  return (action.mock.calls[0] as unknown as [FormData])[0];
}

describe("the Assistant's settings for managing its agent", () => {
  it("should offer tokens with the connections and the agent's sections with the rest of the agent's when every one is given", () => {
    open({ agent: agentSettings(), git: git(), tokens: tokens() });

    expect(
      within(nav())
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Appearance", "Connections", "Tokens", "Sharing", "Assistant", "Git identity", "Web servers"]);
  });

  it("should offer none of them when the page gives none", () => {
    open();

    expect(within(nav()).queryByRole("tab", { name: "Assistant" })).toBeNull();
    expect(within(nav()).queryByRole("tab", { name: "Tokens" })).toBeNull();
    expect(within(nav()).queryByRole("tab", { name: "Git identity" })).toBeNull();
    expect(within(nav()).queryByRole("tab", { name: "Web servers" })).toBeNull();
  });

  it("should leave Tokens out when the person's assistant uses no pasted token", () => {
    open({ connections: connections(["github"], ["github", "azure"]), tokens: tokens() });

    expect(within(nav()).queryByRole("tab", { name: "Tokens" })).toBeNull();
  });
});

describe("the Assistant's own agent", () => {
  it("should name the agent and say where it stands when it opens", () => {
    open({ agent: agentSettings({ statusDetail: "Claude is ready; cloning repositories (12/241)" }) }, "Assistant");

    expect(screen.getByText("assistant")).toBeTruthy();
    expect(screen.getByText(/Running/)).toBeTruthy();
    expect(screen.getByText("Claude is ready; cloning repositories (12/241)")).toBeTruthy();
  });

  it("should say what a restart ends before it is sent, and send the agent only once confirmed", async () => {
    const restart = ok("Restarting. Your chats are kept.");
    open({ agent: agentSettings({}, { restart }) }, "Assistant");

    fireEvent.click(screen.getByRole("button", { name: "Restart your assistant" }));
    expect(screen.getByText(/Anything a chat is working on right now stops\. Your chats are all kept/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restart" }));
    expect(restart).not.toHaveBeenCalled();
    await submit("Restart your assistant");

    expect(sent(restart).get("id")).toBe(ID);
    expect(screen.getByRole("status").textContent).toBe("Restarting. Your chats are kept.");
  });

  it("should send nothing when the restart is cancelled", () => {
    const restart = ok();
    open({ agent: agentSettings({}, { restart }) }, "Assistant");

    fireEvent.click(screen.getByRole("button", { name: "Restart your assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(restart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart your assistant" })).toBeTruthy();
  });

  // Opening the Assistant starts its agent, so a stop would be undone by the refresh that follows it.
  it("should offer no stop, no delete, and no restart of an agent that is not running", () => {
    open({ agent: agentSettings({ desired: "stopped", status: "stopped" }) }, "Assistant");

    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop|Delete/ })).toBeNull();
    expect(screen.getByText(/nothing to restart/)).toBeTruthy();
  });

  it("should send the agent and the new name when it is renamed, and show the refusal when the name is taken", async () => {
    const rename = vi.fn<FormAction>(async () => ({ ok: false as const, error: "you already have a virtual agent called jerry" }));
    open({ agent: agentSettings({}, { rename }) }, "Assistant");

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("assistant");
    fireEvent.change(name, { target: { value: "jerry" } });
    await submit("Rename your assistant");

    expect([sent(rename).get("id"), sent(rename).get("name")]).toEqual([ID, "jerry"]);
    expect(screen.getByRole("alert").textContent).toContain("you already have a virtual agent called jerry");
  });
});

describe("the Assistant's web servers", () => {
  it("should link each port on the viewer first, under its prefix with the trailing slash, and on the VPN after it", () => {
    open({ agent: agentSettings({ exposedPorts: [{ port: 3000, url: VPN_3000, viewerUrl: VIEWER_3000 }] }) }, "Web servers");

    const links = within(screen.getByRole("list", { name: "Web server URLs" })).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([VIEWER_3000, VPN_3000]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
  });

  it("should link the VPN address alone when the viewer is off", () => {
    open({ agent: agentSettings({ exposedPorts: [{ port: 3000, url: VPN_3000 }] }) }, "Web servers");

    expect(
      within(screen.getByRole("list", { name: "Web server URLs" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual([VPN_3000]);
  });

  it("should say how to open a port that listens on loopback only when the pod reports one", () => {
    open({ agent: agentSettings({ localOnlyPorts: [5173] }) }, "Web servers");

    expect(screen.getByText("No web servers running.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Ports listening on 127.0.0.1 only" })).getByText(/Port 5173.*0\.0\.0\.0/)).toBeTruthy();
  });

  it("should say there are none while the agent is stopped", () => {
    open({ agent: agentSettings({ desired: "stopped", status: "stopped" }) }, "Web servers");

    expect(screen.getByText("None while your assistant is stopped.")).toBeTruthy();
  });
});

describe("the Assistant's git identity", () => {
  it("should send the name and email when they are saved", async () => {
    const save = ok("Your git identity is saved");
    open({ git: git(false, { save }) }, "Git identity");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alice Example" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    await submit("Save your git identity");

    expect([sent(save).get("name"), sent(save).get("email")]).toEqual(["Alice Example", "alice@example.com"]);
    expect(screen.queryByRole("button", { name: "Go back to the default" })).toBeNull();
  });

  it("should show what is stored and offer to go back to the default when one is stored", async () => {
    const clear = ok();
    open({ git: git(true, { clear }) }, "Git identity");

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alice Example");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("alice@example.com");
    await submit("Go back to the default git identity");

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("should say why it cannot be shown when the hub cannot read it", () => {
    open({ git: { ...git(), settings: { available: false, reason: "no credential store is configured" } } }, "Git identity");

    expect(screen.getByText("Your git identity cannot be shown: no credential store is configured")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });
});

describe("the Assistant's pasted tokens", () => {
  it("should list each pasted token the assistant uses, saved or not, and never its value", () => {
    open({ tokens: tokens() }, "Tokens");

    const rows = within(screen.getByRole("list", { name: "Tokens" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Claude tokenSaved"), expect.stringContaining("Jenkins API tokenNot saved")]);
    expect(screen.getByRole("button", { name: "Remove your Claude token" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove your Jenkins API token" })).toBeNull();
  });

  it("should send the kind and the new value when a token is added", async () => {
    const save = ok("Your Jenkins API token is stored");
    open({ tokens: tokens({ save }) }, "Tokens");

    fireEvent.click(screen.getByRole("button", { name: "Add your Jenkins API token" }));
    fireEvent.change(screen.getByLabelText("Jenkins API token"), { target: { value: "11aa" } });
    await submit("Save your Jenkins API token");

    expect([sent(save).get("kind"), sent(save).get("value")]).toEqual(["jenkins", "11aa"]);
    expect((screen.queryByLabelText("Jenkins API token") as HTMLInputElement | null)?.type ?? "password").toBe("password");
  });

  it("should say the assistant cannot answer without it before removing the model's token, and send the kind once confirmed", async () => {
    const remove = ok();
    open({ tokens: tokens({ remove }) }, "Tokens");

    fireEvent.click(screen.getByRole("button", { name: "Remove your Claude token" }));
    expect(screen.getByText(/it cannot answer again until you paste a new one/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await submit("Remove your Claude token");

    expect(sent(remove).get("kind")).toBe("claude");
  });

  it("should say when the assistant stops using an optional token before it is removed", () => {
    open({ connections: connections(["github", "claude", "jenkins"]), tokens: tokens() }, "Tokens");

    fireEvent.click(screen.getByRole("button", { name: "Remove your Jenkins API token" }));

    expect(screen.getByText("Remove your Jenkins API token? Your assistant stops using it the next time it starts.")).toBeTruthy();
  });
});
