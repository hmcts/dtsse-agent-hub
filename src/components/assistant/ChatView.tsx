"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import { PRODUCTS, productLabel } from "@/assistant/products";
import type { Template } from "@/assistant/starters";
import { type Progress, progress, type ThreadItem, threadItems } from "@/assistant/thread";
import type { ConversationView } from "@/assistant/views";
import { useLiveConversation } from "@/components/agents/useLiveConversation";
import { ArtefactPanel, type SaveArtefactAction } from "@/components/assistant/ArtefactPanel";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { Mark, SidebarToggle } from "@/components/assistant/AssistantShell";
import { Composer } from "@/components/assistant/Composer";
import type { ExportToJiraAction, JiraAccess } from "@/components/assistant/JiraExport";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubEvent } from "@/components/live/HubStream";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { AgentStatus } from "@/realtime/events";
import type { ActionResult } from "@/web/action";

export interface ChatActions {
  send: (input: { conversationId: unknown; body: unknown }) => Promise<ActionResult<{ message: ThreadMessage }>>;
  warm: (input: { conversationId: unknown }) => Promise<ActionResult>;
  setProduct: (input: { conversationId: unknown; product: unknown }) => Promise<ActionResult>;
  rename: (input: { conversationId: unknown; title: unknown }) => Promise<ActionResult>;
  remove: (input: { conversationId: unknown }) => Promise<ActionResult>;
  saveArtefact: SaveArtefactAction;
  exportToJira: ExportToJiraAction;
}

function Dots({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3.5" role="status">
      <Mark size="sm" />
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="h-1.5 w-1.5 animate-asst-dot rounded-full bg-asst-accent" style={{ animationDelay: `${dot * 0.15}s` }} />
        ))}
      </span>
      <span className="text-[13px] text-asst-muted">{label}</span>
    </div>
  );
}

function Item({ item }: { item: ThreadItem }) {
  if (item.type === "product") {
    return (
      <li className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        Product changed to {item.label}
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </li>
    );
  }
  if (item.type === "user") {
    return (
      <li className="flex flex-col items-end gap-1">
        <span className="sr-only">You said:</span>
        <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[18px_18px_4px_18px] bg-asst-bubble px-4 py-2.5">{item.text}</div>
        {item.delivery === "expired" ? <span className="text-xs text-asst-error">Not delivered. Send it again.</span> : null}
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3.5">
      <span className="mt-px">
        <Mark size="sm" />
      </span>
      <div className="min-w-0 flex-1 text-asst-body">
        <span className="sr-only">The assistant said:</span>
        <AssistantMarkdown source={item.text} />
      </div>
    </li>
  );
}

function ConfirmProduct({ from, to, onCancel, onConfirm }: { from: string; to: string; onCancel: () => void; onConfirm: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  // The dialog's one decision, focused as it opens.
  useEffect(() => confirm.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-change-title"
        className="flex w-full max-w-[420px] flex-col gap-3.5 rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl"
      >
        <h2 id="product-change-title" className="text-lg font-semibold">
          Change product?
        </h2>
        <p className="text-pretty text-asst-body">
          You're switching from <strong className="font-semibold text-asst-text">{productLabel(from)}</strong> to{" "}
          <strong className="font-semibold text-asst-text">{productLabel(to)}</strong>. From now on, answers will use that product's context.
        </p>
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" onClick={onCancel} className="rounded-[10px] border border-asst-strong px-4 py-2.5 text-sm hover:bg-asst-active">
            Cancel
          </button>
          <button
            ref={confirm}
            type="button"
            onClick={onConfirm}
            className="rounded-[10px] bg-asst-accent px-4 py-2.5 text-sm font-semibold text-asst-ink hover:bg-asst-accent-hover"
          >
            Change product
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMenu({ title, onRename, onDelete }: { title: string; onRename: (title: string) => Promise<void>; onDelete: () => Promise<void> }) {
  const [open, setOpen] = useState<"closed" | "menu" | "rename" | "delete">("closed");
  const [draft, setDraft] = useState(title);
  const ref = useRef<HTMLDivElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open === "rename") {
      titleBox.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (open === "closed") {
      return;
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        setOpen("closed");
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const item = "rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="Chat options"
        aria-haspopup="menu"
        aria-expanded={open !== "closed"}
        onClick={() => setOpen(open === "closed" ? "menu" : "closed")}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-lg text-asst-muted hover:bg-asst-field hover:text-asst-text"
      >
        ⋯
      </button>
      {open === "closed" ? null : (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[260px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl">
          {open === "menu" ? (
            <div role="menu" aria-label="Chat options" className="flex flex-col gap-0.5">
              <button type="button" role="menuitem" className={item} onClick={() => setOpen("rename")}>
                Rename
              </button>
              <button type="button" role="menuitem" className={`${item} text-asst-error`} onClick={() => setOpen("delete")}>
                Delete chat
              </button>
            </div>
          ) : open === "rename" ? (
            <form
              method="post"
              className="flex flex-col gap-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename(draft).then(() => setOpen("closed"));
              }}
            >
              <label className="text-xs text-asst-faint" htmlFor="chat-title">
                Chat name
              </label>
              <input
                ref={titleBox}
                id="chat-title"
                value={draft}
                maxLength={200}
                onChange={(event) => setDraft(event.target.value)}
                className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-none focus:border-asst-accent-line"
              />
              <button type="submit" className="self-end rounded-lg bg-asst-accent px-3 py-1.5 text-sm font-semibold text-asst-ink">
                Save
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-sm">Delete this chat and its document? This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen("closed")} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm">
                  Cancel
                </button>
                <button type="button" onClick={() => void onDelete()} className="rounded-lg bg-asst-error px-3 py-1.5 text-sm font-semibold text-asst-ink">
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * One conversation: what the person and the assistant said, a line saying what the assistant is doing while it
 * works, and the composer; beside it, the conversation's document. Kept live by the conversation's agent's events;
 * a change to the conversation itself (its product, title, document or session) re-renders the page, which hands
 * down the new `view`.
 */
export function ChatView({
  view,
  templates,
  actions,
  jira
}: {
  view: ConversationView;
  templates: readonly Template[];
  actions: ChatActions;
  /** Whether the person has connected Jira, for the document's export. */
  jira: JiraAccess;
}) {
  const router = useRouter();
  const arrivals = useAnnouncer("replies");
  const live = useLiveConversation(view.agentId, view.page, { onReply: () => arrivals.announce("New reply from the assistant") });
  const [status, setStatus] = useState<AgentStatus>(view.agentStatus);
  const [pendingProduct, setPendingProduct] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warmed = useRef(false);
  const seenVersion = useRef(view.artefact.version);
  const narrow = useNarrow();

  useEffect(() => setStatus(view.agentStatus), [view.agentStatus]);
  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", ({ agent_id, status: next }) => {
    if (agent_id === view.agentId) {
      setStatus(next);
    }
  });

  // The assistant writing the document opens it, so the person sees what it was asked to draft.
  useEffect(() => {
    if (view.artefact.version > seenVersion.current && view.artefact.updatedBy === "agent") {
      setPanel(true);
      arrivals.announce("The assistant updated the document");
    }
    seenVersion.current = Math.max(seenVersion.current, view.artefact.version);
  }, [view.artefact.version, view.artefact.updatedBy, arrivals]);

  const thread = threadItems(live.items, view.productHistory);
  const doing: Progress = progress(live.items, thread, status, view.sessionState);
  const scroller = useStickToBottom<HTMLDivElement>(`${thread.length}:${doing.state}`);
  const artefact: ArtefactSnapshot = {
    title: view.artefact.title,
    markdown: view.artefact.markdown,
    version: view.artefact.version,
    updatedBy: view.artefact.updatedBy
  };

  async function send(body: string): Promise<string | null> {
    const result = await actions.send({ conversationId: view.id, body });
    if (!result.ok) {
      return result.error;
    }
    live.addMessage(result.message);
    return null;
  }

  async function changeProduct(product: string): Promise<void> {
    setPendingProduct(null);
    const result = await actions.setProduct({ conversationId: view.id, product });
    setError(result.ok ? null : result.error);
    router.refresh();
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-asst-field px-4">
          <SidebarToggle />
          <h1 className="min-w-0 truncate text-[15px] font-medium">{view.title}</h1>
          <label className="sr-only" htmlFor="chat-product">
            Product
          </label>
          <select
            id="chat-product"
            value={view.product}
            onChange={(event) => setPendingProduct(event.target.value)}
            className="shrink-0 cursor-pointer appearance-none rounded-md border border-asst-accent-line bg-transparent px-2 py-1 font-plex-mono text-[11px] uppercase leading-none tracking-wider text-asst-accent-soft outline-none focus:border-asst-accent"
          >
            {PRODUCTS.map((product) => (
              <option key={product.slug} value={product.slug} className="bg-asst-raised normal-case">
                {product.label}
              </option>
            ))}
          </select>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {panel ? null : (
              <button
                type="button"
                onClick={() => setPanel(true)}
                className="flex h-[34px] items-center gap-2 whitespace-nowrap rounded-[9px] border border-asst-strong pl-2.5 pr-3 text-[13px] hover:border-asst-accent-line hover:bg-asst-field"
              >
                <span aria-hidden="true" className="text-lg leading-none text-asst-accent">
                  +
                </span>
                {view.artefact.version > 0 ? "Open document" : "Add document"}
              </button>
            )}
            <ChatMenu
              title={view.title}
              onRename={async (title) => {
                const result = await actions.rename({ conversationId: view.id, title });
                setError(result.ok ? null : result.error);
                router.refresh();
              }}
              onDelete={async () => {
                const result = await actions.remove({ conversationId: view.id });
                if (result.ok) {
                  router.push("/assistant");
                } else {
                  setError(result.error);
                }
              }}
            />
          </div>
        </header>
        <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[760px] flex-col gap-[26px] px-5 pb-10 pt-7">
            {live.olderBefore !== null ? (
              <button
                type="button"
                onClick={() => void live.loadEarlier()}
                disabled={live.loading}
                className="self-center rounded-full border border-asst-strong px-3 py-1 text-[13px] hover:bg-asst-field disabled:opacity-60"
              >
                {live.loading ? "Loading" : "Show earlier messages"}
              </button>
            ) : null}
            {live.error === null ? null : (
              <p role="alert" className="self-center text-xs text-asst-error">
                {live.error}
              </p>
            )}
            <ol aria-label="Conversation" className="flex flex-col gap-[26px]">
              {thread.map((item) => (
                <Item key={item.key} item={item} />
              ))}
            </ol>
            {doing.state === "idle" ? null : <Dots label={doing.label} />}
          </div>
          <AnnouncerRegion text={arrivals.text} />
        </div>
        <div className="shrink-0 px-4 pb-3.5">
          <div className="mx-auto max-w-[760px]">
            {error === null ? null : (
              <p role="alert" className="pb-2 text-center text-[13px] text-asst-error">
                {error}
              </p>
            )}
            <Composer
              templates={templates}
              onSend={send}
              onFocus={() => {
                if (!warmed.current && status === "offline") {
                  warmed.current = true;
                  void actions.warm({ conversationId: view.id });
                }
              }}
            />
          </div>
        </div>
      </div>
      {panel ? (
        <ArtefactPanel
          conversationId={view.id}
          artefact={artefact}
          productLabel={view.productLabel}
          save={actions.saveArtefact}
          onClose={() => setPanel(false)}
          jira={{ exported: view.jira, access: jira, exportTo: actions.exportToJira }}
          narrow={narrow}
        />
      ) : null}
      {pendingProduct !== null && pendingProduct !== view.product ? (
        <ConfirmProduct from={view.product} to={pendingProduct} onCancel={() => setPendingProduct(null)} onConfirm={() => void changeProduct(pendingProduct)} />
      ) : null}
    </div>
  );
}
