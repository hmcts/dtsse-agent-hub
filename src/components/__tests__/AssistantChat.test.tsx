/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import type { ConversationView } from "@/assistant/views";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { Composer } from "@/components/assistant/Composer";
import { EmptyChat } from "@/components/assistant/EmptyChat";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { ConversationPage, TranscriptEntryView } from "@/transcripts/conversation";

const AGENT = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined,
  useWatch: () => undefined
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
  hubHandlers.clear();
  vi.useRealTimers();
});

function message(id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-10-21T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "delivered",
    ...overrides
  };
}

function entry(id: string, overrides: Partial<TranscriptEntryView> = {}): TranscriptEntryView {
  return {
    id,
    key: `k${id}`,
    session_id: "session-1",
    role: "assistant",
    content: { text: `entry ${id}` },
    truncated: false,
    redacted: false,
    message_id: null,
    occurred_at: "2026-10-21T09:01:00.000Z",
    ...overrides
  };
}

function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
  return { messages: [], entries: [], olderBefore: null, lastId: null, more: false, ...overrides };
}

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: CONVERSATION,
    title: "Writing a story",
    product: "ccd",
    productLabel: "CCD",
    productHistory: [],
    agentId: AGENT,
    agentStatus: "idle",
    sessionState: null,
    sessionDetail: null,
    artefact: { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null },
    page: page(),
    ...overrides
  };
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function actions(overrides: Partial<ChatActions> = {}): ChatActions {
  return {
    send: vi.fn(async () => ({ ok: true as const, message: message("99", { body: "sent" }) })),
    warm: ok(),
    setProduct: ok(),
    rename: ok(),
    remove: ok(),
    saveArtefact: vi.fn(async () => ({ ok: true as const, saved: true as const, version: 1 })),
    ...overrides
  };
}

function emit(type: string, data: unknown): void {
  act(() => {
    hubHandlers.get(type)?.(data);
  });
}

async function type(text: string): Promise<void> {
  const box = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

describe("ChatView thread", () => {
  it("should show what the person and the assistant said and hide tool calls, results and system lines when rendering the thread", () => {
    const initial = page({
      messages: [message("1", { body: "How do I add an event?" })],
      entries: [
        entry("2", { role: "tool_use", content: { id: "t1", name: "Read", input: { file: "secret.ts" } } }),
        entry("3", { role: "tool_result", content: { tool_use_id: "t1", output: "the tool output", is_error: false } }),
        entry("4", { role: "system", content: { text: "a system line" } }),
        entry("5", { role: "assistant", content: { text: "Add it to the definition." }, occurred_at: "2026-10-21T09:02:00.000Z" })
      ]
    });
    render(<ChatView view={conversation({ page: initial })} templates={TEMPLATES} actions={actions()} />);

    const thread = screen.getByRole("list", { name: "Conversation" });
    expect(within(thread).getByText("How do I add an event?")).toBeTruthy();
    expect(within(thread).getByText("Add it to the definition.")).toBeTruthy();
    expect(within(thread).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("the tool output")).toBeNull();
    expect(screen.queryByText("a system line")).toBeNull();
    expect(screen.queryByText(/secret\.ts/)).toBeNull();
  });

  it("should mark a product change in the thread when the conversation's product history has one", () => {
    render(
      <ChatView view={conversation({ productHistory: [{ product: "pcs", at: "2026-10-21T08:00:00.000Z" }] })} templates={TEMPLATES} actions={actions()} />
    );

    expect(screen.getByText(/Product changed to Possession Claims Service \(PCS\)/)).toBeTruthy();
  });

  it("should say the message was not delivered when it expired", () => {
    render(<ChatView view={conversation({ page: page({ messages: [message("1", { delivery: "expired" })] }) })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByText("Not delivered. Send it again.")).toBeTruthy();
  });
});

describe("ChatView progress", () => {
  it("should say the assistant is starting when the last message is undelivered and the agent is offline", () => {
    render(
      <ChatView
        view={conversation({ agentStatus: "offline", page: page({ messages: [message("1", { delivery: "queued" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByText("Starting your assistant…")).toBeTruthy();
  });

  it("should say it is waiting for a free assistant when the session is queued", () => {
    render(
      <ChatView
        view={conversation({ agentStatus: "offline", sessionState: "queued", page: page({ messages: [message("1", { delivery: "queued" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByText("Waiting for a free assistant…")).toBeTruthy();
  });

  it("should name the latest tool call's activity when the agent is busy", () => {
    const initial = page({
      messages: [message("1")],
      entries: [
        entry("2", { role: "tool_use", content: { id: "t1", name: "Grep", input: {} } }),
        entry("3", { role: "tool_use", content: { id: "t2", name: "Read", input: {} }, occurred_at: "2026-10-21T09:01:30.000Z" })
      ]
    });
    render(<ChatView view={conversation({ agentStatus: "busy", page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByRole("status").textContent).toContain("Reading");
  });

  it("should show nothing in progress when the assistant has answered and is idle", () => {
    const initial = page({ messages: [message("1")], entries: [entry("2")] });
    render(<ChatView view={conversation({ page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.queryByText(/Starting your assistant/)).toBeNull();
  });

  it("should follow the agent's status from the stream when an agent_status event names this agent", () => {
    render(
      <ChatView
        view={conversation({ agentStatus: "offline", page: page({ messages: [message("1", { delivery: "queued" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    emit("agent_status", { agent_id: "someone-else", status: "busy" });
    expect(screen.getByText("Starting your assistant…")).toBeTruthy();

    emit("agent_status", { agent_id: AGENT, status: "busy" });
    expect(screen.queryByText("Starting your assistant…")).toBeNull();
    expect(screen.getByText("Thinking")).toBeTruthy();
  });
});

describe("ChatView product", () => {
  it("should draw the chosen product's label itself when the header shows the picker", () => {
    render(
      <ChatView view={conversation({ product: "sscs", productLabel: "SSCS (Social Security and Child Support)" })} templates={TEMPLATES} actions={actions()} />
    );

    const drawn = screen.getAllByText("SSCS (Social Security and Child Support)").filter((node) => node.tagName !== "OPTION");

    expect(drawn).toHaveLength(1);
    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("sscs");
  });

  it("should change the product only once the person confirms when they pick another product", async () => {
    const setProduct = ok();
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions({ setProduct })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    const dialog = screen.getByRole("dialog", { name: "Change product?" });
    expect(dialog.textContent).toContain("CCD");
    expect(dialog.textContent).toContain("Possession Claims Service (PCS)");
    expect(setProduct).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Change product" }));
    });

    expect(setProduct).toHaveBeenCalledWith({ conversationId: CONVERSATION, product: "pcs" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should leave the product alone when the person cancels the change", () => {
    const setProduct = ok();
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions({ setProduct })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setProduct).not.toHaveBeenCalled();
  });

  it("should close the confirmation when the person presses Escape", () => {
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show the refusal when the product cannot be changed", async () => {
    render(
      <ChatView
        view={conversation()}
        templates={TEMPLATES}
        actions={actions({ setProduct: vi.fn(async () => ({ ok: false as const, error: "no such product" })) })}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change product" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("no such product");
  });

  it("should show the default and change from it when the conversation is on a product no longer offered", () => {
    const setProduct = ok();
    render(<ChatView view={conversation({ product: "other", productLabel: "other" })} templates={TEMPLATES} actions={actions({ setProduct })} />);

    const select = screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement;
    expect(select.value).toBe("general");
    expect(within(select).queryByRole("option", { name: "other" })).toBeNull();

    fireEvent.change(select, { target: { value: "pcs" } });

    expect(screen.getByRole("dialog", { name: "Change product?" }).textContent).toContain("from General to Possession Claims Service (PCS)");
  });
});

describe("ChatView sending", () => {
  it("should send the message and show it in the thread when sending succeeds", async () => {
    const send = vi.fn(async () => ({ ok: true as const, message: message("9", { body: "hello assistant" }) }));
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions({ send })} />);

    await type("hello assistant");

    expect(send).toHaveBeenCalledWith({ conversationId: CONVERSATION, body: "hello assistant" });
    expect(within(screen.getByRole("list", { name: "Conversation" })).getByText("hello assistant")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("should show the error and keep the text when sending fails", async () => {
    render(
      <ChatView
        view={conversation()}
        templates={TEMPLATES}
        actions={actions({ send: vi.fn(async () => ({ ok: false as const, error: "that conversation no longer exists" })) })}
      />
    );

    await type("hello");

    expect(screen.getByRole("alert").textContent).toBe("that conversation no longer exists");
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("hello");
  });

  it("should warm the session once when the person focuses the composer and the agent is offline", () => {
    const warm = ok();
    render(<ChatView view={conversation({ agentStatus: "offline" })} templates={TEMPLATES} actions={actions({ warm })} />);

    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.focus(box);
    fireEvent.blur(box);
    fireEvent.focus(box);

    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith({ conversationId: CONVERSATION });
  });

  it("should not warm the session when the agent is already running", () => {
    const warm = ok();
    render(<ChatView view={conversation({ agentStatus: "idle" })} templates={TEMPLATES} actions={actions({ warm })} />);

    fireEvent.focus(screen.getByRole("textbox", { name: "Message" }));

    expect(warm).not.toHaveBeenCalled();
  });
});

describe("ChatView document", () => {
  it("should open the document panel when the person chooses Add document", () => {
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

    expect(screen.queryByRole("region", { name: "Document" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add document/ }));

    expect(screen.getByRole("region", { name: "Document" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add document/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(screen.queryByRole("region", { name: "Document" })).toBeNull();
  });

  it("should offer to open the document when one has been written", () => {
    render(
      <ChatView
        view={conversation({ artefact: { title: "Story", markdown: "x", version: 1, updatedBy: "user", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByRole("button", { name: /Open document/ })).toBeTruthy();
  });

  it("should open the panel when the assistant writes a newer version of the document", () => {
    const { rerender } = render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

    rerender(
      <ChatView
        view={conversation({ artefact: { title: "Story", markdown: "# Drafted", version: 1, updatedBy: "agent", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByRole("region", { name: "Document" })).toBeTruthy();
  });

  it("should leave the panel closed when the newer version is the person's own", () => {
    const { rerender } = render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

    rerender(
      <ChatView
        view={conversation({ artefact: { title: "Story", markdown: "# Mine", version: 1, updatedBy: "user", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.queryByRole("region", { name: "Document" })).toBeNull();
  });
});

describe("ChatView menu", () => {
  it("should rename the chat when the person saves a new name from the options menu", async () => {
    const rename = ok();
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions({ rename })} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "Chat name" }) as HTMLInputElement;
    expect(box.value).toBe("Writing a story");
    fireEvent.change(box, { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(rename).toHaveBeenCalledWith({ conversationId: CONVERSATION, title: "Renamed" });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  });

  it("should delete the chat and go to a new chat when the person confirms the delete", async () => {
    const remove = ok();
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions({ remove })} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(remove).toHaveBeenCalledWith({ conversationId: CONVERSATION });
    expect(push).toHaveBeenCalledWith("/assistant");
  });

  it("should show the refusal and stay when the chat cannot be deleted", async () => {
    render(
      <ChatView view={conversation()} templates={TEMPLATES} actions={actions({ remove: vi.fn(async () => ({ ok: false as const, error: "gone already" })) })} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("gone already");
  });

  it("should close the options menu when the person presses Escape", () => {
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("menu", { name: "Chat options" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Composer", () => {
  function composer(onSend: (text: string) => Promise<string | null> = vi.fn(async () => null), props: Partial<Parameters<typeof Composer>[0]> = {}) {
    render(<Composer templates={TEMPLATES} onSend={onSend} {...props} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  it("should send and clear the box when the person presses Enter", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);

    fireEvent.change(box, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).toHaveBeenCalledWith("hello");
    expect(box.value).toBe("");
  });

  it("should not send when the person presses Shift+Enter", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);

    fireEvent.change(box, { target: { value: "line one" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe("line one");
  });

  it("should disable Send and send nothing when the box is empty or only whitespace", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);

    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "   " } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should send when the person clicks Send", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);

    fireEvent.change(box, { target: { value: "hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(onSend).toHaveBeenCalledWith("hi");
  });

  it("should not send when the composer is disabled", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend, { disabled: true });

    fireEvent.change(box, { target: { value: "hi" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("should fill the box with a template when the person picks one from the menu", () => {
    const box = composer();

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Templates" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bug" }));

    expect(box.value).toBe(TEMPLATES.find((template) => template.name === "Bug")?.text);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the menu when the person presses Escape", () => {
    composer();

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    expect(screen.getByRole("menu", { name: "Add" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a template" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("should close the menu when the person clicks outside it", () => {
    composer();

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should show the error, describe the box with it and keep the text when sending fails", async () => {
    const box = composer(vi.fn(async () => "a message is at most 10 characters"));

    fireEvent.change(box, { target: { value: "too long a message" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("a message is at most 10 characters");
    expect(box.getAttribute("aria-describedby")).toBe(alert.id);
    expect(box.value).toBe("too long a message");
  });
});

describe("EmptyChat", () => {
  it("should start a conversation with the starter's prompt and the chosen product and go to it when the person picks a starter card", async () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    render(<EmptyChat starters={STARTERS} templates={TEMPLATES} start={start} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    const starter = STARTERS[0];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(starter?.title ?? "") }));
    });

    expect(start).toHaveBeenCalledWith({ product: "pcs", body: starter?.prompt });
    expect(push).toHaveBeenCalledWith("/assistant/abc");
  });

  it("should start with the default product when the person has not chosen one", async () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    render(<EmptyChat starters={STARTERS} templates={TEMPLATES} start={start} />);

    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("general");
    await type("my own words");

    expect(start).toHaveBeenCalledWith({ product: "general", body: "my own words" });
    expect(push).toHaveBeenCalledWith("/assistant/abc");
  });

  it("should show the error and let the person try again when a starter cannot start", async () => {
    render(<EmptyChat starters={STARTERS} templates={TEMPLATES} start={vi.fn(async () => ({ ok: false as const, error: "not available" }))} />);

    const card = screen.getByRole("button", { name: /Research/ }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(card);
    });

    expect(screen.getByRole("alert").textContent).toBe("not available");
    expect(card.disabled).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
