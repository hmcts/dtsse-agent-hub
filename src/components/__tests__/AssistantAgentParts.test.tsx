/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checklistState } from "@/assistant/connections";
import { LoginCountdown, remaining } from "@/components/assistant/LoginCountdown";
import { statusLabel } from "@/components/assistant/labels";
import type { LoginView } from "@/virtual-agents/logins";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function login(overrides: Partial<LoginView> = {}): LoginView {
  return {
    kind: "github",
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: "2026-10-05T12:10:00.000Z",
    state: "pending",
    updatedAt: "2026-10-05T12:08:00.000Z",
    codeWaitingUntil: null,
    ...overrides
  };
}

describe("statusLabel", () => {
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
});

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
