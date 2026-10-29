/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import { Conversation, transcriptUrl } from "@/components/agents/Conversation";
import { offlineNote } from "@/components/agents/DirectComposer";
import { ANNOUNCE_AFTER_MS } from "@/components/live/Announcer";
import { HubStreamProvider } from "@/components/live/HubStream";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { QuestionView } from "@/questions/views";
import type { ConversationPage, TranscriptEntryView } from "@/transcripts/conversation";
import { duration } from "@/web/format";

const AGENT = "11111111-1111-1111-1111-111111111111";

function message(id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    tagged_agents: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "queued",
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
    occurred_at: "2026-09-29T09:01:00.000Z",
    ...overrides
  };
}

function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
  return { messages: [], entries: [], olderBefore: null, lastId: null, more: false, ...overrides };
}

const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

class FakeSource {
  static last: FakeSource | undefined;
  readyState = 1;
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  closed = false;
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

function answers(...responses: (Response | (() => Response))[]) {
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("no more answers");
    }
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function view(props: Partial<Parameters<typeof Conversation>[0]> = {}) {
  return (
    <Conversation
      agentId={AGENT}
      agentName="pcs"
      ownerName="Alice"
      viewerOid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
      status="idle"
      initial={page()}
      send={vi.fn()}
      answerQuestion={vi.fn()}
      {...props}
    />
  );
}

function live(props: Partial<Parameters<typeof Conversation>[0]> = {}) {
  vi.stubGlobal("EventSource", FakeSource);
  return render(<HubStreamProvider>{view(props)}</HubStreamProvider>);
}

async function submit(text: string): Promise<void> {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
  });
}

describe("offlineNote", () => {
  it("should say the message is queued and when it expires when the agent has a name", () => {
    expect(offlineNote("pcs")).toBe(
      `@pcs is offline; your message is queued and delivered when it reconnects. Queued messages expire after ${duration(EXPIRE_AFTER_SECONDS)} offline.`
    );
    expect(offlineNote("pcs")).toContain("24 hours");
  });

  it("should say this agent when the agent's name is not known", () => {
    expect(offlineNote(undefined)).toMatch(/^This agent is offline;/);
  });
});

describe("transcriptUrl", () => {
  it("should ask for the agent's entries around the cursor when given one", () => {
    expect(transcriptUrl(AGENT, { before: "41" })).toBe(`/api/ui/agents/${AGENT}/transcript?before=41`);
    expect(transcriptUrl(AGENT, { after: "7" })).toBe(`/api/ui/agents/${AGENT}/transcript?after=7`);
  });
});

describe("Conversation composer", () => {
  // An agent's page is its owner's, and an owner may always message their own session, so the composer is simply
  // there: there is no read-only rendering of this page left to test.
  it("should show the composer above the thread", () => {
    render(view({ initial: page({ messages: [message("1")] }) }));

    expect(screen.getByRole("form", { name: "Message this agent" })).toBeTruthy();
    expect(screen.getByText("message 1")).toBeTruthy();
  });

  it("should add the sent message to the conversation and clear the box when sending succeeds", async () => {
    const send = vi.fn(async () => ({ ok: true as const, message: message("9", { body: "hello agent" }) }));
    render(view({ send }));

    await submit("hello agent");

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "hello agent" });
    expect(screen.getByText("hello agent")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("should show the refusal when the server refuses the message", async () => {
    render(view({ send: vi.fn(async () => ({ ok: false as const, error: "no such agent" })) }));

    await submit("hi");

    expect(screen.getByRole("alert").textContent).toContain("no such agent");
  });

  it("should say the message could not be sent when the call itself fails", async () => {
    answers(new Response(null, { status: 200 }));
    render(
      view({
        send: vi.fn(async () => {
          throw new Error("offline");
        })
      })
    );

    await submit("hi");

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  });

  it("should offer to sign in again instead of a failure when the call fails because the session has ended", async () => {
    const fetch = answers(new Response(null, { status: 401 }));
    render(
      view({
        send: vi.fn(async () => {
          throw new Error("An unexpected response was received from the server.");
        })
      })
    );

    await submit("hi");

    expect(fetch).toHaveBeenCalledWith("/api/ui/session", expect.anything());
    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/auth/login?redirect=%2F");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not send when the message is only whitespace", async () => {
    const send = vi.fn();
    render(view({ send }));

    await submit("   ");

    expect(send).not.toHaveBeenCalled();
  });

  it("should describe the composer with the offline note when the agent is offline", () => {
    render(view({ status: "offline" }));

    const note = screen.getByText(/@pcs is offline/);
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBe(note.id);
  });

  it("should show no offline note when the agent is live", () => {
    render(view({ status: "busy" }));

    expect(screen.queryByText(/is offline/)).toBeNull();
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBeNull();
  });

  it("should show and hide the offline note as the agent's status changes on the stream", async () => {
    live({});

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: "someone-else", status: "offline" });
    });
    expect(screen.queryByText(/is offline/)).toBeNull();

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: AGENT, status: "offline" });
    });
    expect(screen.getByText(/@pcs is offline/)).toBeTruthy();

    await act(async () => {
      FakeSource.last?.emit("agent_status", { agent_id: AGENT, status: "idle" });
    });
    expect(screen.queryByText(/is offline/)).toBeNull();
  });
});

describe("Conversation direct messages", () => {
  it("should show each message's delivery state and nothing for a reply with no target when rendering the conversation", () => {
    render(
      view({
        initial: page({
          messages: [
            message("1", { delivery: "delivered" }),
            message("2", {
              target_agent_id: null,
              delivery: null,
              author: { type: "agent", agent_id: AGENT, agent_name: "pcs", owner_name: "Bob", owner_email: null }
            })
          ]
        })
      })
    );

    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText("replied")).toBeTruthy();
    expect(screen.getAllByText(/^(queued|delivered|expired)$/)).toHaveLength(1);
  });

  it("should link each message's id to its message page when rendering the conversation", () => {
    render(view({ initial: page({ messages: [message("41")] }) }));

    expect(screen.getByRole("link", { name: "#41" }).getAttribute("href")).toBe("/hub/m/41");
  });

  it("should say the conversation is empty when there is nothing in it", () => {
    render(view());

    expect(screen.getByText("Nothing in this agent's conversation yet.")).toBeTruthy();
  });

  it("should watch the agent and show a live message and its delivery when they arrive", async () => {
    live({ initial: page({ messages: [message("1")] }) });

    expect(FakeSource.last?.url).toBe(`/api/ui/stream?agent=${AGENT}`);
    await act(async () => {
      FakeSource.last?.emit("direct", { message: message("2", { body: "live one" }) });
    });
    expect(screen.getByText("live one")).toBeTruthy();
    expect(screen.getAllByText("queued")).toHaveLength(2);

    await act(async () => {
      FakeSource.last?.emit("delivery", { message_id: "1", state: "delivered" });
    });

    expect(screen.getAllByText("queued")).toHaveLength(1);
    expect(screen.getByText("delivered").closest("li")?.getAttribute("data-message-id")).toBe("1");
  });
});

describe("Conversation skills", () => {
  const SKILL = { name: "cft-explain", description: "Explain a CFT topic" };

  it("should re-read the page when the watched agent's skills change, and not for another agent's", async () => {
    live({});

    await act(async () => {
      FakeSource.last?.emit("agent_skills", { agent_id: "someone-else" });
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      FakeSource.last?.emit("agent_skills", { agent_id: AGENT });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("should offer the new skills in the composer when the re-read page hands down a changed list", () => {
    const { rerender } = render(view({}));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    expect(screen.queryByRole("listbox", { name: "Skills" })).toBeNull();

    rerender(view({ skills: [SKILL] }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "/c", selectionStart: 2, selectionEnd: 2 } });

    expect(screen.getByRole("listbox", { name: "Skills" }).textContent).toContain("cft-explain");
  });
});

describe("Conversation questions", () => {
  const ASKED: QuestionView = {
    id: "q-1",
    agentId: AGENT,
    askedAt: "2026-09-29T09:02:00.000Z",
    questions: [
      {
        question: "Do you prefer red or blue?",
        header: "Colour",
        options: [
          { label: "Red", description: "You prefer red." },
          { label: "Blue", description: "You prefer blue." }
        ],
        multiSelect: false
      }
    ],
    answer: null,
    offered: true
  };

  it("should show a question the agent's session asked, merged into the time line", () => {
    render(view({ initial: page({ entries: [entry("1")] }), questions: [ASKED] }));

    const items = screen.getByRole("list", { name: "Conversation" }).children;
    expect(screen.getByRole("region", { name: "A question for you" })).toBeTruthy();
    expect(items).toHaveLength(2);
  });

  it("should send the owner's choice through the action the page gave it", async () => {
    const answerQuestion = vi.fn(async () => ({ ok: true as const }));
    render(view({ questions: [ASKED], answerQuestion }));

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Red/ }));
    });

    expect(answerQuestion).toHaveBeenCalledWith({ questionId: "q-1", answers: { answers: [{ labels: ["Red"], text: null }] } });
  });

  // The reader of this page is the agent's owner, who may answer, so the controls are offered beside the card
  // rather than drawn and then refused.
  it("should offer the viewer the options, since they own the agent that asked", () => {
    render(view({ questions: [ASKED] }));

    expect(screen.getByText("Do you prefer red or blue?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Red/ })).toBeTruthy();
  });

  it("should re-read the page when the watched agent's questions change, and not for another agent's", async () => {
    live({ questions: [ASKED] });

    await act(async () => {
      FakeSource.last?.emit("agent_question", { agent_id: "someone-else" });
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      FakeSource.last?.emit("agent_question", { agent_id: AGENT });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Conversation transcript entries", () => {
  it("should show the person's and the agent's turns by who said them when rendering text entries", () => {
    render(
      view({
        initial: page({
          entries: [
            entry("1", { role: "user", content: { text: "please fix the build" } }),
            entry("2", { content: { text: "**done**" }, occurred_at: "2026-09-29T09:02:00.000Z" })
          ]
        })
      })
    );

    const [asked, answered] = screen.getAllByRole("listitem");
    expect(asked?.textContent).toContain("Alice");
    expect(asked?.textContent).toContain("please fix the build");
    expect(answered?.textContent).toContain("@pcs");
    expect(answered?.querySelector("strong")?.textContent).toBe("done");
  });

  it("should collapse a tool call to its name and a summary of its input when rendering it", () => {
    render(
      view({
        initial: page({ entries: [entry("1", { role: "tool_use", content: { id: "t1", name: "Bash", input: { command: "yarn test", timeout: 5 } } })] })
      })
    );

    const details = screen.getByText("Bash").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("yarn test");
    expect(details?.querySelector("pre")?.textContent).toBe(JSON.stringify({ command: "yarn test", timeout: 5 }, null, 2));
  });

  it("should mark a failed tool result as an error and show its output when rendering it", () => {
    render(
      view({
        initial: page({
          entries: [
            entry("1", { role: "tool_result", content: { tool_use_id: "t1", output: "exit 1\nstack", is_error: true } }),
            entry("2", { role: "tool_result", content: { tool_use_id: "t2", output: "ok", is_error: false }, occurred_at: "2026-09-29T09:02:00.000Z" })
          ]
        })
      })
    );

    const failed = screen.getByText("Error").closest("details");
    expect(failed?.className).toContain("border-red-800");
    expect(failed?.querySelector("pre")?.textContent).toBe("exit 1\nstack");
    expect(screen.getByText("Result").closest("details")?.className).not.toContain("border-red-800");
  });

  it("should show the pattern that hid an entry as text, and which tool ran, when entries are redacted", () => {
    const aws = "AKIA[0-9A-Z]{16}";
    const markup = "<b>(?:ghp|gho)_[A-Za-z0-9]{36}</b>";
    render(
      view({
        initial: page({
          entries: [
            entry("1", { redacted: true, content: { redacted: aws } }),
            entry("2", { role: "tool_use", redacted: true, content: { id: "t1", name: "Read", redacted: markup } }),
            entry("3", { role: "tool_result", redacted: true, content: { redacted: "-----BEGIN [A-Z ]*PRIVATE KEY-----" } }),
            entry("4", { role: "system", redacted: true, content: { redacted: "password=\\S+" } })
          ]
        })
      })
    );

    const patterns = [...document.querySelectorAll("li code")];
    expect(patterns.map((code) => code.textContent)).toEqual([aws, markup, "-----BEGIN [A-Z ]*PRIVATE KEY-----", "password=\\S+"]);
    expect(patterns.map((code) => code.getAttribute("title"))).toEqual(patterns.map((code) => code.textContent));
    expect(screen.getAllByText("hidden: matched secret pattern")).toHaveLength(4);
    expect(patterns[1]?.closest("li")?.textContent).toContain("Read");
    expect(document.querySelector("li b")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
  });

  it("should mark a truncated entry and show a system note when rendering them", () => {
    render(view({ initial: page({ entries: [entry("1", { truncated: true }), entry("2", { role: "system", content: { text: "compacted" } })] }) }));

    expect(screen.getByText("truncated").closest("li")?.getAttribute("data-entry-id")).toBe("1");
    expect(screen.getByText("compacted").closest("li")?.textContent).toContain("System");
  });

  it("should show a background task's status and summary, and not its ids or output file, when a turn reports one", () => {
    const text = [
      "<task-notification>",
      "<task-id>bohu4iyck</task-id>",
      "<tool-use-id>toolu_bdrk_01MiSSuFVL3TcKiNnDeNbvc7</tool-use-id>",
      "<output-file>/tmp/claude-1000/-home-linus/d8f088b7/tasks/bohu4iyck.output</output-file>",
      "<status>completed</status>",
      '<summary>Background command "Run the unit suite" completed (exit code 0)</summary>',
      "</task-notification>"
    ].join("\n");
    render(view({ initial: page({ entries: [entry("1", { role: "user", content: { text } })] }) }));

    const item = screen.getByText("Task").closest("li");
    expect(item?.textContent).toContain("completed");
    expect(item?.textContent).toContain('Background command "Run the unit suite" completed');
    expect(item?.textContent).not.toContain("bohu4iyck");
    expect(item?.textContent).not.toContain("/tmp/claude-1000");
    expect(item?.textContent).not.toContain("Alice");
    expect(item?.querySelector("details")).toBeNull();
  });

  it("should mark a failed task and offer a subagent's report when a turn reports one", () => {
    const text =
      '<task-notification>\n<status>failed</status>\n<summary>Agent "Fix the build" finished</summary>\n<result>**step one**\nexit 1</result>\n</task-notification>';
    render(view({ initial: page({ entries: [entry("1", { role: "user", content: { text } })] }) }));

    const details = screen.getByText("failed").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.className).toContain("border-red-800");
    expect(details?.querySelector("pre")?.textContent).toBe("**step one**\nexit 1");
    expect(details?.querySelector("strong")).toBeNull();
  });

  it("should show what a monitor saw, and not call it finished, when a turn reports an event", () => {
    const text = [
      "<task-notification>",
      "<task-id>b1ako8104</task-id>",
      '<summary>Monitor event: "hmcts-claude-provider apply completion"</summary>',
      "<event>RUN COMPLETED: failure\napply job: failure</event>",
      "</task-notification>"
    ].join("\n");
    render(view({ initial: page({ entries: [entry("1", { role: "user", content: { text } })] }) }));

    const details = screen.getByText("Task").closest("details");
    expect(details?.textContent).not.toContain("finished");
    expect(details?.textContent).toContain("update");
    expect(details?.querySelector("pre")?.textContent).toBe("RUN COMPLETED: failure\napply job: failure");
  });

  it("should read a truncated task notification's fields, and not its cut off report, when the upload limit cut the turn", () => {
    const text = [
      "<task-notification>",
      "<status>completed</status>",
      '<summary>Agent "Design decay detection" finished</summary>',
      "<result>## Layer 1 — the first thing it found"
    ].join("\n");
    render(view({ initial: page({ entries: [entry("1", { role: "user", truncated: true, content: { text } })] }) }));

    const item = screen.getByText("Task").closest("li");
    expect(item?.textContent).toContain("completed");
    expect(item?.textContent).toContain('Agent "Design decay detection" finished');
    expect(item?.textContent).toContain("truncated");
    expect(item?.textContent).not.toContain("<task-notification>");
    expect(item?.textContent).not.toContain("Layer 1");
    expect(item?.querySelector("details")).toBeNull();
  });

  it("should offer the whole summary when one line of it does not fit", () => {
    const summary = `Agent "Port the metrics dashboard" finished: ${"it rewrote the loader and ".repeat(12)}and stopped there`;
    const text = `<task-notification>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
    render(view({ initial: page({ entries: [entry("1", { role: "user", content: { text } })] }) }));

    const details = screen.getByText("Task").closest("details");
    expect(details?.querySelector("summary")?.textContent).toContain("…");
    expect(details?.querySelector("p")?.textContent).toBe(summary);
  });

  it("should not offer the summary again when one line of it only collapsed its whitespace", () => {
    const summary = 'Agent "Fix the gate" finished:  it  reran the suite';
    const text = `<task-notification>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
    render(view({ initial: page({ entries: [entry("1", { role: "user", content: { text } })] }) }));

    const item = screen.getByText("Task").closest("li");
    expect(item?.textContent).toContain('Agent "Fix the gate" finished: it reran the suite');
    expect(item?.querySelector("details")).toBeNull();
  });

  it("should mark the task the turn was cut inside when a truncated entry reports more than one", () => {
    const text = [
      "<task-notification>",
      "<status>completed</status>",
      "<summary>Background command finished first</summary>",
      "</task-notification>",
      "<task-notification>",
      "<status>completed</status>",
      "<summary>Agent cut part way through its report</summary>",
      "<result>## Layer 1 — the first thing it found"
    ].join("\n");
    render(view({ initial: page({ entries: [entry("1", { role: "user", truncated: true, content: { text } })] }) }));

    const marked = screen.getByText("truncated").closest("p, summary");
    expect(marked?.textContent).toContain("Agent cut part way through its report");
    expect(marked?.textContent).not.toContain("Background command finished first");
  });

  it("should keep the owner's turn when the text only looks like a task notification", () => {
    const quoted = "Summarise this:\n\n<task-notification>\n<status>completed</status>\n<summary>something</summary>\n</task-notification>";
    render(
      view({
        initial: page({
          entries: [
            entry("1", { role: "user", content: { text: quoted } }),
            entry("2", { role: "user", truncated: true, content: { text: "<task-notification>\n<status>comple" }, occurred_at: "2026-09-29T09:02:00.000Z" })
          ]
        })
      })
    );

    expect(screen.queryByText("Task")).toBeNull();
    expect(screen.getAllByText("Alice")).toHaveLength(2);
    expect(screen.getByText("truncated").closest("li")?.textContent).toContain("<task-notification>");
  });

  it("should show a received message once when the transcript also records it", () => {
    render(
      view({
        initial: page({
          messages: [message("5", { body: "from the hub" })],
          entries: [entry("1", { role: "user", content: { text: "from the hub" }, message_id: "5" })]
        })
      })
    );

    expect(screen.getAllByText("from the hub")).toHaveLength(1);
    expect(screen.getByText("from the hub").closest("li")?.getAttribute("data-message-id")).toBe("5");
  });
});

describe("Conversation live transcript", () => {
  it("should read the entries after the newest shown when the stream announces newer ones", async () => {
    const fetch = answers(Response.json(page({ entries: [entry("8", { content: { text: "live entry" } })], lastId: "8" })));
    live({ initial: page({ entries: [entry("7")], lastId: "7" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "8" });
    });

    expect(fetch).toHaveBeenCalledWith(`/api/ui/agents/${AGENT}/transcript?after=7`, expect.anything());
    expect(screen.getByText("live entry")).toBeTruthy();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "8" });
      FakeSource.last?.emit("transcript", { agent_id: "another-agent", last_id: "99" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should keep reading until it reaches the announced entry when one read is not enough", async () => {
    const fetch = answers(
      Response.json(page({ entries: [entry("1")], lastId: "1", more: true })),
      Response.json(page({ entries: [entry("2", { content: { text: "second" } })], lastId: "2" }))
    );
    live();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "2" });
    });

    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `/api/ui/agents/${AGENT}/transcript?after=0`,
      `/api/ui/agents/${AGENT}/transcript?after=1`
    ]);
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("should read once at a time and carry on to a newer entry announced during a read", async () => {
    let answer: (response: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(Response.json(page({ entries: [entry("6", { content: { text: "newest" } })], lastId: "6" })));
    vi.stubGlobal("fetch", fetch);
    live({ initial: page({ lastId: "4" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "5" });
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "6" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(Response.json(page({ entries: [entry("5")], lastId: "5" })));
    });

    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `/api/ui/agents/${AGENT}/transcript?after=4`,
      `/api/ui/agents/${AGENT}/transcript?after=5`
    ]);
    expect(screen.getByText("newest")).toBeTruthy();
  });

  it("should stop reading when the announced entry has gone before it is read", async () => {
    const fetch = answers(Response.json(page({ lastId: "3" })));
    live({ initial: page({ lastId: "3" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "9" });
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should leave the entries for the next event to read when a read fails", async () => {
    const fetch = answers(new Response(null, { status: 500 }), Response.json(page({ entries: [entry("4", { content: { text: "later" } })], lastId: "4" })));
    live({ initial: page({ lastId: "3" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });
    expect(screen.queryByText("later")).toBeNull();

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText("later")).toBeTruthy();
  });

  it("should end the session when a live read is answered 401", async () => {
    answers(new Response(null, { status: 401 }));
    live({ initial: page({ lastId: "3" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "4" });
    });

    expect(FakeSource.last?.closed).toBe(true);
  });
});

describe("Conversation earlier pages", () => {
  it("should load earlier entries and messages above, and stop offering more, when the start is reached", async () => {
    const fetch = answers(
      Response.json(
        page({
          messages: [message("1", { body: "older message", created_at: "2026-09-28T09:00:00.000Z" })],
          entries: [entry("2", { content: { text: "older entry" }, occurred_at: "2026-09-28T10:00:00.000Z" })]
        })
      )
    );
    render(view({ initial: page({ entries: [entry("3")], olderBefore: "3" }) }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(fetch).toHaveBeenCalledWith(`/api/ui/agents/${AGENT}/transcript?before=3`, expect.anything());
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByRole("listitem")[0]?.textContent).toContain("older message");
    expect(screen.getAllByRole("listitem")[1]?.textContent).toContain("older entry");
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });

  it("should say earlier activity could not be loaded when the read fails", async () => {
    answers(new Response(null, { status: 500 }));
    render(view({ initial: page({ entries: [entry("3")], olderBefore: "3" }) }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeTruthy();
  });

  it("should offer to sign in again when the read is answered 401", async () => {
    answers(new Response(null, { status: 401 }));
    render(view({ initial: page({ entries: [entry("3")], olderBefore: "3" }) }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });

    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Conversation announcements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should announce a new message by its sender, and nothing for one already shown, when messages arrive live", async () => {
    vi.useFakeTimers();
    live({ initial: page({ messages: [message("1")] }) });

    expect(screen.getByRole("list", { name: "Conversation" }).getAttribute("aria-live")).toBeNull();
    await act(async () => {
      FakeSource.last?.emit("direct", { message: message("1") });
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });
    expect(screen.getByTestId("arrivals").textContent).toBe("");

    await act(async () => {
      FakeSource.last?.emit("direct", {
        message: message("2", { author: { type: "agent", agent_id: AGENT, agent_name: "pcs", owner_name: "Bob", owner_email: null } })
      });
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(screen.getByTestId("arrivals").textContent).toBe("New message from @pcs");
  });

  it("should announce the agent's reply when one arrives in the transcript", async () => {
    vi.useFakeTimers();
    answers(Response.json(page({ entries: [entry("8"), entry("9", { role: "tool_use", content: { id: "t", name: "Bash", input: {} } })], lastId: "9" })));
    live({ initial: page({ lastId: "7" }) });

    await act(async () => {
      FakeSource.last?.emit("transcript", { agent_id: AGENT, last_id: "9" });
    });
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_AFTER_MS);
    });

    expect(screen.getByTestId("arrivals").textContent).toBe("New reply from @pcs");
  });
});
