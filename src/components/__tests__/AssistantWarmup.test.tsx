/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readiness } from "@/assistant/onboarding";
import type { AssistantSummary } from "@/assistant/views";
import { WAITING_COOKIE, waitingCookie, waitingDismissed } from "@/assistant/waiting";
import {
  firstWarmupMessage,
  WARMUP_GENERAL,
  WARMUP_PATIENCE_MS,
  WARMUP_ROTATE_MS,
  WARMUP_SIGNPOST,
  WARMUP_SLOW,
  warmupPhase,
  warmupPool
} from "@/assistant/warmup";
import { AssistantVisit } from "@/components/assistant/AssistantVisit";
import { OnboardingGate, WarmingUp } from "@/components/assistant/GettingReady";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { VirtualAgentStatus } from "@/virtual-agents/lifecycle";
import type { LoginView } from "@/virtual-agents/logins";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  // The hydration tests mount their own container, which an assertion failing would otherwise leave for the next test.
  document.body.replaceChildren();
  // biome-ignore lint/suspicious/noDocumentCookie: the component writes the cookie the same way, so the test clears it the same way
  document.cookie = waitingCookie(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** What the page reads of the cookie the screen writes, which is all that carries the choice across a navigation. */
function dismissedByCookie(summary: AssistantSummary): boolean {
  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${WAITING_COOKIE}=`))
    ?.slice(WAITING_COOKIE.length + 1);
  return waitingDismissed(value, summary.id, summary.startedAt);
}

function assistant(status: VirtualAgentStatus = "stopped", overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "0f8a6a1e-0000-4000-8000-000000000001",
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
    onboarded: true,
    toChat: [],
    ...overrides
  };
}

function warming(status: VirtualAgentStatus = "stopped", overrides: Partial<AssistantSummary> = {}) {
  return <WarmingUp assistant={assistant(status, overrides)} unavailable={null} onDismiss={() => undefined} />;
}

function stored(...kinds: CredentialKind[]): CredentialStatus[] {
  return kinds.map((kind) => ({ kind, stored: true, accountLabel: null, updatedAt: null, updatedVia: null }));
}

/** A sign-in the pod has relayed and is waiting on, as one does when a returning person's Azure token has expired. */
function login(kind: CredentialKind): LoginView {
  return {
    kind,
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    state: "pending",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    codeWaitingUntil: null
  };
}

/** What the rotating line says; it is hidden from the accessibility tree, so it is found by that, not by a role. */
function rotating(within: ParentNode = screen.getByRole("dialog")): string | null {
  return within.querySelector("p[aria-hidden='true']")?.textContent ?? null;
}

function tick(times = 1): void {
  act(() => {
    vi.advanceTimersByTime(WARMUP_ROTATE_MS * times);
  });
}

describe("WarmingUp", () => {
  it("should show the progress and a line to read but no connections when the assistant is starting again", () => {
    render(warming());

    expect(screen.getByRole("heading", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Getting your assistant ready" }).getAttribute("aria-valuenow")).toBe("5");
    expect(screen.getByText("Starting your assistant again…")).toBeTruthy();
    expect(screen.getByText(WARMUP_SIGNPOST)).toBeTruthy();
    expect(rotating()).toBe(firstWarmupMessage("starting"));
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
    expect(screen.queryByRole("button", { name: /continue|Start chatting/ })).toBeNull();
  });

  it("should leave the step as the only line a screen reader is told about when it rotates", () => {
    render(warming());

    const live = screen.getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0]?.textContent).toBe("Starting your assistant again…");
    const line = screen.getByText(firstWarmupMessage("starting"));
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.getAttribute("role")).toBeNull();
  });

  it("should take its lines from the pod's phase when it is cloning the workspace", () => {
    vi.useFakeTimers();
    render(warming("cloning"));

    expect(rotating()).toBe(firstWarmupMessage("cloning"));
    tick();
    expect(warmupPool("cloning")).toContain(rotating());
  });

  it("should change the line with the step when the pod moves on to the next one", () => {
    vi.useFakeTimers();
    const { rerender } = render(warming("provisioning"));

    expect(rotating()).toBe(firstWarmupMessage("starting"));
    rerender(warming("cloning"));

    expect(screen.getByText("Preparing your workspace…")).toBeTruthy();
    expect(rotating()).toBe(firstWarmupMessage("cloning"));
  });

  it("should reach the lines that carry a long wait when the rotation runs to the end of the pool", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    render(warming("stopped"));

    tick();

    expect(WARMUP_GENERAL).toContain(rotating());
  });

  it("should change the line every six seconds, in no fixed order", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValueOnce(0.9).mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    render(warming());
    const pool = warmupPool("starting");

    const seen = [rotating()];
    for (let round = 0; round < 3; round += 1) {
      tick();
      seen.push(rotating());
    }

    expect(seen).toEqual([pool[0], pool[9], pool[0], pool[5]]);
  });

  it("should never show the same line twice running", () => {
    vi.useFakeTimers();
    render(warming());

    let previous = rotating();
    for (let round = 0; round < 25; round += 1) {
      tick();
      const current = rotating();
      expect(current).not.toBe(previous);
      previous = current;
    }
  });

  it("should stop rotating and say it is taking a while when three minutes have passed", () => {
    vi.useFakeTimers();
    render(warming());

    act(() => {
      vi.advanceTimersByTime(WARMUP_PATIENCE_MS);
    });

    expect(screen.getByText(WARMUP_SLOW)).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
    expect(rotating()).toBeNull();

    tick(5);
    expect(screen.getByText(WARMUP_SLOW)).toBeTruthy();
  });

  it("should say it is taking a while from the moment it opens when the assistant has been on one step too long", () => {
    const stuck = new Date(Date.now() - 10 * 60_000).toISOString();

    render(warming("cloning", { statusChangedAt: stuck }));

    expect(screen.getByText(WARMUP_SLOW)).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
    expect(rotating()).toBeNull();
  });

  it("should say nothing amusing and why it stopped when the assistant failed", () => {
    vi.useFakeTimers();
    render(warming("failed", { statusDetail: "image pull failed" }));

    expect(screen.getByRole("heading", { name: "Your assistant could not start" })).toBeTruthy();
    expect(screen.getByText("image pull failed")).toBeTruthy();
    expect(rotating()).toBeNull();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(WARMUP_PATIENCE_MS + WARMUP_ROTATE_MS);
    });
    expect(screen.queryByText(WARMUP_SLOW)).toBeNull();
  });

  it("should say the assistant is unavailable when the page says so", () => {
    render(<WarmingUp assistant={assistant()} unavailable="Virtual agents are not available here" theme="dark" onDismiss={() => undefined} />);

    expect(screen.getByText("Virtual agents are not available here")).toBeTruthy();
  });
});

describe("WarmingUp hydration", () => {
  it("should pick no random line while rendering, so the server and the browser agree", () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random");
    render(warming());

    expect(random).not.toHaveBeenCalled();
    expect(rotating()).toBe(firstWarmupMessage("starting"));

    tick();
    expect(random).toHaveBeenCalled();
  });

  it("should hydrate the server's markup without a mismatch when the browser takes over", () => {
    const element = warming("cloning");
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    const served = rotating(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    act(() => {
      root = hydrateRoot(container, element);
    });

    expect(errors).not.toHaveBeenCalled();
    expect(rotating(container)).toBe(served);
    expect(served).toBe(firstWarmupMessage(warmupPhase("cloning")));

    act(() => root?.unmount());
    container.remove();
  });

  it("should hydrate without a mismatch when the wait crosses three minutes between the server and the browser", () => {
    vi.useFakeTimers();
    // Rendered a second short of the patience the screen allows, and picked up by the browser a moment after it.
    const element = warming("stopped", { statusChangedAt: new Date(Date.now() - WARMUP_PATIENCE_MS + 1_000).toISOString() });
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    const served = rotating(container);
    vi.advanceTimersByTime(2_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    act(() => {
      root = hydrateRoot(container, element);
    });

    expect(served).toBe(firstWarmupMessage("starting"));
    expect(errors).not.toHaveBeenCalled();
    // And then the browser's own clock has its say.
    expect(container.textContent).toContain(WARMUP_SLOW);

    act(() => root?.unmount());
    container.remove();
  });
});

describe("OnboardingGate while the assistant starts", () => {
  function gate(summary: AssistantSummary, statuses: CredentialStatus[] = [], dismissed = false) {
    const noop = vi.fn(async () => ({ ok: true as const }));
    return (
      <OnboardingGate
        assistant={summary}
        statuses={statuses}
        unavailable={null}
        paste={noop}
        save={noop}
        reconnect={noop}
        now={Date.now()}
        dismissed={dismissed}
      />
    );
  }

  it("should wait on the warming-up screen when someone who has onboarded arrives to a stopped assistant", () => {
    render(gate(assistant("stopped")));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByText(WARMUP_SIGNPOST)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Connections" })).toBeNull();
  });

  it("should show nothing when someone who has onboarded arrives to an assistant already running", () => {
    render(gate(assistant("running")));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should go once the assistant is running and stay gone if it stops again in the same visit", () => {
    const { rerender } = render(gate(assistant("requested")));

    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(gate(assistant("running")));
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(gate(assistant("stopped")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should ask for the connections on a banner rather than a screen when the person has yet to onboard", () => {
    render(gate(assistant("provisioning", { onboarded: false })));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Connect your accounts" })).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
  });

  it("should offer the connections rather than the warming-up screen when someone who has yet to onboard opens them", () => {
    render(gate(assistant("provisioning", { onboarded: false })));

    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
  });

  it("should not follow onboarding with the warming-up screen when the person has just carried on", () => {
    const { rerender } = render(gate(assistant("cloning", { onboarded: false })));
    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    rerender(gate(assistant("cloning")));
    act(() => screen.getByRole("button", { name: "Start chatting" }).click());

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should offer the sign-in rather than a line to read when a returning person's assistant is waiting on them", () => {
    render(gate(assistant("awaiting_login", { logins: [login("azure")] }), stored("github", "azure", "claude")));

    const azure = within(screen.getByRole("list", { name: "Connections" }))
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText("Azure", { exact: true }) !== null) as HTMLElement;
    expect(within(azure).getByText("Waiting for you")).toBeTruthy();
    expect(within(azure).getByText("ABCD-1234")).toBeTruthy();
    expect(within(azure).getByRole("link", { name: "the Azure sign-in page" }).getAttribute("href")).toBe("https://example.com/device");
    expect(screen.getByText("Your assistant is waiting for you to sign in again before it can carry on.")).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
  });

  // What is left behind is the sign-in, not the step: the ask is the thing with something to do about it, and the
  // assistant does not stay in `awaiting_login` for long enough to be the thing that reports it.
  it("should leave the sign-in behind on a banner when a returning person carries on to their chats", () => {
    render(gate(assistant("awaiting_login", { logins: [login("azure")] }), stored("github", "azure", "claude")));

    fireEvent.click(screen.getByRole("button", { name: "Carry on without waiting" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    const banner = screen.getByRole("region", { name: "Sign in" });
    expect(banner.textContent).toContain("Your assistant is waiting for you to sign in to Azure.");
  });

  it("should open the sign-in again from that banner when the person asks for it", () => {
    render(gate(assistant("awaiting_login", { logins: [login("azure")] }), stored("github", "azure", "claude")));
    fireEvent.click(screen.getByRole("button", { name: "Carry on without waiting" }));

    fireEvent.click(screen.getByRole("button", { name: "Show the sign-in" }));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
  });

  it("should let the person carry on to their conversations when their assistant could not start", () => {
    render(gate(assistant("failed", { statusDetail: "image pull failed" })));

    expect(screen.getByRole("dialog", { name: "Your assistant could not start" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Carry on without it" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Your assistant could not start");
  });

  it("should close the waiting screen when the person presses Escape", () => {
    render(gate(assistant("cloning")));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Preparing your workspace…");
  });

  it("should stay on the waiting screen when the person presses a key other than Escape", () => {
    render(gate(assistant("cloning")));

    fireEvent.keyDown(window, { key: "Enter" });

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
  });

  it("should bring the screen back when someone who sent it away asks to see the progress again", () => {
    render(gate(assistant("stopped")));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    fireEvent.click(screen.getByRole("button", { name: "Show progress" }));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
    expect(screen.getByText(WARMUP_SIGNPOST)).toBeTruthy();
  });

  it("should still say when the assistant came up to someone who sent the screen away", () => {
    const { rerender } = render(gate(assistant("stopped")));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    rerender(gate(assistant("running")));

    expect(screen.getByRole("status").textContent).toBe("Your assistant is ready");
    expect(screen.queryByRole("button", { name: "Show progress" })).toBeNull();
  });

  it("should stay out of the way across a navigation when the person has sent the waiting screen away", () => {
    const summary = assistant("stopped");
    const { unmount } = render(gate(summary));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    // Going to a conversation remounts the page's whole subtree, so only the cookie carries the choice.
    unmount();
    render(gate(summary, [], dismissedByCookie(summary)));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Starting your assistant again…");
  });

  it("should wait on the screen again across a navigation when the person has asked to watch the progress", () => {
    const summary = assistant("stopped");
    const { unmount } = render(gate(summary));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    fireEvent.click(screen.getByRole("button", { name: "Show progress" }));
    unmount();
    render(gate(summary, [], dismissedByCookie(summary)));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
  });

  it("should leave nothing behind across a navigation when the assistant came up while they waited", () => {
    const starting = assistant("stopped");
    const { unmount } = render(gate(starting));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    unmount();
    // The same wait, now over: the cookie still names it, so only `waiting` tells the two arrivals apart.
    const up = assistant("running", { startedAt: starting.startedAt });
    render(gate(up, [], dismissedByCookie(up)));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should wait on the screen again when the assistant is started afresh after one wait was sent away", () => {
    const morning = assistant("stopped");
    const { unmount } = render(gate(morning));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    unmount();
    // The idle sweep stopped it and opening the page asked for it again, which moves `startedAt`.
    const evening = assistant("requested", { startedAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString() });
    render(gate(evening, [], dismissedByCookie(evening)));

    expect(screen.getByRole("dialog", { name: "Your assistant is getting ready" })).toBeTruthy();
  });

  it("should keep the notice clear of the band the composer owns when the screen has been sent away", () => {
    render(gate(assistant("stopped")));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));

    // The composer centres its error line and its guidance at the bottom of the chat; only a browser shows the
    // overlap, so this holds the notice to the other end of the page.
    const notice = screen.getByRole("status").parentElement as HTMLElement;
    expect(notice.className).toContain("top-[68px]");
    expect(notice.className).not.toContain("bottom-");
  });

  it("should leave nothing on the page when the person hides the notice too", () => {
    render(gate(assistant("stopped")));

    fireEvent.click(screen.getByRole("button", { name: "Carry on while it starts" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide your assistant's progress" }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should stay away when the assistant stops again after a navigation within the same visit", () => {
    // The layout holds the visit and stays mounted while the page under it is replaced, which is the only part of
    // this a browser does and jsdom cannot: here the page subtree is keyed so React remounts it the same way.
    function Area({ page, summary }: { page: string; summary: AssistantSummary }) {
      return (
        <AssistantVisit>
          <div key={page}>{gate(summary)}</div>
        </AssistantVisit>
      );
    }
    const { rerender } = render(<Area page="/assistant" summary={assistant("running")} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    // They read for long enough that the idle sweep stopped it, then opened a conversation.
    rerender(<Area page="/assistant/one" summary={assistant("stopped")} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should never paint the screen saying the assistant is ready when it reaches running", () => {
    const painted: (string | null)[] = [];
    // A layout effect reads the DOM React has just committed, before the browser paints it and before the gate's own
    // effects run, which is the frame the person would see.
    function Probe() {
      useLayoutEffect(() => {
        painted.push(document.querySelector("[role='dialog'] h1")?.textContent ?? null);
      });
      return null;
    }
    const view = (status: VirtualAgentStatus) => (
      <>
        {gate(assistant(status))}
        <Probe />
      </>
    );

    const { rerender } = render(view("cloning"));
    rerender(view("running"));

    expect(painted).toEqual(["Your assistant is getting ready", null]);
  });
});
