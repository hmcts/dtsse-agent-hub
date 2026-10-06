/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import { LifecyclePanel } from "@/components/virtual-agents/LifecyclePanel";
import { LoginCountdown, remaining } from "@/components/virtual-agents/LoginCountdown";
import { idleFor, statusLabel, stopReasonLabel } from "@/components/virtual-agents/labels";
import { checklistState, OnboardingChecklist } from "@/components/virtual-agents/OnboardingChecklist";
import { PortsPanel } from "@/components/virtual-agents/PortsPanel";
import { RenameVirtualAgent } from "@/components/virtual-agents/RenameVirtualAgent";
import { SizePanel } from "@/components/virtual-agents/SizePanel";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { createLimit, DiskNotice, VirtualAgentsView } from "@/components/virtual-agents/VirtualAgentsView";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginView } from "@/virtual-agents/logins";
import type { VirtualAgentCard } from "@/virtual-agents/views";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
  hubHandlers.clear();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function card(overrides: Partial<VirtualAgentCard> = {}): VirtualAgentCard {
  return {
    id: "0f8a6a1e-0000-4000-8000-000000000001",
    name: "pcs-api",
    desired: "running",
    status: "running",
    statusDetail: null,
    modelRoute: "bedrock",
    size: "small",
    exposedPorts: [],
    stopReason: null,
    lastActivityAt: "2026-10-05T10:55:00.000Z",
    stoppedAt: null,
    diskExpiresAt: null,
    diskDeletedAt: null,
    agentId: null,
    createdAt: "2026-10-05T09:00:00.000Z",
    ...overrides
  };
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function created() {
  return vi.fn(async () => ({ ok: true as const, id: "0f8a6a1e-0000-4000-8000-000000000009", confirmation: "created" }));
}

describe("labels", () => {
  it("should say an agent is being deleted whatever its pod last reported", () => {
    expect(statusLabel("running", "deleted")).toBe("Deleting");
    expect(statusLabel("awaiting_login", "running")).toBe("Waiting for you to sign in");
  });

  it.each([
    ["running", "Stopping"],
    ["requested", "Stopping"],
    ["awaiting_login", "Stopping"],
    ["stopping", "Stopping"],
    ["stopped", "Stopped"],
    ["failed", "Failed"]
  ] as const)("should read a %s agent as %s when it is meant to be stopped", (status, label) => {
    expect(statusLabel(status, "stopped")).toBe(label);
  });

  it("should read a just-started agent as requested when the orchestrator has yet to apply it", () => {
    expect(statusLabel("requested", "running")).toBe("Requested");
  });

  it.each([
    ["user", "You stopped it"],
    ["idle", "Stopped after being idle"],
    ["evening", "Stopped for the evening"],
    ["quota", "quota"],
    ["expired", "time ran out"],
    ["failed", "it failed"]
  ] as const)("should explain a stop when its reason is %s", (reason, text) => {
    expect(stopReasonLabel(reason)).toContain(text);
  });

  it.each([
    ["2026-10-05T11:48:00.000Z", "12 min"],
    ["2026-10-05T09:00:00.000Z", "3 h"],
    ["2026-10-05T08:55:00.000Z", "3 h 5 min"],
    ["2026-10-02T12:00:00.000Z", "3 days"],
    ["2026-10-05T12:05:00.000Z", "0 min"]
  ])("should say how long since %s as %s", (since, text) => {
    expect(idleFor(since, NOW)).toBe(text);
  });
});

describe("VirtualAgentsView", () => {
  it("should list the viewer's agents with their status, idle time and a link to each", () => {
    render(<VirtualAgentsView agents={[card()]} route="bedrock" create={created()} now={NOW} />);

    const list = screen.getByRole("list", { name: "Your virtual agents" });
    expect(within(list).getByRole("link", { name: "pcs-api" }).getAttribute("href")).toBe("/agents/0f8a6a1e-0000-4000-8000-000000000001");
    expect(list.textContent).toContain("Running");
    expect(list.textContent).toContain("idle for 1 h 5 min");
  });

  it("should say why a stopped agent stopped and warn before its disk is deleted", () => {
    render(
      <VirtualAgentsView
        agents={[
          card({
            desired: "stopped",
            status: "stopped",
            stopReason: "evening",
            stoppedAt: "2026-10-04T18:00:00.000Z",
            diskExpiresAt: "2026-10-07T12:00:00.000Z"
          })
        ]}
        route="bedrock"
        create={created()}
        now={NOW}
      />
    );

    expect(screen.getByText(/Stopped for the evening/)).toBeTruthy();
    expect(screen.getByText(/Its disk will be deleted in 2 days/)).toBeTruthy();
    expect(screen.queryByText(/idle for/)).toBeNull();
  });

  it("should warn that a virtual agent acts with the viewer's access and name the model route when it offers to create one", () => {
    render(<VirtualAgentsView agents={[]} route="own-licence" create={created()} now={NOW} />);

    expect(screen.getByText("A virtual agent acts with your GitHub and Azure access.")).toBeTruthy();
    expect(screen.getByText(/your own Claude licence/)).toBeTruthy();
    expect(screen.getByText("You have no virtual agents.")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Create a virtual agent" })).toBeTruthy();
  });

  it("should name Amazon Bedrock and the viewer's Bedrock API key when the viewer is on the Bedrock route", () => {
    render(<VirtualAgentsView agents={[]} route="bedrock" create={created()} now={NOW} />);

    expect(screen.getByText("Model: Amazon Bedrock, with your Bedrock API key")).toBeTruthy();
  });

  it("should send the name to the create action and open the new agent's page when the form is submitted", async () => {
    const create = vi.fn(async () => ({ ok: true as const, id: "0f8a6a1e-0000-4000-8000-000000000009", confirmation: "pcs-api is starting" }));
    render(<VirtualAgentsView agents={[]} route="bedrock" create={create} now={NOW} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "pcs-api" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Create a virtual agent" }));
    });

    expect((create.mock.calls[0] as unknown as [FormData])[0].get("name")).toBe("pcs-api");
    expect(push).toHaveBeenCalledWith("/agents/0f8a6a1e-0000-4000-8000-000000000009");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("should offer no create form and say why when the viewer is at a limit", () => {
    render(<VirtualAgentsView agents={[card(), card({ id: "b", name: "b" })]} route="bedrock" create={created()} now={NOW} />);

    expect(screen.queryByRole("form", { name: "Create a virtual agent" })).toBeNull();
    expect(screen.getByText(/2 virtual agents running/)).toBeTruthy();
  });
});

describe("createLimit", () => {
  it("should refuse at the total limit, not counting agents being deleted", () => {
    const stopped = card({ desired: "stopped" });
    expect(createLimit([stopped, stopped, stopped])).toContain("Delete one");
    expect(createLimit([stopped, stopped, card({ desired: "deleted" })])).toBeUndefined();
  });
});

describe("DiskNotice", () => {
  it("should say the disk has gone when it was deleted", () => {
    render(<DiskNotice agent={{ diskExpiresAt: "2026-10-01T00:00:00.000Z", diskDeletedAt: "2026-10-01T00:00:00.000Z" }} now={NOW} />);

    expect(screen.getByText(/disk has been deleted/)).toBeTruthy();
  });

  it("should say today when the expiry has come", () => {
    render(<DiskNotice agent={{ diskExpiresAt: "2026-10-05T11:00:00.000Z", diskDeletedAt: null }} now={NOW} />);

    expect(screen.getByText(/deleted today/)).toBeTruthy();
  });

  it("should show nothing when the expiry is far off", () => {
    const { container } = render(<DiskNotice agent={{ diskExpiresAt: "2026-10-19T12:00:00.000Z", diskDeletedAt: null }} now={NOW} />);

    expect(container.textContent).toBe("");
  });

  it("should say one day in the singular", () => {
    render(<DiskNotice agent={{ diskExpiresAt: "2026-10-06T11:00:00.000Z", diskDeletedAt: null }} now={NOW} />);

    expect(screen.getByText(/in 1 day /)).toBeTruthy();
  });
});

describe("LifecyclePanel", () => {
  function actions() {
    return { start: ok(), stop: ok(), remove: ok() };
  }

  it("should offer to stop a running agent and show its detail", () => {
    render(<LifecyclePanel agent={card({ statusDetail: "cloning hmcts/pcs-api" })} actions={actions()} />);

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByText("cloning hmcts/pcs-api")).toBeTruthy();
  });

  it("should offer to start a stopped agent and say why it stopped", async () => {
    const given = actions();
    render(<LifecyclePanel agent={card({ desired: "stopped", status: "stopped", stopReason: "idle" })} actions={given} />);

    expect(screen.getByText("Stopped after being idle")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    expect((given.start.mock.calls[0] as unknown as [FormData])[0].get("id")).toBe(card().id);
  });

  it("should ask again before deleting, and delete only once confirmed", async () => {
    const given = actions();
    render(<LifecyclePanel agent={card()} actions={given} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Confirm deleting pcs-api" });
    expect(confirm.textContent).toContain("Anything not pushed is lost");
    expect(given.remove).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete pcs-api" }));
    });
    expect((given.remove.mock.calls[0] as unknown as [FormData])[0].get("id")).toBe(card().id);
  });

  it("should go back without deleting when the confirmation is cancelled", () => {
    const given = actions();
    render(<LifecyclePanel agent={card()} actions={given} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group")).toBeNull();
    expect(given.remove).not.toHaveBeenCalled();
  });

  it("should offer nothing when the agent is being deleted", () => {
    render(<LifecyclePanel agent={card({ desired: "deleted", status: "stopping" })} actions={actions()} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/being deleted/)).toBeTruthy();
  });
});

describe("RenameVirtualAgent", () => {
  it("should offer the current name and send the id and the new name when the form is submitted", async () => {
    const rename = vi.fn(async () => ({ ok: true as const, confirmation: "Renamed to pcs-frontend" }));
    render(<RenameVirtualAgent agent={card()} rename={rename} />);

    const field = screen.getByLabelText("New name") as HTMLInputElement;
    expect(field.value).toBe("pcs-api");
    fireEvent.change(field, { target: { value: "pcs-frontend" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Rename pcs-api" }));
    });

    const sent = (rename.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get("id")).toBe(card().id);
    expect(sent.get("name")).toBe("pcs-frontend");
    expect(screen.getByRole("status").textContent).toBe("Renamed to pcs-frontend");
    expect(refresh).toHaveBeenCalled();
  });

  it("should show the refusal when the name is taken", async () => {
    const rename = vi.fn(async () => ({ ok: false as const, error: "you already have a virtual agent called jerry" }));
    render(<RenameVirtualAgent agent={card()} rename={rename} />);

    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "jerry" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Rename pcs-api" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("you already have a virtual agent called jerry");
  });

  it("should offer no rename when the agent is being deleted", () => {
    render(<RenameVirtualAgent agent={card({ desired: "deleted" })} rename={ok()} />);

    expect(screen.queryByRole("form")).toBeNull();
  });
});

describe("running agent detail", () => {
  it("should show what a running agent's pod last said, such as its background clone", () => {
    const detail = "Claude is ready; cloning repositories (12/241)";
    render(<VirtualAgentsView agents={[card({ statusDetail: detail })]} route="bedrock" create={created()} now={NOW} />);
    render(<LifecyclePanel agent={card({ statusDetail: detail })} actions={{ start: ok(), stop: ok(), remove: ok() }} />);

    expect(screen.getAllByText(detail)).toHaveLength(2);
  });

  it.each([
    ["stopping", "stopped"],
    ["failed", "running"]
  ] as const)("should show the orchestrator's apply error when the agent is %s", (status, desired) => {
    const detail = "the orchestrator couldn't apply this agent: GET services/va-0f8a6a1e: 403 forbidden";
    render(<LifecyclePanel agent={card({ status, desired, statusDetail: detail })} actions={{ start: ok(), stop: ok(), remove: ok() }} />);

    expect(screen.getByText(detail)).toBeTruthy();
  });
});

describe("the size choice", () => {
  it("should offer every size on the create form, small first, and send the one chosen", async () => {
    const create = vi.fn(async () => ({ ok: true as const, id: "0f8a6a1e-0000-4000-8000-000000000009", confirmation: "big is starting" }));
    render(<VirtualAgentsView agents={[]} route="bedrock" create={create} now={NOW} />);

    const size = screen.getByLabelText("Size") as HTMLSelectElement;
    expect([...size.options].map((option) => option.textContent)).toEqual([
      "Small: 1–4 CPUs, 4Gi–8Gi memory",
      "Medium: 2–4 CPUs, 8Gi–16Gi memory",
      "Large: 4–8 CPUs, 16Gi–32Gi memory"
    ]);
    expect(size.value).toBe("small");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "big" } });
    fireEvent.change(size, { target: { value: "large" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Create a virtual agent" }));
    });

    expect((create.mock.calls[0] as unknown as [FormData])[0].get("size")).toBe("large");
  });

  it.each([
    ["requested", "running"],
    ["stopped", "stopped"]
  ] as const)("should offer to change the size when the agent is %s", async (status, desired) => {
    const resize = vi.fn(async () => ({ ok: true as const, confirmation: "pcs-api is now medium" }));
    render(<SizePanel agent={card({ status, desired })} resize={resize} />);

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "medium" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Change the size of pcs-api" }));
    });

    const sent = (resize.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("size")]).toEqual([card().id, "medium"]);
    expect(screen.getByRole("status").textContent).toBe("pcs-api is now medium");
  });

  it("should show the size and say to stop the agent when it is running", () => {
    render(<SizePanel agent={card({ size: "large" })} resize={ok()} />);

    expect(screen.getByText("Large: 4–8 CPUs, 16Gi–32Gi memory")).toBeTruthy();
    expect(screen.getByText("Stop it to change its size.")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("should show nothing when the agent is being deleted", () => {
    const { container } = render(<SizePanel agent={card({ desired: "deleted" })} resize={ok()} />);

    expect(container.textContent).toBe("");
  });
});

describe("PortsPanel", () => {
  const URL_3000 = "https://va-0f8a6a1e-3000.preview.platform.hmcts.net";

  function actions() {
    return { expose: ok(), unexpose: ok() };
  }

  it("should warn who can open the URLs and offer to expose a port when there are none", async () => {
    const given = actions();
    render(<PortsPanel agent={card()} actions={given} />);

    expect(screen.getByRole("note").textContent).toBe("Anyone on the HMCTS VPN can open these URLs. Servers must listen on 0.0.0.0.");
    expect(screen.queryByRole("list", { name: "Exposed ports" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "3000" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Expose a port" }));
    });

    const sent = (given.expose.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("port")]).toEqual([card().id, "3000"]);
  });

  it("should link each exposed port at its URL and remove the one asked for", async () => {
    const given = actions();
    render(<PortsPanel agent={card({ exposedPorts: [{ port: 3000, url: URL_3000 }] })} actions={given} />);

    const link = within(screen.getByRole("list", { name: "Exposed ports" })).getByRole("link", { name: URL_3000 });
    expect(link.getAttribute("href")).toBe(URL_3000);
    expect(link.getAttribute("rel")).toContain("noopener");
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Stop exposing port 3000" }));
    });

    expect((given.unexpose.mock.calls[0] as unknown as [FormData])[0].get("port")).toBe("3000");
  });

  it("should offer no more ports when three are exposed", () => {
    const exposedPorts = [3000, 4000, 5000].map((port) => ({ port, url: `https://va-x-${port}.example.net` }));
    render(<PortsPanel agent={card({ exposedPorts })} actions={actions()} />);

    expect(screen.queryByRole("form", { name: "Expose a port" })).toBeNull();
    expect(screen.getByText("3 of 3")).toBeTruthy();
  });

  it("should show nothing when the agent is being deleted", () => {
    const { container } = render(<PortsPanel agent={card({ desired: "deleted" })} actions={actions()} />);

    expect(container.textContent).toBe("");
  });
});

describe("the optional Jenkins API token", () => {
  it("should come after the needed sign-ins with a box to paste it, a link to make one, and count towards what is stored when it is not stored yet", async () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "Your Jenkins API token is stored" }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github"]}
        optional={["jenkins"]}
        statuses={[stored("github")]}
        logins={[]}
        paste={ok()}
        save={save}
        now={NOW}
      />
    );

    const items = within(screen.getByRole("list", { name: "Sign-ins" })).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("h3")?.textContent)).toEqual(["GitHub", "Jenkins API token"]);
    expect(screen.getByText("1 of 2 stored")).toBeTruthy();
    expect(items[1]!.textContent).toContain("Optional");
    expect(within(items[1]!).getByRole("link", { name: "your Jenkins user's Configure page" }).getAttribute("href")).toBe(
      "https://build.hmcts.net/me/configure"
    );
    fireEvent.change(screen.getByLabelText("Paste your Jenkins API token"), { target: { value: "11a2b3c4d5e6f708192a3b4c5d" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your Jenkins API token" }));
    });

    expect((save.mock.calls[0] as unknown as [FormData])[0].get("kind")).toBe("jenkins");
  });
});

function login(overrides: Partial<LoginView> = {}): LoginView {
  return {
    kind: "github",
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-10-05T12:10:00.000Z",
    state: "pending",
    codeWaiting: false,
    ...overrides
  };
}

function stored(kind: CredentialStatus["kind"], accountLabel: string | null = null): CredentialStatus {
  return { kind, stored: true, accountLabel, updatedAt: "2026-10-05T11:00:00.000Z", updatedVia: "pod" };
}

describe("checklistState", () => {
  it("should put a pending login first, even over a stored credential", () => {
    expect(checklistState(true, login(), NOW)).toBe("login");
  });

  it.each([
    ["an expired login", login({ expiresAt: "2026-10-05T11:59:59.000Z" })],
    ["a completed login", login({ state: "completed" })],
    ["no login", undefined]
  ])("should fall back to whether it is stored when there is %s", (_label, given) => {
    expect(checklistState(true, given, NOW)).toBe("stored");
    expect(checklistState(false, given, NOW)).toBe("waiting");
  });
});

describe("OnboardingChecklist", () => {
  it("should show a card for each credential needed, with stored sign-ins connected and no account label, when one is stored", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "azure"]}
        statuses={[stored("azure", "alice@justice.gov.uk")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    const items = within(screen.getByRole("list", { name: "Sign-ins" })).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("h3")?.textContent)).toEqual(["GitHub", "Azure"]);
    expect(items[0]!.textContent).toContain("Waiting for your virtual agent to ask");
    expect(items[1]!.textContent).toContain("✓ Connected");
    expect(items[1]!.textContent).not.toContain("alice@justice.gov.uk");
    expect(screen.getByText("1 of 2 stored")).toBeTruthy();
  });

  it("should show a device code, its link and how long it lasts when a device-code login is pending", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github"]}
        statuses={[]}
        logins={[login()]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    const link = screen.getByRole("link", { name: "https://github.com/login/device" });
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("ABCD-1234").tagName).toBe("CODE");
    expect(screen.getByText("GitHub device code:")).toBeTruthy();
  });

  it("should offer a box to paste a code back to the agent when a paste-code login is pending", async () => {
    const paste = vi.fn(async () => ({ ok: true as const, confirmation: "Sent to your virtual agent" }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "azure", "claude"]}
        statuses={[]}
        logins={[login({ kind: "claude", prompt: "paste_code", userCode: null, verificationUri: "https://claude.ai/oauth/authorize?x=1" })]}
        paste={paste}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByRole("link", { name: "the Claude sign-in page" }).getAttribute("href")).toBe("https://claude.ai/oauth/authorize?x=1");
    const input = screen.getByLabelText("Claude code");
    expect(input).toHaveProperty("type", "password");
    fireEvent.change(input, { target: { value: "pasted#code" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Paste the Claude code" }));
    });

    const sent = (paste.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("kind"), sent.get("code")]).toEqual(["va-1", "claude", "pasted#code"]);
  });

  it("should say a pasted code is waiting rather than ask again when one has been sent", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["claude"]}
        statuses={[]}
        logins={[login({ kind: "claude", prompt: "paste_code", codeWaiting: true })]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("waiting for your virtual agent");
  });

  it("should offer a password box for the Bedrock API key and save it as the owner's credential when it is not stored", async () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "Your Bedrock API key is stored" }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "azure", "bedrock"]}
        statuses={[]}
        logins={[]}
        paste={ok()}
        save={save}
        now={NOW}
      />
    );

    const item = within(screen.getByRole("list", { name: "Sign-ins" })).getAllByRole("listitem")[2]!;
    expect(item.querySelector("h3")?.textContent).toBe("Bedrock API key");
    expect(item.textContent).toContain("Not stored");
    const input = within(item).getByLabelText("Paste your Bedrock API key");
    expect(input).toHaveProperty("type", "password");
    fireEvent.change(input, { target: { value: "ABSK-pasted" } });
    await act(async () => {
      fireEvent.submit(within(item).getByRole("form", { name: "Save your Bedrock API key" }));
    });

    const sent = (save.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("kind"), sent.get("value")]).toEqual(["bedrock", "ABSK-pasted"]);
    expect(within(item).getByRole("status").textContent).toBe("Your Bedrock API key is stored");
  });

  it("should tick a stored Bedrock API key, count it and not ask for it again when it is stored", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "azure", "bedrock"]}
        statuses={[stored("bedrock")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    const item = within(screen.getByRole("list", { name: "Sign-ins" })).getAllByRole("listitem")[2]!;
    expect(item.textContent).toContain("✓ Stored");
    expect(within(item).queryByRole("form")).toBeNull();
    expect(within(item).queryByRole("textbox")).toBeNull();
    expect(item.querySelector("input")).toBeNull();
    expect(within(item).getByRole("button", { name: "Replace your Bedrock API key" }).querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("1 of 3 stored")).toBeTruthy();
  });

  it("should open the box to replace a stored key and close it again when the pencil and then Cancel are pressed", async () => {
    const save = vi.fn(async () => ({ ok: true as const, confirmation: "Your Jenkins API token is stored" }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={[]}
        optional={["jenkins"]}
        statuses={[stored("jenkins")]}
        logins={[]}
        paste={ok()}
        save={save}
        now={NOW}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace your Jenkins API token" }));
    expect(screen.queryByRole("button", { name: "Replace your Jenkins API token" })).toBeNull();
    const input = screen.getByLabelText("Replace your Jenkins API token");
    expect(input).toHaveProperty("type", "password");
    expect(input).toHaveProperty("value", "");
    fireEvent.change(input, { target: { value: "11a2b3c4d5e6f708192a3b4c5d" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your Jenkins API token" }));
    });
    expect((save.mock.calls[0] as unknown as [FormData])[0].get("kind")).toBe("jenkins");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace your Jenkins API token" })).toBeTruthy();
  });

  it("should offer a box to paste a Claude token when it is not stored and no sign-in is waiting", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["claude"]}
        statuses={[]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByText("Not stored")).toBeTruthy();
    expect(screen.getByLabelText("Paste your Claude token")).toHaveProperty("type", "password");
  });

  it("should count every card shown, the optional ones included, when some are stored", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "azure", "bedrock"]}
        optional={["jenkins"]}
        statuses={[stored("github"), stored("azure"), stored("bedrock")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByText("3 of 4 stored")).toBeTruthy();
    const jenkins = within(screen.getByRole("list", { name: "Sign-ins" })).getAllByRole("listitem")[3]!;
    expect(jenkins.textContent).toContain("Optional");
    expect(within(jenkins).getByLabelText("Paste your Jenkins API token")).toBeTruthy();
  });

  it("should keep every field in the panel to the panel's width when it is narrow", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github", "claude", "bedrock"]}
        optional={["jenkins"]}
        statuses={[]}
        logins={[login({ kind: "claude", prompt: "paste_code", userCode: null })]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    const fields = Array.from(document.querySelectorAll("input:not([type=hidden])"));
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(field.className).toContain("w-full");
      expect(field.className).toContain("min-w-0");
      expect(field.className).not.toMatch(/(^|\s)w-(\d|\[)/);
      expect(field.closest("label")?.className).toContain("min-w-0");
      expect(field.closest("form")?.className).toContain("min-w-0");
    }
  });

  it.each([
    ["github", "GitHub"],
    ["azure", "Azure"]
  ] as const)("should show a stored %s sign-in as connected with a reconnect button rather than a form when it is stored", (kind, title) => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={[kind]}
        statuses={[stored(kind, "alice@justice.gov.uk")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByText("✓ Connected")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByText(/alice@justice\.gov\.uk/)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: `Reconnect ${title}` })
        .querySelector("svg")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("should ask before reconnecting, send the agent and kind, and say it restarts when the agent is running", async () => {
    const reconnect = vi.fn(async () => ({ ok: true as const, confirmation: "pcs-api is restarting to sign in to GitHub again" }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={reconnect}
        needed={["github"]}
        statuses={[stored("github")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
    const confirm = screen.getByRole("group", { name: "Confirm reconnecting GitHub" });
    expect(confirm.textContent).toContain("restart this one");
    expect(reconnect).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Reconnect GitHub" }));
    });

    const sent = (reconnect.mock.calls[0] as unknown as [FormData])[0];
    expect([sent.get("id"), sent.get("kind")]).toEqual(["va-1", "github"]);
  });

  it("should say a stopped agent signs in when it next starts, and send nothing on Cancel, when the agent is stopped", () => {
    const reconnect = vi.fn(async () => ({ ok: true as const }));
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="stopped"
        reconnect={reconnect}
        needed={["azure"]}
        statuses={[stored("azure")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Azure" }));
    const confirm = screen.getByRole("group", { name: "Confirm reconnecting Azure" });
    expect(confirm.textContent).toContain("when it next starts");
    expect(within(confirm).getByRole("button", { name: "Delete Azure sign-in" })).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Azure" })).toBeTruthy();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("should offer no reconnect when the agent is being deleted", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="deleted"
        reconnect={ok()}
        needed={["github"]}
        statuses={[stored("github")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByText("✓ Connected")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should say the last sign-in failed when it did", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["azure"]}
        statuses={[]}
        logins={[login({ kind: "azure", state: "failed" })]}
        paste={ok()}
        save={ok()}
        now={NOW}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain("Azure sign-in failed");
  });

  it("should say why credentials cannot be stored when the deployment has nowhere to keep them", () => {
    render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        reconnect={ok()}
        needed={["github"]}
        statuses={[]}
        logins={[]}
        paste={ok()}
        save={ok()}
        now={NOW}
        unavailable="no vault here"
      />
    );

    expect(screen.getByText("no vault here")).toBeTruthy();
  });
});

describe("LoginCountdown", () => {
  it("should round up to the second and never go below zero when it counts down", () => {
    expect(remaining("2026-10-05T12:01:30.000Z", NOW)).toBe("1:30");
    expect(remaining("2026-10-05T12:00:00.500Z", NOW)).toBe("0:01");
    expect(remaining("2026-10-05T11:00:00.000Z", NOW)).toBe("0:00");
  });

  it("should tick once mounted and say when the code has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<LoginCountdown expiresAt="2026-10-05T12:00:02.000Z" />);

    expect(screen.getByText("for 0:02")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("expired")).toBeTruthy();
  });
});

describe("VirtualAgentRefresh", () => {
  it("should re-read the page when the virtual agent it shows changes, and not for another", () => {
    render(<VirtualAgentRefresh virtualAgentId="va-1" />);

    hubHandlers.get("virtual_agent")?.({ virtual_agent_id: "va-2" });
    expect(refresh).not.toHaveBeenCalled();
    hubHandlers.get("virtual_agent")?.({ virtual_agent_id: "va-1" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("should re-read the list for any of the viewer's virtual agents when it names none", () => {
    render(<VirtualAgentRefresh />);

    hubHandlers.get("virtual_agent")?.({ virtual_agent_id: "va-9" });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Sidebar", () => {
  const data = { mine: [], shared: [], channels: { mine: [], shared: [] }, topics: [] };
  const viewer = { oid: "dev-alice", tid: "dev", name: "Alice" };

  it("should link to the viewer's virtual agents and not to a separate credentials page when the feature is on", () => {
    render(<Sidebar data={data} viewer={viewer} signInDisabled virtualAgents />);

    expect(screen.getByRole("link", { name: "Virtual agents" }).getAttribute("href")).toBe("/virtual");
    expect(screen.queryByRole("link", { name: "Credentials" })).toBeNull();
  });

  it("should link to the credentials page and not mention virtual agents when the feature is off", () => {
    render(<Sidebar data={data} viewer={viewer} signInDisabled />);

    expect(screen.queryByRole("link", { name: "Virtual agents" })).toBeNull();
    expect(screen.getByRole("link", { name: "Credentials" }).getAttribute("href")).toBe("/settings/credentials");
  });
});
