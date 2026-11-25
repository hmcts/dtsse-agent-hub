/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLink } from "@/assistant/views";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { ChatMenu } from "@/components/assistant/ChatMenu";
import { EmptyChat, type EmptyChatActions, type EmptyFolder, folderDraftId } from "@/components/assistant/EmptyChat";
import { FolderList, type SidebarFolders } from "@/components/assistant/FolderList";

const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FOLDER = "11111111-1111-1111-1111-111111111111";
const OTHER_FOLDER = "22222222-2222-2222-2222-222222222222";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined,
  useHubSubscribe: () => () => () => undefined,
  useWatch: () => undefined
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
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
  refresh.mockReset();
  push.mockReset();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function link(id: string, title: string, folderId: string | null = null): ConversationLink {
  return { kind: "cloud", id, title, product: "ccd", productLabel: "CCD", lastActiveAt: new Date().toISOString(), pinnedAt: null, mark: null, folderId };
}

function sidebarFolders(overrides: Partial<SidebarFolders> = {}): SidebarFolders {
  return {
    list: [
      {
        id: FOLDER,
        name: "Possession claims",
        chats: [
          { id: "c1", title: "Claim form" },
          { id: "c2", title: "Eviction story" }
        ]
      },
      { id: OTHER_FOLDER, name: "Welsh", chats: [] }
    ],
    create: vi.fn(async () => ({ ok: true as const, id: FOLDER })),
    move: ok(),
    ...overrides
  };
}

describe("FolderList", () => {
  it("should list each folder as a link to its page, the open one marked as current", () => {
    render(<FolderList folders={sidebarFolders()} activeId={`/assistant/folders/${FOLDER}`} />);

    const open = screen.getByRole("link", { name: "Possession claims" });
    expect(open.getAttribute("href")).toBe(`/assistant/folders/${FOLDER}`);
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Welsh" }).getAttribute("aria-current")).toBeNull();
  });

  it("should start with every folder closed when nothing open is in one", () => {
    render(<FolderList folders={sidebarFolders()} activeId="elsewhere" />);

    expect(screen.getByRole("button", { name: "Expand Possession claims" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Chats in Possession claims" })).toBeNull();
  });

  it("should list a folder's chats when it is expanded, and hide them again when it is collapsed", () => {
    render(<FolderList folders={sidebarFolders()} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand Possession claims" }));
    const chats = screen.getByRole("list", { name: "Chats in Possession claims" });
    expect(
      within(chats)
        .getAllByRole("link")
        .map((chat) => [chat.textContent, chat.getAttribute("href")])
    ).toEqual([
      ["Claim form", "/assistant/c1"],
      ["Eviction story", "/assistant/c2"]
    ]);
    const collapse = screen.getByRole("button", { name: "Collapse Possession claims" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.getAttribute("aria-controls")).toBe(chats.id);

    fireEvent.click(collapse);
    expect(screen.queryByRole("list", { name: "Chats in Possession claims" })).toBeNull();
  });

  it("should say an expanded folder has no chats when it is empty", () => {
    render(<FolderList folders={sidebarFolders()} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand Welsh" }));

    expect(within(screen.getByRole("list", { name: "Chats in Welsh" })).getByText("No chats yet")).toBeTruthy();
  });

  it("should start with the folder expanded when its page or one of its chats is open, the chat marked as current", () => {
    render(<FolderList folders={sidebarFolders()} activeId={`/assistant/folders/${FOLDER}`} />);
    expect(screen.getByRole("list", { name: "Chats in Possession claims" })).toBeTruthy();
    cleanup();

    render(<FolderList folders={sidebarFolders()} activeId="c2" />);
    const current = within(screen.getByRole("list", { name: "Chats in Possession claims" })).getByRole("link", { name: "Eviction story" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("list", { name: "Chats in Welsh" })).toBeNull();
  });

  it("should expand the folder when one of its chats is opened later, and keep a folder closed by hand closed on the same page", () => {
    const { rerender } = render(<FolderList folders={sidebarFolders()} activeId={null} />);
    expect(screen.queryByRole("list", { name: "Chats in Possession claims" })).toBeNull();

    rerender(<FolderList folders={sidebarFolders()} activeId="c1" />);
    expect(screen.getByRole("list", { name: "Chats in Possession claims" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Possession claims" }));
    rerender(<FolderList folders={sidebarFolders()} activeId="c1" />);
    expect(screen.queryByRole("list", { name: "Chats in Possession claims" })).toBeNull();
  });

  it("should invite the person to make one when they have no folders", () => {
    render(<FolderList folders={sidebarFolders({ list: [] })} activeId={null} />);

    expect(screen.getByText("Group your chats into folders.")).toBeTruthy();
  });

  it("should create a folder with the typed name and open its page", async () => {
    const create = vi.fn(async () => ({ ok: true as const, id: OTHER_FOLDER }));
    render(<FolderList folders={sidebarFolders({ create })} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const box = screen.getByRole("textbox", { name: "Folder name" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "Bulk scan" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(create).toHaveBeenCalledWith({ name: "Bulk scan" });
    expect(push).toHaveBeenCalledWith(`/assistant/folders/${OTHER_FOLDER}`);
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();
  });

  it("should keep the box open and show the refusal when the name is refused", async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: "a folder name is 1 to 80 characters" }));
    render(<FolderList folders={sidebarFolders({ create })} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox", { name: "Folder name" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("a folder name is 1 to 80 characters");
    expect(screen.getByRole("textbox", { name: "Folder name" })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("should create one folder however many times the person presses Create while it is going", async () => {
    let answer: (value: { ok: true; id: string }) => void = () => undefined;
    const create = vi.fn(() => new Promise<{ ok: true; id: string }>((resolve) => (answer = resolve)));
    render(<FolderList folders={sidebarFolders({ create })} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const box = screen.getByRole("textbox", { name: "Folder name" });
    fireEvent.change(box, { target: { value: "Bulk scan" } });
    fireEvent.submit(box);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeTruthy();
    fireEvent.submit(box);
    await act(async () => {
      answer({ ok: true, id: FOLDER });
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("should say the request could not be sent when the action never answers", async () => {
    const create = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    render(<FolderList folders={sidebarFolders({ create })} activeId={null} />);

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox", { name: "Folder name" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  });

  it("should close the box and return focus to the plus when the person presses Escape or Cancel", () => {
    render(<FolderList folders={sidebarFolders()} activeId={null} />);
    const plus = screen.getByRole("button", { name: "New folder" });

    fireEvent.click(plus);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();
    expect(document.activeElement).toBe(plus);

    fireEvent.click(plus);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();

    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(screen.queryByRole("textbox", { name: "Folder name" })).toBeNull();
  });
});

describe("ChatMenu's Move to folder", () => {
  function menu(move: { folders: { id: string; name: string }[]; current: string | null; onMove: (id: string | null) => Promise<void> }) {
    render(
      <ChatMenu title="Event help" pinned={false} onPin={async () => undefined} onRename={async () => undefined} onDelete={async () => undefined} move={move} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
  }

  it("should move the chat into the folder the person picks", async () => {
    const onMove = vi.fn(async () => undefined);
    menu({ folders: [{ id: FOLDER, name: "Possession claims" }], current: null, onMove });

    const pane = screen.getByRole("group", { name: "Move to folder" });
    expect(within(pane).queryByRole("button", { name: "Remove from folder" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(pane).getByRole("button", { name: "Possession claims" }));
    });

    expect(onMove).toHaveBeenCalledWith(FOLDER);
    expect(screen.queryByRole("group", { name: "Move to folder" })).toBeNull();
  });

  it("should show the chat's own folder as current and offer to take it out", async () => {
    const onMove = vi.fn(async () => undefined);
    menu({
      folders: [
        { id: FOLDER, name: "Possession claims" },
        { id: OTHER_FOLDER, name: "Welsh" }
      ],
      current: FOLDER,
      onMove
    });

    const current = screen.getByRole("button", { name: /Possession claims/ });
    expect(current.getAttribute("aria-pressed")).toBe("true");
    expect((current as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Welsh" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove from folder" }));
    });

    expect(onMove).toHaveBeenCalledWith(null);
  });

  it("should say how to make a folder when the person has none", () => {
    menu({ folders: [], current: null, onMove: vi.fn() });

    expect(screen.getByText(/You have no folders yet/)).toBeTruthy();
  });

  it("should offer no Pin or Move item to a folder's own menu, and ask about deleting a folder", () => {
    render(<ChatMenu title="Welsh" noun="folder" label="Folder options" onRename={async () => undefined} onDelete={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));

    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move to folder" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Folder name" }).getAttribute("maxLength")).toBe("80");
    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    expect(screen.getByText("Delete this folder? The chats in it are kept.")).toBeTruthy();
  });
});

describe("AssistantShell with folders", () => {
  function actions(): ConversationActions {
    return { rename: ok(), pin: ok(), remove: ok(), pinFeedback: ok(), archiveFeedback: ok(), renameForm: ok(), pinForm: ok(), removeForm: ok() };
  }

  it("should list the folders in the sidebar and move a chat from its row's menu", async () => {
    const folders = sidebarFolders();
    render(
      <AssistantShell
        now={Date.now()}
        viewerName="Alice Smith"
        groups={[{ label: "Today", items: [link("a", "Event help", OTHER_FOLDER)] }]}
        activeId={null}
        actions={actions()}
        folders={folders}
      >
        <p>page</p>
      </AssistantShell>
    );

    const nav = screen.getByRole("navigation", { name: "Chats" });
    expect(within(nav).getByRole("link", { name: "Possession claims" })).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "Options for Event help" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    const pane = screen.getByRole("group", { name: "Move to folder" });
    expect(within(pane).getByRole("button", { name: /Welsh/ }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(within(pane).getByRole("button", { name: "Possession claims" }));
    });

    expect(folders.move).toHaveBeenCalledWith({ conversationId: "a", folderId: FOLDER });
    expect(refresh).toHaveBeenCalled();
  });

  it("should show the refusal under the row when the move is refused", async () => {
    const folders = sidebarFolders({ move: vi.fn(async () => ({ ok: false as const, error: "no such folder" })) });
    render(
      <AssistantShell
        now={Date.now()}
        viewerName="Alice Smith"
        groups={[{ label: "Today", items: [link("a", "Event help")] }]}
        activeId={null}
        actions={actions()}
        folders={folders}
      >
        <p>page</p>
      </AssistantShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Options for Event help" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Possession claims" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("no such folder");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("should offer no Folders section or Move item when folders are left out", () => {
    render(
      <AssistantShell
        now={Date.now()}
        viewerName="Alice Smith"
        groups={[{ label: "Today", items: [link("a", "Event help")] }]}
        activeId={null}
        actions={actions()}
      >
        <p>page</p>
      </AssistantShell>
    );

    expect(screen.queryByRole("heading", { name: "Folders" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Options for Event help" }));
    expect(screen.queryByRole("menuitem", { name: "Move to folder" })).toBeNull();
  });
});

describe("EmptyChat in a folder", () => {
  function emptyActions(overrides: Partial<EmptyChatActions> = {}): EmptyChatActions {
    return {
      start: vi.fn(async () => ({ ok: true as const, id: "abc" })),
      open: vi.fn(async () => ({ ok: true as const, id: "opened" })),
      send: ok(),
      setProduct: ok(),
      ...overrides
    };
  }

  function folder(overrides: Partial<EmptyFolder> = {}): EmptyFolder {
    return { id: FOLDER, name: "Possession claims", chats: [], rename: ok(), remove: ok(), ...overrides };
  }

  it("should head the screen with the folder and start the chat in it", async () => {
    const actions = emptyActions();
    render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={actions} folder={folder()} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Possession claims");
    expect(screen.getByRole("heading", { name: "New chat in Possession claims" })).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "Draft a story" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(actions.start).toHaveBeenCalledWith({ product: "general", body: "Draft a story", folderId: FOLDER });
    expect(push).toHaveBeenCalledWith("/assistant/abc");
  });

  it("should open the conversation for a file in the folder", async () => {
    const actions = emptyActions();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ upload_id: "u1" })))
    );
    render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={actions} folder={folder()} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Files to attach"), { target: { files: [new File(["a"], "a.txt", { type: "text/plain" })] } });
    });

    expect(actions.open).toHaveBeenCalledWith({ product: "general", folderId: FOLDER });
    vi.unstubAllGlobals();
  });

  it("should list the folder's chats, or say there are none", () => {
    const { rerender } = render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={emptyActions()} folder={folder()} />);
    expect(screen.getByText(/None yet/)).toBeTruthy();

    rerender(
      <EmptyChat
        viewerOid={VIEWER}
        starters={[]}
        templates={[]}
        skills={[]}
        actions={emptyActions()}
        folder={folder({ chats: [link("c1", "Claim form", FOLDER)] })}
      />
    );
    const chats = screen.getByRole("region", { name: "Chats in this folder" });
    expect(
      within(chats)
        .getByRole("link", { name: /Claim form/ })
        .getAttribute("href")
    ).toBe("/assistant/c1");
    expect(within(chats).getByText("Today")).toBeTruthy();
  });

  it("should rename the folder from its header's menu", async () => {
    const rename = ok();
    render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={emptyActions()} folder={folder({ rename })} />);

    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "PCS" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(rename).toHaveBeenCalledWith({ folderId: FOLDER, name: "PCS" });
    expect(refresh).toHaveBeenCalled();
  });

  it("should leave for a new chat once the folder is deleted", async () => {
    const remove = ok();
    render(<EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={emptyActions()} folder={folder({ remove })} />);

    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(remove).toHaveBeenCalledWith({ folderId: FOLDER });
    expect(push).toHaveBeenCalledWith("/assistant");
  });

  it("should show the refusal and stay when the folder could not be renamed or deleted", async () => {
    const refused = vi.fn(async () => ({ ok: false as const, error: "no such folder" }));
    render(
      <EmptyChat viewerOid={VIEWER} starters={[]} templates={[]} skills={[]} actions={emptyActions()} folder={folder({ remove: refused, rename: refused })} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("no such folder");
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Folder options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("no such folder");
  });

  it("should keep a folder's draft apart from the plain new chat's", () => {
    expect(folderDraftId(FOLDER)).toBe(`new:${FOLDER}`);
  });
});
