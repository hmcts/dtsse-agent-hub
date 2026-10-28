/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTORS, canSignInAgain, connectionsPrompt, offeredConnections, signsInOnRequest } from "@/assistant/connections";
import { readiness } from "@/assistant/onboarding";
import type { AssistantSummary } from "@/assistant/views";
import { GettingReady, OnboardingGate } from "@/components/assistant/GettingReady";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { VirtualAgentStatus } from "@/virtual-agents/lifecycle";
import type { LoginView } from "@/virtual-agents/logins";
import { neededCredentials, OPTIONAL_CREDENTIALS } from "@/virtual-agents/views";

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
    needed: neededCredentials("own-licence"),
    optional: OPTIONAL_CREDENTIALS,
    logins: [],
    onboarded: false,
    // Empty, so `chatGate` stays open: most of these set `onboarded` without the statuses behind it, and are about
    // the banner and the sign-ins. The gate has tests of its own below that give it both.
    toChat: [],
    models: [],
    defaultModel: "claude-sonnet-5-5",
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
    codeWaitingUntil: null,
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
    <GettingReady
      assistant={assistant()}
      statuses={[]}
      unavailable={null}
      paste={ok()}
      save={ok()}
      reconnect={ok()}
      now={Date.now()}
      onDone={() => undefined}
      {...props}
    />
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
  it("should list the needed connections and Atlassian but neither Azure nor Jenkins when rendering the connections", () => {
    render(ready());

    const items = within(screen.getByRole("list", { name: "Connections" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    ["GitHub", "Claude", "Atlassian"].forEach((name, index) => {
      expect(within(items[index] as HTMLElement).getByText(name, { exact: true })).toBeTruthy();
    });
    expect(screen.queryByText("Jenkins")).toBeNull();
    expect(screen.queryByText("Azure")).toBeNull();
  });

  it("should list an Azure row with its code when the person asked for an Azure sign-in", () => {
    render(ready({ assistant: assistant("awaiting_login", { logins: [login("azure")] }) }));

    expect(within(connector("Azure")).getByText("ABCD-1234")).toBeTruthy();
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

  /**
   * A pasted code keeps for `PASTED_CODE_TTL_MS` while the sign-in itself can run for `MAX_LOGIN_SECONDS`, and
   * `takePastedCode` gives the pod nothing past the deadline without clearing the column. So the row has to go by
   * whether the code is still collectable: `storePastedCode` would take another, and the box is how they send it.
   */
  it("should ask for the code again when the one the person pasted is past being collected", () => {
    const stale = login("claude", {
      prompt: "paste_code",
      userCode: null,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      codeWaitingUntil: new Date(Date.now() - 60_000).toISOString()
    });
    render(ready({ assistant: assistant("awaiting_login", { logins: [stale] }) }));

    const claude = within(connector("Claude"));
    expect(claude.queryByText(/Got it/)).toBeNull();
    expect(claude.getByRole("form", { name: "Paste the Claude code" })).toBeTruthy();
  });

  it("should say the code arrived when the person has pasted one the pod has yet to fetch", () => {
    render(
      ready({
        assistant: assistant("awaiting_login", {
          logins: [login("claude", { prompt: "paste_code", userCode: null, codeWaitingUntil: new Date(Date.now() + 5 * 60_000).toISOString() })]
        })
      })
    );

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

    const form = within(connector("AI model access")).getByRole("form", { name: "Save your Claude Code key" });
    expect((within(form).getByLabelText("Claude Code key") as HTMLInputElement).type).toBe("password");
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

    const form = within(connector("AI model access")).getByRole("form", { name: "Save your Claude Code key" });
    expect(within(form).getByLabelText("Claude Code key")).toBeTruthy();
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

    const shown = offeredConnections(summary, Date.now()).map((row) => String(row.kind));
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
    return (
      <OnboardingGate
        assistant={summary}
        statuses={stored}
        unavailable={null}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={Date.now()}
        dismissed={dismissed}
      />
    );
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
        now={Date.now()}
      />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  const UNREADABLE = "this deployment has no credentials vault, so credentials cannot be stored here";

  /** What the page passes when the hub cannot read the credential store: the reason, and no statuses to go on. */
  function unreadable(summary: AssistantSummary = assistant("running"), dismissed = false) {
    return (
      <OnboardingGate
        assistant={summary}
        statuses={[]}
        unavailable={UNREADABLE}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={Date.now()}
        dismissed={dismissed}
      />
    );
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

  // Short of GitHub and Claude, which the gate's own tests cover, nothing covers the page until the person asks for
  // it. The connections screen is `fixed inset-0`, so showing it unbidden takes away the sidebar, every conversation
  // and the settings.
  it("should ask on a banner, over nothing, when the person has a connection still to make", () => {
    render(gate(assistant("awaiting_credentials"), statuses("github")));

    expect(screen.queryByRole("dialog")).toBeNull();
    const banner = screen.getByRole("region", { name: "Connect your accounts" });
    expect(banner.textContent).toContain("Your assistant needs Claude before it can work for you.");
    expect(within(banner).getByRole("button", { name: "Connect accounts" })).toBeTruthy();
  });

  it("should name every needed connection when the person has stored none of them", () => {
    render(gate(assistant()));

    expect(screen.getByRole("region", { name: "Connect your accounts" }).textContent).toContain("needs GitHub and Claude");
  });

  it("should not mention Azure anywhere above the chats when Azure is not connected", () => {
    render(gate(assistant("awaiting_credentials"), statuses("github")));

    expect(screen.getByRole("region", { name: "Connect your accounts" }).textContent).not.toContain("Azure");
  });

  it("should raise no banner, and count the person as onboarded, when only Azure is missing", () => {
    const summary = assistant("running", { onboarded: true });
    render(gate(summary, statuses("github", "claude")));

    expect(screen.queryByRole("region", { name: "Connect your accounts" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sign in" })).toBeNull();
    expect(document.body.textContent).not.toContain("Azure");
  });

  it("should raise no sign-in ask for an Azure sign-in the person asked for and let lapse", () => {
    const summary = assistant("running", { onboarded: true, logins: [lapsed("azure")] });
    render(gate(summary, statuses("github", "claude")));

    expect(screen.queryByRole("region", { name: "Sign in" })).toBeNull();
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

    expect(screen.getByRole("region", { name: "Sign in" }).textContent).toContain("sign in to Jenkins");
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

      const banner = screen.getByRole("region", { name: "Sign in" });
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
      expect(screen.getByRole("region", { name: "Sign in" })).toBeTruthy();
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

      expect(screen.getByRole("region", { name: "Sign in" }).textContent).toContain("could not sign in to Atlassian, and is not asking again by itself");
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
          now={Date.now()}
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
          now={Date.now()}
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
      const sent = login("claude", { prompt: "paste_code", userCode: null, codeWaitingUntil: new Date(Date.now() + 5 * 60_000).toISOString() });
      render(gate(assistant("awaiting_login", { onboarded: true, logins: [sent] }), statuses(...ONBOARDED)));

      expect(screen.queryByRole("region", { name: "Sign in" })).toBeNull();
    });

    it("should read out the ask, which arrives after the page and so is not read by being there", () => {
      const { rerender } = render(gate(running([]), statuses(...ONBOARDED)));
      expect(screen.getByTestId("sign-in-ask").textContent).toBe("");

      rerender(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      expect(screen.getByTestId("sign-in-ask").textContent).toBe("Your assistant is waiting for you to sign in to Atlassian.");
    });

    // A sentence, not a count: two asks a second apart would read as "2 new sign-ins", which names neither and says
    // nothing to do about either.
    it("should read out both sign-ins when a second one joins the first", () => {
      const { rerender } = render(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      rerender(gate(running([login("atlassian"), login("github")]), statuses(...ONBOARDED)));

      expect(screen.getByTestId("sign-in-ask").textContent).toContain("GitHub and Atlassian");
    });

    // The message says what there is to do, so a fresh code arriving over a lapsed sign-in changes it — a sentence
    // keyed to the names alone would be the same text and read out nothing, while the row went from a button to a code.
    it("should read out the fresh code when one arrives for a sign-in that had lapsed", () => {
      const { rerender } = render(gate(running([lapsed("atlassian")]), statuses(...ONBOARDED)));
      const before = screen.getByTestId("sign-in-ask").textContent;

      rerender(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      expect(screen.getByTestId("sign-in-ask").textContent).not.toBe(before);
      expect(screen.getByTestId("sign-in-ask").textContent).toContain("waiting for you to sign in to Atlassian");
    });

    it("should read out nothing once the ask has cleared", () => {
      const { rerender } = render(gate(running([login("atlassian")]), statuses(...ONBOARDED)));

      rerender(gate(running([login("atlassian", { state: "completed" })]), statuses(...ONBOARDED)));

      expect(screen.getByTestId("sign-in-ask").textContent).toBe("");
    });

    it("should ask for nothing when a sign-in failed before the credential it belongs with was stored", () => {
      const stale = login("atlassian", { state: "failed", updatedAt: new Date(Date.parse(STORED_AT) - 60_000).toISOString() });
      render(gate(running([stale]), statuses(...ONBOARDED)));

      expect(screen.queryByRole("region")).toBeNull();
    });

    /**
     * `saveCredential` refuses a Claude token from somebody whose agents run on Amazon Bedrock, and a lapsed Claude
     * row's only control is that box. Nothing clears the login row either, so an ask here would be one the person
     * can neither satisfy nor dismiss, for as long as they use the Assistant.
     */
    it("should ask for nothing when the only lapsed sign-in is one the hub would take no value for", () => {
      const summary = assistant("running", { needed: ["github", "azure", "bedrock"], onboarded: true, logins: [lapsed("claude")] });
      render(gate(summary, statuses("github", "azure", "bedrock", "atlassian")));

      expect(screen.queryByRole("region")).toBeNull();
    });

    it("should still ask while that sign-in's code is live, which goes back through the pod rather than the hub", () => {
      const summary = assistant("running", { needed: ["github", "azure", "bedrock"], onboarded: true, logins: [login("claude")] });
      render(gate(summary, statuses("github", "azure", "bedrock", "atlassian")));

      expect(screen.getByRole("region", { name: "Sign in" }).textContent).toContain("sign in to Claude");
    });

    it("should ask for nothing while the hub cannot read the credentials, which say nothing about any sign-in", () => {
      render(
        <OnboardingGate
          assistant={running([lapsed("atlassian")])}
          statuses={[]}
          unavailable={UNREADABLE}
          paste={ok()}
          save={ok()}
          reconnect={ok()}
          now={Date.now()}
          dismissed
        />
      );

      expect(screen.queryByRole("region", { name: "Sign in" })).toBeNull();
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
      /** What the assistant under test needs and offers, and so the credentials the hub would take from the person. */
      const NEEDS: CredentialKind[] = ["bedrock"];
      const OFFERS: CredentialKind[] = ["jenkins", "atlassian"];
      const SITUATIONS = {
        "a live code": { make: (kind: CredentialKind) => login(kind, { expiresAt: LIVE() }), live: true },
        "a code that ran out with no pod report": { make: (kind: CredentialKind) => login(kind, { expiresAt: PAST() }), live: false },
        "a sign-in reported expired": { make: (kind: CredentialKind) => lapsed(kind), live: false },
        "a sign-in reported failed": { make: (kind: CredentialKind) => lapsed(kind, "failed"), live: false },
        "a sign-in the person has sent a code back for": {
          make: (kind: CredentialKind) => login(kind, { prompt: "paste_code", userCode: null, codeWaitingUntil: LIVE() }),
          live: null
        }
      };
      const CASES = (["github", "azure", "claude", "bedrock", "jenkins", "atlassian"] as const).flatMap((kind) =>
        Object.keys(SITUATIONS).flatMap((situation) => [true, false].map((held) => ({ kind, situation, held })))
      );

      /** What `kind` is called on the screen, which is how its row is found. */
      function named(kind: CredentialKind): string {
        return CONNECTORS[kind]?.name ?? kind;
      }

      it.each(CASES)("should be one the person can act on for $kind with $situation when its credential is stored: $held", ({ kind, situation, held }) => {
        const { make, live } = SITUATIONS[situation as keyof typeof SITUATIONS];
        // Nothing the assistant needs is ever the kind under test, so `onboarded` is honestly true and the ask under
        // test is the sign-in one rather than the connect one.
        const summary = assistant("running", { needed: NEEDS, optional: OFFERS, onboarded: true, logins: [make(kind)] });
        render(gate(summary, held ? statuses("bedrock", kind) : statuses("bedrock")));

        // Asserted rather than skipped past, so every case says something. A code they have already sent back waits
        // on nobody. A live one always asks, because finishing it goes back through the pod rather than through a
        // credential the hub has to accept for them. A lapsed one asks only while there is a way back it will take,
        // and never for a sign-in made on request, whose way back is in settings.
        const asked = screen.queryByRole("region", { name: "Sign in" }) !== null;
        expect(asked).toBe(live === true || (live === false && canSignInAgain(kind, [...NEEDS, ...OFFERS]) && !signsInOnRequest(kind)));
        if (!asked) {
          return;
        }
        fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));
        // A key the person pastes opens its box on Connect, and a sign-in the assistant makes puts its confirmation
        // behind "Sign in again"; a relayed code already shows what it has.
        for (const label of ["Connect", "Sign in again"]) {
          const control = within(connector(named(kind))).queryByRole("button", { name: label });
          if (control !== null) {
            fireEvent.click(control);
          }
        }
        const row = connector(named(kind));
        if (live) {
          // The code itself is the action: they type it on the page the row links to, so there is nothing to submit.
          expect(row.querySelector("code")?.textContent).toBe("ABCD-1234");
          return;
        }
        // Named rather than "any form", so a box whose save the hub would refuse cannot pass for an action: what is
        // offered has to be the one control that fits, and each of these is accepted as it stands.
        const forms = within(row)
          .queryAllByRole("form")
          .map((form) => form.getAttribute("aria-label"));

        expect(forms).toEqual([CONNECTORS[kind]?.paste === null ? `Sign in to ${named(kind)} again` : `Save your ${CONNECTORS[kind]?.paste}`]);
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

/**
 * What the HTML the server sends says, which is everything a person has until the bundle has arrived — and for good
 * where hydration fails or scripts do not run. These rows carry a device code as plain text and the provider's page
 * as a plain `<a href>`, both of which work with no script at all, so a sign-in this HTML reads as live when it is
 * dead is a working link and a number to type for something that cannot be completed. The clock comes in from the
 * server component for that reason: it is a real time, and React serialises it, so the browser's first render is
 * made from the same number and there is nothing for hydration to disagree about.
 */
describe("OnboardingGate holding the person at GitHub and Claude", () => {
  const OWN_LICENCE: Partial<AssistantSummary> = { needed: ["github", "azure", "claude"], toChat: ["github", "claude"] };
  const BEDROCK: Partial<AssistantSummary> = { needed: ["github", "azure", "bedrock"], toChat: ["github", "bedrock"] };

  function held(summary: AssistantSummary, stored: CredentialStatus[] = [], options: { dismissed?: boolean; unavailable?: string | null } = {}) {
    return (
      <OnboardingGate
        assistant={summary}
        statuses={stored}
        unavailable={options.unavailable ?? null}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={Date.now()}
        dismissed={options.dismissed ?? false}
      />
    );
  }

  it("should hold the person on the connections screen when neither GitHub nor Claude is connected", () => {
    render(held(assistant("awaiting_credentials", OWN_LICENCE)));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Connect your accounts" })).toBeNull();
  });

  it("should offer no way past the screen when GitHub is connected and Claude is not", () => {
    render(held(assistant("awaiting_credentials", OWN_LICENCE), statuses("github", "azure")));

    expect(screen.queryByRole("button", { name: "Go to your chats" })).toBeNull();
    expect((screen.getByRole("button", { name: "Connect the accounts above to continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
  });

  it("should hold the screen when Claude is connected and GitHub is not", () => {
    render(held(assistant("awaiting_login", OWN_LICENCE), statuses("azure", "claude")));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to your chats" })).toBeNull();
  });

  it("should hold the screen when the person sent the getting-ready screen away on an earlier page", () => {
    render(held(assistant("awaiting_credentials", OWN_LICENCE), [], { dismissed: true }));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
  });

  it("should hold the screen when the assistant is already running and a chat credential has gone", () => {
    render(held(assistant("running", { ...OWN_LICENCE, onboarded: false }), statuses("azure", "claude")));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("should hold the screen on the Bedrock key and not take a Claude token for it when the assistant runs on Bedrock", () => {
    render(held(assistant("awaiting_credentials", BEDROCK), statuses("github", "claude")));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to your chats" })).toBeNull();
  });

  it("should let the person through to their chats when the assistant runs on Bedrock and GitHub and its key are connected", () => {
    render(held(assistant("running", { ...BEDROCK, onboarded: true }), statuses("github", "azure", "bedrock")));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should ask for Azure on the banner rather than hold the screen when GitHub and Claude are connected", () => {
    render(held(assistant("awaiting_login", OWN_LICENCE), statuses("github", "claude")));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your accounts" }).textContent).toContain("needs Azure");
  });

  it("should not hold the person when the hub cannot read the credentials", () => {
    render(held(assistant("running", OWN_LICENCE), [], { unavailable: "this deployment has no credentials vault, so credentials cannot be stored here" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Your sign-ins cannot be checked" })).toBeTruthy();
  });

  it("should offer the way to the chats when GitHub and Claude are connected during the visit", () => {
    const { rerender } = render(held(assistant("awaiting_credentials", OWN_LICENCE), statuses("azure")));
    expect(screen.queryByRole("button", { name: "Go to your chats" })).toBeNull();

    rerender(held(assistant("cloning", { ...OWN_LICENCE, onboarded: true }), statuses("github", "azure", "claude")));

    expect((screen.getByRole("button", { name: "Start chatting" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });
});

describe("the HTML the server sends", () => {
  const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60_000).toISOString();

  function serverHtml(node: React.ReactElement): string {
    return renderToString(node);
  }

  function gate(summary: AssistantSummary, stored: CredentialStatus[]) {
    return <OnboardingGate assistant={summary} statuses={stored} unavailable={null} paste={ok()} save={ok()} reconnect={ok()} now={Date.now()} />;
  }

  /**
   * Through the gate, which is where the clock comes from, and on a pod still in `awaiting_login` so the screen with
   * the digits on it is part of the document rather than something the person has to open.
   */
  it("should offer no code for a device sign-in whose code ran out before the page was built", () => {
    const dead = login("atlassian", { expiresAt: AN_HOUR_AGO(), updatedAt: AN_HOUR_AGO() });
    const summary = assistant("awaiting_login", { onboarded: true, logins: [dead] });
    const html = serverHtml(gate(summary, statuses("github", "azure", "claude", "atlassian")));

    expect(html).not.toContain("ABCD-1234");
    expect(html).not.toContain("enter this code");
    expect(html).toContain("Sign-in expired");
    expect(html).toContain("Sign in again");
  });

  /**
   * An HTML payload can sit for a while before the browser takes it over, so the number it was built with is stale
   * by then. The clock is re-read as the browser arrives rather than only at the first tick, or the page would go on
   * offering a code that died between the two.
   */
  it("should drop a code that died between the page being built and the browser taking it over", () => {
    const built = Date.now() - 60_000;
    const died = login("atlassian", { expiresAt: new Date(Date.now() - 30_000).toISOString(), updatedAt: new Date(built).toISOString() });
    const summary = assistant("awaiting_login", { onboarded: true, logins: [died] });

    render(
      <OnboardingGate
        assistant={summary}
        statuses={statuses("github", "azure", "claude", "atlassian")}
        unavailable={null}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={built}
      />
    );

    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.getByText("Sign-in expired")).toBeTruthy();
  });

  it("should offer the code for a device sign-in whose code is still live when the page is built", () => {
    const summary = assistant("awaiting_login", { onboarded: true, logins: [login("atlassian")] });
    const html = serverHtml(gate(summary, statuses("github", "azure", "claude", "atlassian")));

    expect(html).toContain("ABCD-1234");
    expect(html).toContain("enter this code");
  });

  it("should ask for the code again when the one the person pasted was past collecting before the page was built", () => {
    const dead = login("claude", {
      prompt: "paste_code",
      userCode: null,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      codeWaitingUntil: AN_HOUR_AGO()
    });
    const summary = assistant("awaiting_login", { needed: ["github", "azure", "claude"], onboarded: true, logins: [dead] });
    const html = serverHtml(gate(summary, statuses("github", "azure", "claude")));

    expect(html).not.toContain("Got it");
    expect(html).toContain("Paste the Claude code");
  });

  // Both ways a Claude sign-in can be over for somebody on the Bedrock route: a pod's report, and a code that simply
  // ran out. The second is the one a clock decides, so it is the one a stand-in clock would read as live.
  it.each([
    ["a pod reported it expired", "expired" as const],
    ["its code ran out with no report", "pending" as const]
  ])("should raise no ask for a Claude sign-in the hub would take no value for when %s", (_what, state) => {
    const over = login("claude", { state, expiresAt: AN_HOUR_AGO(), updatedAt: AN_HOUR_AGO() });
    const summary = assistant("running", { needed: ["github", "azure", "bedrock"], onboarded: true, logins: [over] });
    const html = serverHtml(gate(summary, statuses("github", "azure", "bedrock", "atlassian")));

    expect(html).not.toContain("Claude");
    expect(html).not.toContain("Sign in");
  });

  /**
   * The banner itself is in the HTML, because a person who can see it should have the ask with the page. The live
   * region is not: a region is not announced for what it already holds, so an ask that was there at load would reach
   * a screen-reader user only if they happened on the banner. Going from empty to the sentence is a change, and read.
   */
  it("should carry the ask but hold it back from the live region until the browser takes the page over", () => {
    const relayed = assistant("running", { onboarded: true, logins: [login("atlassian")] });
    const stored = statuses("github", "azure", "claude", "atlassian");
    const html = serverHtml(gate(relayed, stored));

    expect(html).toContain('aria-label="Sign in"');
    expect(html).toContain('data-testid="sign-in-ask"></div>');

    render(gate(relayed, stored));
    expect(screen.getByTestId("sign-in-ask").textContent).toBe("Your assistant is waiting for you to sign in to Atlassian.");
  });
});
