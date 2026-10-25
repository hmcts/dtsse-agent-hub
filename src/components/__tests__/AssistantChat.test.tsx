/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/agents/skills";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import type { ConversationView } from "@/assistant/views";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { Composer } from "@/components/assistant/Composer";
import { EmptyChat, type EmptyChatActions, NEW_CHAT_DRAFT } from "@/components/assistant/EmptyChat";
import { draftKey } from "@/components/useDraft";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { ConversationPage, TranscriptEntryView } from "@/transcripts/conversation";

const AGENT = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const OTHER_CONVERSATION = "33333333-3333-3333-3333-333333333333";
const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_VIEWER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined,
  useWatch: () => undefined
}));

/** Every observer the message box made, so a test can deliver the resize jsdom never will. */
const resizes: (() => void)[] = [];

beforeEach(() => {
  resizes.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
  hubHandlers.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
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
    skills: [],
    clientFeatures: null,
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
    render(<ChatView viewerOid={VIEWER} view={conversation({ page: initial })} templates={TEMPLATES} actions={actions()} />);

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
      <ChatView
        viewerOid={VIEWER}
        view={conversation({ productHistory: [{ product: "pcs", at: "2026-10-21T08:00:00.000Z" }] })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByText(/Product changed to Possession Claims Service \(PCS\)/)).toBeTruthy();
  });

  it("should say the message was not delivered when it expired", () => {
    render(
      <ChatView
        viewerOid={VIEWER}
        view={conversation({ page: page({ messages: [message("1", { delivery: "expired" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByText("Not delivered. Send it again.")).toBeTruthy();
  });
});

describe("ChatView progress", () => {
  it("should say the assistant is starting when the last message is undelivered and the agent is offline", () => {
    render(
      <ChatView
        viewerOid={VIEWER}
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
        viewerOid={VIEWER}
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
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "busy", page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByText("Reading")).toBeTruthy();
  });

  it("should show nothing in progress when the assistant has answered and is idle", () => {
    const initial = page({ messages: [message("1")], entries: [entry("2")] });
    render(<ChatView viewerOid={VIEWER} view={conversation({ page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.queryByText(/Starting your assistant/)).toBeNull();
  });

  it("should say how many subagents it is waiting on when the assistant has handed work out", () => {
    const initial = page({
      messages: [message("1")],
      entries: [
        entry("2", { role: "tool_use", content: { id: "t1", name: "Agent", input: {} } }),
        entry("3", { role: "tool_use", content: { id: "t2", name: "Agent", input: {} }, occurred_at: "2026-10-21T09:01:10.000Z" }),
        entry("4", { role: "tool_use", content: { id: "t3", name: "Agent", input: {} }, occurred_at: "2026-10-21T09:01:20.000Z" }),
        entry("5", {
          role: "tool_result",
          content: { tool_use_id: "t2", output: "done", is_error: false },
          occurred_at: "2026-10-21T09:01:30.000Z"
        })
      ]
    });
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "busy", page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByText("Working through it · 2 helpers running")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Working on your answer, with 2 helpers running");
  });

  it("should clear the line and the announcement when a stopped answer leaves the session idle", () => {
    const initial = page({
      messages: [message("1")],
      entries: [entry("2", { role: "tool_use", content: { id: "t1", name: "Agent", input: {} } })]
    });
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "busy", page: initial })} templates={TEMPLATES} actions={actions()} />);
    expect(screen.getByRole("status").textContent).toBe("Working on your answer, with 1 helper running");

    emit("agent_status", { agent_id: AGENT, status: "idle" });

    expect(screen.queryByText(/helper/)).toBeNull();
    expect(screen.queryByText("Working through it")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("should keep a live region in the page before there is anything to announce, so the first thing it says is read", () => {
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("should not read the activity out, since it changes with every tool call", () => {
    const initial = page({
      messages: [message("1")],
      entries: [entry("2", { role: "tool_use", content: { id: "t1", name: "Grep", input: {} } })]
    });
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "busy", page: initial })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.getByText("Searching")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Working on your answer");
  });

  it("should follow the agent's status from the stream when an agent_status event names this agent", () => {
    render(
      <ChatView
        viewerOid={VIEWER}
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
      <ChatView
        viewerOid={VIEWER}
        view={conversation({ product: "sscs", productLabel: "SSCS (Social Security and Child Support)" })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    const drawn = screen.getAllByText("SSCS (Social Security and Child Support)").filter((node) => node.tagName !== "OPTION");

    expect(drawn).toHaveLength(1);
    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("sscs");
  });

  it("should change the product only once the person confirms when they pick another product", async () => {
    const setProduct = ok();
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions({ setProduct })} />);

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
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions({ setProduct })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setProduct).not.toHaveBeenCalled();
  });

  it("should close the confirmation when the person presses Escape", () => {
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show the refusal when the product cannot be changed", async () => {
    render(
      <ChatView
        viewerOid={VIEWER}
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
    render(
      <ChatView viewerOid={VIEWER} view={conversation({ product: "other", productLabel: "other" })} templates={TEMPLATES} actions={actions({ setProduct })} />
    );

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
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions({ send })} />);

    await type("hello assistant");

    expect(send).toHaveBeenCalledWith({ conversationId: CONVERSATION, body: "hello assistant", uploadIds: [] });
    expect(within(screen.getByRole("list", { name: "Conversation" })).getByText("hello assistant")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("should show the error and keep the text when sending fails", async () => {
    render(
      <ChatView
        viewerOid={VIEWER}
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
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "offline" })} templates={TEMPLATES} actions={actions({ warm })} />);

    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.focus(box);
    fireEvent.blur(box);
    fireEvent.focus(box);

    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith({ conversationId: CONVERSATION });
  });

  it("should not warm the session when the agent is already running", () => {
    const warm = ok();
    render(<ChatView viewerOid={VIEWER} view={conversation({ agentStatus: "idle" })} templates={TEMPLATES} actions={actions({ warm })} />);

    fireEvent.focus(screen.getByRole("textbox", { name: "Message" }));

    expect(warm).not.toHaveBeenCalled();
  });
});

describe("ChatView skills", () => {
  it("should offer the conversation's skills in the composer when its session reported some", () => {
    const skills = [{ name: "cft-explain", description: "Answer a what is X question" }];
    render(<ChatView viewerOid={VIEWER} view={conversation({ skills })} templates={TEMPLATES} actions={actions()} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Message" }), { target: { value: "/cft" } });

    expect(screen.getByRole("option", { name: /cft-explain/ })).toBeTruthy();
  });

  // A reported skill list re-reads the page through `AssistantRefresh`, which debounces it against the rest of a
  // cold chat coming up; that is covered in `AssistantShell.test.tsx`.
  it("should not re-read the page itself when the conversation's agent reports a changed skill list", () => {
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    emit("agent_skills", { agent_id: AGENT });

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("ChatView document", () => {
  it("should open the document panel when the person chooses Add document", () => {
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

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
        viewerOid={VIEWER}
        view={conversation({ artefact: { title: "Story", markdown: "x", version: 1, updatedBy: "user", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByRole("button", { name: /Open document/ })).toBeTruthy();
  });

  it("should open the panel when the assistant writes a newer version of the document", () => {
    const { rerender } = render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    rerender(
      <ChatView
        viewerOid={VIEWER}
        view={conversation({ artefact: { title: "Story", markdown: "# Drafted", version: 1, updatedBy: "agent", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByRole("region", { name: "Document" })).toBeTruthy();
  });

  it("should leave the panel closed when the newer version is the person's own", () => {
    const { rerender } = render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    rerender(
      <ChatView
        viewerOid={VIEWER}
        view={conversation({ artefact: { title: "Story", markdown: "# Mine", version: 1, updatedBy: "user", updatedAt: "2026-10-21T09:00:00.000Z" } })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.queryByRole("region", { name: "Document" })).toBeNull();
  });
});

describe("ChatView menu", () => {
  it("should offer the open chat for sharing from the options menu", () => {
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));

    expect(screen.getByRole("menuitem", { name: "Share" }).getAttribute("href")).toBe(`/assistant/${CONVERSATION}?share=1`);
  });

  it("should rename the chat when the person saves a new name from the options menu", async () => {
    const rename = ok();
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions({ rename })} />);

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
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions({ remove })} />);

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
      <ChatView
        viewerOid={VIEWER}
        view={conversation()}
        templates={TEMPLATES}
        actions={actions({ remove: vi.fn(async () => ({ ok: false as const, error: "gone already" })) })}
      />
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
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("menu", { name: "Chat options" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Composer", () => {
  function composer(onSend: (text: string) => Promise<string | null> = vi.fn(async () => null), props: Partial<Parameters<typeof Composer>[0]> = {}) {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId={CONVERSATION} onSend={onSend} {...props} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  it("should send and clear the box when the person presses Enter", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);

    fireEvent.change(box, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).toHaveBeenCalledWith("hello", []);
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

    expect(onSend).toHaveBeenCalledWith("hi", []);
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

describe("Composer skills", () => {
  const SKILLS: Skill[] = [
    { name: "cft-explain", description: "Answer a what is X question" },
    { name: "cft-how-to", description: "Find a how-to recipe" },
    { name: "pcs:start-env", description: "Start an environment out of hours" }
  ];

  function composer(skills: Skill[] = SKILLS, onSend: (text: string) => Promise<string | null> = vi.fn(async () => null)) {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId={CONVERSATION} onSend={onSend} skills={skills} />);
  }

  function field(): HTMLTextAreaElement {
    return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  }

  function write(value: string): void {
    fireEvent.change(field(), { target: { value } });
  }

  function options(): string[] {
    return screen.queryAllByRole("option").map((option) => option.firstElementChild?.textContent ?? "");
  }

  function activeOption(): string | null {
    const id = field().getAttribute("aria-activedescendant");
    return id === null ? null : (document.getElementById(id)?.firstElementChild?.textContent ?? null);
  }

  it("should list every skill with its description when the message is a bare slash", () => {
    composer();

    write("/");

    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(options()).toEqual(["/cft-explain", "/cft-how-to", "/pcs:start-env"]);
    expect(activeOption()).toBe("/cft-explain");
    expect(within(screen.getByRole("listbox", { name: "Skills" })).getByText("Find a how-to recipe")).toBeTruthy();
  });

  it("should narrow the list to the names that match when a query is typed", () => {
    composer();

    write("/cft");

    expect(options()).toEqual(["/cft-explain", "/cft-how-to"]);
  });

  it("should move the active option with the arrow keys, wrapping at either end", () => {
    composer();
    write("/cft");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toBe("/cft-how-to");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toBe("/cft-explain");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(activeOption()).toBe("/cft-how-to");
  });

  it("should pick the active skill and not send when Enter is pressed while the list is open", async () => {
    const onSend = vi.fn(async () => null);
    composer(SKILLS, onSend);
    write("/cft");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(field().value).toBe("/cft-explain ");
    expect(field().selectionStart).toBe("/cft-explain ".length);
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("should pick the skill that is clicked", () => {
    composer();
    write("/");

    fireEvent.click(screen.getByRole("option", { name: /pcs:start-env/ }));

    expect(field().value).toBe("/pcs:start-env ");
    expect(document.activeElement).toBe(field());
  });

  it("should close the list on Escape and keep it closed until the message changes", () => {
    composer();
    write("/cft");

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);

    write("/cft-");
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  it("should send the skill line on Enter when the list is closed", async () => {
    const onSend = vi.fn(async () => null);
    composer(SKILLS, onSend);
    write("/cft-explain what is CDAM?");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onSend).toHaveBeenCalledWith("/cft-explain what is CDAM?", []);
  });

  // Both popovers are drawn above the box, in the same place, so either one open with the other would be painted
  // over by it.
  it("should close the skill list when the + menu is opened", () => {
    composer();
    write("/cft");

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));

    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(options()).toEqual([]);
    expect(screen.getByRole("menu", { name: "Add" })).toBeTruthy();
  });

  it("should close the + menu when the skill list opens", () => {
    composer();
    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));

    write("/cft");

    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  it("should offer the list again when a template starting with a slash is picked after an Escape", () => {
    const templates = [{ name: "Skill template", text: "/cft-explain what is CDAM?" }];
    render(<Composer templates={templates} viewerOid={VIEWER} draftId={CONVERSATION} onSend={vi.fn(async () => null)} skills={SKILLS} />);
    write("/cft");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Templates" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Skill template" }));

    expect(field().value).toBe("/cft-explain what is CDAM?");
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  it("should be a plain box with no list when the session reported no skills", () => {
    composer([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "/" } });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryAllByRole("option")).toEqual([]);
  });
});

function emptyActions(start: EmptyChatActions["start"]): EmptyChatActions {
  return {
    start,
    open: vi.fn(async () => ({ ok: true as const, id: "opened" })),
    send: vi.fn(async () => ({ ok: true as const })),
    setProduct: vi.fn(async () => ({ ok: true as const }))
  };
}

/** Unmounting flushes whatever the throttle still owes, so none of these has to wait on its timer. */
describe("Composer draft", () => {
  function composer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId={CONVERSATION} onSend={vi.fn(async () => null)} {...props} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  function write(box: HTMLTextAreaElement, value: string): void {
    fireEvent.change(box, { target: { value } });
  }

  function stored(draftId: string, viewerOid = VIEWER): string | null {
    return sessionStorage.getItem(draftKey("assistant-draft", viewerOid, draftId));
  }

  it("should restore the unsent message when the composer mounts again for the same conversation", () => {
    write(composer(), "half a thought about CDAM");

    cleanup();
    const box = composer();

    expect(box.value).toBe("half a thought about CDAM");
    expect(stored(CONVERSATION)).toBe("half a thought about CDAM");
  });

  it("should keep each conversation's draft apart when both have one", () => {
    write(composer(), "meant for this conversation");
    cleanup();
    write(composer({ draftId: OTHER_CONVERSATION }), "meant for the other one");
    cleanup();

    const box = composer();

    expect(box.value).toBe("meant for this conversation");
    expect(stored(OTHER_CONVERSATION)).toBe("meant for the other one");
  });

  it("should start empty when the conversation has no draft of its own", () => {
    write(composer(), "meant for this conversation");
    cleanup();

    const box = composer({ draftId: OTHER_CONVERSATION });

    expect(box.value).toBe("");
    expect(stored(OTHER_CONVERSATION)).toBeNull();
  });

  it("should forget the draft when the message is sent", async () => {
    const box = composer();
    write(box, "all finished");

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(box.value).toBe("");
    expect(stored(CONVERSATION)).toBeNull();
    cleanup();
    expect(composer().value).toBe("");
  });

  it("should keep the draft when the send is refused", async () => {
    const box = composer({ onSend: vi.fn(async () => "the assistant is not available") });
    write(box, "worth keeping");

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe("the assistant is not available");
    cleanup();
    expect(composer().value).toBe("worth keeping");
  });

  it("should keep the next message when it was typed while the send was in flight", async () => {
    // The box is not disabled while the send is in flight, so the next message is typed before the send resolves.
    const onSend = vi.fn(async () => {
      write(screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement, "and the next thought");
      return null;
    });
    const box = composer({ onSend });
    write(box, "all finished");

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).toHaveBeenCalledWith("all finished", []);
    expect(box.value).toBe("and the next thought");
    cleanup();
    expect(composer().value).toBe("and the next thought");
  });

  it("should keep only what was typed past the sent message when the person carried on typing in the same box", async () => {
    // The box still shows the sent text while the send is in flight, so what is typed next lands on the end of it.
    // Keeping all of it would leave "all finished" in the box for Enter to deliver a second time.
    const onSend = vi.fn(async () => {
      write(screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement, "all finished, and one more thing");
      return null;
    });
    const box = composer({ onSend });
    write(box, "all finished");

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(box.value).toBe(", and one more thing");
    expect(stored(CONVERSATION)).toBe(", and one more thing");
    cleanup();
    expect(composer().value).toBe(", and one more thing");
  });

  it("should leave no draft behind when the box is emptied by hand", () => {
    const box = composer();
    write(box, "second thoughts");
    write(box, "");

    cleanup();

    expect(composer().value).toBe("");
    expect(stored(CONVERSATION)).toBeNull();
  });

  it("should keep the draft without waiting for the box to go away once the throttle has run", () => {
    // The usual way a draft is lost is a crash or a closed laptop with the box still open, so it has to reach
    // storage while the person is still on the page rather than only when the box goes away.
    vi.useFakeTimers();
    write(composer(), "still typing");
    expect(stored(CONVERSATION)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(stored(CONVERSATION)).toBe("still typing");
  });

  it("should keep a template the person picked and then left as a draft", () => {
    composer();
    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Templates" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bug" }));

    cleanup();

    expect(composer().value).toBe(TEMPLATES.find((template) => template.name === "Bug")?.text);
  });

  it("should show no draft of the person who signed out when someone else signs in on the same tab", () => {
    write(composer(), "not for anyone else to see");
    cleanup();

    const box = composer({ viewerOid: OTHER_VIEWER });

    expect(box.value).toBe("");
    expect(stored(CONVERSATION, OTHER_VIEWER)).toBeNull();
  });

  it("should leave none of the signed-out person's drafts of any kind in the tab when someone else signs in", () => {
    write(composer(), "not for anyone else to see");
    cleanup();
    sessionStorage.setItem(draftKey("direct-draft", VIEWER, AGENT), "nor this message to an agent");
    sessionStorage.setItem("agent-hub:something-else", "not a draft");

    composer({ viewerOid: OTHER_VIEWER });

    expect(stored(CONVERSATION)).toBeNull();
    expect(sessionStorage.getItem(draftKey("direct-draft", VIEWER, AGENT))).toBeNull();
    expect(sessionStorage.getItem("agent-hub:something-else")).toBe("not a draft");
  });

  it("should keep the draft when the page is hidden before the throttle has written it", () => {
    // React cleanup does not run on a page unload, so without a flush on hide the first 300ms of a message is lost.
    write(composer(), "quick");
    expect(stored(CONVERSATION)).toBeNull();

    fireEvent(window, new Event("pagehide"));

    expect(stored(CONVERSATION)).toBe("quick");
  });

  // jsdom does no layout, so a test about the box's height says how wide the box is and how tall its text is. Width
  // comes first because a box of no width cannot be measured at all.
  function laidOut(width: number, height: (box: HTMLTextAreaElement) => number): void {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function scrollHeight(this: Element) {
      return height(this as HTMLTextAreaElement);
    });
  }

  it("should grow the box to the height of the restored draft when a draft of several lines is put back", () => {
    laidOut(248, (box) => (box.value?.split("\n").length ?? 1) * 20);
    write(composer(), "line one\nline two\nline three");
    cleanup();

    const box = composer();

    expect(box.value).toBe("line one\nline two\nline three");
    expect(box.style.height).toBe("60px");
  });

  it("should stop growing the box at the height it starts scrolling at when the restored draft is longer still", () => {
    laidOut(248, () => 600);
    write(composer(), "a very long draft");
    cleanup();

    expect(composer().style.height).toBe("200px");
  });

  it("should leave the box one line tall when it is measured before it has been given a width", () => {
    // With no width the text wraps at nothing, a line per character, and the box would be given the whole of the
    // height it is allowed to hold an empty message. One line is what an empty box needs.
    laidOut(0, () => 485);

    expect(composer().style.height).toBe("auto");
  });

  it("should measure the box again when it is given a width, which on a phone is after the sidebar becomes a drawer", () => {
    let width = 0;
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => (width === 0 ? 485 : 35));
    const box = composer();

    width = 248;
    act(() => {
      for (const resize of resizes) {
        resize();
      }
    });

    expect(box.style.height).toBe("35px");
  });

  it("should leave the box alone when it is told of a change that is not a change of width", () => {
    laidOut(248, () => 35);
    const box = composer();
    box.style.height = "99px";

    act(() => {
      for (const resize of resizes) {
        resize();
      }
    });

    expect(box.style.height).toBe("99px");
  });

  it("should keep the draft of a conversation the person switched away from and came back to", () => {
    // Each conversation is its own page, so switching unmounts this chat and mounts the other one's.
    const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);
    write(box(), "half a thought about CDAM");
    cleanup();

    render(<ChatView viewerOid={VIEWER} view={conversation({ id: OTHER_CONVERSATION })} templates={TEMPLATES} actions={actions()} />);
    expect(box().value).toBe("");
    cleanup();
    render(<ChatView viewerOid={VIEWER} view={conversation()} templates={TEMPLATES} actions={actions()} />);

    expect(box().value).toBe("half a thought about CDAM");
  });
});

describe("EmptyChat", () => {
  it("should start a conversation with the starter's prompt and the chosen product and go to it when the person picks a starter card", async () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });
    const starter = STARTERS[0];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(starter?.title ?? "") }));
    });

    expect(start).toHaveBeenCalledWith({ product: "pcs", body: starter?.prompt });
    expect(push).toHaveBeenCalledWith("/assistant/abc");
  });

  it("should offer no skill list when the person types a slash, because a new chat has no session yet", () => {
    render(
      <EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(vi.fn(async () => ({ ok: true as const, id: "abc" })))} />
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "/" } });

    // The only listbox a skill list would add; the product select's own options are its, and stay.
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  });

  it("should start with the default product when the person has not chosen one", async () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);

    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("general");
    await type("my own words");

    expect(start).toHaveBeenCalledWith({ product: "general", body: "my own words" });
    expect(push).toHaveBeenCalledWith("/assistant/abc");
  });

  it("should show the error and let the person try again when a starter cannot start", async () => {
    render(
      <EmptyChat
        viewerOid={VIEWER}
        starters={STARTERS}
        templates={TEMPLATES}
        actions={emptyActions(vi.fn(async () => ({ ok: false as const, error: "not available" })))}
      />
    );

    const card = screen.getByRole("button", { name: /Research/ }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(card);
    });

    expect(screen.getByRole("alert").textContent).toBe("not available");
    expect(card.disabled).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("should keep what was typed in the new chat when the person goes away and comes back", () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);
    fireEvent.change(box(), { target: { value: "a thought I have not finished" } });

    cleanup();
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);

    expect(box().value).toBe("a thought I have not finished");
    expect(sessionStorage.getItem(draftKey("assistant-draft", VIEWER, NEW_CHAT_DRAFT))).toBe("a thought I have not finished");
  });

  it("should forget the new chat's draft once the first message has created the conversation", async () => {
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);

    await type("my own words");

    expect(push).toHaveBeenCalledWith("/assistant/abc");
    expect(sessionStorage.getItem(draftKey("assistant-draft", VIEWER, NEW_CHAT_DRAFT))).toBeNull();
  });

  it("should leave no sent words in the new chat's draft when the person typed on while the first send was in flight", async () => {
    // The new chat's draft is not keyed on any conversation, so anything left in it is what the *next* new chat
    // opens with. Words that have already been delivered must not be among them, or Enter sends them again.
    const start = vi.fn(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "my own words and a second thought" } });
      return { ok: true as const, id: "abc" };
    });
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);

    await type("my own words");

    expect(sessionStorage.getItem(draftKey("assistant-draft", VIEWER, NEW_CHAT_DRAFT))).toBe(" and a second thought");
    cleanup();
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(" and a second thought");
  });

  it("should keep what is in the box when a starter card starts a conversation instead", async () => {
    // The card sends its own words, so what the person typed is still unsent and is still theirs to come back to.
    const start = vi.fn(async () => ({ ok: true as const, id: "abc" }));
    const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);
    fireEvent.change(box(), { target: { value: "a thought I have not finished" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(STARTERS[0]?.title ?? "") }));
    });

    expect(start).toHaveBeenCalledWith({ product: "general", body: STARTERS[0]?.prompt });
    expect(box().value).toBe("a thought I have not finished");
    cleanup();
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={emptyActions(start)} />);
    expect(box().value).toBe("a thought I have not finished");
  });
});
