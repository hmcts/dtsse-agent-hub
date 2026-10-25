/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMatch } from "@/assistant/views";
import { ConversationSearch, SEARCH_AFTER_MS } from "@/components/assistant/ConversationSearch";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => undefined }), usePathname: () => "/assistant" }));

function match(id: string, title: string, snippet: string | null = null): ConversationMatch {
  return { id, title, product: "pcs", productLabel: "Possession Claims (PCS)", lastActiveAt: "2026-10-24T09:00:00.000Z", snippet };
}

const search = vi.fn<(query: string, signal: AbortSignal) => Promise<ConversationMatch[]>>();

function list(): React.ReactNode {
  return (
    <div>
      <h2>Today</h2>
      <a href="/assistant/a">Event help</a>
    </div>
  );
}

function render_(): void {
  render(<ConversationSearch search={search}>{list()}</ConversationSearch>);
}

function box(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search chats" });
}

/** Types a query and lets the debounce and the search itself run. */
async function type(query: string): Promise<void> {
  fireEvent.change(box(), { target: { value: query } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_AFTER_MS);
  });
}

/** Listens for a key reaching `window`, as the shell's drawer does, until the test ends. */
function watchWindow(): { heard: () => boolean } {
  let heard = false;
  const listener = () => {
    heard = true;
  };
  window.addEventListener("keydown", listener);
  listeners.push(listener);
  return { heard: () => heard };
}

const listeners: ((event: KeyboardEvent) => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset();
  search.mockResolvedValue([]);
  push.mockReset();
});

afterEach(() => {
  cleanup();
  for (const listener of listeners.splice(0)) {
    window.removeEventListener("keydown", listener);
  }
  vi.useRealTimers();
});

describe("ConversationSearch", () => {
  it("should show the sidebar's own list and ask for nothing when nothing is typed", () => {
    render_();

    expect(screen.getByRole("link", { name: "Event help" })).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
    expect(box().getAttribute("aria-expanded")).toBe("false");
  });

  it("should find a chat by a word in its title when one is typed", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();

    await type("possession");

    expect(search.mock.calls[0]?.[0]).toBe("possession");
    const results = screen.getByRole("listbox", { name: "Chats found" });
    expect(within(results).getByRole("option", { name: "Possession claim help" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 chat found.");
  });

  it("should show where a chat matched when the match was in a message rather than its title", async () => {
    search.mockResolvedValue([match("c1", "Tenancy question", "…about a possession claim at the county court…")]);
    render_();

    await type("possession");

    expect(screen.getByText("…about a possession claim at the county court…")).toBeTruthy();
  });

  it("should hide the sidebar's own list while a search is on and bring it back when the box is emptied", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();

    await type("possession");
    expect(screen.queryByRole("link", { name: "Event help" })).toBeNull();

    await type("");

    expect(screen.getByRole("link", { name: "Event help" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("should say so when nothing matches", async () => {
    search.mockResolvedValue([]);
    render_();

    await type("possession");

    expect(screen.getByRole("status").textContent).toBe("No chats match that.");
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(box().getAttribute("aria-expanded")).toBe("false");
  });

  it("should say it is searching while the answer is still coming", async () => {
    search.mockReturnValue(new Promise(() => undefined));
    render_();

    await type("possession");

    expect(screen.getByRole("status").textContent).toBe("Searching your chats…");
  });

  // Emptying the list on every keystroke would flicker the results away and back as a word is typed out.
  it("should keep the results it has while the next search runs", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();
    await type("possession");

    search.mockReturnValue(new Promise(() => undefined));
    await type("possession claim");

    expect(screen.getByRole("option", { name: "Possession claim help" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Searching your chats…");
  });

  it("should say so when the search cannot be reached", async () => {
    search.mockRejectedValue(new Error("offline"));
    render_();

    await type("possession");

    expect(screen.getByRole("status").textContent).toBe("Your chats could not be searched. Check your connection and try again.");
  });

  // One letter matches nearly every chat, so it is not a search: the sidebar keeps its list rather than showing one
  // that looks searched and is not narrowed at all.
  it("should not search for a single letter", async () => {
    render_();

    await type("p");

    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Event help" })).toBeTruthy();
  });

  it("should ask once for a word typed a letter at a time", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();

    for (const query of ["po", "pos", "poss"]) {
      fireEvent.change(box(), { target: { value: query } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_AFTER_MS - 1);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe("poss");
  });

  it("should move through the results with the arrow keys and open the one it is on with Enter", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help"), match("c2", "Possession order")]);
    render_();
    await type("possession");

    const options = screen.getAllByRole("option");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(push).toHaveBeenCalledWith("/assistant/c2");
  });

  it("should wrap round the results when the arrow keys run off either end", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help"), match("c2", "Possession order")]);
    render_();
    await type("possession");
    const options = screen.getAllByRole("option");

    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1]!.id);

    fireEvent.keyDown(box(), { key: "ArrowDown" });

    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
  });

  it("should open a result that is clicked", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();
    await type("possession");

    fireEvent.click(screen.getByRole("option", { name: "Possession claim help" }));

    expect(push).toHaveBeenCalledWith("/assistant/c1");
  });

  it("should empty the box once a chat has been opened, so the sidebar is back on its list", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();
    await type("possession");

    fireEvent.click(screen.getByRole("option", { name: "Possession claim help" }));

    expect((box() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("link", { name: "Event help" })).toBeTruthy();
  });

  it("should leave the keys alone while there is nothing to move through", async () => {
    render_();
    await type("possession");

    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(push).not.toHaveBeenCalled();
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
  });

  // The shell closes its drawer on Escape from `window`, which is where a key pressed in the box ends up.
  it("should empty the box on Escape and leave the sidebar's drawer alone", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();
    await type("possession");

    const drawer = watchWindow();
    fireEvent.keyDown(box(), { key: "Escape" });

    expect((box() as HTMLInputElement).value).toBe("");
    expect(drawer.heard()).toBe(false);
  });

  it("should let Escape through when the box is already empty, so the drawer can close on it", () => {
    render_();

    const drawer = watchWindow();
    fireEvent.keyDown(box(), { key: "Escape" });

    expect(drawer.heard()).toBe(true);
  });

  it("should describe the box as a combobox over the list of results", async () => {
    search.mockResolvedValue([match("c1", "Possession claim help")]);
    render_();

    await type("possession");

    expect(box().getAttribute("aria-autocomplete")).toBe("list");
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(screen.getByRole("listbox", { name: "Chats found" }).id);
  });

  it("should drop an answer to a query that has been typed past", async () => {
    render_();
    const signals: AbortSignal[] = [];
    search.mockImplementation(async (_query, signal) => {
      signals.push(signal);
      return [];
    });

    fireEvent.change(box(), { target: { value: "poss" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_AFTER_MS);
    });
    await type("possession");

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
