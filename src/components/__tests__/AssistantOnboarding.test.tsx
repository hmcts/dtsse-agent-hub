/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTORS, connectionsPrompt, offeredConnections } from "@/assistant/connections";
import { readiness } from "@/assistant/onboarding";
import type { AssistantSummary } from "@/assistant/views";
import { GettingReady, OnboardingGate } from "@/components/assistant/GettingReady";
import { ANNOUNCE_AFTER_MS } from "@/components/live/Announcer";
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

/** When a stored credential was saved, so a sign-in can be put either side of it on purpose. */
const STORED_AT = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

function statuses(...stored: CredentialKind[]): CredentialStatus[] {
  return stored.map((kind) => ({ kind, stored: true, accountLabel: null, updatedAt: STORED_AT, updatedVia: null }));
}

function login(kind: CredentialKind, overrides: Partial<LoginView> = {}): LoginView {
  return {
    kind,
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: "pending",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    codeWaiting: false,
    ...overrides
  };
}

/** A sign-in that lapsed after the credential it was to replace was saved, which is a credential the pod cannot use. */
function lapsed(kind: CredentialKind, state: "expired" | "failed" = "expired"): LoginView {
  return login(kind, { state, expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 60_000).toISOString() });
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function ready(props: Partial<Parameters<typeof GettingReady>[0]> = {}) {
  return (
    <GettingReady assistant={assistant()} statuses={[]} unavailable={null} paste={ok()} save={ok()} reconnect={ok()} onDone={() => undefined} {...props} />
  );
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

/** What a row offers the person, named, so a row offering two things to do at once is one assertion. */
function formsIn(name: string): (string | null)[] {
  return within(connector(name))
    .getAllByRole("form")
    .map((form) => form.getAttribute("aria-label"));
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

  it("should say a sign-in failed, and offer to make it again, when the last one did", () => {
    render(ready({ assistant: assistant("running", { logins: [login("github", { state: "failed" })] }) }));

    const github = connector("GitHub");
    expect(within(github).getByText("Last sign-in failed")).toBeTruthy();
    expect(within(github).getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  // A key the person pastes has its own way back, so the row says what became of the sign-in and points at it rather
  // than promising an ask that is not coming: nothing re-relays until the pod next starts.
  it("should point a lapsed pasted sign-in at the box that connects it rather than promising another ask", () => {
    render(ready({ assistant: assistant("running", { needed: ["github", "azure", "claude"], logins: [login("claude", { state: "expired" })] }) }));

    const alert = within(connector("Claude")).getByRole("alert").textContent ?? "";
    expect(alert).toContain("ran out before anyone used it");
    expect(alert).toContain("Claude token");
    expect(alert).not.toContain("will ask again");
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

/**
 * The one failure on this screen with no way out from the person's side: being asked for a credential the rows do
 * not cover, or covering it with a row that connects nothing. Either way every row they can see reads as connected,
 * the bar sits where the pod left it, and the ask never clears.
 */
describe("GettingReady asks the person can act on", () => {
  it("should offer the Bedrock key the ask names when the bedrock route is missing it", () => {
    const summary = assistant("awaiting_credentials", { needed: ["github", "azure", "bedrock"] });
    render(ready({ assistant: summary, statuses: statuses("github", "azure") }));

    const missing = connectionsPrompt("connect", summary.needed, new Set<CredentialKind>(["github", "azure"]));
    expect(missing?.message).toContain("AI model access");
    const row = connector("AI model access");
    fireEvent.click(within(row).getByRole("button", { name: "Connect" }));

    const form = within(connector("AI model access")).getByRole("form", { name: "Save your Bedrock API key" });
    expect(within(form).getByLabelText("Bedrock API key")).toBeTruthy();
    expect((form.querySelector('input[name="kind"]') as HTMLInputElement).value).toBe("bedrock");
  });

  // The pod gives up driving `claude setup-token` and asks the owner to paste the token, so a note about a sign-in
  // that is never coming would leave them with the ask and nowhere to answer it.
  it("should offer the Claude token the ask names when the own-licence route is missing it", () => {
    const summary = assistant("awaiting_credentials", { needed: ["github", "azure", "claude"] });
    render(ready({ assistant: summary, statuses: statuses("github", "azure") }));

    const missing = connectionsPrompt("connect", summary.needed, new Set<CredentialKind>(["github", "azure"]));
    expect(missing?.message).toContain("Claude");
    fireEvent.click(within(connector("Claude")).getByRole("button", { name: "Connect" }));

    const form = within(connector("Claude")).getByRole("form", { name: "Save your Claude token" });
    expect(within(form).getByLabelText("Claude token")).toBeTruthy();
    expect((form.querySelector('input[name="kind"]') as HTMLInputElement).value).toBe("claude");
  });

  // Asking to connect and then having the pod relay its code is the usual order on the Claude row, and two password
  // boxes posting to different places is worse than either alone: a token typed into the code box reaches the pod and
  // comes back only as a sign-in that did not work.
  it("should offer the relayed sign-in alone when one arrives after the person asked to connect", () => {
    const summary = assistant("awaiting_credentials", { needed: ["github", "azure", "claude"] });
    const { rerender } = render(ready({ assistant: summary, statuses: statuses("github", "azure") }));
    fireEvent.click(within(connector("Claude")).getByRole("button", { name: "Connect" }));

    expect(formsIn("Claude")).toEqual(["Save your Claude token"]);

    const relayed = assistant("awaiting_login", {
      needed: ["github", "azure", "claude"],
      logins: [login("claude", { prompt: "paste_code", userCode: null })]
    });
    rerender(ready({ assistant: relayed, statuses: statuses("github", "azure") }));

    expect(formsIn("Claude")).toEqual(["Paste the Claude code"]);
    expect(connector("Claude").querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it("should offer a row for a sign-in the assistant is waiting on that it would not offer unasked", () => {
    const summary = assistant("awaiting_login", { needed: ["github", "azure", "bedrock"], logins: [login("jenkins")] });
    render(ready({ assistant: summary, statuses: statuses("github", "azure", "bedrock", "atlassian") }));

    const jenkins = connector("Jenkins");
    expect(within(jenkins).getByText("Waiting for you")).toBeTruthy();
    expect(within(jenkins).getByText("ABCD-1234")).toBeTruthy();
  });

  it("should leave nothing the assistant is waiting on off the list", () => {
    const waitingOn: CredentialKind[] = ["azure", "jenkins"];
    const summary = assistant("awaiting_login", { needed: ["github", "azure", "bedrock"], logins: waitingOn.map((kind) => login(kind)) });
    render(ready({ assistant: summary, statuses: statuses("github", "bedrock", "atlassian") }));

    const shown = offeredConnections(summary).map((row) => String(row.kind));
    expect(waitingOn.filter((kind) => !shown.includes(kind))).toEqual([]);
    for (const kind of waitingOn) {
      expect(within(connector(CONNECTORS[kind]?.name ?? kind)).getByText("Waiting for you")).toBeTruthy();
    }
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

/**
 * The hub failing to read someone's credentials looks exactly like their having stored none — `onboarded` is false
 * either way — so these pin the two apart from the person's side: nobody is asked to connect what the hub has not
 * looked at, and the screen says which of the two it is.
 */
describe("GettingReady when the hub cannot read the credentials", () => {
  const REASON = "this deployment has no credentials vault, so credentials cannot be stored here";

  /** What the page passes when the credential store cannot be read: the reason, and no statuses to go on. */
  function unreadable(props: Partial<Parameters<typeof GettingReady>[0]> = {}) {
    return ready({ unavailable: REASON, statuses: [], ...props });
  }

  it("should say the sign-ins cannot be read, and why, when the credential store cannot be read", () => {
    render(unreadable());

    expect(screen.getByText(/cannot read your sign-ins/)).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });

  it("should ask for no account, and let the person past, when the hub cannot tell what they have connected", () => {
    const onDone = vi.fn();
    render(unreadable({ onDone }));

    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect the accounts above to continue" })).toBeNull();
    const carryOn = screen.getByRole("button", { name: "Carry on" }) as HTMLButtonElement;
    expect(carryOn.disabled).toBe(false);

    fireEvent.click(carryOn);
    expect(onDone).toHaveBeenCalled();
  });
});

describe("OnboardingGate", () => {
  function gate(summary: AssistantSummary, stored: CredentialStatus[] = [], dismissed = false) {
    return <OnboardingGate assistant={summary} statuses={stored} unavailable={null} paste={ok()} save={ok()} reconnect={ok()} dismissed={dismissed} />;
  }

  it("should ask for nothing when every needed account is connected and the hub can read them", () => {
    render(
      <OnboardingGate
        assistant={assistant("running", { onboarded: true })}
        statuses={statuses("github", "azure", "claude")}
        unavailable={null}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
      />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  const UNREADABLE = "this deployment has no credentials vault, so credentials cannot be stored here";

  /** What the page passes when the hub cannot read the credential store: the reason, and no statuses to go on. */
  function unreadable(summary: AssistantSummary = assistant("running"), dismissed = false) {
    return <OnboardingGate assistant={summary} statuses={[]} unavailable={UNREADABLE} paste={ok()} save={ok()} reconnect={ok()} dismissed={dismissed} />;
  }

  it("should let the person into their chat, and ask them for nothing, when the hub cannot read the credentials", () => {
    render(unreadable());

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect accounts" })).toBeNull();
    const banner = screen.getByRole("region", { name: "Your sign-ins cannot be checked" });
    expect(banner.textContent).toContain("still connected");
    for (const name of ["GitHub", "Azure", "Claude"]) {
      expect(banner.textContent).not.toContain(name);
    }
  });

  it("should say why on the screen when someone the hub cannot read the credentials for opens it", () => {
    render(unreadable());

    fireEvent.click(screen.getByRole("button", { name: "Show progress" }));

    expect(screen.getByText(/cannot read your sign-ins/)).toBeTruthy();
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Carry on" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Unlike the ask to connect, this one can be sent away: there is nothing for the person to do about it, so saying
  // it once is enough. The same cookie carries that choice, so a navigation does not say it again.
  it("should go when the person sends away a message about sign-ins that cannot be checked", () => {
    render(unreadable());

    fireEvent.click(screen.getByRole("button", { name: "Hide this message" }));

    expect(screen.queryByRole("region", { name: "Your sign-ins cannot be checked" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should stay gone across a navigation when the page has read that choice from the cookie", () => {
    render(unreadable(assistant("running"), true));

    expect(screen.queryByRole("region", { name: "Your sign-ins cannot be checked" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should never offer to hide the ask to connect, which is the one with something left to do", () => {
    render(gate(assistant("awaiting_credentials")));

    expect(screen.getByRole("region", { name: "Connect your accounts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide this message" })).toBeNull();
  });

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

  it("should name every needed connection when the person has stored none of them", () => {
    render(gate(assistant()));

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

  // Someone who has onboarded is asked only for a sign-in their pod has stopped for, and the screen the ask opens has
  // to have that sign-in on it: a screen listing every other connection as connected is an ask nobody can clear.
  it("should list the sign-in the pod is waiting on when someone who has onboarded opens the progress", () => {
    const summary = assistant("awaiting_login", {
      needed: ["github", "azure", "bedrock"],
      onboarded: true,
      logins: [login("jenkins")]
    });
    render(gate(summary, statuses("github", "azure", "bedrock", "atlassian"), true));

    expect(screen.getByRole("region", { name: "Sign in again" }).textContent).toContain("sign in to Jenkins");
    fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

    expect(within(connector("Jenkins")).getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("55");
  });

  /**
   * A sign-in relayed while the person is already in a conversation has to reach them there. None of the gate's
   * latches may hide it: `waiting` and `ranOnce` are settled by the time it arrives, an optional kind raises no
   * connections ask, and the Jira footer shows a code only while an export is pending. A pod's code lasts two
   * minutes, so an ask that waits for a navigation is an ask that arrives after the code is dead.
   */
  describe("a sign-in relayed after the page loaded", () => {
    const ONBOARDED: CredentialKind[] = ["github", "azure", "claude", "atlassian"];

    function running(logins: LoginView[]) {
      return assistant("running", { onboarded: true, logins });
    }

    it("should ask on a banner when a sign-in arrives for someone whose assistant is already up", () => {
      const { rerender } = render(gate(running([]), statuses(...ONBOARDED)));
      expect(screen.queryByRole("region")).toBeNull();

      rerender(gate(assistant("awaiting_login", { onboarded: true, logins: [login("atlassian")] }), statuses(...ONBOARDED)));

      const banner = screen.getByRole("region", { name: "Sign in again" });
      expect(banner.textContent).toContain("Your assistant is waiting for you to sign in to Atlassian.");
    });

    it("should show the code when the person opens the sign-in from that banner", () => {
      render(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

      expect(screen.getByRole("dialog", { name: "Your assistant is ready" })).toBeTruthy();
      expect(within(connector("Atlassian")).getByText("ABCD-1234")).toBeTruthy();
    });

    it("should put the banner back when the person closes the sign-in on Escape", () => {
      render(gate(running([login("atlassian")]), statuses(...ONBOARDED)));
      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("region", { name: "Sign in again" })).toBeTruthy();
    });

    it("should never offer to hide the ask, which is the only thing saying a code is waiting", () => {
      render(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      expect(screen.queryByRole("button", { name: "Hide this message" })).toBeNull();
    });

    it("should stop asking once the sign-in is over and done with", () => {
      render(gate(running([login("atlassian", { state: "completed" })]), statuses(...ONBOARDED)));

      expect(screen.queryByRole("region")).toBeNull();
    });

    // `failLogin` returns the assistant to `running` as the last code dies, so by then the status says nothing and
    // the credential is still stored. The login row is the only thing left that knows, and the ask reads from it.
    it("should ask about a stored sign-in that a later sign-in lapsed over", () => {
      render(gate(running([lapsed("atlassian")]), statuses(...ONBOARDED)));

      expect(screen.getByRole("region", { name: "Sign in again" }).textContent).toContain("sign in to Atlassian");
    });

    it("should offer the person a way to have their assistant sign in again when the stored sign-in has lapsed", async () => {
      const reconnect = ok();
      render(
        <OnboardingGate
          assistant={running([lapsed("atlassian")])}
          statuses={statuses(...ONBOARDED)}
          unavailable={null}
          paste={ok()}
          save={ok()}
          reconnect={reconnect}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

      const row = connector("Atlassian");
      expect(within(row).queryByText("✓ Connected")).toBeNull();
      expect(within(row).getByText("Sign-in expired")).toBeTruthy();
      fireEvent.click(within(row).getByRole("button", { name: "Sign in again" }));
      await act(async () => {
        fireEvent.submit(within(connector("Atlassian")).getByRole("form", { name: "Sign in to Atlassian again" }));
      });

      const sent = (reconnect.mock.calls[0] as unknown as [FormData])[0];
      expect([sent.get("id"), sent.get("kind")]).toEqual([ASSISTANT, "atlassian"]);
    });

    /**
     * `reconnectSignIn` deletes a `credential` row, which is one per owner and kind, so it takes the value every
     * virtual agent the person owns uses — and what marks this row lapsed is this agent's own login row, which says
     * nothing about the others. So it asks before it does that, and says what it will take.
     */
    it("should ask before deleting the sign-in every one of their virtual agents uses", async () => {
      const reconnect = ok();
      render(
        <OnboardingGate
          assistant={running([lapsed("atlassian")])}
          statuses={statuses(...ONBOARDED)}
          unavailable={null}
          paste={ok()}
          save={ok()}
          reconnect={reconnect}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

      expect(within(connector("Atlassian")).queryByRole("form")).toBeNull();
      fireEvent.click(within(connector("Atlassian")).getByRole("button", { name: "Sign in again" }));

      const row = connector("Atlassian");
      expect(row.textContent).toContain("which all your virtual agents use");
      expect(row.textContent).toContain("Your chats are kept");
      await act(async () => undefined);
      expect(reconnect).not.toHaveBeenCalled();
    });

    it("should let the person change their mind about signing in again", () => {
      render(gate(running([lapsed("atlassian")]), statuses(...ONBOARDED)));
      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));
      fireEvent.click(within(connector("Atlassian")).getByRole("button", { name: "Sign in again" }));

      fireEvent.click(within(connector("Atlassian")).getByRole("button", { name: "Cancel" }));

      expect(within(connector("Atlassian")).queryByRole("form")).toBeNull();
      expect(within(connector("Atlassian")).getByRole("button", { name: "Sign in again" })).toBeTruthy();
    });

    /**
     * Where `reconnectSignIn` leaves the person: the credential deleted, the login row still lapsed, and the pod
     * restarting. Nothing in the hub re-relays, so the row has to keep offering the only thing that asks — and say
     * the truth about it, which is now a restart and not a deletion.
     */
    it("should keep offering the sign-in, and promise no deletion, once the credential has gone with it", () => {
      render(gate(running([lapsed("atlassian")]), statuses("github", "azure", "claude")));

      fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));
      fireEvent.click(within(connector("Atlassian")).getByRole("button", { name: "Sign in again" }));

      const row = connector("Atlassian");
      expect(within(row).getByRole("form", { name: "Sign in to Atlassian again" })).toBeTruthy();
      expect(row.textContent).not.toContain("Delete");
      expect(row.textContent).not.toContain("will appear here");
    });

    it("should say nothing is waiting on the person once they have sent the code back", () => {
      const sent = login("claude", { prompt: "paste_code", userCode: null, codeWaiting: true });
      render(gate(assistant("awaiting_login", { onboarded: true, logins: [sent] }), statuses(...ONBOARDED)));

      expect(screen.queryByRole("region", { name: "Sign in again" })).toBeNull();
    });

    it("should announce the ask, which arrives after the page and so is not read by being there", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(gate(running([]), statuses(...ONBOARDED)));

        rerender(gate(running([login("atlassian")]), statuses(...ONBOARDED)));
        act(() => {
          vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
        });

        expect(screen.getByTestId("arrivals").textContent).toContain("sign in to Atlassian");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should ask for nothing when a sign-in failed before the credential it belongs with was stored", () => {
      const stale = login("atlassian", { state: "failed", updatedAt: new Date(Date.parse(STORED_AT) - 60_000).toISOString() });
      render(gate(running([stale]), statuses(...ONBOARDED)));

      expect(screen.queryByRole("region")).toBeNull();
    });

    it("should ask for nothing while the hub cannot read the credentials, which say nothing about any sign-in", () => {
      render(
        <OnboardingGate assistant={running([lapsed("atlassian")])} statuses={[]} unavailable={UNREADABLE} paste={ok()} save={ok()} reconnect={ok()} dismissed />
      );

      expect(screen.queryByRole("region", { name: "Sign in again" })).toBeNull();
    });

    /**
     * The bar for the ask: an unhideable banner naming a sign-in with nothing to do about it is the fault this PR is
     * for, not a report of it. So for every state a sign-in can be in, either no ask is raised or the screen the ask
     * opens has a row for that sign-in with something on it that connects it — a code to enter, a box to paste a new
     * value into, or a sign-in to have the assistant make again.
     *
     * Exhaustive over the connections the Assistant words and over what can become of a relayed sign-in, because the
     * two states that got through review were adjacent ones: a Jenkins sign-in reported lapsed, which the banner
     * named and the screen had no row for, and an Atlassian one lapsed with nothing stored, whose only control said
     * the assistant would ask again when nothing was going to.
     */
    describe("every ask it raises", () => {
      const LIVE = () => new Date(Date.now() + 10 * 60_000).toISOString();
      const PAST = () => new Date(Date.now() - 60_000).toISOString();
      const SITUATIONS = {
        "a live code": (kind: CredentialKind) => login(kind, { expiresAt: LIVE() }),
        "a code that ran out with no pod report": (kind: CredentialKind) => login(kind, { expiresAt: PAST() }),
        "a sign-in reported expired": (kind: CredentialKind) => lapsed(kind),
        "a sign-in reported failed": (kind: CredentialKind) => lapsed(kind, "failed"),
        "a sign-in the person has sent a code back for": (kind: CredentialKind) => login(kind, { prompt: "paste_code", userCode: null, codeWaiting: true })
      };
      const CASES = (["github", "azure", "claude", "bedrock", "jenkins", "atlassian"] as const).flatMap((kind) =>
        Object.keys(SITUATIONS).flatMap((situation) => [true, false].map((held) => ({ kind, situation, held })))
      );

      /** What `kind` is called on the screen, which is how its row is found. */
      function named(kind: CredentialKind): string {
        return CONNECTORS[kind]?.name ?? kind;
      }

      it.each(CASES)("should be one the person can act on for $kind with $situation when its credential is stored: $held", ({ kind, situation, held }) => {
        const relayed = SITUATIONS[situation as keyof typeof SITUATIONS](kind);
        // Nothing the assistant needs is ever the kind under test, so `onboarded` is honestly true and the ask under
        // test is the sign-in one rather than the connect one.
        const summary = assistant("running", { needed: ["bedrock"], optional: ["jenkins", "atlassian"], onboarded: true, logins: [relayed] });
        render(gate(summary, held ? statuses("bedrock", kind) : statuses("bedrock")));

        // Asserted rather than skipped past, so every case says something: the one sign-in that is not waiting on
        // the person is the one whose code they have already sent back, and every other state raises the ask.
        const asked = screen.queryByRole("region", { name: "Sign in again" }) !== null;
        expect(asked).toBe(situation !== "a sign-in the person has sent a code back for");
        if (!asked) {
          return;
        }
        fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));
        // A key the person pastes opens its box on Connect; everything else already shows what it has.
        const connect = within(connector(named(kind))).queryByRole("button", { name: "Connect" });
        if (connect !== null) {
          fireEvent.click(connect);
        }
        const row = connector(named(kind));
        const pressable =
          within(row).queryAllByRole("form").length > 0 ||
          within(row).queryByRole("button", { name: "Sign in again" }) !== null ||
          row.querySelector("code") !== null;

        expect(pressable).toBe(true);
      });
    });
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
