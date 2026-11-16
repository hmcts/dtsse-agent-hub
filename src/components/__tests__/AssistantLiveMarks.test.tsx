/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSession } from "@/assistant/local-session";
import type { ConversationLink, ConversationMatch } from "@/assistant/views";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { ConversationSearch, SEARCH_AFTER_MS } from "@/components/assistant/ConversationSearch";
import { LiveLocalSessions } from "@/components/assistant/LiveLocalSessions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams()
}));

/** Every subscriber, as the real hook keeps them: each local row subscribes for itself, with its latest handler. */
const subscribers = new Set<{ type: string; handler: (data: unknown) => void }>();
vi.mock("@/components/live/HubStream", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useHubEvent: (type: string, handler: (data: unknown) => void) => {
      const latest = useRef(handler);
      latest.current = handler;
      useEffect(() => {
        const subscriber = { type, handler: (data: unknown) => latest.current(data) };
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }, [type]);
    },
    useEndSession: () => () => undefined
  };
});

function publish(data: { agent_id: string; status: "busy" | "idle" | "offline"; conversation_id: string | null }): void {
  act(() => {
    for (const subscriber of [...subscribers]) {
      if (subscriber.type === "agent_status") {
        subscriber.handler(data);
      }
    }
  });
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
  subscribers.clear();
  vi.useRealTimers();
});

function local(id: string, title: string, session: LocalSession): ConversationLink {
  return {
    kind: "local",
    id,
    title,
    product: "ccd",
    productLabel: "CCD",
    lastActiveAt: "2026-10-21T09:00:00.000Z",
    pinnedAt: null,
    mark: { where: "computer", session }
  };
}

function shell(items: ConversationLink[]) {
  return (
    <AssistantShell now={Date.now()} viewerName="Alice Smith" groups={[{ label: "Today", items }]} activeId={null}>
      <p>page</p>
    </AssistantShell>
  );
}

function row(name: RegExp): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Chats" })).getByRole("link", { name });
}

describe("a local chat's mark", () => {
  it("should recolour and rename the mark of the chat a status names, and no other, when its session changes", () => {
    render(shell([local("a", "Fixing the sweep", "ready"), local("b", "Reviewing the form", "ready")]));

    publish({ agent_id: "agent-a", status: "busy", conversation_id: "a" });

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, working: Fixing the sweep");
    expect(row(/Fixing the sweep/).querySelector('[data-badge="working"]')).not.toBeNull();
    expect(row(/Reviewing the form/).textContent).toBe("On your computer, ready: Reviewing the form");

    publish({ agent_id: "agent-a", status: "offline", conversation_id: "a" });

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, not connected: Fixing the sweep");
    expect(screen.getByTitle("On your computer, not connected").classList.contains("text-asst-faint")).toBe(true);
  });

  it("should leave every mark alone when a status names no chat", () => {
    render(shell([local("a", "Fixing the sweep", "ready")]));

    publish({ agent_id: "agent-pod", status: "busy", conversation_id: null });

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, ready: Fixing the sweep");
  });

  // Recolouring a list is not news: a live region would read out every turn of every session.
  it("should change the mark without announcing it", () => {
    render(shell([local("a", "Fixing the sweep", "ready")]));

    publish({ agent_id: "agent-a", status: "busy", conversation_id: "a" });

    const regions = [...document.querySelectorAll("[aria-live], [role=status], [role=alert]")];
    expect(regions.map((region) => region.textContent)).toEqual(regions.map(() => ""));
  });

  it("should keep a live status when the page re-reads the mark it arrived over", () => {
    const view = render(shell([local("a", "Fixing the sweep", "ready")]));

    publish({ agent_id: "agent-a", status: "busy", conversation_id: "a" });
    view.rerender(shell([local("a", "Fixing the sweep", "ready")]));

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, working: Fixing the sweep");
  });

  it("should show the server's mark when a re-read brings a different one from the mark a live status arrived over", () => {
    const view = render(shell([local("a", "Fixing the sweep", "ready")]));

    publish({ agent_id: "agent-a", status: "busy", conversation_id: "a" });
    view.rerender(shell([local("a", "Fixing the sweep", "disconnected")]));

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, not connected: Fixing the sweep");
  });

  // A re-read that moved the mark on is newer than the live status, which must not come back when a later re-read
  // happens to bring the mark it first arrived over.
  it("should not bring back a dropped live status when a later re-read returns the mark it arrived over", () => {
    const view = render(shell([local("a", "Fixing the sweep", "ready")]));

    publish({ agent_id: "agent-a", status: "busy", conversation_id: "a" });
    view.rerender(shell([local("a", "Fixing the sweep", "working")]));
    // The idle status is missed, and the next re-read reads it.
    view.rerender(shell([local("a", "Fixing the sweep", "ready")]));

    expect(row(/Fixing the sweep/).textContent).toBe("On your computer, ready: Fixing the sweep");
  });

  it("should hear statuses through one subscription however many local chats are listed", () => {
    render(shell([local("a", "Fixing the sweep", "ready"), local("b", "Reviewing the form", "ready"), local("c", "Old chat", "disconnected")]));

    expect([...subscribers].filter((subscriber) => subscriber.type === "agent_status")).toHaveLength(1);
  });

  it("should recolour a local chat among the search's results when its session changes", async () => {
    vi.useFakeTimers();
    const result: ConversationMatch = { ...local("c1", "Fixing the sweep", "disconnected"), snippet: null };
    const search = vi.fn<(query: string, signal: AbortSignal) => Promise<ConversationMatch[]>>().mockResolvedValue([result]);
    render(
      <LiveLocalSessions served={new Map()}>
        <ConversationSearch search={search}>{null}</ConversationSearch>
      </LiveLocalSessions>
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "sweep" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_AFTER_MS);
    });

    publish({ agent_id: "agent-c1", status: "idle", conversation_id: "c1" });

    expect(screen.getByRole("option", { name: /^On your computer, ready/ }).textContent).toContain("On your computer, ready: Fixing the sweep");
  });
});
