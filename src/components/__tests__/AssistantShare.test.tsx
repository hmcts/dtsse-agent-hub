/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharePerson } from "@/assistant/shares";
import type { SharedConversationView } from "@/assistant/sharing";
import { ShareDialog } from "@/components/assistant/ShareDialog";
import { SharedChat } from "@/components/assistant/SharedChat";
import { ShareGate } from "@/components/assistant/ShareGate";

const replaced: string[] = [];
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (target: string) => void replaced.push(target), refresh, push: () => undefined }),
  usePathname: () => "/assistant"
}));

const CONVERSATION = "33333333-3333-3333-3333-333333333333";

function person(oid: string, name: string, email: string | null = `${oid}@example.com`): SharePerson {
  return { oid, name, email, sharedAt: "2026-10-25T09:00:00.000Z" };
}

/** `fetch` answering `/api/ui/people` with these candidates, and the calls it was asked to make. */
function people(candidates: { oid: string; name: string; email: string | null }[]) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      calls.push(url);
      if (init?.signal !== undefined) {
        signals.push(init.signal);
      }
      return new Response(JSON.stringify({ people: candidates }));
    })
  );
  return { calls, signals };
}

function ok(result: SharePerson[]) {
  return vi.fn(async () => ({ ok: true as const, people: result }));
}

function dialog(props: Partial<React.ComponentProps<typeof ShareDialog>> = {}) {
  return <ShareDialog conversationId={CONVERSATION} people={[]} share={ok([])} unshare={ok([])} onClose={() => undefined} {...props} />;
}

function box(): HTMLInputElement {
  return screen.getByLabelText("Who can read it") as HTMLInputElement;
}

async function type(value: string): Promise<void> {
  fireEvent.change(box(), { target: { value } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

beforeEach(() => {
  replaced.length = 0;
  refresh.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ people: [] })))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ShareGate", () => {
  // Opening the dialog from the chat you are already in only changes the query, which Next answers by re-rendering
  // this page rather than remounting it. Anything remembered from the first render would leave the dialog shut.
  it("should show the dialog when the address gains the parameter, without being remounted", () => {
    const { rerender } = render(<ShareGate conversationId={CONVERSATION} open={false} people={[]} share={ok([])} unshare={ok([])} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<ShareGate conversationId={CONVERSATION} open people={[]} share={ok([])} unshare={ok([])} />);

    expect(screen.getByRole("dialog", { name: "Share this chat" })).toBeTruthy();
  });

  it("should hide the dialog again when the parameter goes, which is what the back button does", () => {
    const { rerender } = render(<ShareGate conversationId={CONVERSATION} open people={[]} share={ok([])} unshare={ok([])} />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(<ShareGate conversationId={CONVERSATION} open={false} people={[]} share={ok([])} unshare={ok([])} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should take the parameter off the address when the dialog is closed", () => {
    render(<ShareGate conversationId={CONVERSATION} open people={[]} share={ok([])} unshare={ok([])} />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(replaced).toEqual([`/assistant/${CONVERSATION}`]);
  });

  it("should show the list it was last given, so a share made in another tab is not shown as missing", () => {
    const { rerender } = render(<ShareGate conversationId={CONVERSATION} open people={[]} share={ok([])} unshare={ok([])} />);
    expect(screen.getByText("This chat is not shared with anyone.")).toBeTruthy();

    rerender(<ShareGate conversationId={CONVERSATION} open people={[person("bob", "Bob Tester")]} share={ok([])} unshare={ok([])} />);

    expect(within(screen.getByRole("list", { name: "Shared with" })).getByText(/Bob Tester/)).toBeTruthy();
  });
});

describe("ShareDialog", () => {
  it("should say what a recipient will see, before anything is shared", () => {
    render(dialog());

    const said = screen.getByRole("dialog").textContent ?? "";
    expect(said).toContain("read");
    expect(said).toContain("cannot reply");
    expect(said).toContain("says only how many");
    // The one case where a file is named anyway, which the owner has to know before they share rather than after.
    expect(said).toContain("may name it");
    expect(said).toContain("most recent part");
  });

  it("should offer the chat's own link to copy", () => {
    render(dialog());

    expect((screen.getByLabelText("Their link") as HTMLInputElement).value).toContain(`/assistant/shared/${CONVERSATION}`);
    expect(screen.getByText(/Anyone else who is sent it sees nothing/)).toBeTruthy();
  });

  it("should ask nobody until the query is long enough to be specific", async () => {
    const asked = people([]);
    render(dialog());

    await type("b");

    expect(asked.calls).toEqual([]);
  });

  it("should ask once for a query typed a letter at a time, and abort what it no longer needs", async () => {
    const asked = people([{ oid: "bob", name: "Bob Tester", email: "bob@example.com" }]);
    render(dialog());

    fireEvent.change(box(), { target: { value: "bo" } });
    fireEvent.change(box(), { target: { value: "bob" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(asked.calls).toEqual(["/api/ui/people?q=bob"]);
    expect(screen.getByRole("option", { name: /Bob Tester/ })).toBeTruthy();
  });

  it("should abort the request in flight when the query changes under it", async () => {
    const asked = people([{ oid: "bob", name: "Bob Tester", email: null }]);
    render(dialog());

    await type("bo");
    fireEvent.change(box(), { target: { value: "bobb" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(asked.signals[0]?.aborted).toBe(true);
    expect(asked.signals[1]?.aborted).toBe(false);
  });

  it("should offer nobody and keep working when the lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    render(dialog());

    await type("bob");

    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("should leave out the people it is already shared with, so nobody is offered twice", async () => {
    people([
      { oid: "bob", name: "Bob Tester", email: "bob@example.com" },
      { oid: "carol", name: "Carol Tester", email: "carol@example.com" }
    ]);
    render(dialog({ people: [person("bob", "Bob Tester")] }));

    await type("tester");

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("Carol Tester")]);
  });

  it("should share with the person picked from the list and show them as a reader", async () => {
    people([{ oid: "bob", name: "Bob Tester", email: "bob@example.com" }]);
    const share = ok([person("bob", "Bob Tester")]);
    render(dialog({ share }));
    await type("bob");

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Bob Tester/ }));
    });

    expect(share).toHaveBeenCalledWith({ conversationId: CONVERSATION, recipientOid: "bob" });
    expect(within(screen.getByRole("list", { name: "Shared with" })).getByText("can read")).toBeTruthy();
    // The box is emptied and the list shut, so the next name starts from nothing.
    expect(box().value).toBe("");
    expect(screen.queryByRole("option")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("should move through the list with the arrow keys and share with Enter", async () => {
    people([
      { oid: "bob", name: "Bob Tester", email: "bob@example.com" },
      { oid: "carol", name: "Carol Tester", email: "carol@example.com" }
    ]);
    const share = ok([person("carol", "Carol Tester")]);
    render(dialog({ share }));
    await type("tester");

    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]?.id);
    // Down from the last option comes back to the first, and up from the first to the last.
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
    fireEvent.keyDown(box(), { key: "ArrowUp" });

    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });

    expect(share).toHaveBeenCalledWith({ conversationId: CONVERSATION, recipientOid: "carol" });
  });

  it("should shut the list on Escape without closing the dialog, which the next Escape does", async () => {
    people([{ oid: "bob", name: "Bob Tester", email: "bob@example.com" }]);
    const onClose = vi.fn();
    render(dialog({ onClose }));
    await type("bob");

    fireEvent.keyDown(box(), { key: "Escape" });

    expect(screen.queryByRole("option")).toBeNull();
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should close the dialog on Escape from the page", () => {
    const onClose = vi.fn();
    render(dialog({ onClose }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("should take a person off the list when their share is removed", async () => {
    const unshare = ok([]);
    render(dialog({ people: [person("bob", "Bob Tester")], unshare }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });

    expect(unshare).toHaveBeenCalledWith({ conversationId: CONVERSATION, recipientOid: "bob" });
    expect(screen.getByText("This chat is not shared with anyone.")).toBeTruthy();
  });

  it("should show the refusal and leave the list alone when a share is refused", async () => {
    const share = vi.fn(async () => ({ ok: false as const, error: "that person has not used the hub yet, so cannot be shared with" }));
    people([{ oid: "bob", name: "Bob Tester", email: "bob@example.com" }]);
    render(dialog({ share }));
    await type("bob");

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Bob Tester/ }));
    });

    expect(screen.getByRole("alert").textContent).toContain("has not used the hub yet");
    expect(screen.getByText("This chat is not shared with anyone.")).toBeTruthy();
  });

  it("should say so and keep the dialog usable when the share cannot be sent at all", async () => {
    const share = vi.fn(async () => {
      throw new Error("offline");
    });
    people([{ oid: "bob", name: "Bob Tester", email: "bob@example.com" }]);
    render(dialog({ share }));
    await type("bob");

    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Bob Tester/ }));
    });

    expect(screen.getByRole("alert").textContent).toContain("check your connection");
    expect(screen.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(false);
  });

  it("should copy the link to the clipboard and say that it did", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(dialog());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`/assistant/shared/${CONVERSATION}`));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  // Without a clipboard permission there is nothing to copy with, so the box is selected for the person to copy by
  // hand rather than the button doing nothing at all.
  it("should select the link instead when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        }
      }
    });
    render(dialog());
    const field = screen.getByLabelText("Their link") as HTMLInputElement;
    const select = vi.spyOn(field, "select");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect(select).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

function view(overrides: Partial<SharedConversationView> = {}): SharedConversationView {
  return {
    id: CONVERSATION,
    title: "Writing a possession order",
    productLabel: "Possession",
    ownerName: "Alice Tester",
    thread: [
      { type: "user", key: "m1", at: "2026-10-25T09:00:00.000Z", text: "What goes in a possession order?", attachmentCount: 0 },
      { type: "assistant", key: "t1", at: "2026-10-25T09:00:01.000Z", text: "The property, the date and the costs." }
    ],
    earlierHidden: false,
    document: null,
    access: "reader",
    ...overrides
  };
}

describe("SharedChat", () => {
  it("should show the thread, whose chat it is, and nothing to write with", () => {
    render(<SharedChat view={view()} />);

    expect(screen.getByRole("heading", { name: "Writing a possession order" })).toBeTruthy();
    expect(screen.getByText(/Shared with you by Alice Tester/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Conversation" })).getByText("What goes in a possession order?")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should tell the owner that this is what the people they named see", () => {
    render(<SharedChat view={view({ access: "owner" })} />);

    expect(screen.getByText(/as the people you shared it with see it/)).toBeTruthy();
  });

  it("should count a message's files without naming them", () => {
    render(<SharedChat view={view({ thread: [{ type: "user", key: "m1", at: "2026-10-25T09:00:00.000Z", text: "Have a look", attachmentCount: 2 }] })} />);

    expect(screen.getByText("2 files sent with this message")).toBeTruthy();
  });

  it("should say that an answer was stopped, rather than letting it end mid-thought", () => {
    render(
      <SharedChat
        view={view({
          thread: [
            { type: "assistant", key: "t1", at: "2026-10-25T09:00:01.000Z", text: "The property, the" },
            { type: "stopped", key: "s1", at: "2026-10-25T09:00:02.000Z" }
          ]
        })}
      />
    );

    expect(screen.getByText("This answer was stopped")).toBeTruthy();
  });

  it("should say so when the chat began before the part it shows", () => {
    render(<SharedChat view={view({ earlierHidden: true })} />);

    expect(screen.getByText(/most recent part of the chat/)).toBeTruthy();
  });

  it("should say nothing about earlier messages when the whole chat is shown", () => {
    render(<SharedChat view={view()} />);

    expect(screen.queryByText(/most recent part of the chat/)).toBeNull();
  });

  it("should show the document under its own heading when the chat has one", () => {
    render(<SharedChat view={view({ document: { title: "Draft order", markdown: "The property, the date and the costs." } })} />);

    expect(screen.getByRole("heading", { name: "Draft order" })).toBeTruthy();
  });

  it("should show no document section when the chat has none", () => {
    render(<SharedChat view={view()} />);

    expect(screen.queryByRole("heading", { name: "Draft order" })).toBeNull();
  });
});
