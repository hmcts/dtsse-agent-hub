"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DEFAULT_PRODUCT } from "@/assistant/products";
import type { Starter, Template } from "@/assistant/starters";
import { SidebarToggle } from "@/components/assistant/AssistantShell";
import { Composer } from "@/components/assistant/Composer";
import { ProductSelect } from "@/components/assistant/ProductSelect";
import type { ActionResult } from "@/web/action";

export type StartAction = (input: { product: unknown; body: unknown }) => Promise<ActionResult<{ id: string }>>;
export type OpenAction = (input: { product: unknown }) => Promise<ActionResult<{ id: string }>>;
export type SendAction = (input: { conversationId: unknown; body: unknown; uploadIds: unknown }) => Promise<ActionResult>;
export type ProductAction = (input: { conversationId: unknown; product: unknown }) => Promise<ActionResult>;

export interface EmptyChatActions {
  /** A conversation and its first message in one go, for the ordinary case where nothing was attached. */
  start: StartAction;
  /** An empty conversation, for a file to belong to before any of its bytes can be sent. */
  open: OpenAction;
  /** The first message, when attaching has already created the conversation. */
  send: SendAction;
  /** The product, when it is changed after attaching has already created the conversation. */
  setProduct: ProductAction;
}

/**
 * What the new chat's draft is kept under. There is no conversation to key it on until the first message creates one,
 * and a conversation id is a UUID, so this can never be mistaken for one.
 */
export const NEW_CHAT_DRAFT = "new";

/**
 * A new chat: what the person is working on, as a starter card or their own words, and which product it is about.
 *
 * Attaching a file is a plausible opening move — handing the assistant a scanned letter and asking what it says — so
 * the Attach item is offered here as well as in a chat that already exists. A file has to belong to a conversation
 * before any of its bytes can be sent, so the first attachment creates one, and the first message then goes into it
 * rather than starting another. Everything else is unchanged: the conversation is created with one more round trip
 * that the chip's own progress bar already covers, and the page still moves to `/assistant/{id}` on send, not on
 * attach — moving at attach would unmount this composer and lose both the part in flight and whatever was typed.
 */
export function EmptyChat({
  starters,
  templates,
  viewerOid,
  actions,
  uploads = false
}: {
  starters: readonly Starter[];
  templates: readonly Template[];
  /** Who is reading, which the composer keys its draft on. */
  viewerOid: string;
  actions: EmptyChatActions;
  uploads?: boolean;
}) {
  const router = useRouter();
  const [product, setProduct] = useState(DEFAULT_PRODUCT);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The conversation attaching created, and the request that created it. The promise is held rather than the id so
  // that four files chosen at once share one conversation: each calls `openConversation`, and all but the first wait
  // on the call already in flight instead of creating another chat.
  const opening = useRef<Promise<string> | null>(null);
  const opened = useRef<string | null>(null);

  async function openConversation(): Promise<string> {
    opening.current ??= (async () => {
      const result = await actions.open({ product });
      if (!result.ok) {
        // Cleared so the next attempt tries again rather than replaying this failure for the rest of the session.
        opening.current = null;
        throw new Error(result.error);
      }
      opened.current = result.id;
      return result.id;
    })();
    return await opening.current;
  }

  async function changeProduct(next: string): Promise<void> {
    setProduct(next);
    const conversation = opened.current;
    if (conversation === null) {
      // Nothing has been attached, so there is no conversation yet and the first message carries the product.
      return;
    }
    // Attaching created the conversation with the product chosen at the time, so a later change has to reach it, and
    // a change that did not land is said so rather than left as a control showing a value nothing has.
    const result = await actions.setProduct({ conversationId: conversation, product: next });
    setError(result.ok ? null : result.error);
  }

  async function begin(body: string, uploadIds: string[] = []): Promise<string | null> {
    const conversation = opened.current;
    if (conversation === null) {
      const result = await actions.start({ product, body });
      if (!result.ok) {
        return result.error;
      }
      router.push(`/assistant/${result.id}`);
      return null;
    }
    const result = await actions.send({ conversationId: conversation, body, uploadIds });
    if (!result.ok) {
      return result.error;
    }
    router.push(`/assistant/${conversation}`);
    return null;
  }

  async function starter(prompt: string): Promise<void> {
    setStarting(true);
    setError(null);
    const failure = await begin(prompt);
    if (failure !== null) {
      setError(failure);
      setStarting(false);
    }
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-asst-field px-4">
        <SidebarToggle />
        <h1 className="truncate text-[15px] font-medium">New chat</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center gap-7 px-5 py-10">
          <h2 className="text-balance text-center text-[28px] font-medium tracking-tight">What are you working on?</h2>
          <ul aria-label="Starters" className="grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-2">
            {starters.map((card) => (
              <li key={card.title}>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => void starter(card.prompt)}
                  className="flex h-full w-full flex-col gap-0.5 rounded-xl border border-asst-line bg-asst-raised px-4 py-3.5 text-left hover:border-asst-accent-line hover:bg-asst-hover disabled:opacity-60"
                >
                  <span className="text-sm font-medium">{card.title}</span>
                  <span className="text-[13px] text-asst-muted">{card.sub}</span>
                </button>
              </li>
            ))}
          </ul>
          <ProductSelect value={product} onChange={(next) => void changeProduct(next)} />
          {error === null ? null : (
            <p role="alert" className="text-[13px] text-asst-error">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-3.5">
        <div className="mx-auto max-w-[760px]">
          {/* The draft is forgotten when the message typed here is sent, which is also when the page moves to the
              conversation — not when the conversation is created, because attaching a file creates one while the
              person is still typing into this box. A starter card sends its own words and leaves the box alone. */}
          <Composer
            templates={templates}
            viewerOid={viewerOid}
            draftId={NEW_CHAT_DRAFT}
            onSend={begin}
            disabled={starting}
            uploads={uploads}
            openConversation={openConversation}
          />
        </div>
      </div>
    </>
  );
}
