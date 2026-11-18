"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { clientSupports, sessionLacks } from "@/agents/client-features";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import type { ArtefactSnapshot } from "@/app/_actions/assistant";
import { MAX_ASKED_BODY } from "@/assistant/deck";
import { type DocumentKind, documentLabel } from "@/assistant/documents";
import { type ExportDefaults, NO_DEFAULTS } from "@/assistant/export-defaults";
import { PRODUCTS, productLabel, storedProduct } from "@/assistant/products";
import type { Template } from "@/assistant/starters";
import {
  backgroundHelpers,
  type Progress,
  progress,
  progressAnnouncement,
  progressLabel,
  type SessionNotice,
  sessionNotice,
  type ThreadItem,
  threadItems
} from "@/assistant/thread";
import type { ConversationView } from "@/assistant/views";
import { useLiveConversation } from "@/components/agents/useLiveConversation";
import { ArtefactPanel, type SaveArtefactAction, type UnsavedDraft } from "@/components/assistant/ArtefactPanel";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { Mark, SidebarToggle } from "@/components/assistant/AssistantShell";
import { ChatMenu } from "@/components/assistant/ChatMenu";
import { Composer } from "@/components/assistant/Composer";
import type { ExportToConfluenceAction } from "@/components/assistant/ConfluenceExport";
import { CreateMenu, type CreateOption } from "@/components/assistant/CreateMenu";
import type { SaveDeckAction, UnsavedDeckDraft } from "@/components/assistant/DeckEditor";
import type { RestoreDeckAction } from "@/components/assistant/DeckHistory";
import { DeckPanel, type SlideAsk } from "@/components/assistant/DeckPanel";
import { DocmosisPanel, type LoadSettled, useTemplateLoad } from "@/components/assistant/DocmosisPanel";
import { ticketsOffered } from "@/components/assistant/ExportFooter";
import { ForkedThread } from "@/components/assistant/ForkedThread";
import type { ExportToGithubAction } from "@/components/assistant/GithubExport";
import { ItemSwitcher, type SwitcherItem } from "@/components/assistant/ItemSwitcher";
import type { ExportToJiraAction, JiraAccess } from "@/components/assistant/JiraExport";
import { ARTEFACT_OVERLAY_MAX_WIDTH } from "@/components/assistant/layout";
import { MessageAttachments } from "@/components/assistant/MessageAttachments";
import { NotifyPanel } from "@/components/assistant/NotifyPanel";
import { VideoPanel } from "@/components/assistant/VideoPanel";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubEvent } from "@/components/live/HubStream";
import { type AnswerQuestionAction, QuestionCard } from "@/components/questions/QuestionCard";
import type { ThreadMessage } from "@/messages/direct-thread";
import { MAX_BODY } from "@/messages/limits";
import type { AgentStatus } from "@/realtime/events";
import type { ActionResult } from "@/web/action";
import { ACTION_UNREACHABLE } from "@/web/action-fault";
import { duration } from "@/web/format";
import { RESTART_IN_SETTINGS } from "@/web/home";

export interface ChatActions {
  send: (input: { conversationId: unknown; body: unknown; uploadIds: unknown }) => Promise<ActionResult<{ message: ThreadMessage }>>;
  warm: (input: { conversationId: unknown }) => Promise<ActionResult>;
  /** `stopped` is false for a press the answer beat, which ends no turn and is told to nobody. */
  stop: (input: { conversationId: unknown }) => Promise<ActionResult<{ stopped: boolean }>>;
  setProduct: (input: { conversationId: unknown; product: unknown }) => Promise<ActionResult>;
  rename: (input: { conversationId: unknown; title: unknown }) => Promise<ActionResult>;
  pin: (input: { conversationId: unknown; pinned: unknown }) => Promise<ActionResult>;
  remove: (input: { conversationId: unknown }) => Promise<ActionResult>;
  /** The person's answer to a question the assistant asked with its own question tool. */
  answerQuestion: AnswerQuestionAction;
  saveArtefact: SaveArtefactAction;
  /** Left out, the document panel offers no Remove. */
  removeArtefact?: (input: { conversationId: unknown; documentId: unknown }) => Promise<ActionResult>;
  exportToJira: ExportToJiraAction;
  /** Left out, a person whose ticket tool is GitHub is offered no ticket export. */
  exportToGithub?: ExportToGithubAction;
  exportToConfluence?: ExportToConfluenceAction;
  /** Left out, the slides panel offers no Remove. */
  removeDeck?: (input: { conversationId: unknown; itemId: unknown }) => Promise<ActionResult>;
  /** Left out, the Docmosis panel offers no Remove. */
  removeDocmosisTemplate?: (input: { conversationId: unknown; itemId: unknown }) => Promise<ActionResult>;
  /** Left out, the Notify panel offers no Remove. */
  removeNotifyTemplate?: (input: { conversationId: unknown; itemId: unknown }) => Promise<ActionResult>;
  /** Left out, the slides panel offers no restore of an older version. */
  restoreDeck?: RestoreDeckAction;
  /** Left out, the slides panel offers no editing. */
  saveDeck?: SaveDeckAction;
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

/**
 * Stops the answer being written. Rendered only where `doing.state` is `working` — the session itself reads `busy` —
 * so the only stop that can find nothing to end is one pressed in the seconds that status is stale. A session still
 * starting, or a message still being sent, has no turn to interrupt and is offered no button.
 *
 * `pressed` is what stands in for the control going away: the thread takes a moment to come back with the stop
 * recorded, and a button that stayed live through it invites a second press at a turn already ending.
 */
function StopButton({ onStop }: { onStop: () => Promise<void> }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      disabled={pressed}
      onClick={() => {
        setPressed(true);
        void onStop().finally(() => setPressed(false));
      }}
      className="flex items-center gap-1.5 rounded-full border border-asst-strong px-2.5 py-1 text-xs text-asst-muted hover:bg-asst-field disabled:opacity-60"
    >
      <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-current" />
      Stop
    </button>
  );
}

/**
 * What happens to a message typed into a local chat whose session is not connected, in the person's own terms.
 *
 * The same promise the hub's own composer makes about an offline agent (`offlineNote`), and the same bound, read from
 * the same constant. It is worded from the delivery's side rather than the session's because that is what the person
 * is deciding about: whether to type now or wait until their laptop is back.
 */
function localOfflineNote(): string {
  return `This chat is a Claude Code session on your own computer, and it is not connected. Your message is kept and delivered when it reconnects, for up to ${duration(EXPIRE_AFTER_SECONDS)} offline.`;
}

/** An edit a closed document could not save, with the document it belongs to. */
type DocumentDraft = UnsavedDraft & { id: string; kind: DocumentKind };

/** The exports of a document not saved yet. */
const NOT_EXPORTED = { status: "none" } as const;

/** What Create's Slides sends, as the person's own message. */
export const CREATE_SLIDES = "Create a new slide deck for this conversation.";

/** How long each warming quip stands before the next, which is a few seconds of a wait that is usually a few more. */
export const QUIP_INTERVAL_MS = 3000;

/** Whether the person has asked their system for less motion, followed as it changes as `useNarrow` follows a resize. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * What is happening to the session behind this chat, above the composer, for the whole of the wait before the person
 * has sent anything, including while a session is being started for them.
 *
 * `aria-hidden`, all of it. The warming words rotate every few seconds and are a decoration over one unchanging
 * fact; a live region here would read a different joke out every few seconds and talk over the person for the length
 * of the wait. The fact itself is announced once by the one region the page already keeps, which carries
 * `notice.announcement` whenever `progress` has nothing of its own to say (WCAG 4.1.3).
 *
 * Under `prefers-reduced-motion` the rotation stops and the first quip stands for the whole wait. The quip is words
 * and stays — there is nothing in reading a sentence for somebody who finds movement painful or distracting — but
 * text that swaps itself out on a timer is movement, and it is also uninterruptible: it cannot be paused, and the
 * person reading slowly is the one it takes the line away from.
 *
 * The rotation itself is deterministic: it starts at the first quip and goes through them in order, so what is on the
 * screen is a function of how long the wait has run and nothing else.
 */
function SessionNote({ notice }: { notice: SessionNotice | null }) {
  const hold = useReducedMotion();
  const [shown, setShown] = useState(0);
  // How many words there are to go through, which `starting` is the only state with more than one of. Both the thing
  // that decides whether anything rotates and, changing, the thing that says this is a different wait from the last.
  const count = notice?.words.length ?? 0;
  useEffect(() => {
    // Back to the first quip, so a later wait does not open part-way through the rotation of the one before it.
    setShown(0);
    if (hold || count < 2) {
      return;
    }
    const rotate = setInterval(() => setShown((at) => at + 1), QUIP_INTERVAL_MS);
    return () => clearInterval(rotate);
  }, [count, hold]);
  if (notice === null) {
    return null;
  }
  return (
    <p aria-hidden="true" className="pb-2 text-center text-[13px] text-asst-muted">
      {notice.words[shown % notice.words.length] ?? notice.words[0]}
    </p>
  );
}

function Item({ item, answerQuestion, repoBase }: { item: ThreadItem; answerQuestion: AnswerQuestionAction; repoBase: string | null }) {
  if (item.type === "question") {
    return (
      <li>
        <QuestionCard view={item.question} answer={answerQuestion} />
      </li>
    );
  }
  if (item.type === "stopped") {
    return (
      <li className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        You stopped this answer
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </li>
    );
  }
  if (item.type === "product") {
    return (
      <li className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        Product changed to {item.label}
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </li>
    );
  }
  // One quiet line per tool call, in a local chat only. Named for a screen reader, since "Bash" beside a path says
  // nothing on its own, and the summary is left to truncate: it is a path or a command, and the start of one is the
  // part that identifies it.
  if (item.type === "tool") {
    return (
      <li className="flex min-w-0 items-baseline gap-2 text-xs text-asst-faint">
        <span className="sr-only">Used</span>
        <span className="shrink-0 font-plex-mono text-asst-muted">{item.name}</span>
        {item.summary === "" ? null : <span className="min-w-0 truncate">{item.summary}</span>}
        {item.failed ? <span className="shrink-0 text-asst-error">failed</span> : null}
      </li>
    );
  }
  if (item.type === "notice") {
    return (
      <li className={`flex min-w-0 items-baseline gap-2 text-xs ${item.failed ? "text-asst-error" : "text-asst-faint"}`}>
        {item.failed ? <span className="shrink-0 font-medium">Failed:</span> : null}
        <span title={item.text} className="min-w-0 truncate">
          {item.text}
        </span>
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
        <MessageAttachments attachments={item.attachments} />
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
        <AssistantMarkdown source={item.text} repoBase={repoBase} />
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
 * works and how many subagents it is waiting on, and the composer; beside it, one of the conversation's documents or
 * other items. The line comes from the session's transcript and its own status, both already streamed here, so no page
 * read follows a tool call. Kept live by the conversation's agent's events;
 * a change to the conversation itself (its product, title, document or session) re-renders the page, which hands
 * down the new `view`.
 */
export function ChatView({
  view,
  templates,
  viewerOid,
  actions,
  jira,
  defaults = NO_DEFAULTS
}: {
  view: ConversationView;
  templates: readonly Template[];
  /** Who is reading, which the composer keys its draft on. */
  viewerOid: string;
  actions: ChatActions;
  /** Whether the person has connected Jira, for the document's export. */
  jira: JiraAccess;
  /** Where the person's documents go by default, which the exports start from. */
  defaults?: ExportDefaults;
}) {
  const router = useRouter();
  const arrivals = useAnnouncer("replies");
  const live = useLiveConversation(view.agentId, view.page, {
    questions: view.questions,
    onReply: () => arrivals.announce("New reply from the assistant")
  });
  const [status, setStatus] = useState<AgentStatus>(view.agentStatus);
  /**
   * What the session's client claims, as the page read it and then as every `agent_status` frame that carries a claim
   * says: one does whenever the claim is written, by a registration or a heartbeat, in the same frame as the status it
   * goes with, so the two change together. A `resync` after a dropped stream re-reads the page, which resets it.
   */
  const [claim, setClaim] = useState<string[] | null>(view.clientFeatures);
  const [pendingProduct, setPendingProduct] = useState<string | null>(null);
  /**
   * The one panel beside the chat: a document, a deck or a template, never two, since two panels beside a chat leave the chat
   * no room to read in. The header's switcher moves between them, so each is two presses from another.
   */
  const [panel, setPanel] = useState<"document" | "deck" | "docmosis" | "notify" | "video" | null>(null);
  /**
   * Which document the document panel shows: one the conversation holds, or one Create opened and nobody has saved
   * yet, whose id the browser makes so that its first save creates it under that id.
   */
  const [openDocument, setOpenDocument] = useState<{ id: string; kind: DocumentKind } | null>(null);
  /** Which deck the slides panel shows. */
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  /** Which Docmosis template the panel shows; `null` is a new one, which the panel's picker makes. */
  const [openDocmosis, setOpenDocmosis] = useState<string | null>(null);
  /** The same for the Notify panel. */
  const [openNotify, setOpenNotify] = useState<string | null>(null);
  // Read by a closed editor's late answer, which comes back through the props of the render that last showed it.
  const panelNow = useRef(panel);
  panelNow.current = panel;
  const openDocmosisNow = useRef(openDocmosis);
  openDocmosisNow.current = openDocmosis;
  const openDocumentNow = useRef(openDocument);
  openDocumentNow.current = openDocument;
  /** The document panel has edits not yet saved, or a conflict showing, which a panel opened in its place would cut short. */
  const documentBusy = useRef(false);
  /** The same for the slides' editor. */
  const deckBusy = useRef(false);
  /** The same for the Docmosis form: edits typed and not yet rendered, or a newer version to settle. */
  const docmosisBusy = useRef(false);
  /** The Docmosis templates the assistant wrote while another panel was busy, which wait behind their rows in the switcher. */
  const [docmosisWaiting, setDocmosisWaiting] = useState<readonly string[]>([]);
  /** The same for the Notify template: a draft not yet saved, or a newer version to settle. */
  const notifyBusy = useRef(false);
  /** The Notify templates the assistant wrote while another panel was busy, which wait behind their rows in the switcher. */
  const [notifyWaiting, setNotifyWaiting] = useState<readonly string[]>([]);
  /** The assistant published a video while another panel was busy, so it waits in the switcher. */
  const [videoWaiting, setVideoWaiting] = useState(false);
  /** The decks the assistant wrote while another panel was busy, which wait behind their rows in the switcher. */
  const [decksWaiting, setDecksWaiting] = useState<readonly string[]>([]);
  /** The documents the assistant wrote while another panel was busy, which wait behind their rows in the switcher. */
  const [documentsWaiting, setDocumentsWaiting] = useState<readonly string[]>([]);
  /**
   * An edit the document was closed on whose save then failed or found a newer version: the document opens again with
   * it, keyed afresh so a panel the person opened meanwhile takes it in too, or, while the slides' editor is busy, it
   * waits behind the document's row in the switcher. The panel that takes it clears it, so it is handed to one panel only.
   */
  const [unsaved, setUnsaved] = useState<{ draft: DocumentDraft | null; key: number }>({ draft: null, key: 0 });
  /** The same for an edit the slides' editor was closed on, with the deck it was of. */
  const [unsavedDeck, setUnsavedDeck] = useState<{ draft: UnsavedDeckDraft | null; deckId: string | null; key: number }>({ draft: null, deckId: null, key: 0 });
  const deckOpen = panel === "deck" ? openDeck : null;
  const decksDraftWaiting = (id: string): boolean => unsavedDeck.draft !== null && unsavedDeck.deckId === id && deckOpen !== id;
  const documentOpen = panel === "document" ? openDocument : null;
  const documentDraftWaiting = unsaved.draft !== null && documentOpen?.id !== unsaved.draft.id;
  const [ask, setAsk] = useState<SlideAsk | null>(null);
  /**
   * How many decks the conversation held when Create asked the assistant for slides, so it waits for the new one
   * rather than asking again. The chat is keyed by conversation, so another conversation starts clear.
   */
  const [slidesAskedAt, setSlidesAskedAt] = useState<number | null>(null);
  const slidesAsked = slidesAskedAt !== null && view.decks.length <= slidesAskedAt;
  const [error, setError] = useState<string | null>(null);
  const warmed = useRef(false);
  const seenVersions = useRef(new Map(view.documents.map((document) => [document.id, document.version])));
  const seenDecks = useRef(new Map(view.decks.map((deck) => [deck.id, deck.version])));
  const seenDocmosis = useRef(new Map(view.docmosisTemplates.map((template) => [template.id, template.version])));
  const seenNotify = useRef(new Map(view.notifyTemplates.map((template) => [template.id, template.version])));
  const deck = view.decks.find((one) => one.id === openDeck);
  const docmosis = view.docmosisTemplates.find((one) => one.id === openDocmosis) ?? null;
  const notify = view.notifyTemplates.find((one) => one.id === openNotify) ?? null;
  const video = view.video;
  const seenVideo = useRef(video?.version ?? 0);
  const narrow = useNarrow();
  const ticketTool = defaults.ticketTool;

  useEffect(() => setStatus(view.agentStatus), [view.agentStatus]);
  useEffect(() => setClaim(view.clientFeatures), [view.clientFeatures]);
  useHubEvent<{ agent_id: string; status: AgentStatus; client_features?: string[] | null }>("agent_status", (frame) => {
    if (frame.agent_id === view.agentId) {
      if (frame.client_features !== undefined) {
        setClaim(frame.client_features);
      }
      setStatus(frame.status);
    }
  });
  // The frame carries the agent id alone, so a question asked, or answered in another tab, is read with the page.
  useHubEvent<{ agent_id: string }>("agent_question", ({ agent_id }) => {
    if (agent_id === view.agentId) {
      router.refresh();
    }
  });

  /**
   * The assistant writing a document opens it, so the person sees what it was asked to draft, unless they are part-way
   * through another panel or another document, when it is announced and its row in the switcher marked instead. Of
   * several written at once, the newest is the one opened.
   */
  useEffect(() => {
    const seen = seenVersions.current;
    const arrived = view.documents.filter((document) => document.version > (seen.get(document.id) ?? 0) && document.updatedBy === "agent");
    for (const document of view.documents) {
      seen.set(document.id, Math.max(seen.get(document.id) ?? 0, document.version));
    }
    const newest = arrived.at(-1);
    if (newest === undefined) {
      return;
    }
    const busyElsewhere =
      (panel === "deck" && deckBusy.current) ||
      (panel === "docmosis" && docmosisBusy.current) ||
      (panel === "notify" && notifyBusy.current) ||
      (panel === "document" && documentBusy.current && openDocument?.id !== newest.id);
    if (busyElsewhere) {
      setDocumentsWaiting((before) => [...before, ...arrived.map((document) => document.id).filter((id) => !before.includes(id))]);
      arrivals.announce(`The assistant updated "${documentLabel(newest.kind, newest.title, ticketTool)}". Open it from Items to see it.`);
    } else {
      setOpenDocument({ id: newest.id, kind: newest.kind });
      setPanel("document");
      arrivals.announce("The assistant updated the document");
    }
  }, [view.documents, arrivals, panel, openDocument, ticketTool]);

  /**
   * The same for a deck: a newer version from the assistant opens the slides in the other panel's place, unless the
   * person is part-way through another panel or another deck, when it is announced and its row in the switcher marked
   * instead. The slides' own editor takes in a newer version of its deck itself, or offers it against the person's edit.
   */
  useEffect(() => {
    const seen = seenDecks.current;
    const arrived = view.decks.filter((one) => one.version > (seen.get(one.id) ?? 0) && one.updatedBy === "agent");
    for (const one of view.decks) {
      seen.set(one.id, Math.max(seen.get(one.id) ?? 0, one.version));
    }
    const newest = arrived.at(-1);
    if (newest === undefined) {
      return;
    }
    if ((panel === "document" && documentBusy.current) || (panel === "docmosis" && docmosisBusy.current) || (panel === "notify" && notifyBusy.current)) {
      setDecksWaiting((before) => [...before, ...arrived.map((one) => one.id).filter((id) => !before.includes(id))]);
      arrivals.announce("The assistant updated the slides. Open them from Items to see them.");
    } else {
      setOpenDeck(newest.id);
      setPanel("deck");
      arrivals.announce("The assistant updated the slides");
    }
  }, [view.decks, arrivals, panel]);

  /**
   * The same for a Docmosis template: a newer version from the assistant opens it in the other panel's place, unless
   * the person is part-way through another panel, when it is announced and its row in the switcher marked instead. The
   * panel itself takes in a newer version, or offers it against what the person has typed. The person's own versions,
   * a template they loaded from the library among them, never open it: they are already looking at it.
   */
  useEffect(() => {
    const seen = seenDocmosis.current;
    const arrived = view.docmosisTemplates.filter((one) => one.version > (seen.get(one.id) ?? 0) && one.updatedBy === "agent");
    for (const one of view.docmosisTemplates) {
      seen.set(one.id, Math.max(seen.get(one.id) ?? 0, one.version));
    }
    const newest = arrived.at(-1);
    if (newest === undefined) {
      return;
    }
    if (
      (panel === "document" && documentBusy.current) ||
      (panel === "deck" && deckBusy.current) ||
      (panel === "notify" && notifyBusy.current) ||
      (panel === "docmosis" && docmosisBusy.current && openDocmosis !== newest.id)
    ) {
      setDocmosisWaiting((before) => [...before, ...arrived.map((one) => one.id).filter((id) => !before.includes(id))]);
      arrivals.announce("The assistant updated the template. Open it from Items to see it.");
    } else {
      setOpenDocmosis(newest.id);
      setPanel("docmosis");
      arrivals.announce("The assistant updated the template");
    }
  }, [view.docmosisTemplates, arrivals, panel, openDocmosis]);

  /** The same for a Notify template, which the assistant loads with `notify pull` or changes with `notify put`. */
  useEffect(() => {
    const seen = seenNotify.current;
    const arrived = view.notifyTemplates.filter((one) => one.version > (seen.get(one.id) ?? 0) && one.updatedBy === "agent");
    for (const one of view.notifyTemplates) {
      seen.set(one.id, Math.max(seen.get(one.id) ?? 0, one.version));
    }
    const newest = arrived.at(-1);
    if (newest === undefined) {
      return;
    }
    if (
      (panel === "document" && documentBusy.current) ||
      (panel === "deck" && deckBusy.current) ||
      (panel === "docmosis" && docmosisBusy.current) ||
      (panel === "notify" && notifyBusy.current && openNotify !== newest.id)
    ) {
      setNotifyWaiting((before) => [...before, ...arrived.map((one) => one.id).filter((id) => !before.includes(id))]);
      arrivals.announce("The assistant updated the Notify template. Open it from Items to see it.");
    } else if (panel !== "notify" || openNotify !== newest.id) {
      setOpenNotify(newest.id);
      setPanel("notify");
      arrivals.announce("The assistant updated the Notify template");
    }
  }, [view.notifyTemplates, arrivals, panel, openNotify]);
  /** The same for the journey video, which the assistant publishes with `video put`. Only the person's own edits are ever busy, and the video has none. */
  const videoVersion = video?.version ?? 0;
  useEffect(() => {
    if (videoVersion > seenVideo.current) {
      if (
        (panel === "document" && documentBusy.current) ||
        (panel === "deck" && deckBusy.current) ||
        (panel === "docmosis" && docmosisBusy.current) ||
        (panel === "notify" && notifyBusy.current)
      ) {
        setVideoWaiting(true);
        arrivals.announce("The assistant published a video. Open it from Items to see it.");
      } else if (panel !== "video") {
        setPanel("video");
        arrivals.announce("The assistant published a video");
      }
    }
    seenVideo.current = Math.max(seenVideo.current, videoVersion);
  }, [videoVersion, arrivals, panel]);
  useEffect(() => {
    if (documentOpen !== null) {
      setDocumentsWaiting((before) => (before.includes(documentOpen.id) ? before.filter((id) => id !== documentOpen.id) : before));
    }
    if (deckOpen !== null) {
      setDecksWaiting((before) => (before.includes(deckOpen) ? before.filter((id) => id !== deckOpen) : before));
    }
    if (panel === "docmosis" && openDocmosis !== null) {
      setDocmosisWaiting((before) => (before.includes(openDocmosis) ? before.filter((id) => id !== openDocmosis) : before));
    }
    if (panel === "video") {
      setVideoWaiting(false);
    }
    if (panel === "notify" && openNotify !== null) {
      setNotifyWaiting((before) => (before.includes(openNotify) ? before.filter((id) => id !== openNotify) : before));
    }
  }, [panel, documentOpen, deckOpen, openDocmosis, openNotify]);
  /**
   * An edit the slides' editor could not save as it closed opens the slides again with it, unless the person is
   * part-way through the document, which keeps the panel: the edit then waits behind the slides' row in the switcher.
   */
  function reopenDeck(draft: UnsavedDeckDraft, deckId: string): void {
    setUnsavedDeck((before) => ({ draft, deckId, key: before.key + 1 }));
    if (
      (panelNow.current === "document" && documentBusy.current) ||
      (panelNow.current === "docmosis" && docmosisBusy.current) ||
      (panelNow.current === "notify" && notifyBusy.current)
    ) {
      arrivals.announce(
        draft.conflict === null
          ? "Your slides could not be saved. Open them from Items to see your changes."
          : "The slides changed while you were editing them. Open them from Items to see your changes."
      );
      return;
    }
    setOpenDeck(deckId);
    setPanel("deck");
    arrivals.announce(
      draft.conflict === null
        ? "Your slides could not be saved, so they are open again"
        : "The slides changed while you were editing them, so they are open again"
    );
  }
  /** The same for a document, which waits behind its row in the switcher while another panel is busy. */
  function reopenDocument(draft: DocumentDraft): void {
    const otherDocumentBusy = panelNow.current === "document" && documentBusy.current && openDocumentNow.current?.id !== draft.id;
    // The key remounts the open document, which would drop what the person is typing in it.
    setUnsaved((before) => ({ draft, key: before.key + (otherDocumentBusy ? 0 : 1) }));
    if (
      otherDocumentBusy ||
      (panelNow.current === "deck" && deckBusy.current) ||
      (panelNow.current === "docmosis" && docmosisBusy.current) ||
      (panelNow.current === "notify" && notifyBusy.current)
    ) {
      arrivals.announce(
        draft.conflict === null
          ? "Your document could not be saved. Open it from Items to see your changes."
          : "The document changed while you were editing it. Open it from Items to see your changes."
      );
      return;
    }
    setOpenDocument({ id: draft.id, kind: draft.kind });
    setPanel("document");
    arrivals.announce(
      draft.conflict === null ? "Your document could not be saved, so it is open again" : "The document changed while you were editing it, so it is open again"
    );
  }

  // The picker can only show a product it offers, so it and the dialog it opens read the stored one through this.
  const product = storedProduct(view.product);
  /**
   * Whether a pod is behind this chat, which is the one question every control that instructs one hangs on: the
   * stop, the attach, the warm on focus and the document's two exports all reach the session through its pod, and
   * there is none for a session on the person's own computer. One reading of `view.local`, so the controls cannot
   * disagree about where the chat is.
   */
  const pod = !view.local;
  /** Opens a new document of `kind`, which its first save creates; the switcher lists the ones already made. */
  function createDocument(kind: DocumentKind): void {
    setOpenDocument({ id: crypto.randomUUID(), kind });
    setPanel("document");
  }
  /**
   * What Create offers: a new item, of any kind, as many times as the person likes; the ones already made are reached
   * through the switcher. A ticket or a Confluence page is a document that goes to that one place, so it is offered only
   * where there is a pod to export it. Slides, a Docmosis template and a Notify template are each made through the pod —
   * the assistant drafts the slides, and the two templates are chosen from libraries the pod reads — so a local chat is
   * offered none of them. Every pod booted on the current hub has the slides tools (`podPlugins`), and the view does
   * not carry the stored plugins an older client would need checking against, so a pod chat is always offered Slides.
   */
  const creatable: CreateOption[] = [
    { key: "document", label: "Document", choose: () => createDocument("document") },
    ...(pod
      ? [
          { key: "ticket", label: ticketTool === "github" ? "GitHub issue" : "Jira backlog", choose: () => createDocument("ticket") },
          { key: "confluence", label: "Confluence page", choose: () => createDocument("confluence") }
        ]
      : []),
    ...(pod
      ? [
          { key: "slides", label: slidesAsked ? "Slides, being made" : "Slides", choose: () => void createSlides() },
          {
            key: "docmosis",
            label: "Docmosis template",
            choose: () => {
              setOpenDocmosis(null);
              setPanel("docmosis");
            }
          },
          {
            key: "notify",
            label: "Notify template",
            choose: () => {
              setOpenNotify(null);
              setPanel("notify");
            }
          }
        ]
      : [])
  ];
  const shownDocument = documentOpen === null ? undefined : view.documents.find((document) => document.id === documentOpen.id);
  const tickets = ticketsOffered(ticketTool, shownDocument?.jira ?? NOT_EXPORTED, shownDocument?.github ?? NOT_EXPORTED);
  const thread = threadItems(live.items, view.productHistory, view.stopHistory, view.local);
  const doing: Progress = progress(live.items, thread, status, view.sessionState, view.local);
  // Not part of `doing`: background work carries on after the session goes idle, so it has to show when nothing else does.
  const background = useMemo(() => (status === "offline" ? 0 : backgroundHelpers(live.items)), [status, live.items]);
  /**
   * What to say about the session behind this chat while there is nothing to say about an answer. `view.local` is the
   * reading `pod` negates, passed on so the rule that a chat with no pod gets none of this is kept where the wording
   * is; `status` rather than `view.agentStatus`, so the line goes the moment the stream says the session is up.
   */
  const notice = sessionNotice(view.sessionState, status, doing, view.local);
  /** The one live region's text. At most one of the two can have anything: `sessionNotice` answers for an idle thread alone. */
  const announced = notice === null ? progressAnnouncement(doing) : notice.announcement;
  /**
   * Both halves of "there is something to stop, and stopping it will work".
   *
   * `working` and not merely "not idle": the waking states are a session still starting or a message still on its
   * way, where there is no turn to interrupt. It also stands in for the staleness of `clientFeatures`, which is
   * written at registration and never cleared — a conversation whose session was idle-reaped still claims `stop`,
   * and only the status says it is not running.
   *
   * The claim itself is the other half. A pod takes the current client when it boots, so a conversation on an older
   * session has no stop until that session is next started; a button there would do nothing, which is worse than
   * the plain wait.
   *
   * Having a pod is the third. The laptop client claims `stop` and means it — it is the same client — but the
   * interrupt is an `assistant_stop` to the conversation's pod, so `stopAnswer` answers `nothing-running` for a
   * conversation that has none. Without this the button would be offered on every local chat and do nothing at all.
   */
  const stoppable = pod && doing.state === "working" && clientSupports(claim, "stop");
  /**
   * A pod session on a client older than `plain-prompt` wraps the person's words in an envelope, and can take them for
   * somebody else's. Only a restart of the assistant gives the session the current client, so that is what is offered.
   */
  const restartNeeded = pod && sessionLacks(claim, status, "plain-prompt");
  const scroller = useStickToBottom<HTMLDivElement>(`${thread.length}:${doing.state}`);
  function markDocumentBusy(busy: boolean): void {
    documentBusy.current = busy;
  }
  function markDeckBusy(busy: boolean): void {
    deckBusy.current = busy;
  }
  function markDocmosisBusy(busy: boolean): void {
    docmosisBusy.current = busy;
  }
  function markNotifyBusy(busy: boolean): void {
    notifyBusy.current = busy;
  }

  /**
   * A load from the template library ended while the panel was closed: the panel opens on its outcome, unless the
   * person is part-way through the document or the slides, when the outcome waits for them to open it.
   */
  function templateLoadSettled(outcome: LoadSettled, item?: string): void {
    if (item !== undefined && outcome === "loaded" && (panelNow.current === "docmosis" || openDocmosisNow.current === null)) {
      setOpenDocmosis(item);
    }
    if (panelNow.current === "docmosis") {
      return;
    }
    if ((panelNow.current === "document" && documentBusy.current) || (panelNow.current === "deck" && deckBusy.current)) {
      if (outcome === "failed") {
        arrivals.announce("Your template did not load. Open it from Items to see why.");
      }
      return;
    }
    setPanel("docmosis");
    if (outcome === "failed") {
      arrivals.announce("Your template did not load");
    }
  }
  const templateLoad = useTemplateLoad({
    conversationId: view.id,
    templates: view.docmosisTemplates,
    target: openDocmosis,
    announce: arrivals.announce,
    onSettled: templateLoadSettled
  });
  // A load's outcome waits in the Docmosis panel, so its row stays in the switcher until the person has seen it.
  const loadFailed = templateLoad.load.phase === "failed";
  /**
   * What the switcher moves between: each item the conversation holds, and the panel that is open, which is one to
   * return to even before its first save.
   */
  const items: SwitcherItem[] = [
    ...documentRows().map(({ id, kind, title }) => ({
      key: `document:${id}`,
      label: documentLabel(kind, title, ticketTool),
      open: () => {
        setOpenDocument({ id, kind });
        setPanel("document");
      },
      waiting: documentsWaiting.includes(id),
      unsaved: documentDraftWaiting && unsaved.draft?.id === id
    })),
    ...view.decks.map((one) => ({
      key: `deck:${one.id}`,
      label: one.title,
      open: () => {
        setOpenDeck(one.id);
        setPanel("deck");
      },
      waiting: decksWaiting.includes(one.id),
      unsaved: decksDraftWaiting(one.id)
    })),
    ...view.docmosisTemplates.map((one) => ({
      key: `docmosis:${one.id}`,
      label: one.name,
      open: () => {
        setOpenDocmosis(one.id);
        setPanel("docmosis");
      },
      waiting: docmosisWaiting.includes(one.id)
    })),
    ...(openDocmosis === null && (panel === "docmosis" || templateLoad.pending || loadFailed)
      ? [
          {
            key: "docmosis:new",
            label: "New Docmosis template",
            open: () => {
              setOpenDocmosis(null);
              setPanel("docmosis");
            },
            failed: loadFailed && panel !== "docmosis"
          }
        ]
      : []),
    ...view.notifyTemplates.map((one) => ({
      key: `notify:${one.id}`,
      label: one.name,
      open: () => {
        setOpenNotify(one.id);
        setPanel("notify");
      },
      waiting: notifyWaiting.includes(one.id)
    })),
    ...(openNotify === null && panel === "notify"
      ? [
          {
            key: "notify:new",
            label: "New Notify template",
            open: () => {
              setOpenNotify(null);
              setPanel("notify");
            }
          }
        ]
      : []),
    ...(video === null ? [] : [{ key: "video", label: "Video", open: () => setPanel("video"), waiting: videoWaiting }])
  ];
  const switcherPanel =
    documentOpen !== null
      ? `document:${documentOpen.id}`
      : panel === "deck"
        ? `deck:${openDeck}`
        : panel === "docmosis" || panel === "notify"
          ? `${panel}:${(panel === "docmosis" ? openDocmosis : openNotify) ?? "new"}`
          : panel;
  const artefact: ArtefactSnapshot = {
    title: shownDocument?.title ?? null,
    markdown: shownDocument?.markdown ?? "",
    version: shownDocument?.version ?? 0,
    updatedBy: shownDocument?.updatedBy ?? null
  };
  /**
   * The documents the switcher lists: every one the conversation holds, and one not saved yet that is open or has an
   * edit waiting, which is one to return to even before its first save.
   */
  function documentRows(): { id: string; kind: DocumentKind; title: string | null }[] {
    const rows: { id: string; kind: DocumentKind; title: string | null }[] = view.documents.map(({ id, kind, title }) => ({ id, kind, title }));
    for (const fresh of [documentOpen, unsaved.draft]) {
      if (fresh !== null && !rows.some((row) => row.id === fresh.id)) {
        rows.push({ id: fresh.id, kind: fresh.kind, title: null });
      }
    }
    return rows;
  }

  async function removeDocument(id: string): Promise<string | null> {
    if (view.documents.some((document) => document.id === id) && actions.removeArtefact !== undefined) {
      const result = await actions.removeArtefact({ conversationId: view.id, documentId: id });
      if (!result.ok) {
        return result.error;
      }
      router.refresh();
    }
    setUnsaved((before) => (before.draft?.id === id ? { draft: null, key: before.key } : before));
    setPanel(null);
    setOpenDocument(null);
    return null;
  }

  async function removeDeck(id: string): Promise<string | null> {
    if (actions.removeDeck !== undefined) {
      const result = await actions.removeDeck({ conversationId: view.id, itemId: id });
      if (!result.ok) {
        return result.error;
      }
      router.refresh();
    }
    setUnsavedDeck((before) => (before.deckId === id ? { draft: null, deckId: null, key: before.key } : before));
    setPanel(null);
    setOpenDeck(null);
    return null;
  }

  async function removeDocmosisTemplate(id: string): Promise<string | null> {
    if (actions.removeDocmosisTemplate !== undefined) {
      const result = await actions.removeDocmosisTemplate({ conversationId: view.id, itemId: id });
      if (!result.ok) {
        return result.error;
      }
      router.refresh();
    }
    setPanel(null);
    setOpenDocmosis(null);
    return null;
  }

  async function removeNotifyTemplate(id: string): Promise<string | null> {
    if (actions.removeNotifyTemplate !== undefined) {
      const result = await actions.removeNotifyTemplate({ conversationId: view.id, itemId: id });
      if (!result.ok) {
        return result.error;
      }
      router.refresh();
    }
    setPanel(null);
    setOpenNotify(null);
    return null;
  }

  async function send(body: string, uploadIds: string[]): Promise<string | null> {
    // A slide the person asked about goes in front of their words, which is the whole of how the session is told. The
    // box holds their words to the room the slide leaves (`limit` below), so the two together never pass `MAX_BODY`.
    const asked = ask === null ? body : `${ask.reference}\n${body}`;
    const result = await actions.send({ conversationId: view.id, body: asked, uploadIds });
    if (!result.ok) {
      return result.error;
    }
    setAsk(null);
    // Someone who scrolled up to re-read and then sent wants to see their message and the reply coming, not stay put.
    scroller.stickNow();
    live.addMessage(result.message);
    return null;
  }

  /** There is no blank deck to edit: slides are drafted by the assistant, so Create asks it to make a new one. */
  async function createSlides(): Promise<void> {
    if (slidesAsked) {
      return;
    }
    setSlidesAskedAt(view.decks.length);
    let problem: string | null;
    try {
      problem = await send(CREATE_SLIDES, []);
    } catch {
      problem = ACTION_UNREACHABLE;
    }
    if (problem !== null) {
      setError(problem);
      setSlidesAskedAt(null);
    }
  }

  async function stop(): Promise<void> {
    const result = await actions.stop({ conversationId: view.id });
    setError(result.ok ? null : result.error);
    // Only for a stop that ended a turn. Said rather than left to the thread's redraw, because the stop is the one
    // thing here a person does and gets no reply to, and the line that records it is a quiet separator a reader is
    // not sent to. A press the answer beat records nothing, so there is nothing to announce either.
    if (result.ok && result.stopped) {
      arrivals.announce("Stopped");
    }
    router.refresh();
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
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 outline-hidden"
            >
              {PRODUCTS.map((offered) => (
                <option key={offered.slug} value={offered.slug} className="bg-asst-raised normal-case">
                  {offered.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <ItemSwitcher items={items} current={switcherPanel} />
            <CreateMenu options={creatable} />
            <ChatMenu
              title={view.title}
              shareHref={`/assistant/${view.id}?share=1`}
              local={view.local}
              forkHref={`/assistant/${view.id}?fork=1`}
              pinned={view.pinned}
              onPin={async (pinned) => {
                const result = await actions.pin({ conversationId: view.id, pinned });
                setError(result.ok ? null : result.error);
                router.refresh();
              }}
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
          <div className="mx-auto flex max-w-[900px] flex-col gap-[26px] px-5 pb-10 pt-7">
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
            {/* Only once the thread reaches its own start, so the copied part never sits above a gap in the copy's own. */}
            {view.forked === null || live.olderBefore !== null ? null : <ForkedThread forked={view.forked} />}
            {live.error === null ? null : (
              <p role="alert" className="self-center text-xs text-asst-error">
                {live.error}
              </p>
            )}
            <ol aria-label="Conversation" className="flex flex-col gap-[26px]">
              {thread.map((item) => (
                <Item key={item.key} item={item} answerQuestion={actions.answerQuestion} repoBase={view.repoBase} />
              ))}
            </ol>
            {doing.state === "idle" ? null : (
              <div className="flex items-center gap-3">
                <Dots doing={doing} />
                {stoppable ? <StopButton onStop={stop} /> : null}
              </div>
            )}
            {background === 0 ? null : (
              <p
                data-testid="background-helpers"
                className="flex items-center gap-2 self-start rounded-full border border-asst-strong px-3 py-1 text-[13px] text-asst-muted"
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 animate-asst-dot rounded-full bg-asst-accent" />
                {background === 1 ? "1 helper working in the background" : `${background} helpers working in the background`}
              </p>
            )}
            {/*
              The one live region on the page, and always in it even with nothing to say: a live region added to the
              document at the same moment as its first text is not reliably announced. Emptying it as the answer
              settles is deliberate too, so the next thing it says is read as new. It carries what the assistant is
              doing or, while it is doing nothing, the state of the session behind the chat — one at a time, because a
              second region beside it would be two things reading themselves out over each other.
            */}
            <p role="status" className="sr-only">
              {announced}
            </p>
          </div>
          <AnnouncerRegion text={arrivals.text} />
        </div>
        <div className="shrink-0 px-4 pb-3.5">
          <div className="mx-auto max-w-[900px]">
            {error === null ? null : (
              <p role="alert" className="pb-2 text-center text-[13px] text-asst-error">
                {error}
              </p>
            )}
            {/*
              The box stays live: a message to a session that is not connected queues as a delivery and is handed to
              it on the stream it opens when it comes back, so there is something to be gained by typing. What it
              cannot do is wait for ever — the sweep expires a delivery to an agent that has been offline that long,
              which for a laptop session is the clock that runs rather than the delivery's own age.
            */}
            {view.local && status === "offline" ? <p className="pb-2 text-center text-[13px] text-asst-muted">{localOfflineNote()}</p> : null}
            {/*
              The same slot as the note above it, and at most one of the two is ever in it: that one is a laptop
              session that is away, this one a pod's session that is not up yet, and `sessionNotice` answers nothing
              for a chat with no pod.
            */}
            <SessionNote notice={notice} />
            {restartNeeded ? (
              <p data-testid="restart-needed" className="pb-2 text-center text-[13px] text-asst-muted">
                This chat is running on an older version of your assistant, which can mistake your messages for someone else's.{" "}
                <Link href={RESTART_IN_SETTINGS} className="text-asst-accent underline hover:text-asst-accent-hover">
                  Restart it in Settings
                </Link>{" "}
                to update it.
              </p>
            ) : null}
            <Composer
              templates={templates}
              viewerOid={viewerOid}
              // The conversation, not its agent: a /clear registers a new agent and remounts the page, and the
              // half-written message belongs to the conversation the person never left.
              draftId={view.id}
              onSend={send}
              conversationId={view.id}
              // Only a pod can be handed a file: see the `local_session` refusal in `src/assistant/uploads.ts`. The
              // control is taken away rather than left to offer something that is then refused.
              attach={pod}
              skills={view.skills}
              reference={ask === null ? undefined : { label: ask.label, onRemove: () => setAsk(null) }}
              limit={ask === null ? MAX_BODY : MAX_ASKED_BODY}
              dropZone={scroller.ref}
              onFocus={() => {
                if (pod && !warmed.current && status === "offline") {
                  warmed.current = true;
                  void actions.warm({ conversationId: view.id });
                }
              }}
            />
          </div>
        </div>
      </div>
      {panel === "deck" && deck !== undefined ? (
        <DeckPanel
          key={`${deck.id}:${unsavedDeck.key}`}
          draft={unsavedDeck.deckId === deck.id ? (unsavedDeck.draft ?? undefined) : undefined}
          onDraftTaken={() => setUnsavedDeck((before) => ({ draft: null, deckId: null, key: before.key }))}
          onUnsaved={(draft) => reopenDeck(draft, deck.id)}
          onRemove={actions.removeDeck === undefined ? undefined : () => removeDeck(deck.id)}
          save={actions.saveDeck}
          onBusy={markDeckBusy}
          conversationId={view.id}
          deck={deck}
          onClose={() => setPanel(null)}
          narrow={narrow}
          announce={arrivals.announce}
          restore={actions.restoreDeck}
          onAsk={(next) => {
            setAsk(next);
            // On a narrow screen the panel covers the chat, so it gives way to the composer the question is typed in.
            if (narrow) {
              setPanel(null);
            }
          }}
        />
      ) : null}
      {panel === "docmosis" ? (
        <DocmosisPanel
          key={openDocmosis ?? "new"}
          conversationId={view.id}
          docmosis={docmosis}
          onRemove={docmosis === null || actions.removeDocmosisTemplate === undefined ? undefined : () => removeDocmosisTemplate(docmosis.id)}
          owner
          loader={pod ? templateLoad : undefined}
          onClose={() => setPanel(null)}
          onBusy={markDocmosisBusy}
          narrow={narrow}
          announce={arrivals.announce}
        />
      ) : null}
      {panel === "notify" ? (
        <NotifyPanel
          key={openNotify ?? "new"}
          onCreated={(id) => setOpenNotify(id)}
          conversationId={view.id}
          notify={notify}
          onRemove={notify === null || actions.removeNotifyTemplate === undefined ? undefined : () => removeNotifyTemplate(notify.id)}
          owner
          canPick={pod}
          onClose={() => setPanel(null)}
          onBusy={markNotifyBusy}
          narrow={narrow}
          announce={arrivals.announce}
        />
      ) : null}
      {panel === "video" && video !== null ? (
        <VideoPanel
          conversationId={view.id}
          video={video}
          canPost={view.canPostVideo}
          onClose={() => setPanel(null)}
          narrow={narrow}
          announce={arrivals.announce}
        />
      ) : null}
      {documentOpen !== null ? (
        <ArtefactPanel
          key={`${documentOpen.id}:${unsaved.key}`}
          draft={unsaved.draft?.id === documentOpen.id ? unsaved.draft : undefined}
          onDraftTaken={() => setUnsaved((before) => ({ draft: null, key: before.key }))}
          onUnsaved={(draft) => reopenDocument({ ...draft, ...documentOpen })}
          onRemove={actions.removeArtefact === undefined ? undefined : () => removeDocument(documentOpen.id)}
          conversationId={view.id}
          documentId={documentOpen.id}
          kind={documentOpen.kind}
          artefact={artefact}
          productLabel={view.productLabel}
          save={actions.saveArtefact}
          onClose={() => setPanel(null)}
          onBusy={markDocumentBusy}
          /*
           * The document itself stays on a local chat — it is a hub row the person and the session both edit, and
           * `saveArtefact` works there — but neither export is offered, which is what `pod` takes away here. An
           * export is carried out by the conversation's session, instructed through `assistantFrame`, and that frame
           * reaches a pod's session alone: `requestJiraExport` would set the status pending, the footer would say
           * "Creating ticket…" until the 15-minute timeout and then report a generic failure, and a retry the same.
           * The panel keeps copy, download and print, which are the ways a document leaves a local chat.
           * `requestJiraExport` and `requestConfluenceExport` refuse it as well, so this is the convenience half.
           */
          // The person's ticket tool, a Jira backlog or a GitHub repository, and the other tool too when the document
          // already has a ticket there (`ticketsOffered`).
          jira={
            pod && tickets.jira
              ? { exported: shownDocument?.jira ?? NOT_EXPORTED, access: jira, exportTo: actions.exportToJira, defaultProject: defaults.jira }
              : undefined
          }
          github={
            pod && tickets.github && actions.exportToGithub !== undefined
              ? {
                  exported: shownDocument?.github ?? NOT_EXPORTED,
                  exportTo: actions.exportToGithub,
                  defaultRepo: defaults.github,
                  defaultProject: defaults.githubProject
                }
              : undefined
          }
          confluence={
            !pod || actions.exportToConfluence === undefined
              ? undefined
              : { exported: shownDocument?.confluence ?? NOT_EXPORTED, access: jira, exportTo: actions.exportToConfluence, defaultPage: defaults.confluence }
          }
          narrow={narrow}
        />
      ) : null}
      {pendingProduct !== null && pendingProduct !== product ? (
        <ConfirmProduct from={product} to={pendingProduct} onCancel={() => setPendingProduct(null)} onConfirm={() => void changeProduct(pendingProduct)} />
      ) : null}
    </div>
  );
}
