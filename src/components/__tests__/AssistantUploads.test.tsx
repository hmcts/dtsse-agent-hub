/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "@/assistant/starters";
import type { ConversationView } from "@/assistant/views";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { Composer } from "@/components/assistant/Composer";
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
});

afterEach(() => {
  cleanup();
  uploads.pending.length = 0;
  uploads.discarded.length = 0;
  refresh.mockReset();
  push.mockReset();
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
  render(<Composer templates={TEMPLATES} onSend={onSend} conversationId="c1" {...props} />);
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
    render(<ChatView view={conversation()} templates={TEMPLATES} actions={actions()} />);

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
    render(<Composer templates={TEMPLATES} onSend={vi.fn(async () => null)} />);
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

  it("should offer no file controls when there is no conversation to attach to yet", () => {
    render(<Composer templates={TEMPLATES} onSend={vi.fn(async () => null)} />);

    expect(screen.getByRole("button", { name: "Add a template" })).toBeTruthy();
    expect(screen.queryByLabelText("Files to attach")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a template" }));
    expect(screen.queryByRole("menuitem", { name: "Attach files" })).toBeNull();
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
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-10-21T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "delivered",
    ...overrides
  };
}

/** The upload store adds `attachments` to `ThreadMessage`; the rendering is built against that shape now. */
function withAttachments(attachments: { name: string; bytes: number }[], overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return { ...message(overrides), attachments } as ThreadMessage;
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

function actions(): ChatActions {
  return {
    send: vi.fn(async () => ({ ok: true as const, message: message({ id: "99" }) })),
    warm: vi.fn(async () => ({ ok: true as const })),
    setProduct: vi.fn(async () => ({ ok: true as const })),
    rename: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    saveArtefact: vi.fn(async () => ({ ok: true as const, saved: true as const, version: 1 }))
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
    render(<ChatView view={view} templates={TEMPLATES} actions={actions()} />);

    const sent = screen.getByRole("list", { name: "Files sent with this message" });
    const shown = within(sent).getAllByRole("listitem");
    expect(shown).toHaveLength(2);
    expect(shown[0]?.textContent).toBe("📎letter.pdf2 KB");
    expect(shown[1]?.textContent).toBe("📎spreadsheet.xlsx3.0 MB");
    expect(within(screen.getByRole("list", { name: "Conversation" })).getByText("have a look at this")).toBeTruthy();
  });

  it("should say the file cannot be opened from the page when describing a chip", () => {
    render(
      <ChatView
        view={conversation({ page: page({ messages: [withAttachments([{ name: "letter.pdf", bytes: 10 }])] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    const chip = within(screen.getByRole("list", { name: "Files sent with this message" })).getAllByRole("listitem")[0];
    expect(chip?.getAttribute("title")).toBe("Sent to the assistant. It is not kept here, so it cannot be opened or downloaded from this page.");
  });

  it("should show the chips without an empty bubble when the message was only files", () => {
    render(
      <ChatView
        view={conversation({ page: page({ messages: [withAttachments([{ name: "letter.pdf", bytes: 10 }], { body: "" })] }) })}
        templates={TEMPLATES}
        actions={actions()}
      />
    );

    const item = within(screen.getByRole("list", { name: "Conversation" })).getAllByRole("listitem")[0];
    expect(item?.textContent).toBe("You said:📎letter.pdf10 bytes");
  });

  it("should show no attachment list when the message carried no files", () => {
    render(<ChatView view={conversation({ page: page({ messages: [message()] }) })} templates={TEMPLATES} actions={actions()} />);

    expect(screen.queryByRole("list", { name: "Files sent with this message" })).toBeNull();
  });
});
