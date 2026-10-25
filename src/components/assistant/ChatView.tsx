"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import { PRODUCTS, productLabel, storedProduct } from "@/assistant/products";
import type { Template } from "@/assistant/starters";
import { type Progress, progress, progressAnnouncement, progressLabel, type ThreadItem, threadItems } from "@/assistant/thread";
import type { ConversationView } from "@/assistant/views";
import { useLiveConversation } from "@/components/agents/useLiveConversation";
import { ArtefactPanel, type SaveArtefactAction } from "@/components/assistant/ArtefactPanel";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { Mark, SidebarToggle } from "@/components/assistant/AssistantShell";
import { ChatMenu } from "@/components/assistant/ChatMenu";
import { Composer } from "@/components/assistant/Composer";
import { ARTEFACT_OVERLAY_MAX_WIDTH } from "@/components/assistant/layout";
import { fileSizeLabel } from "@/components/assistant/uploadClient";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubEvent } from "@/components/live/HubStream";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { AgentStatus } from "@/realtime/events";
import type { ActionResult } from "@/web/action";

export interface ChatActions {
  send: (input: { conversationId: unknown; body: unknown; uploadIds: unknown }) => Promise<ActionResult<{ message: ThreadMessage }>>;
  warm: (input: { conversationId: unknown }) => Promise<ActionResult>;
  setProduct: (input: { conversationId: unknown; product: unknown }) => Promise<ActionResult>;
  rename: (input: { conversationId: unknown; title: unknown }) => Promise<ActionResult>;
  remove: (input: { conversationId: unknown }) => Promise<ActionResult>;
  saveArtefact: SaveArtefactAction;
}

/**
 * What the assistant is doing, shown while it works. Not itself a live region: the activity changes with every tool
 * call, and the one region on the page announces only the facts that settle (`progressAnnouncement`).
 */
function Dots({ doing }: { doing: Progress }) {
  return (
    <div className="flex items-center gap-3.5">
      <Mark size="sm" />
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="h-1.5 w-1.5 animate-asst-dot rounded-full bg-asst-accent" style={{ animationDelay: `${dot * 0.15}s` }} />
        ))}
      </span>
      <span className="text-[13px] text-asst-muted">{progressLabel(doing)}</span>
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
        {item.text === "" ? null : (
          <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[18px_18px_4px_18px] bg-asst-bubble px-4 py-2.5">{item.text}</div>
        )}
        {item.attachments.length === 0 ? null : (
          <ul aria-label="Files sent with this message" className="flex max-w-[82%] flex-wrap justify-end gap-1.5">
            {item.attachments.map((file) => (
              <li
                key={file.id}
                title="Sent to the assistant. It is not kept here, so it cannot be opened or downloaded from this page."
                className="flex items-center gap-1.5 rounded-lg border border-asst-line px-2 py-1 text-xs text-asst-muted"
              >
                <span aria-hidden="true">📎</span>
                <span className="max-w-[200px] truncate">{file.name}</span>
                <span className="shrink-0 text-asst-faint">{fileSizeLabel(file.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
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

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${ARTEFACT_OVERLAY_MAX_WIDTH}px)`);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * One conversation: what the person and the assistant said, a line saying what the assistant is doing while it
 * works and how many subagents it is waiting on, and the composer; beside it, the conversation's document. The line
 * comes from the session's transcript and its own status, both already streamed here, so no page read follows a tool
 * call. Kept live by the conversation's agent's events;
 * a change to the conversation itself (its product, title, document or session) re-renders the page, which hands
 * down the new `view`.
 */
export function ChatView({
  view,
  templates,
  viewerOid,
  actions
}: {
  view: ConversationView;
  templates: readonly Template[];
  /** Who is reading, which the composer keys its draft on. */
  viewerOid: string;
  actions: ChatActions;
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

  // The picker can only show a product it offers, so it and the dialog it opens read the stored one through this.
  const product = storedProduct(view.product);
  const thread = threadItems(live.items, view.productHistory);
  const doing: Progress = progress(live.items, thread, status, view.sessionState);
  const scroller = useStickToBottom<HTMLDivElement>(`${thread.length}:${doing.state}`);
  const artefact: ArtefactSnapshot = {
    title: view.artefact.title,
    markdown: view.artefact.markdown,
    version: view.artefact.version,
    updatedBy: view.artefact.updatedBy
  };

  async function send(body: string, uploadIds: string[]): Promise<string | null> {
    const result = await actions.send({ conversationId: view.id, body, uploadIds });
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
          {/* Gives way long before the product chip beside it, keeping 4rem so the start of the name always shows. */}
          <h1 className="min-w-[4rem] shrink-[999] truncate text-[15px] font-medium">{view.title}</h1>
          <label className="sr-only" htmlFor="chat-product">
            Product
          </label>
          {/*
            The chip draws the chosen label itself, truncated, and its own arrow, with the real select laid over it
            at full size and invisible: a native select is as wide as its widest option, the longest label here runs
            to 40 characters, and how a select renders a value too long for it is the engine's business rather than
            `text-overflow`'s. The chip never goes below 4rem, so it stays readable and operable in a 320px header.
          */}
          <div className="relative flex min-w-[4rem] max-w-[9.5rem] shrink items-center gap-1.5 rounded-md border border-asst-accent-line px-2 py-1 font-plex-mono text-[11px] uppercase leading-none tracking-wider text-asst-accent-soft focus-within:border-asst-accent">
            <span aria-hidden="true" className="min-w-0 truncate">
              {productLabel(product)}
            </span>
            <span aria-hidden="true" className="shrink-0 text-[7px] leading-none text-asst-accent">
              ▼
            </span>
            <select
              id="chat-product"
              value={product}
              onChange={(event) => setPendingProduct(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 outline-none"
            >
              {PRODUCTS.map((offered) => (
                <option key={offered.slug} value={offered.slug} className="bg-asst-raised normal-case">
                  {offered.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {panel ? null : (
              <button
                type="button"
                onClick={() => setPanel(true)}
                // Named here as well, because below 480px the icon stands alone so that a 320px header still fits
                // the title, the product chip and both buttons.
                aria-label={view.artefact.version > 0 ? "Open document" : "Add document"}
                className="flex h-[34px] items-center whitespace-nowrap rounded-[9px] border border-asst-strong px-2.5 text-[13px] hover:border-asst-accent-line hover:bg-asst-field min-[480px]:gap-2 min-[480px]:pr-3"
              >
                <span aria-hidden="true" className="text-lg leading-none text-asst-accent">
                  +
                </span>
                <span className="hidden min-[480px]:inline">{view.artefact.version > 0 ? "Open document" : "Add document"}</span>
              </button>
            )}
            <ChatMenu
              title={view.title}
              shareHref={`/assistant/${view.id}?share=1`}
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
            {doing.state === "idle" ? null : <Dots doing={doing} />}
            {/*
              Always in the page, even with nothing to say: a live region added to the document at the same moment as
              its first text is not reliably announced. Emptying it as the answer settles is deliberate too, so the
              next thing it says is read as new.
            */}
            <p role="status" className="sr-only">
              {progressAnnouncement(doing)}
            </p>
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
              viewerOid={viewerOid}
              // The conversation, not its agent: a /clear registers a new agent and remounts the page, and the
              // half-written message belongs to the conversation the person never left.
              draftId={view.id}
              onSend={send}
              conversationId={view.id}
              skills={view.skills}
              dropZone={scroller.ref}
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
          narrow={narrow}
        />
      ) : null}
      {pendingProduct !== null && pendingProduct !== product ? (
        <ConfirmProduct from={product} to={pendingProduct} onCancel={() => setPendingProduct(null)} onConfirm={() => void changeProduct(pendingProduct)} />
      ) : null}
    </div>
  );
}
