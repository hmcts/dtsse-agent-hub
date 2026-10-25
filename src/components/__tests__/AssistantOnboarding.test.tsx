/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readiness } from "@/assistant/onboarding";
import type { AssistantSummary } from "@/assistant/views";
import { GettingReady, OnboardingGate } from "@/components/assistant/GettingReady";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { VirtualAgentStatus } from "@/virtual-agents/lifecycle";
import type { LoginView } from "@/virtual-agents/logins";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
});

const ASSISTANT = "0f8a6a1e-0000-4000-8000-000000000001";

function assistant(status: VirtualAgentStatus = "provisioning", overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: ASSISTANT,
    name: "assistant",
    desired: "running",
    status,
    statusDetail: null,
    statusChangedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    readiness: readiness(status),
    needed: ["github", "azure", "claude"],
    optional: ["jenkins", "atlassian"],
    logins: [],
    onboarded: false,
    ...overrides
  };
}

function statuses(...stored: CredentialKind[]): CredentialStatus[] {
  return stored.map((kind) => ({ kind, stored: true, accountLabel: null, updatedAt: null, updatedVia: null }));
}

function login(kind: CredentialKind, overrides: Partial<LoginView> = {}): LoginView {
  return {
    kind,
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: "pending",
    codeWaiting: false,
    ...overrides
  };
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function ready(props: Partial<Parameters<typeof GettingReady>[0]> = {}) {
  return <GettingReady assistant={assistant()} statuses={[]} unavailable={null} paste={ok()} save={ok()} onDone={() => undefined} {...props} />;
}

function connector(name: string): HTMLElement {
  const item = within(screen.getByRole("list", { name: "Connections" }))
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(name, { exact: true }) !== null);
  if (item === undefined) {
    throw new Error(`no connector ${name}`);
  }
  return item;
}

describe("GettingReady progress", () => {
  it("should show how far the assistant has got when it is starting", () => {
    render(ready());

    expect(screen.getByRole("heading", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Getting your assistant ready" }).getAttribute("aria-valuenow")).toBe("30");
    expect(screen.getByRole("status").textContent).toBe("Starting your assistant…");
  });

  it("should say the assistant is ready when it is running", () => {
    render(ready({ assistant: assistant("running") }));

    expect(screen.getByRole("heading", { name: "Your assistant is ready" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("should say the assistant could not start and why when it failed", () => {
    render(ready({ assistant: assistant("failed", { statusDetail: "image pull failed" }) }));

    expect(screen.getByRole("heading", { name: "Your assistant could not start" })).toBeTruthy();
    expect(screen.getByText("image pull failed")).toBeTruthy();
  });

  it("should say the assistant is unavailable when the page says so", () => {
    render(ready({ unavailable: "Virtual agents are not available here" }));

    expect(screen.getByText("Virtual agents are not available here")).toBeTruthy();
  });
});

describe("GettingReady connectors", () => {
  it("should list the needed connections and Atlassian but not Jenkins when rendering the connections", () => {
    render(ready());

    const items = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    ["GitHub", "Azure", "Claude", "Atlassian"].forEach((name, index) => {
      expect(within(items[index] as HTMLElement).getByText(name, { exact: true })).toBeTruthy();
    });
    expect(screen.queryByText("Jenkins")).toBeNull();
  });

  it("should show a stored connection as connected", () => {
    render(ready({ statuses: statuses("github") }));

    expect(within(connector("GitHub")).getByText("✓ Connected")).toBeTruthy();
  });

  it("should show the device code to enter when the assistant is waiting on a device sign-in", () => {
    render(ready({ assistant: assistant("awaiting_login", { logins: [login("azure")] }) }));

    const azure = connector("Azure");
    expect(within(azure).getByText("Waiting for you")).toBeTruthy();
    expect(within(azure).getByText("ABCD-1234")).toBeTruthy();
    expect(within(azure).getByRole("link", { name: "the Azure sign-in page" }).getAttribute("href")).toBe("https://example.com/device");
  });

  it("should offer a form to paste the code when the sign-in gives the person a code to paste back", () => {
    render(ready({ assistant: assistant("awaiting_login", { logins: [login("claude", { prompt: "paste_code", userCode: null })] }) }));

    const claude = connector("Claude");
    expect(within(claude).getByText("Waiting for you")).toBeTruthy();
    const form = within(claude).getByRole("form", { name: "Paste the Claude code" });
    expect(within(form).getByLabelText("Claude code")).toBeTruthy();
  });

  it("should say the code arrived when the person has pasted one the pod has yet to fetch", () => {
    render(ready({ assistant: assistant("awaiting_login", { logins: [login("claude", { prompt: "paste_code", userCode: null, codeWaiting: true })] }) }));

    expect(within(connector("Claude")).getByText(/Got it/)).toBeTruthy();
    expect(within(connector("Claude")).queryByRole("form")).toBeNull();
  });

  it("should say a sign-in failed when the last one did", () => {
    render(ready({ assistant: assistant("running", { logins: [login("github", { state: "failed" })] }) }));

    expect(within(connector("GitHub")).getByRole("alert").textContent).toContain("did not work");
  });

  it("should show a sign-in as connecting while the assistant is starting", () => {
    render(ready());

    expect(within(connector("GitHub")).getByText("Connecting…")).toBeTruthy();
    expect(within(connector("GitHub")).queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("should show a sign-in as connecting with a note once the person clicks Connect on a running assistant", () => {
    render(ready({ assistant: assistant("running") }));

    fireEvent.click(within(connector("GitHub")).getByRole("button", { name: "Connect" }));

    expect(within(connector("GitHub")).getByText("Connecting…")).toBeTruthy();
    expect(within(connector("GitHub")).getByText(/The sign-in will appear here/)).toBeTruthy();
  });

  it("should offer a form for the Bedrock key once the person clicks Connect, even while the assistant starts", () => {
    render(ready({ assistant: assistant("provisioning", { needed: ["github", "azure", "bedrock"] }) }));

    const bedrock = connector("AI model access");
    expect(within(bedrock).queryByRole("form")).toBeNull();
    fireEvent.click(within(bedrock).getByRole("button", { name: "Connect" }));

    const form = within(connector("AI model access")).getByRole("form", { name: "Save your Bedrock API key" });
    expect((within(form).getByLabelText("Bedrock API key") as HTMLInputElement).type).toBe("password");
  });
});

describe("GettingReady continue", () => {
  it("should not let the person carry on when a needed account is still to connect", () => {
    const onDone = vi.fn();
    render(ready({ onDone }));

    const button = screen.getByRole("button", { name: "Connect the accounts above to continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("should let the person start chatting when every needed account is connected", () => {
    const onDone = vi.fn();
    render(ready({ assistant: assistant("running", { onboarded: true }), statuses: statuses("github", "azure", "claude"), onDone }));

    fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));

    expect(onDone).toHaveBeenCalled();
  });

  it("should offer the way out of the screen while a needed account is still to connect", () => {
    const onLeave = vi.fn();
    render(ready({ onLeave }));

    fireEvent.click(screen.getByRole("button", { name: "Go to your chats" }));

    expect(onLeave).toHaveBeenCalled();
  });

  it("should offer no way out beside Start chatting once every needed account is connected", () => {
    render(ready({ assistant: assistant("running", { onboarded: true }), statuses: statuses("github", "azure", "claude"), onLeave: vi.fn() }));

    expect(screen.getByRole("button", { name: "Start chatting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to your chats" })).toBeNull();
  });
});

describe("OnboardingGate", () => {
  function gate(summary: AssistantSummary, stored: CredentialStatus[] = [], dismissed = false) {
    return <OnboardingGate assistant={summary} statuses={stored} unavailable={null} paste={ok()} save={ok()} dismissed={dismissed} />;
  }

  it("should show nothing when the person had onboarded before the visit and their assistant is running", () => {
    render(gate(assistant("running", { onboarded: true })));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Nothing covers the page until the person asks for it. The connections screen is `fixed inset-0`, so showing it
  // unbidden takes away the sidebar, every conversation and the settings that could fix whatever is missing — and
  // whether a needed credential can be stored at all is not only up to them.
  it("should ask on a banner, over nothing, when the person has a connection still to make", () => {
    render(gate(assistant("awaiting_credentials"), statuses("github")));

    expect(screen.queryByRole("dialog")).toBeNull();
    const banner = screen.getByRole("region", { name: "Connect your accounts" });
    expect(banner.textContent).toContain("Your assistant needs Azure and Claude before it can work for you.");
    expect(within(banner).getByRole("button", { name: "Connect accounts" })).toBeTruthy();
  });

  it("should name every connection in general when the hub could not read what is stored", () => {
    render(gate(assistant(), [], false));

    expect(screen.getByRole("region", { name: "Connect your accounts" }).textContent).toContain("needs GitHub, Azure and Claude");
  });

  it("should open the connections when the person asks for them from the banner", () => {
    render(gate(assistant()));

    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should put the banner back when the person leaves the connections with one still to make", () => {
    render(gate(assistant()));
    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    fireEvent.click(screen.getByRole("button", { name: "Go to your chats" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your accounts" })).toBeTruthy();
  });

  it("should leave the connections on Escape when one is still to make", () => {
    render(gate(assistant()));
    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your accounts" })).toBeTruthy();
  });

  it("should keep asking on the banner across a navigation when the person has yet to connect everything", () => {
    render(gate(assistant(), [], true));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your accounts" })).toBeTruthy();
  });

  it("should stay until the person chooses Start chatting when they finish onboarding during the visit", () => {
    const { rerender } = render(gate(assistant()));
    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();

    rerender(gate(assistant("running", { onboarded: true })));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Connect your accounts" })).toBeNull();
  });
});
