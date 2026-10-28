"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DEFAULT_PRODUCT, isProduct } from "@/assistant/products";
import { fillWith, type Starter, type Template } from "@/assistant/starters";
import type { UnsentChat } from "@/assistant/views";
import { SidebarToggle } from "@/components/assistant/AssistantShell";
import { Composer, type ComposerFiller } from "@/components/assistant/Composer";
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

/** Where the new chat's product choice is remembered, scoped to the viewer as the drafts are and for the same reason. */
const PRODUCT_KEY = "agent-hub:assistant-product:";

/**
 * The product the new chat was last set to, in `sessionStorage`.
 *
 * It has to be remembered, and it has to be remembered *here*, because the draft text is: coming back to find the
 * words restored and the product silently back to its default is how a message gets sent about the wrong thing. Same
 * store, same per-tab lifetime, so the two always agree. Every access is wrapped for the same reasons `useDraft`
 * wraps its own — storage throws in Safari private browsing and is absent server-side.
 */
function rememberedProduct(viewerOid: string): string | undefined {
  try {
    const stored = window.sessionStorage.getItem(`${PRODUCT_KEY}${viewerOid}`);
    return stored !== null && isProduct(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function rememberProduct(viewerOid: string, product: string): void {
  try {
    window.sessionStorage.setItem(`${PRODUCT_KEY}${viewerOid}`, product);
  } catch {
    // Nothing to do: the choice is still on the screen, it just will not outlive it.
  }
}

/**
 * A new chat: what the person is working on, as a starter card or their own words, and which product it is about.
 *
 * Attaching a file is a plausible opening move — handing the assistant a scanned letter and asking what it says — so
 * the Attach item is offered here as well as in a chat that already exists. A file has to belong to a conversation
 * before any of its bytes can be sent, so the first attachment creates one, and the first message then goes into it
 * rather than starting another. The page still moves to `/assistant/{id}` on send, not on attach — moving at attach
 * would unmount this composer and lose both the part in flight and whatever was typed.
 *
 * **Everything this screen holds has to survive a remount of it**, because the draft text does. The route unmounts
 * and remounts on a trip to another conversation and back, and words returning without the conversation they were
 * attached to was data loss: `begin` would read no conversation, start a second one, and leave the first with the
 * person's file in it for the sweep to take. So the conversation and its files come back from the hub through
 * `unsent` — authoritative, because the bytes are already there — and the product comes back with them, from the
 * conversation's own row when there is one and from `sessionStorage` when there is not.
 *
 * The composer here offers no "/" list. A skill list is a session's report of what it can run, and this screen has no
 * session: the ordinary new chat has no conversation at all, and the one attaching a file opened has an agent no pod
 * has started yet. So the box is a plain one, as the hub's is for an agent that has reported nothing, and the list
 * appears on the conversation's own page once its session says what it has.
 */
export function EmptyChat({
  starters,
  templates,
  viewerOid,
  unsent,
  actions
}: {
  starters: readonly Starter[];
  templates: readonly Template[];
  /** Who is reading, which the composer keys its draft on. */
  viewerOid: string;
  /** The conversation this screen already opened for a file and never sent, if there is one. */
  unsent?: UnsentChat;
  actions: EmptyChatActions;
}) {
  const router = useRouter();
  // The conversation's own product wins: it is what the file was attached under, and what the session will be told.
  const [product, setProduct] = useState(() => unsent?.product ?? rememberedProduct(viewerOid) ?? DEFAULT_PRODUCT);
  const [error, setError] = useState<string | null>(null);

  // The conversation attaching created, and the request that created it. The promise is held rather than the id so
  // that four files chosen at once share one conversation: each calls `openConversation`, and all but the first wait
  // on the call already in flight instead of creating another chat.
  const opening = useRef<Promise<string> | null>(null);
  const opened = useRef<string | null>(unsent?.id ?? null);

  async function openConversation(): Promise<string> {
    // Already have one — this mount opened it, or the hub handed it back after a remount — so nothing is created.
    if (opened.current !== null) {
      return opened.current;
    }
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
    rememberProduct(viewerOid, next);
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

  // A card fills the box rather than sending, so the person answers its few headings before anything goes. Every
  // card's and template's text counts as untouched, so going from one card to another swaps them, and nothing typed
  // is lost to a click.
  const composer = useRef<ComposerFiller>(null);
  const untouched = [...starters.map((card) => card.text), ...templates.map((template) => template.text)];

  function starter(text: string): void {
    composer.current?.fill((current) => fillWith(current, text, untouched));
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
                  onClick={() => starter(card.text)}
                  className="flex h-full w-full flex-col gap-0.5 rounded-xl border border-asst-line bg-asst-raised px-4 py-3.5 text-left hover:border-asst-accent-line hover:bg-asst-hover"
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
        <div className="mx-auto max-w-[900px]">
          {/* The draft is forgotten when the message typed here is sent, which is also when the page moves to the
              conversation — not when the conversation is created, because attaching a file creates one while the
              person is still typing into this box. A starter card only fills this box, so it is a draft like anything typed. */}
          <Composer
            templates={templates}
            viewerOid={viewerOid}
            draftId={NEW_CHAT_DRAFT}
            onSend={begin}
            filler={composer}
            openConversation={openConversation}
            attached={unsent?.attachments}
          />
        </div>
      </div>
    </>
  );
}
