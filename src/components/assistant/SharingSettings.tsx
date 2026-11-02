"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { SharedChatLink, SharePerson } from "@/assistant/shares";
import { type ShareAction, ShareEditor, type ShareMode } from "@/components/assistant/ShareDialog";
import { useSettingsData } from "@/components/assistant/useSettingsData";
import type { SharedChats } from "@/web/data";

/**
 * Both sides of the person's shared chats, as the Assistant's settings show them: their own that they have shared or
 * offered to be forked, and those shared with or offered to them. Nothing is here that was not explicitly shared —
 * there is no browsing anyone else's chats from this section or anywhere else.
 *
 * The four lists are four queries, so they are read through `load`, `readSharedChats`, only once the section opens, and
 * again after each change made in it. Who one of the person's own chats is shared with is read only as its editor is
 * opened, from `GET /api/ui/assistant/shares/{id}`, since that is a query per chat.
 */
export interface AssistantSharing {
  load: () => Promise<SharedChats>;
  share: ShareAction;
  unshare: ShareAction;
  offer: ShareAction;
  withdraw: ShareAction;
}

/**
 * The row whose editor is open: one at a time, so the section stays a list to read rather than a stack of forms. The
 * chat and where it sat are kept so the row stays put while its editor is open, even once a re-read no longer lists
 * it — as it does once the last person is taken off — until the person closes it.
 */
interface Editing {
  mode: ShareMode;
  chat: SharedChatLink;
  index: number;
}

type Loaded = { state: "loading" } | { state: "ready"; people: SharePerson[] } | { state: "failed" };

/** Who the chat is shared with or offered to, or `null` when that could not be read. */
async function loadPeople(id: string, mode: ShareMode, signal: AbortSignal): Promise<SharePerson[] | null> {
  const response = await fetch(`/api/ui/assistant/shares/${encodeURIComponent(id)}${mode === "fork" ? "?mode=fork" : ""}`, { signal });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { people?: SharePerson[] };
  return body.people ?? null;
}

/** The editor under an opened row, once it knows who the chat is shared with. */
function InlineEditor({ id, mode, share, unshare, onChange }: { id: string; mode: ShareMode; share: ShareAction; unshare: ShareAction; onChange: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ state: "loading" });
    loadPeople(id, mode, controller.signal)
      .then((people) => setLoaded(people === null ? { state: "failed" } : { state: "ready", people }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ state: "failed" });
        }
      });
    return () => controller.abort();
  }, [id, mode]);

  if (loaded.state === "loading") {
    return <p className="text-[13px] text-asst-muted">Loading…</p>;
  }
  if (loaded.state === "failed") {
    return (
      <p role="alert" className="text-[13px] text-asst-error">
        Who it is shared with could not be loaded. Close this and try again.
      </p>
    );
  }
  return <ShareEditor mode={mode} conversationId={id} people={loaded.people} share={share} unshare={unshare} onChange={onChange} />;
}

/** `chats` with the open row in it where it was, when it is one of this list's and the last read left it out. */
function withOpenRow(chats: readonly SharedChatLink[], mode: ShareMode, editing: Editing | null): readonly SharedChatLink[] {
  if (editing === null || editing.mode !== mode || chats.some((chat) => chat.id === editing.chat.id)) {
    return chats;
  }
  const at = Math.min(editing.index, chats.length);
  return [...chats.slice(0, at), editing.chat, ...chats.slice(at)];
}

function Chats({
  label,
  chats,
  empty,
  manage
}: {
  label: string;
  chats: readonly SharedChatLink[];
  empty: string;
  /** For the person's own chats: what the button says, which editor it opens, and the row that has it open. */
  manage?: {
    change: string;
    mode: ShareMode;
    editing: Editing | null;
    onToggle: (chat: SharedChatLink, index: number) => void;
    onChange: () => void;
    share: ShareAction;
    unshare: ShareAction;
  };
}) {
  const ids = useId();
  const shown = manage === undefined ? chats : withOpenRow(chats, manage.mode, manage.editing);
  return (
    <section aria-labelledby={`${ids}-heading`} className="flex flex-col gap-2">
      <h4 id={`${ids}-heading`} className="text-[13px] font-semibold">
        {label}
      </h4>
      {shown.length === 0 ? (
        <p className="text-[13px] text-asst-muted">{empty}</p>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-1">
          {shown.map((chat, index) => {
            const open = manage !== undefined && manage.editing?.chat.id === chat.id && manage.editing.mode === manage.mode;
            const editorId = `${ids}-${chat.id}`;
            return (
              <li key={chat.id} className="flex flex-col gap-3 rounded-lg border border-asst-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={`/assistant/shared/${chat.id}`} className="min-w-0 flex-1 truncate text-asst-accent underline hover:text-asst-accent-hover">
                    {chat.title}
                  </Link>
                  <span className="shrink-0 text-xs text-asst-faint">{chat.productLabel}</span>
                  <span className="shrink-0 text-xs text-asst-muted">{chat.withWhom}</span>
                  {manage === undefined ? null : (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={open ? editorId : undefined}
                      // The visible words are the same on every row, so the chat's title goes into the name.
                      aria-label={`${manage.change}: ${chat.title}`}
                      onClick={() => manage.onToggle(chat, index)}
                      className="shrink-0 text-xs text-asst-accent underline hover:text-asst-accent-hover"
                    >
                      {manage.change}
                    </button>
                  )}
                </div>
                {open && manage !== undefined ? (
                  <div id={editorId} className="flex flex-col gap-4 border-t border-asst-line pt-3">
                    <InlineEditor id={chat.id} mode={manage.mode} share={manage.share} unshare={manage.unshare} onChange={manage.onChange} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Lists({ chats, sharing, reload }: { chats: SharedChats; sharing: AssistantSharing; reload: () => void }) {
  const [editing, setEditing] = useState<Editing | null>(null);

  function toggle(mode: ShareMode): (chat: SharedChatLink, index: number) => void {
    return (chat, index) => setEditing((was) => (was?.chat.id === chat.id && was.mode === mode ? null : { mode, chat, index }));
  }

  return (
    <>
      <Chats
        label="Chats you have shared"
        chats={chats.given}
        empty="You have not shared any of your chats."
        manage={{
          change: "Change who can read it",
          mode: "read",
          editing,
          onToggle: toggle("read"),
          onChange: reload,
          share: sharing.share,
          unshare: sharing.unshare
        }}
      />
      <Chats label="Chats shared with you" chats={chats.received} empty="Nobody has shared a chat with you." />
      <Chats
        label="Chats you have let people fork"
        chats={chats.offered}
        empty="You have not offered any of your chats to be forked."
        manage={{
          change: "Change who can fork it",
          mode: "fork",
          editing,
          onToggle: toggle("fork"),
          onChange: reload,
          share: sharing.offer,
          unshare: sharing.withdraw
        }}
      />
      <Chats label="Chats you can fork" chats={chats.forkable} empty="Nobody has offered you a chat to fork." />
    </>
  );
}

export function Sharing({ sharing }: { sharing: AssistantSharing }) {
  const { data: chats, failed, reload } = useSettingsData("sharing", sharing.load);
  return (
    <section aria-labelledby="assistant-settings-sharing" aria-busy={chats === undefined && !failed} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h3 id="assistant-settings-sharing" className="text-sm font-semibold">
          Shared chats
        </h3>
        <p className="text-pretty text-[13px] text-asst-muted">
          Only the people you share a chat with can open it. They see the latest messages and the document as they were when they opened the page. They can't
          reply, edit anything, or open files sent in the chat.
        </p>
        <p className="text-pretty text-[13px] text-asst-muted">
          If you let them fork it, they can copy the chat into their own Assistant and carry on there. Your original stays yours.
        </p>
      </div>
      {failed && chats === undefined ? (
        <p className="text-[13px] text-asst-error">Your shared chats could not be read. Close settings and open them again.</p>
      ) : chats === undefined ? (
        <p className="text-[13px] text-asst-muted">Reading your shared chats…</p>
      ) : (
        <Lists chats={chats} sharing={sharing} reload={reload} />
      )}
    </section>
  );
}
