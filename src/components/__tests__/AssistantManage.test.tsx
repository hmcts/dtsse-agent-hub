/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsData } from "@/assistant/connections";
import { savedCredentials } from "@/assistant/saved-credentials";
import type { FormAction } from "@/components/ActionForm";
import type { AssistantAgentSettings } from "@/components/assistant/AgentSettings";
import { type AssistantTokens, Connections, type ConnectionsView } from "@/components/assistant/ConnectionSettings";
import type { AssistantGitIdentity } from "@/components/assistant/GitIdentitySettings";
import { AssistantSettings } from "@/components/assistant/SettingsDialog";
import { SETTLE_MS } from "@/components/live/useSettled";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { AssistantAgent, GitIdentitySettings } from "@/web/data";

/** The sections of the Assistant's settings that manage the virtual agent it runs on, and the person's own values. */

const refresh = vi.fn();
/**
 * The search the router holds, which is not the address bar's: Next takes a `history.replaceState` or `pushState` as
 * a change of URL only when its state does not carry the router's own `__NA` marker, and its own navigations set
 * both. `routerHistory` below stands in for that patch, so a write Next would not sync leaves this behind as it would.
 */
const router = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams(router.search)
}));
const hubHandlers = new Map<string, () => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: () => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined
}));

/** The stream saying the agent changed, and the settle `useSettingsData` waits before reading again. */
async function agentChanged(): Promise<void> {
  await act(async () => {
    hubHandlers.get("virtual_agent")?.();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 10));
  });
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
  hubHandlers.clear();
});

const ID = "0f8a6a1e-0000-4000-8000-000000000001";
const VPN_3000 = "https://va-0f8a6a1e-3000.preview.platform.hmcts.net";
const VIEWER_3000 = `https://agent-hub-viewer.example/${ID}/3000/`;

function status(kind: CredentialKind, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored: true, accountLabel, updatedAt: "2026-10-24T09:00:00.000Z" };
}

function connections(stored: CredentialKind[], kinds: CredentialKind[] = ["github", "claude", "jenkins"]): ConnectionsData {
  return { route: "own-licence", kinds, statuses: stored.map((kind) => status(kind)), logins: [], unavailable: null };
}

function ok(confirmation?: string) {
  return vi.fn<FormAction>(async () => ({ ok: true as const, ...(confirmation === undefined ? {} : { confirmation }) }));
}

function agent(overrides: Partial<AssistantAgent> = {}): AssistantAgent {
  return { id: ID, name: "assistant", desired: "running", status: "running", statusDetail: null, exposedPorts: [], localOnlyPorts: [], ...overrides };
}

function agentSettings(overrides: Partial<AssistantAgent> | null = {}, actions: Partial<Omit<AssistantAgentSettings, "load">> = {}): AssistantAgentSettings {
  return {
    load: vi.fn(async () => (overrides === null ? null : agent(overrides))),
    restart: ok("Restarting. Your chats are kept."),
    ...actions
  };
}

function gitSettings(stored: boolean): GitIdentitySettings {
  return { available: true, stored, identity: stored ? { name: "Alice Example", email: "alice@example.com" } : {} };
}

function git(settings: GitIdentitySettings = gitSettings(false), actions: Partial<Omit<AssistantGitIdentity, "load">> = {}): AssistantGitIdentity {
  return {
    load: vi.fn(async () => settings),
    save: ok("Your git identity is saved"),
    clear: ok("Your virtual agents are back to the default git identity"),
    ...actions
  };
}

function tokens(
  statuses: CredentialStatus[] = [status("github"), status("claude")],
  actions: Partial<AssistantTokens> = {},
  route: "gateway" | "own-licence" = "own-licence"
): AssistantTokens {
  return { rows: savedCredentials(statuses, route, route === "own-licence"), unavailable: null, save: ok("Saved"), remove: ok(), ...actions };
}

function nav(): HTMLElement {
  return screen.getByRole("tablist", { name: "Settings sections" });
}

/** Opens the dialog at `section`, and lets a section that reads its data once open finish reading it. */
async function open(props: Partial<Parameters<typeof AssistantSettings>[0]> = {}, section?: string): Promise<void> {
  render(<AssistantSettings now={Date.now()} connections={connections(["github", "claude"])} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
  if (section !== undefined) {
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: section }));
    });
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
  it("should offer the saved credentials within Connections, with no section of their own, and the agent's sections after it", async () => {
    await open({ agent: agentSettings(), git: git(), tokens: tokens() });

    expect(
      within(nav())
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Appearance", "Connections", "Assistant", "Git identity", "Web servers"]);
  });

  it("should offer none of the agent's sections when the page gives none", async () => {
    await open();

    for (const name of ["Assistant", "Git identity", "Web servers"]) {
      expect(within(nav()).queryByRole("tab", { name })).toBeNull();
    }
  });

  // Nothing is read for a dialog the person has not opened, nor for a section they have not opened in it.
  it("should read the agent and the git identity only when their sections are opened", async () => {
    const agentLoad = agentSettings();
    const gitLoad = git();
    render(<AssistantSettings now={Date.now()} connections={connections(["github"])} agent={agentLoad} git={gitLoad} />);
    expect(agentLoad.load).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: "Connections" }));
    });
    expect(agentLoad.load).not.toHaveBeenCalled();
    expect(gitLoad.load).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: "Git identity" }));
    });
    expect(gitLoad.load).toHaveBeenCalledTimes(1);
    expect(agentLoad.load).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: "Assistant" }));
    });

    expect(agentLoad.load).toHaveBeenCalledTimes(1);
  });
});

describe("the Assistant's own agent", () => {
  it("should name the agent and say where it stands when it has been read", async () => {
    await open({ agent: agentSettings({ statusDetail: "Claude is ready; cloning repositories (12/241)" }) }, "Assistant");

    expect(screen.getByText("assistant")).toBeTruthy();
    expect(screen.getByText(/Running/)).toBeTruthy();
    expect(screen.getByText("Claude is ready; cloning repositories (12/241)")).toBeTruthy();
  });

  it("should read the agent again when the stream says it changed", async () => {
    const settings = agentSettings();
    await open({ agent: settings }, "Assistant");

    await agentChanged();

    expect(settings.load).toHaveBeenCalledTimes(2);
  });

  it("should say the person has no assistant yet when there is none", async () => {
    await open({ agent: agentSettings(null) }, "Assistant");

    expect(screen.getByText("You have no assistant yet. Opening a chat sets one up.")).toBeTruthy();
  });

  it("should say the agent could not be read when the read fails", async () => {
    await open({ agent: { ...agentSettings(), load: vi.fn(async () => Promise.reject(new Error("down"))) } }, "Assistant");

    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  it("should say what a restart ends before it is sent, and show the server's own confirmation when it has been", async () => {
    const restart = ok("It is not running, so it starts afresh next time anyway.");
    await open({ agent: agentSettings({}, { restart }) }, "Assistant");

    fireEvent.click(screen.getByRole("button", { name: "Restart your assistant" }));
    expect(screen.getByText(/Anything a chat is working on right now stops\. Your chats are all kept/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restart" }));
    expect(restart).not.toHaveBeenCalled();
    await submit("Restart your assistant");

    expect(sent(restart).get("id")).toBe(ID);
    expect(screen.queryByRole("form", { name: "Restart your assistant" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("It is not running, so it starts afresh next time anyway.");
  });

  it("should send nothing when the restart is cancelled", async () => {
    const restart = ok();
    await open({ agent: agentSettings({}, { restart }) }, "Assistant");

    fireEvent.click(screen.getByRole("button", { name: "Restart your assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(restart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart your assistant" })).toBeTruthy();
  });

  // Opening the Assistant starts its agent, so a stop would be undone by the refresh that follows it.
  it("should offer no stop, no delete and no restart when the agent is not running", async () => {
    await open({ agent: agentSettings({ desired: "stopped", status: "stopped" }) }, "Assistant");

    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop|Delete/ })).toBeNull();
    expect(screen.getByText(/nothing to restart/)).toBeTruthy();
  });

  it("should offer no way to rename the agent when its section is open", async () => {
    await open({ agent: agentSettings() }, "Assistant");

    expect(screen.queryByRole("form", { name: /Rename/ })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("the Assistant's web servers", () => {
  it("should link each port on the viewer first, under its prefix with the trailing slash, and on the VPN after it when the viewer is on", async () => {
    await open({ agent: agentSettings({ exposedPorts: [{ port: 3000, url: VPN_3000, viewerUrl: VIEWER_3000 }] }) }, "Web servers");

    const links = within(screen.getByRole("list", { name: "Web server URLs" })).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([VIEWER_3000, VPN_3000]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
  });

  it("should link the VPN address alone when the viewer is off", async () => {
    await open({ agent: agentSettings({ exposedPorts: [{ port: 3000, url: VPN_3000 }] }) }, "Web servers");

    expect(
      within(screen.getByRole("list", { name: "Web server URLs" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual([VPN_3000]);
  });

  it("should say how to open a port that listens on loopback only when the pod reports one", async () => {
    await open({ agent: agentSettings({ localOnlyPorts: [5173] }) }, "Web servers");

    expect(screen.getByText("No web servers running.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Ports listening on 127.0.0.1 only" })).getByText(/Port 5173.*0\.0\.0\.0/)).toBeTruthy();
  });

  it("should say there are none when the agent is stopped", async () => {
    await open({ agent: agentSettings({ desired: "stopped", status: "stopped" }) }, "Web servers");

    expect(screen.getByText("None while your assistant is stopped.")).toBeTruthy();
  });
});

describe("the Assistant's git identity", () => {
  it("should send the name and email when the dialog is saved, and read it again after", async () => {
    const settings = git(gitSettings(false), { save: ok("Your git identity is saved") });
    await open({ git: settings }, "Git identity");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alice Example" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    });

    expect([sent(settings.save as ReturnType<typeof ok>).get("name"), sent(settings.save as ReturnType<typeof ok>).get("email")]).toEqual([
      "Alice Example",
      "alice@example.com"
    ]);
    expect(screen.getByRole("status").textContent).toBe("Your git identity is saved");
    expect(settings.load).toHaveBeenCalledTimes(2);
  });

  it("should show what is stored, and empty the fields and say so when it goes back to the default", async () => {
    const clear = ok("Your virtual agents are back to the default git identity");
    await open({ git: git(gitSettings(true), { clear }) }, "Git identity");

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alice Example");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("alice@example.com");
    await submit("Go back to the default git identity");

    expect(clear).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText("Your virtual agents are back to the default git identity").length).toBeGreaterThan(0);
  });

  it("should say why it cannot be shown when the hub cannot read it", async () => {
    await open({ git: git({ available: false, reason: "no credential store is configured" }) }, "Git identity");

    expect(screen.getByText("Your git identity cannot be shown: no credential store is configured")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });
});

/** The name of each row of the Connections list, in the order the person reads them. */
function rowNames(): string[] {
  return within(screen.getByRole("list", { name: "Connections" }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("list", { name: "Connections" }))
    .getAllByRole("listitem")
    .find((item) => item.querySelector(".font-medium")?.textContent === name);
  if (row === undefined) {
    throw new Error(`no ${name} row`);
  }
  return row;
}

describe("the Assistant's Connections, one row per service", () => {
  it("should list each service once, with its sign-in's and its saved credential's actions on the one row, when both are given", async () => {
    await open(
      {
        connect: { assistantId: ID, running: true, reconnect: ok() },
        tokens: tokens([status("github"), status("claude")])
      },
      "Connections"
    );

    expect(rowNames()).toEqual(["GitHub", "Claude", "Jenkins", "Microsoft 365"]);
    expect(
      within(rowOf("GitHub"))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Connect GitHub", "Remove your GitHub token"]);
    expect(within(rowOf("Jenkins")).getByRole("button", { name: "Add your Jenkins API token" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Saved credentials" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Saved credentials" })).toBeNull();
  });

  it("should offer to remove every stored credential, sign-ins among them, and to paste none of the sign-ins, when all are stored", async () => {
    await open({ tokens: tokens([status("github"), status("azure", "alice@hmcts.net"), status("atlassian")], {}, "gateway") }, "Connections");

    expect(rowNames()).toEqual(["GitHub", "Claude", "Jenkins", "Azure", "Atlassian", "Microsoft 365"]);
    for (const kind of ["GitHub token", "Azure sign-in", "Atlassian sign-in"]) {
      expect(screen.getByRole("button", { name: `Remove your ${kind}` })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /(Add|Replace) your (GitHub|Azure|Atlassian)/ })).toBeNull();
    expect(within(rowOf("Azure")).getByText("alice@hmcts.net")).toBeTruthy();
  });

  it("should send the kind and the new value when a Jenkins API token is pasted, and say so after the form has closed", async () => {
    const save = ok();
    await open({ tokens: tokens([], { save }) }, "Connections");

    fireEvent.click(screen.getByRole("button", { name: "Add your Jenkins API token" }));
    fireEvent.change(screen.getByLabelText("Jenkins API token"), { target: { value: "11a2b3c4d5e6f708192a" } });
    await submit("Save your Jenkins API token");

    expect([sent(save).get("kind"), sent(save).get("value")]).toEqual(["jenkins", "11a2b3c4d5e6f708192a"]);
    expect(screen.queryByRole("form", { name: "Save your Jenkins API token" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Your Jenkins API token is saved");
  });

  // Pasting a token is an action, done at once, and not a setting the dialog's Save waits for.
  it("should leave the dialog's Save with nothing to save when a token is pasted", async () => {
    await open({ tokens: tokens([]) }, "Connections");

    fireEvent.click(screen.getByRole("button", { name: "Add your Jenkins API token" }));
    fireEvent.change(screen.getByLabelText("Jenkins API token"), { target: { value: "11a2b3c4d5e6f708192a" } });

    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("should say the assistant cannot answer without it, and send the kind once confirmed, when the model's token is removed", async () => {
    const remove = ok();
    await open({ tokens: tokens([status("claude")], { remove }) }, "Connections");

    fireEvent.click(screen.getByRole("button", { name: "Remove your Claude token" }));
    expect(screen.getByText(/it cannot answer again until you paste a new one/)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await submit("Remove your Claude token");

    expect(sent(remove).get("kind")).toBe("claude");
    expect(screen.getByRole("status").textContent).toBe("Your Claude token is removed");
  });

  it("should say why the credentials cannot be shown when the hub cannot read them", async () => {
    await open({ tokens: { ...tokens(), rows: [], unavailable: "no credential store is configured" } }, "Connections");

    expect(screen.getByText("Your credentials cannot be shown: no credential store is configured")).toBeTruthy();
  });

  it("should offer Connections for the saved credentials alone when the page gives no sign-ins", async () => {
    render(<AssistantSettings now={Date.now()} tokens={tokens()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: "Connections" }));
    });

    expect(rowNames()).toEqual(["GitHub", "Claude", "Jenkins"]);
  });

  // On the gateway route the model-access row is Claude, so a Claude token still saved from the other route is
  // removed from that row rather than from a second one named Claude.
  it("should put a saved Claude token on the one Claude row when the agents reach Claude through the gateway", async () => {
    await open(
      {
        connections: {
          route: "gateway",
          kinds: ["github", "azure"],
          statuses: [status("github"), status("azure"), status("claude")],
          logins: [],
          unavailable: null
        },
        tokens: tokens([status("github"), status("azure"), status("claude")], {}, "gateway")
      },
      "Connections"
    );

    expect(rowNames()).toEqual(["GitHub", "Claude", "Azure", "Jenkins", "Microsoft 365"]);
    expect(within(rowOf("Claude")).getByRole("button", { name: "Remove your Claude token" })).toBeTruthy();
  });
});

describe("the Assistant's settings deep link", () => {
  const nativeReplace = window.history.replaceState.bind(window.history);
  const nativePush = window.history.pushState.bind(window.history);

  /** Next's patch of `history`, as far as the router's search goes. */
  function routerHistory(native: History["replaceState"]): History["replaceState"] {
    return (data, unused, url) => {
      if (!(data as { __NA?: boolean } | null)?.__NA && url !== undefined && url !== null) {
        router.search = new URL(url, window.location.href).search;
      }
      native(data, unused, url);
    };
  }

  /** The page as the router leaves it after it loads or navigates: the address, its marker and its search. */
  function land(url: string): void {
    nativeReplace({ __NA: true }, "", url);
    router.search = window.location.search;
  }

  function navigate(url: string): void {
    nativePush({ __NA: true }, "", url);
    router.search = window.location.search;
  }

  const page = () => <AssistantSettings now={Date.now()} connections={connections(["github"])} tokens={tokens()} />;

  beforeEach(() => {
    window.history.replaceState = routerHistory(nativeReplace);
    window.history.pushState = routerHistory(nativePush);
  });

  afterEach(() => {
    window.history.replaceState = nativeReplace;
    window.history.pushState = nativePush;
    nativeReplace(null, "", "/");
    router.search = "";
  });

  it("should open at the section ?settings= names, and take the parameter out of the address once closed, when the page loads", async () => {
    land("/assistant?settings=connections&x=1");
    await act(async () => {
      render(page());
    });

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(within(nav()).getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe("true");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/assistant?settings=connections&x=1");

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close settings" }));

    expect(`${window.location.pathname}${window.location.search}`).toBe("/assistant?x=1");
    expect(router.search).toBe("?x=1");
  });

  // A pod on an older client still links its owner to `?settings=credentials` to paste a token.
  it("should open at Connections when ?settings= names the credentials section", async () => {
    land("/assistant?settings=credentials");
    await act(async () => {
      render(page());
    });

    expect(within(nav()).getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe("true");
  });

  it.each([
    ["model", "Assistant"],
    ["size", "Assistant"],
    ["tools", "Plugins"]
  ])("should open at the section that holds it when ?settings= names %s", async (named, section) => {
    land(`/assistant?settings=${named}`);
    await act(async () => {
      render(
        <AssistantSettings
          now={Date.now()}
          connections={connections(["github"])}
          agent={agentSettings()}
          plugins={{ assistantId: ID, available: [{ name: "pcs", description: "" }], checked: [], podRunning: true, save: ok() }}
        />
      );
    });

    expect(within(nav()).getByRole("tab", { name: section }).getAttribute("aria-selected")).toBe("true");
  });

  it("should open at the first section when ?settings= names one it does not offer", () => {
    land("/assistant?settings=nothing-here");
    render(page());

    expect(within(nav()).getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe("true");
  });

  // A client-side navigation re-renders the page it lands on rather than mounting it again.
  it("should open at the section ?settings= names when a navigation reaches it with the page already open", async () => {
    land("/assistant");
    const { rerender } = render(page());
    expect(screen.queryByRole("dialog")).toBeNull();

    navigate("/assistant?settings=connections");
    await act(async () => {
      rerender(page());
    });

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(within(nav()).getByRole("tab", { name: "Connections" }).getAttribute("aria-selected")).toBe("true");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/assistant?settings=connections");
  });

  // The router has to hear the parameter go, or the same link names what it already holds and changes nothing.
  it("should open again when the same link is followed after the dialog it opened was closed", async () => {
    land("/assistant?settings=connections");
    const { rerender } = render(page());
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close settings" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    navigate("/assistant?settings=connections");
    await act(async () => {
      rerender(page());
    });

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("should stay closed when the address names no section", () => {
    land("/assistant");
    render(page());

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("how often the settings read", () => {
  // Every save ends in `router.refresh()`, which hands the dialog a fresh server-action reference.
  it("should not read again when a server render hands the section a new loader", async () => {
    const first = agentSettings();
    const { rerender } = render(<AssistantSettings now={Date.now()} connections={connections(["github"])} agent={first} />);
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    await act(async () => {
      fireEvent.click(within(nav()).getByRole("tab", { name: "Assistant" }));
    });
    const next = { ...first, load: vi.fn(async () => agent()) };

    await act(async () => {
      rerender(<AssistantSettings now={Date.now()} connections={connections(["github"])} agent={next} />);
    });

    expect(first.load).toHaveBeenCalledTimes(1);
    expect(next.load).not.toHaveBeenCalled();
  });

  it("should read once more, and only once, when a restart has been sent and the stream says the agent changed", async () => {
    const settings = agentSettings();
    await open({ agent: settings }, "Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Restart your assistant" }));

    await submit("Restart your assistant");
    await agentChanged();

    expect(settings.load).toHaveBeenCalledTimes(2);
  });
});

/** The Connections section with only saved credentials to list. */
function credentialsOnly(saved: AssistantTokens): ConnectionsView {
  return { list: [], access: null, connect: undefined, microsoft: null, route: "gateway", unavailable: null, warning: null, tokens: saved };
}

describe("a removed credential's confirmation", () => {
  it("should still say an Atlassian sign-in was removed when its row has gone", async () => {
    const remove = ok();
    const statuses = [status("github"), status("atlassian")];
    const { rerender } = render(<Connections view={credentialsOnly(tokens(statuses, { remove }, "gateway"))} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove your Atlassian sign-in" }));
    await submit("Remove your Atlassian sign-in");
    rerender(<Connections view={credentialsOnly(tokens([status("github")], { remove }, "gateway"))} />);

    expect(screen.queryByText("Atlassian")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Your Atlassian sign-in is removed");
  });
});

describe("the Connections section when the hub cannot read", () => {
  // Two reads that fail apart, so each says its own reason in its own words.
  it("should say why the sign-ins and why the saved credentials cannot be shown when both fail", async () => {
    await open(
      {
        connections: { route: "own-licence", kinds: ["github"], statuses: [], logins: [], unavailable: "the sign-ins could not be read" },
        tokens: { ...tokens(), rows: [], unavailable: "no credential store is configured" }
      },
      "Connections"
    );

    expect(screen.getByText("the sign-ins could not be read")).toBeTruthy();
    expect(screen.getByText("Your credentials cannot be shown: no credential store is configured")).toBeTruthy();
  });
});
