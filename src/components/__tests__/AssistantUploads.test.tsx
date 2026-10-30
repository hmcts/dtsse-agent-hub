/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import type { ConversationView, UnsentChat } from "@/assistant/views";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { Composer } from "@/components/assistant/Composer";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { NO_LONGER_HELD, STILL_HELD } from "@/components/assistant/MessageAttachments";
import type { UploadRequest } from "@/components/assistant/uploadClient";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { ConversationPage } from "@/transcripts/conversation";

/**
 * The network is stubbed at the `uploadClient` seam: what a part is and how it is carried is covered in
 * `uploadClient.test.ts`, and these tests are about what the person sees while it happens.
 */
const uploads = vi.hoisted(() => ({
  pending: [] as { request: any; resolve: (uploadId: string) => void; reject: (failure: unknown) => void }[],
  discarded: [] as string[]
}));

vi.mock("@/components/assistant/uploadClient", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/assistant/uploadClient")>();
  return {
    ...real,
    uploadFile: (request: UploadRequest) =>
      new Promise<string>((resolve, reject) => {
        uploads.pending.push({ request, resolve, reject });
      }),
    discardUpload: async (uploadId: string) => {
      uploads.discarded.push(uploadId);
    }
  };
});

/** Who is reading, which the composer keys its draft on. */
const VIEWER = "dev-alice";

const AGENT = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined,
  useWatch: () => undefined
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  // The message box watches its own width, which jsdom has neither an observer nor a layout for.
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});

afterEach(() => {
  cleanup();
  uploads.pending.length = 0;
  uploads.discarded.length = 0;
  refresh.mockReset();
  push.mockReset();
  // The draft text and the remembered product both live here, and both outlive a `cleanup()` by design.
  sessionStorage.clear();
});

function file(name: string, size: number, type = "application/pdf"): File {
  const made = new File([new Uint8Array(1)], name, { type });
  // Defined rather than allocated, so a 26 MB file costs a byte.
  Object.defineProperty(made, "size", { value: size });
  return made;
}

function request(index = 0): UploadRequest {
  return uploads.pending[index]?.request as UploadRequest;
}

async function claimed(index = 0, uploadId = "u1"): Promise<void> {
  await act(async () => {
    request(index).onCreated?.(uploadId);
  });
}

async function finished(index = 0, uploadId = "u1"): Promise<void> {
  await claimed(index, uploadId);
  await act(async () => {
    uploads.pending[index]?.resolve(uploadId);
  });
}

function composer(onSend: (text: string, uploadIds: string[]) => Promise<string | null> = vi.fn(async () => null), props: object = {}) {
  render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={onSend} conversationId="c1" {...props} />);
  return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
}

function picker(): HTMLInputElement {
  return screen.getByLabelText("Files to attach") as HTMLInputElement;
}

function chips(): HTMLElement[] {
  const list = screen.queryByRole("list", { name: "Attached files" });
  return list === null ? [] : within(list).getAllByRole("listitem");
}

async function choose(...chosen: File[]): Promise<void> {
  await act(async () => {
    fireEvent.change(picker(), { target: { files: chosen } });
  });
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
}

describe("Composer attaching", () => {
  it("should open the file picker when the person chooses Attach files from the add menu", () => {
    composer();
    const click = vi.spyOn(picker(), "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Attach a file or add a template" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Attach files" }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should show a chip with the file's name and size when the person picks a file", async () => {
    composer();

    await choose(file("letter.pdf", 2048));

    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("letter.pdf");
    expect(chips()[0]?.textContent).toContain("2 KB");
    expect(request().conversationId).toBe("c1");
    expect(request().name).toBe("letter.pdf");
  });

  it("should attach the clipboard's file and leave the typed message alone when the person pastes one", async () => {
    const box = composer();
    fireEvent.change(box, { target: { value: "have a look at this" } });

    const delivered = fireEvent.paste(box, { clipboardData: { files: [file("", 512, "image/png")] } });

    expect(delivered).toBe(false);
    expect(box.value).toBe("have a look at this");
    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toMatch(/screenshot-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png/);
  });

  it("should do nothing to the paste when the clipboard carries no file", () => {
    const box = composer();

    const delivered = fireEvent.paste(box, { clipboardData: { files: [] } });

    expect(delivered).toBe(true);
    expect(chips()).toHaveLength(0);
  });

  it("should attach a file dropped on the message pane when the pane is the drop zone", async () => {
    render(<ChatView jira={NO_JIRA} view={conversation()} templates={TEMPLATES} viewerOid={VIEWER} actions={actions()} />);

    await act(async () => {
      fireEvent.drop(screen.getByRole("list", { name: "Conversation" }), { dataTransfer: { files: [file("notes.pdf", 100)], types: ["Files"] } });
    });

    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("notes.pdf");
  });

  it("should attach a file dropped on the composer itself when the composer is the target", async () => {
    const box = composer();

    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [file("notes.pdf", 100)], types: ["Files"] } });
    });

    expect(chips()).toHaveLength(1);
  });

  it("should keep a file dropped away from either target from navigating the browser away", async () => {
    composer();

    const delivered = fireEvent.drop(document.body, { dataTransfer: { files: [file("notes.pdf", 100)], types: ["Files"] } });

    expect(delivered).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it("should say files can be dropped while one is dragged over the composer, and stop saying so once it leaves", () => {
    const box = composer();

    act(() => {
      fireEvent.dragOver(box, { dataTransfer: { files: [], types: ["Files"] } });
    });
    expect(screen.getByText("Drop your files here to attach them")).toBeTruthy();

    act(() => {
      fireEvent.dragLeave(window);
    });
    expect(screen.queryByText("Drop your files here to attach them")).toBeNull();
  });

  it("should not say files can be dropped when what is dragged over is not a file", () => {
    const box = composer();

    act(() => {
      fireEvent.dragOver(box, { dataTransfer: { files: [], types: ["text/plain"] } });
    });

    expect(screen.queryByText("Drop your files here to attach them")).toBeNull();
  });

  it("should leave a pasted file alone when there is no conversation to attach it to", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    const delivered = fireEvent.paste(box, { clipboardData: { files: [file("letter.pdf", 10)] } });

    expect(delivered).toBe(true);
    expect(uploads.pending).toHaveLength(0);
  });

  it("should refuse a file over the limit, name the limit and upload nothing when it is too big", async () => {
    composer();

    await choose(file("huge.zip", 26 * 1024 * 1024));

    expect(screen.getByRole("alert").textContent).toBe("huge.zip is too big. Each file must be 25 MB or less.");
    expect(chips()).toHaveLength(0);
    expect(uploads.pending).toHaveLength(0);
  });

  it("should refuse the batch and name the limit when it would be more than four files", async () => {
    composer();

    await choose(file("a.pdf", 10), file("b.pdf", 10), file("c.pdf", 10), file("d.pdf", 10));
    await choose(file("e.pdf", 10));

    expect(screen.getByRole("alert").textContent).toBe("You can attach up to 4 files to a message.");
    expect(chips()).toHaveLength(4);
    expect(uploads.pending).toHaveLength(4);
  });

  it("should offer no file controls when there is no conversation to attach to and none can be opened", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);

    expect(screen.getByRole("button", { name: "Add a template" })).toBeTruthy();
    expect(screen.queryByLabelText("Files to attach")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    expect(screen.queryByRole("menuitem", { name: "Attach files" })).toBeNull();
  });
});

/**
 * A box with nowhere to put a file offers nothing to put one in: no `conversationId` and no `openConversation`, so
 * nothing can be attached and every control that would suggest otherwise stays away.
 */
describe("Composer with nowhere to attach to", () => {
  it("should offer no Attach item in the add menu", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);

    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));

    expect(screen.queryByRole("menuitem", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Templates/ })).toBeTruthy();
  });

  it("should offer no file picker at all", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);

    expect(screen.queryByLabelText("Files to attach")).toBeNull();
  });

  it("should leave a pasted screenshot to the box rather than attaching it", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    const delivered = fireEvent.paste(box, { clipboardData: { files: [file("", 512, "image/png")] } });

    expect(delivered).toBe(true);
    expect(uploads.pending).toHaveLength(0);
  });

  it("should upload nothing when a file is dropped on it", async () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { files: [file("notes.pdf", 100)], types: ["Files"] } });
    });

    expect(uploads.pending).toHaveLength(0);
    expect(chips()).toHaveLength(0);
  });

  it("should not say files can be dropped while one is dragged over it", () => {
    render(<Composer templates={TEMPLATES} viewerOid={VIEWER} draftId="c1" onSend={vi.fn(async () => null)} />);

    act(() => {
      fireEvent.dragOver(screen.getByRole("textbox", { name: "Message" }), { dataTransfer: { files: [], types: ["Files"] } });
    });

    expect(screen.queryByText("Drop your files here to attach them")).toBeNull();
  });

  it("should still show the chips of a message that was sent while it was on, since the file did reach the assistant", () => {
    render(
      <ChatView
        jira={NO_JIRA}
        viewerOid={VIEWER}
        view={conversation({ page: page({ messages: [withAttachments([{ name: "letter.pdf", bytes: 2048 }])] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    expect(screen.getByRole("list", { name: "Files sent with this message" })).toBeTruthy();
  });
});

describe("Composer upload progress", () => {
  it("should show how much of the file has gone when bytes are reported as sent", async () => {
    composer();
    await choose(file("big.pdf", 4000));

    const bar = screen.getByRole("progressbar", { name: "Uploading big.pdf" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");

    await act(async () => {
      request().onProgress?.(1000);
    });
    expect(screen.getByRole("progressbar", { name: "Uploading big.pdf" }).getAttribute("aria-valuenow")).toBe("25");

    await act(async () => {
      request().onProgress?.(4000);
    });
    expect(screen.getByRole("progressbar", { name: "Uploading big.pdf" }).getAttribute("aria-valuenow")).toBe("100");
  });

  it("should stop showing progress once the file is attached", async () => {
    composer();
    await choose(file("big.pdf", 4000));

    await finished();

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(chips()).toHaveLength(1);
  });

  it("should abort the part in flight and discard the upload when the person removes an attachment", async () => {
    composer();
    await choose(file("letter.pdf", 2048));
    await claimed();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove letter.pdf" }));
    });

    expect(request().signal?.aborted).toBe(true);
    expect(uploads.discarded).toEqual(["u1"]);
    expect(chips()).toHaveLength(0);
  });

  it("should discard nothing when the person removes an attachment the hub never claimed", async () => {
    composer();
    await choose(file("letter.pdf", 2048));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove letter.pdf" }));
    });

    expect(uploads.discarded).toEqual([]);
    expect(chips()).toHaveLength(0);
  });

  it("should say what went wrong and offer Try again when a part fails", async () => {
    composer();
    await choose(file("letter.pdf", 2048));
    await claimed();

    await act(async () => {
      uploads.pending[0]?.reject(new Error("the connection was lost while the file was uploading"));
    });

    expect(chips()[0]?.textContent).toContain("the connection was lost while the file was uploading");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should start a fresh upload and throw the half-sent one away when the person tries again", async () => {
    composer();
    await choose(file("letter.pdf", 2048));
    await claimed();
    await act(async () => {
      uploads.pending[0]?.reject(new Error("the connection was lost while the file was uploading"));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(uploads.pending).toHaveLength(2);
    expect(uploads.discarded).toEqual(["u1"]);
    expect(screen.getByRole("progressbar", { name: "Uploading letter.pdf" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("should say the file could not be attached when the failure carries no sentence", async () => {
    composer();
    await choose(file("letter.pdf", 2048));

    await act(async () => {
      uploads.pending[0]?.reject("something odd");
    });

    expect(chips()[0]?.textContent).toContain("the file could not be attached");
  });
});

describe("Composer sending with attachments", () => {
  it("should disable Send and say why while a file is still uploading", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);
    fireEvent.change(box, { target: { value: "here you go" } });

    await choose(file("letter.pdf", 2048));

    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Wait for your files to finish uploading, then send.");
    expect(box.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("should disable Send and say why when a file could not be attached", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);
    fireEvent.change(box, { target: { value: "here you go" } });
    await choose(file("letter.pdf", 2048));

    await act(async () => {
      uploads.pending[0]?.reject(new Error("the upload timed out; try again"));
    });

    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("One of your files could not be attached. Try again, or remove it.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("should send the attachments' upload ids and clear them when the message goes", async () => {
    const onSend = vi.fn(async () => null);
    const box = composer(onSend);
    fireEvent.change(box, { target: { value: "here you go" } });
    await choose(file("letter.pdf", 2048));
    await finished();

    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(onSend).toHaveBeenCalledWith("here you go", ["u1"]);
    expect(chips()).toHaveLength(0);
    expect(box.value).toBe("");
  });

  it("should allow a message that is only an attachment when there is no text", async () => {
    const onSend = vi.fn(async () => null);
    composer(onSend);
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(onSend).toHaveBeenCalledWith("", ["u1"]);
  });

  it("should keep the attachments when the message is refused", async () => {
    const box = composer(vi.fn(async () => "that conversation no longer exists"));
    fireEvent.change(box, { target: { value: "here you go" } });
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe("that conversation no longer exists");
    expect(chips()).toHaveLength(1);
  });
});

function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
  return { messages: [], entries: [], olderBefore: null, lastId: null, more: false, ...overrides };
}

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "1",
    kind: "direct",
    title: null,
    body: "have a look at this",
    topics: [],
    tagged_agents: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-10-21T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "delivered",
    ...overrides
  };
}

/** Far enough ahead that the chips are inside the hub's retention window for as long as any test runs. */
const HELD_UNTIL = "2099-01-01T00:00:00.000Z";

/**
 * A message carrying files, as the thread loads them: the person's own name, the size, and when the hub stops holding
 * the bytes. Held by default, since that is a message just sent; `available_until: null` is a file the sweep has taken.
 */
function withAttachments(
  attachments: { name: string; bytes: number; available_until?: string | null }[],
  overrides: Partial<ThreadMessage> = {}
): ThreadMessage {
  return {
    ...message(overrides),
    attachments: attachments.map((file, index) => ({ id: `u${index + 1}`, media_type: "application/pdf", available_until: HELD_UNTIL, ...file }))
  };
}

const NO_JIRA = { connected: false, login: null };

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: CONVERSATION,
    title: "Writing a story",
    product: "ccd",
    productLabel: "CCD",
    productHistory: [],
    stopHistory: [],
    local: false,
    agentId: AGENT,
    agentStatus: "idle",
    skills: [],
    clientFeatures: null,
    sessionState: null,
    sessionDetail: null,
    artefact: { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null },
    jira: { status: "none" },
    confluence: { status: "none" },
    page: page(),
    forked: null,
    questions: [],
    ...overrides
  };
}

function actions(): ChatActions {
  return {
    send: vi.fn(async () => ({ ok: true as const, message: message({ id: "99" }) })),
    warm: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const, stopped: true })),
    setProduct: vi.fn(async () => ({ ok: true as const })),
    rename: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    answerQuestion: vi.fn(async () => ({ ok: true as const })),
    saveArtefact: vi.fn(async () => ({ ok: true as const, saved: true as const, version: 1 })),
    exportToJira: vi.fn(async () => ({ ok: true as const }))
  };
}

describe("ChatView attachments in the thread", () => {
  it("should show one chip per attachment under the person's message when the message carried files", () => {
    const view = conversation({
      page: page({
        messages: [
          withAttachments([
            { name: "letter.pdf", bytes: 2048 },
            { name: "spreadsheet.xlsx", bytes: 3 * 1024 * 1024 }
          ])
        ]
      })
    });
    render(<ChatView jira={NO_JIRA} view={view} templates={TEMPLATES} viewerOid={VIEWER} actions={actions()} />);

    const sent = screen.getByRole("list", { name: "Files sent with this message" });
    const shown = within(sent).getAllByRole("listitem");
    expect(shown).toHaveLength(2);
    expect(shown[0]?.textContent).toBe("📎letter.pdf2 KB");
    expect(shown[1]?.textContent).toBe("📎spreadsheet.xlsx3.0 MB");
    expect(within(screen.getByRole("list", { name: "Conversation" })).getByText("have a look at this")).toBeTruthy();
  });

  /** The one chip of a thread whose message carried `files`. */
  function chipFor(files: { name: string; bytes: number; available_until?: string | null }[]): HTMLElement {
    render(
      <ChatView
        jira={NO_JIRA}
        viewerOid={VIEWER}
        view={conversation({ page: page({ messages: [withAttachments(files)] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );
    return within(screen.getByRole("list", { name: "Files sent with this message" })).getAllByRole("listitem")[0]!;
  }

  it("should offer the file back as a download when the hub is still holding its bytes", () => {
    const chip = chipFor([{ name: "letter.pdf", bytes: 10 }]);

    const link = within(chip).getByRole("link");
    expect(link.getAttribute("href")).toBe("/api/ui/uploads/u1/content");
    // The person's own name on the saved copy, accents, spaces and all.
    expect(link.getAttribute("download")).toBe("letter.pdf");
    expect(chip.getAttribute("title")).toBe(STILL_HELD);
  });

  it("should offer no download at all, and say the file has gone, when the hub no longer holds it", () => {
    const chip = chipFor([{ name: "letter.pdf", bytes: 10, available_until: null }]);

    expect(within(chip).queryByRole("link")).toBeNull();
    expect(chip.getAttribute("title")).toBe(NO_LONGER_HELD);
    // Still a chip, and still named: the file was attached, whatever became of the bytes.
    expect(chip.textContent).toBe("📎letter.pdf10 bytes");
  });

  it("should offer no download once the window has already closed, whatever state the sweep left the row in", () => {
    const chip = chipFor([{ name: "letter.pdf", bytes: 10, available_until: "2020-01-01T00:00:00.000Z" }]);

    expect(within(chip).queryByRole("link")).toBeNull();
    expect(chip.getAttribute("title")).toBe(NO_LONGER_HELD);
  });

  it("should take the download away while the thread is open, when the window closes under it", () => {
    vi.useFakeTimers();
    try {
      const chip = chipFor([{ name: "letter.pdf", bytes: 10, available_until: new Date(Date.now() + 60_000).toISOString() }]);
      expect(within(chip).queryByRole("link")).not.toBeNull();

      // Act: the window closes with nothing else on the screen changing, which is a thread left open for hours.
      act(() => {
        vi.advanceTimersByTime(61_001);
      });

      const after = within(screen.getByRole("list", { name: "Files sent with this message" })).getAllByRole("listitem")[0]!;
      expect(within(after).queryByRole("link")).toBeNull();
      expect(after.getAttribute("title")).toBe(NO_LONGER_HELD);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should show the chips without an empty bubble when the message was only files", () => {
    render(
      <ChatView
        jira={NO_JIRA}
        viewerOid={VIEWER}
        view={conversation({ page: page({ messages: [withAttachments([{ name: "letter.pdf", bytes: 10 }], { body: "" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    const item = within(screen.getByRole("list", { name: "Conversation" })).getAllByRole("listitem")[0];
    expect(item?.textContent).toBe("You said:📎letter.pdf10 bytes");
  });

  it("should show no attachment list when the message carried no files", () => {
    render(
      <ChatView jira={NO_JIRA} view={conversation({ page: page({ messages: [message()] }) })} templates={TEMPLATES} viewerOid={VIEWER} actions={actions()} />
    );

    expect(screen.queryByRole("list", { name: "Files sent with this message" })).toBeNull();
  });
});

/**
 * Attaching on the new-chat screen, where there is no conversation yet. A file has to belong to one before any of its
 * bytes can be sent, so the first attachment opens one and the first message then goes into it.
 */
describe("EmptyChat attaching before the chat exists", () => {
  function emptyActions(overrides: Partial<EmptyChatActions> = {}): EmptyChatActions {
    return {
      start: vi.fn(async () => ({ ok: true as const, id: "started" })),
      open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
      send: vi.fn(async () => ({ ok: true as const })),
      setProduct: vi.fn(async () => ({ ok: true as const })),
      ...overrides
    };
  }

  function newChat(acts: EmptyChatActions, unsent?: UnsentChat) {
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={acts} unsent={unsent} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  it("should offer Attach files here too, since handing the assistant a document is a way to open a chat", () => {
    newChat(emptyActions());

    fireEvent.click(screen.getByRole("button", { name: "Attach a file or add a template" }));

    expect(screen.getByRole("menuitem", { name: "Attach files" })).toBeTruthy();
  });

  it("should open a conversation with the chosen product and upload into it when the first file is attached", async () => {
    const acts = emptyActions();
    newChat(acts);
    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "pcs" } });

    await choose(file("letter.pdf", 2048));

    expect(acts.open).toHaveBeenCalledWith({ product: "pcs" });
    expect(request().conversationId).toBe(CONVERSATION);
    expect(chips()[0]?.textContent).toContain("letter.pdf");
  });

  it("should stay on the new-chat screen while the file uploads, so nothing typed or in flight is lost", async () => {
    const box = newChat(emptyActions());
    fireEvent.change(box, { target: { value: "what does this say?" } });

    await choose(file("letter.pdf", 2048));
    await finished();

    expect(push).not.toHaveBeenCalled();
    expect(box.value).toBe("what does this say?");
  });

  it("should open one conversation for a batch of files rather than one each", async () => {
    const acts = emptyActions();
    newChat(acts);

    await choose(file("a.pdf", 10), file("b.pdf", 10), file("c.pdf", 10));

    expect(acts.open).toHaveBeenCalledTimes(1);
    expect(uploads.pending.map((upload) => upload.request.conversationId)).toEqual([CONVERSATION, CONVERSATION, CONVERSATION]);
  });

  it("should send the first message into the conversation attaching opened, rather than starting another", async () => {
    const acts = emptyActions();
    const box = newChat(acts);
    fireEvent.change(box, { target: { value: "what does this say?" } });
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(acts.start).not.toHaveBeenCalled();
    expect(acts.send).toHaveBeenCalledWith({ conversationId: CONVERSATION, body: "what does this say?", uploadIds: ["u1"] });
    expect(push).toHaveBeenCalledWith(`/assistant/${CONVERSATION}`);
  });

  it("should send a message of files and no words, since that is the whole ask", async () => {
    const acts = emptyActions();
    newChat(acts);
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(acts.send).toHaveBeenCalledWith({ conversationId: CONVERSATION, body: "", uploadIds: ["u1"] });
  });

  it("should start a conversation the ordinary way when nothing was attached", async () => {
    const acts = emptyActions();
    const box = newChat(acts);
    fireEvent.change(box, { target: { value: "just words" } });

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(acts.open).not.toHaveBeenCalled();
    expect(acts.start).toHaveBeenCalledWith({ product: "general", body: "just words" });
    expect(push).toHaveBeenCalledWith("/assistant/started");
  });

  it("should carry a later change of product through to the conversation attaching already opened", async () => {
    const acts = emptyActions();
    newChat(acts);
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "ccd" } });
    });

    expect(acts.setProduct).toHaveBeenCalledWith({ conversationId: CONVERSATION, product: "ccd" });
  });

  it("should change the product without a call when nothing has been attached, since there is no conversation yet", async () => {
    const acts = emptyActions();
    newChat(acts);

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "ccd" } });
    });

    expect(acts.setProduct).not.toHaveBeenCalled();
  });

  it("should show the refusal on the chip and offer Try again when the conversation cannot be opened", async () => {
    const acts = emptyActions({ open: vi.fn(async () => ({ ok: false as const, error: "the CFT Workspace is not available on this deployment" })) });
    newChat(acts);

    await choose(file("letter.pdf", 2048));

    expect(chips()[0]?.textContent).toContain("the CFT Workspace is not available on this deployment");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should try to open the conversation again rather than replay the failure when the person tries again", async () => {
    const open = vi
      .fn<EmptyChatActions["open"]>()
      .mockResolvedValueOnce({ ok: false as const, error: "it did not work" })
      .mockResolvedValue({ ok: true as const, id: CONVERSATION });
    newChat(emptyActions({ open }));
    await choose(file("letter.pdf", 2048));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(open).toHaveBeenCalledTimes(2);
    expect(request(0).conversationId).toBe(CONVERSATION);
  });
});

describe("EmptyChat when the first message into an opened conversation is refused", () => {
  it("should keep the person on the new-chat screen with their files and the reason", async () => {
    const acts: EmptyChatActions = {
      start: vi.fn(async () => ({ ok: true as const, id: "started" })),
      open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
      send: vi.fn(async () => ({ ok: false as const, error: "that conversation no longer exists" })),
      setProduct: vi.fn(async () => ({ ok: true as const }))
    };
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={acts} />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "have a look" } });
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe("that conversation no longer exists");
    expect(chips()).toHaveLength(1);
    expect(box.value).toBe("have a look");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("EmptyChat when the person changes their mind while the chat is being opened", () => {
  it("should upload nothing once the attachment has been removed, even though the conversation was created", async () => {
    let settle: (result: { ok: true; id: string }) => void = () => undefined;
    const acts: EmptyChatActions = {
      start: vi.fn(async () => ({ ok: true as const, id: "started" })),
      open: vi.fn(
        () =>
          new Promise<{ ok: true; id: string }>((resolve) => {
            settle = resolve;
          })
      ),
      send: vi.fn(async () => ({ ok: true as const })),
      setProduct: vi.fn(async () => ({ ok: true as const }))
    };
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={acts} />);
    await choose(file("letter.pdf", 2048));

    // Removed while the conversation is still being created, so there is no upload id to discard yet.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove letter.pdf" }));
    });
    await act(async () => {
      settle({ ok: true, id: CONVERSATION });
    });

    expect(uploads.pending).toHaveLength(0);
    expect(uploads.discarded).toEqual([]);
    expect(chips()).toHaveLength(0);
  });
});

describe("EmptyChat when a later change of product cannot be saved", () => {
  it("should say so rather than show a product the conversation does not have", async () => {
    const acts: EmptyChatActions = {
      start: vi.fn(async () => ({ ok: true as const, id: "started" })),
      open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
      send: vi.fn(async () => ({ ok: true as const })),
      setProduct: vi.fn(async () => ({ ok: false as const, error: "that conversation no longer exists" }))
    };
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={acts} />);
    await choose(file("letter.pdf", 2048));
    await finished();

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "ccd" } });
    });

    expect(screen.getByRole("alert").textContent).toBe("that conversation no longer exists");
  });
});

/**
 * The whole point of the resumed state. The route unmounts and remounts this screen on a trip to another conversation
 * and back, and the draft text survives that, so the conversation it was attached to has to survive it too. Without
 * this, a send after the remount started a *second* conversation and left the person's file in the first for the
 * sweep to delete — their words came back and their file silently did not.
 */
describe("EmptyChat remounted after a file was attached", () => {
  function actionsFor(overrides: Partial<EmptyChatActions> = {}): EmptyChatActions {
    return {
      start: vi.fn(async () => ({ ok: true as const, id: "started" })),
      open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
      send: vi.fn(async () => ({ ok: true as const })),
      setProduct: vi.fn(async () => ({ ok: true as const })),
      ...overrides
    };
  }

  const unsent: UnsentChat = {
    id: CONVERSATION,
    product: "pcs",
    attachments: [{ id: "u1", name: "scanned letter.pdf", bytes: 2048, media_type: "application/pdf", available_until: HELD_UNTIL }]
  };

  function newChat(acts: EmptyChatActions, resumed?: UnsentChat) {
    render(<EmptyChat viewerOid={VIEWER} starters={STARTERS} templates={TEMPLATES} actions={acts} unsent={resumed} />);
    return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  }

  it("should show the file the hub is still holding as a finished chip", () => {
    newChat(actionsFor(), unsent);

    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.textContent).toContain("scanned letter.pdf");
    expect(chips()[0]?.textContent).toContain("2 KB");
    // Finished, not uploading: the hub would not have reported it otherwise.
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("should send into the conversation the file is already in, rather than starting a second one", async () => {
    const acts = actionsFor();
    const box = newChat(acts, unsent);
    fireEvent.change(box, { target: { value: "what does this say?" } });

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(acts.start).not.toHaveBeenCalled();
    expect(acts.send).toHaveBeenCalledWith({ conversationId: CONVERSATION, body: "what does this say?", uploadIds: ["u1"] });
    expect(push).toHaveBeenCalledWith(`/assistant/${CONVERSATION}`);
  });

  it("should put the product the file was attached under back on the select", () => {
    newChat(actionsFor(), unsent);

    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("pcs");
  });

  it("should attach another file to the same conversation without opening a second one", async () => {
    const acts = actionsFor();
    newChat(acts, unsent);

    await choose(file("notes.txt", 10));

    expect(acts.open).not.toHaveBeenCalled();
    expect(request().conversationId).toBe(CONVERSATION);
    expect(chips()).toHaveLength(2);
  });

  it("should discard a resumed file at the hub when the person removes its chip", async () => {
    newChat(actionsFor(), unsent);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove scanned letter.pdf" }));
    });

    expect(uploads.discarded).toEqual(["u1"]);
    expect(chips()).toHaveLength(0);
  });

  it("should upload nothing for a resumed chip, since its bytes are already at the hub", () => {
    newChat(actionsFor(), unsent);

    expect(uploads.pending).toHaveLength(0);
  });

  it("should carry a change of product through to the conversation that already exists", async () => {
    const acts = actionsFor();
    newChat(acts, unsent);

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "ccd" } });
    });

    expect(acts.setProduct).toHaveBeenCalledWith({ conversationId: CONVERSATION, product: "ccd" });
  });

  it("should start a conversation the ordinary way when the hub has nothing unsent", async () => {
    const acts = actionsFor();
    const box = newChat(acts);
    fireEvent.change(box, { target: { value: "just words" } });

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(chips()).toHaveLength(0);
    expect(acts.start).toHaveBeenCalledWith({ product: "general", body: "just words" });
  });
});

/**
 * The product is remembered for the same reason and in the same place as the draft text: coming back to find the
 * words restored and the product back to its default is how a message gets sent about the wrong thing.
 */
describe("EmptyChat remembering the product with no conversation yet", () => {
  function newChat() {
    render(
      <EmptyChat
        viewerOid={VIEWER}
        starters={STARTERS}
        templates={TEMPLATES}
        actions={{
          start: vi.fn(async () => ({ ok: true as const, id: "started" })),
          open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
          send: vi.fn(async () => ({ ok: true as const })),
          setProduct: vi.fn(async () => ({ ok: true as const }))
        }}
      />
    );
    return screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement;
  }

  it("should put the chosen product back after the screen is remounted", async () => {
    const select = newChat();

    await act(async () => {
      fireEvent.change(select, { target: { value: "pcs" } });
    });
    cleanup();

    expect(newChat().value).toBe("pcs");
  });

  it("should fall back to the default when what was remembered is not a product any more", () => {
    sessionStorage.setItem(`agent-hub:assistant-product:${VIEWER}`, "a-product-that-was-retired");

    expect(newChat().value).toBe("general");
  });
});

describe("EmptyChat when the tab will not keep anything", () => {
  it("should still open, with the default product, when storage refuses to answer", () => {
    // Safari private browsing throws on access rather than returning null. Losing the choice is never worth
    // breaking the screen, which is the same bargain `useDraft` makes with the text.
    const storage = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("the quota is exceeded");
    });

    render(
      <EmptyChat
        viewerOid={VIEWER}
        starters={STARTERS}
        templates={TEMPLATES}
        actions={{
          start: vi.fn(async () => ({ ok: true as const, id: "started" })),
          open: vi.fn(async () => ({ ok: true as const, id: CONVERSATION })),
          send: vi.fn(async () => ({ ok: true as const })),
          setProduct: vi.fn(async () => ({ ok: true as const }))
        }}
      />
    );

    expect((screen.getByRole("combobox", { name: "Product" }) as HTMLSelectElement).value).toBe("general");
    storage.mockRestore();
  });
});
