/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readiness } from "@/assistant/onboarding";
import type { AssistantSummary } from "@/assistant/views";
import { firstWarmupMessage, WARMUP_PATIENCE_MS, WARMUP_ROTATE_MS, WARMUP_SIGNPOST, WARMUP_SLOW, warmupPhase, warmupPool } from "@/assistant/warmup";
import { OnboardingGate, WarmingUp } from "@/components/assistant/GettingReady";
import type { VirtualAgentStatus } from "@/virtual-agents/lifecycle";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function assistant(status: VirtualAgentStatus = "stopped", overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "0f8a6a1e-0000-4000-8000-000000000001",
    name: "assistant",
    desired: "running",
    status,
    statusDetail: null,
    readiness: readiness(status),
    needed: ["github", "azure", "claude"],
    optional: ["jenkins", "atlassian"],
    logins: [],
    onboarded: true,
    ...overrides
  };
}

function warming(status: VirtualAgentStatus = "stopped", overrides: Partial<AssistantSummary> = {}) {
  return <WarmingUp assistant={assistant(status, overrides)} unavailable={null} />;
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

  it("should fall back to the lines that fit any phase when the phase has none of its own", () => {
    render(warming("running"));

    expect(warmupPool("any")).toContain(rotating());
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

    expect(seen).toEqual([pool[0], pool[5], pool[0], pool[3]]);
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

  it("should keep going round a phase with only two lines", () => {
    vi.useFakeTimers();
    render(warming("awaiting_login"));
    const [azure, idam] = warmupPool("signing_in");

    expect(rotating()).toBe(azure);
    tick();
    expect(rotating()).toBe(idam);
    tick();
    expect(rotating()).toBe(azure);
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
    render(<WarmingUp assistant={assistant()} unavailable="Virtual agents are not available here" theme="dark" />);

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
});

describe("OnboardingGate while the assistant starts", () => {
  function gate(summary: AssistantSummary) {
    const noop = vi.fn(async () => ({ ok: true as const }));
    return <OnboardingGate assistant={summary} statuses={[]} unavailable={null} paste={noop} save={noop} />;
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

  it("should offer the connections rather than the warming-up screen when the person has yet to onboard", () => {
    render(gate(assistant("provisioning", { onboarded: false })));

    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByText(WARMUP_SIGNPOST)).toBeNull();
  });

  it("should not follow onboarding with the warming-up screen when the person has just carried on", () => {
    const { rerender } = render(gate(assistant("cloning", { onboarded: false })));

    rerender(gate(assistant("cloning")));
    act(() => screen.getByRole("button", { name: "Start chatting" }).click());

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
