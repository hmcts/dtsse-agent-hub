/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "@/assistant/starters";
import { ChatMenu } from "@/components/assistant/ChatMenu";
import { Composer } from "@/components/assistant/Composer";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { menuKeyTarget, useMenuButton } from "@/components/assistant/useMenuButton";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { ACTION_STALE_PAGE, ACTION_UNREACHABLE, actionThrew } from "@/web/action-fault";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}));

const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// jsdom has no ResizeObserver, which the message box uses to keep its height to its text.
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("actionThrew", () => {
  it("should ask for a reload when the page is older than the deployment it talks to", () => {
    expect(actionThrew(new Error('Failed to find Server Action "abc". This request might be from an older or newer deployment.'))).toBe(ACTION_STALE_PAGE);
  });

  it("should say it is the connection for anything else", () => {
    expect(actionThrew(new Error("fetch failed"))).toBe(ACTION_UNREACHABLE);
    expect(actionThrew("not an error")).toBe(ACTION_UNREACHABLE);
  });

  it("should say the caller's own words for the connection when it has them, and still ask for a reload after a deploy", () => {
    expect(actionThrew(new Error("fetch failed"), "The chat could not be sent.")).toBe("The chat could not be sent.");
    expect(actionThrew(new Error("This request might be from an older or newer deployment."), "The chat could not be sent.")).toBe(ACTION_STALE_PAGE);
  });
});

describe("Composer when the send throws", () => {
  function composer(onSend: (text: string, ids: string[]) => Promise<string | null>) {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={onSend} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  it("should give the box back, keep the words and say why, rather than stay disabled", async () => {
    const box = composer(
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );
    fireEvent.change(box, { target: { value: "hello" } });

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe(ACTION_UNREACHABLE);
    expect(box.value).toBe("hello");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("should ask for a reload when the page is from before a deploy", async () => {
    const box = composer(
      vi.fn(async () => {
        throw new Error('Failed to find Server Action "abc"');
      })
    );
    fireEvent.change(box, { target: { value: "hello" } });

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe(ACTION_STALE_PAGE);
  });
});

describe("EmptyChat when opening a chat for a file throws", () => {
  it("should try again for the next file rather than replay the failure", async () => {
    const open = vi.fn<EmptyChatActions["open"]>().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce({ ok: true, id: "c2" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ upload_id: "u1" })))
    );
    const actions: EmptyChatActions = {
      start: vi.fn(),
      open,
      send: vi.fn(async () => ({ ok: true as const })),
      setProduct: vi.fn(async () => ({ ok: true as const }))
    };
    render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={actions} />);
    const picker = screen.getByLabelText("Files to attach");

    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["a"], "a.txt", { type: "text/plain" })] } });
    });
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["b"], "b.txt", { type: "text/plain" })] } });
    });

    expect(open).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

function Panel() {
  const resize = useResizableWidth({ storageKey: "test-width", label: "Resize", initial: 300, min: 200, reserve: () => 0, edge: "left" });
  return (
    <div>
      <div {...resize.separator} />
      <output>{resize.width}</output>
    </div>
  );
}

describe("useResizableWidth", () => {
  it("should keep working when storage cannot be read or written", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    render(<Panel />);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });

    expect(screen.getByRole("status").textContent).not.toBe("300");
  });

  it("should stop following the pointer when the browser cancels the drag, and when the panel goes mid-drag", () => {
    const { unmount } = render(<Panel />);
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");

    fireEvent.pointerDown(screen.getByRole("separator"));
    expect(added.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
    fireEvent(window, new Event("pointercancel"));
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));

    removed.mockClear();
    fireEvent.pointerDown(screen.getByRole("separator"));
    unmount();
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
  });
});

describe("ChatMenu from the keyboard", () => {
  function menu(onDelete: () => Promise<void> = vi.fn(async () => undefined)) {
    render(
      <ChatMenu
        title="Event help"
        shareHref="/s"
        forkHref="/f"
        pinned={false}
        onPin={vi.fn(async () => undefined)}
        onRename={vi.fn(async () => undefined)}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
  }

  it("should put focus on the first item as it opens, and move through the items with the arrow keys", () => {
    menu();
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1) as HTMLElement, { key: "Tab" });
    expect(document.activeElement).toBe(items.at(-1));
  });

  it("should close as a link in it is followed", () => {
    menu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should put focus on Cancel when Delete chat is chosen, and delete once however often Delete is pressed", async () => {
    let finish: () => void = () => undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    menu(onDelete);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    const remove = screen.getByRole("button", { name: "Delete" });
    act(() => {
      fireEvent.click(remove);
      fireEvent.click(remove);
    });
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeTruthy();
    await act(async () => {
      finish();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("menuKeyTarget", () => {
  it("should wrap at either end, start an arrow from its own end with nothing focused, and answer Home and End", () => {
    expect(menuKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyTarget("ArrowUp", -1, 3)).toBe(2);
    expect(menuKeyTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyTarget("Home", 2, 3)).toBe(0);
    expect(menuKeyTarget("End", 0, 3)).toBe(2);
    expect(menuKeyTarget("Enter", 0, 3)).toBeNull();
    expect(menuKeyTarget("ArrowDown", -1, 0)).toBeNull();
  });
});

describe("useDismiss from a click outside", () => {
  function Menu() {
    const menu = useMenuButton();
    return (
      <div>
        <div ref={menu.container}>
          <button ref={menu.trigger} type="button" onClick={menu.toggle}>
            Open
          </button>
          {menu.open ? (
            <div ref={menu.menu} role="menu" onKeyDown={menu.onMenuKeyDown}>
              <button type="button" role="menuitem">
                One
              </button>
            </div>
          ) : null}
        </div>
        <input aria-label="Elsewhere" />
      </div>
    );
  }

  it("should leave focus off the trigger in every menu, so the click can put it where it landed", () => {
    render(<Menu />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "One" }));

    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Elsewhere" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Open" }));
  });
});

describe("ChatMenu after a deploy", () => {
  it("should ask for a reload, not the connection, when the page names an action the hub no longer has", async () => {
    render(
      <ChatMenu
        title="Event help"
        shareHref="/s"
        forkHref="/f"
        pinned={false}
        onPin={vi.fn(async () => {
          throw new Error('Failed to find Server Action "abc"');
        })}
        onRename={vi.fn(async () => undefined)}
        onDelete={vi.fn(async () => undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    });

    expect(screen.getByRole("alert").textContent).toBe(ACTION_STALE_PAGE);
  });
});

describe("useResizableWidth ending a drag", () => {
  it("should remember the width a cancelled drag left, and end a first drag when a second begins", () => {
    render(<Panel />);
    const separator = screen.getByRole("separator");

    fireEvent.pointerDown(separator);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 420 }));
    fireEvent(window, new Event("pointercancel"));
    expect(window.localStorage.getItem("test-width")).toBe("420");

    const removed = vi.spyOn(window, "removeEventListener");
    fireEvent.pointerDown(separator);
    fireEvent.pointerDown(separator);
    expect(removed.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);
  });
});
