"use client";

import { dataKey, findPlaceholders, formValues, personalisationSchema, renderLocal, templateAdminUrl } from "@hmcts-cft/notify-tools";
import { BUILT_IN_PRODUCTS, mergeProducts } from "@hmcts-cft/notify-tools/products";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { DocmosisForm, type DocmosisFormHandlers } from "@/components/assistant/DocmosisForm";
import type { JsonObject as FormData, ObjectSchema } from "@/components/assistant/docmosis-data";
import { ARTEFACT_MIN_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import {
  groupTemplates,
  type JsonObject,
  jobFailure,
  type ListedTemplate,
  lineDiff,
  type NotifySummary,
  type NotifyVersionEntry,
  type NotifyView,
  notifySaveUrl,
  notifyUrl,
  notifyVersionsUrl,
  notifyVersionUrl,
  sanitiseHtml,
  showsNotifyPreview,
  TYPE_NAMES
} from "@/components/assistant/notify-data";
import { PodJobRefused, requestPodJob, waitForPodJob } from "@/components/assistant/podJobClient";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubSubscribe } from "@/components/live/HubStream";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";
const field = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text read-only:opacity-70";
const select = "h-[30px] min-w-0 max-w-full shrink rounded-lg border border-asst-strong bg-asst-field px-2 text-[13px] text-asst-text";

/** How long the draft is left alone before what was typed is saved. */
export const SAVE_AFTER_MS = 800;
/** How often a pod that is still waking is asked again, and for how long, past the hub's 30 seconds of grace. */
export const WAKING_RETRY_MS = 3000;
const WAKING_ATTEMPTS = 20;

/** The products a pod can read Notify keys for: the package's own table, as the pod's is. */
const PRODUCTS = mergeProducts([]).filter((product) => BUILT_IN_PRODUCTS.some((built) => built.id === product.id));
const productLabel = (id: string): string => PRODUCTS.find((product) => product.id === id)?.label ?? id;

type JobResult<T> = { ok: true; result: T } | { ok: false; message: string };

/**
 * One pod job from asking to answer. A pod still waking is asked again every `WAKING_RETRY_MS`, which is how the
 * first ask after its first status report goes through; a refusal, a pod that cannot run the kind, and a job that
 * ends in anything but `done` come back as words to show.
 */
async function runPodJob<T>(
  conversationId: string,
  kind: string,
  args: unknown,
  events: ReturnType<typeof useHubSubscribe>,
  signal: AbortSignal
): Promise<JobResult<T>> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      const asked = await requestPodJob(conversationId, kind, args, { signal });
      if (asked.status === "waking") {
        if (attempt + 1 >= WAKING_ATTEMPTS) {
          return { ok: false, message: "Your assistant is still starting. Try again in a moment." };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, WAKING_RETRY_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true }
          );
        });
        continue;
      }
      if (asked.status === "unsupported") {
        return { ok: false, message: "Your assistant cannot read Notify yet. Restart it from the settings to update it, then try again." };
      }
      if (asked.status === "no_pod") {
        return { ok: false, message: "This chat runs on your own computer, so the CFT Workspace cannot read Notify for it." };
      }
      if (asked.status === "assistant_gone") {
        return { ok: false, message: "This chat's assistant has been replaced, so it cannot read Notify for it." };
      }
      const outcome = await waitForPodJob(conversationId, asked.job_id, { signal, events });
      if (outcome.status === "done") {
        return { ok: true, result: outcome.result as T };
      }
      return { ok: false, message: jobFailure(outcome) };
    }
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return { ok: false, message: error instanceof PodJobRefused ? error.message : "Your assistant could not be reached. Try again." };
  }
}

/** The latest version, read when the panel opens, again whenever the page says the version or revision moved on, and on `refresh`. */
function useNotifyView(notify: NotifySummary | null, conversationId: string): { view: NotifyView | null; failed: boolean; refresh: () => void } {
  const itemId = notify?.id ?? null;
  const version = notify?.version ?? 0;
  const revision = notify?.revision ?? 0;
  const [read, setRead] = useState<{ view: NotifyView | null; failed: boolean }>({ view: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version or revision, or another attempt, is what makes the template worth reading again
  useEffect(() => {
    if (itemId === null || (version === 0 && attempt === 0)) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(notifyUrl(conversationId, itemId), { cache: "no-store", signal: controller.signal });
        if (response.status === 404) {
          setRead({ view: null, failed: false });
          return;
        }
        if (!response.ok) {
          throw new Error(`the Notify template read answered ${response.status}`);
        }
        setRead({ view: (await response.json()) as NotifyView, failed: false });
      } catch {
        if (!controller.signal.aborted) {
          setRead((before) => ({ view: before.view, failed: true }));
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, itemId, version, revision, attempt]);
  return { view: read.view, failed: read.failed, refresh: () => setAttempt((count) => count + 1) };
}

function useVersions(conversationId: string, itemId: string | null, version: number): NotifyVersionEntry[] {
  const [versions, setVersions] = useState<NotifyVersionEntry[]>([]);
  useEffect(() => {
    if (itemId === null || version === 0) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(notifyVersionsUrl(conversationId, itemId), { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          setVersions(((await response.json()) as { versions: NotifyVersionEntry[] }).versions);
        }
      } catch {
        // The picker is then the latest alone.
      }
    })();
    return () => controller.abort();
  }, [conversationId, itemId, version]);
  return versions;
}

function useOlderVersion(conversationId: string, itemId: string | null, picked: number | null): { view: NotifyView | null; failed: boolean } {
  const [read, setRead] = useState<{ view: NotifyView | null; failed: boolean; version: number | null }>({ view: null, failed: false, version: null });
  useEffect(() => {
    if (itemId === null || picked === null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(notifyVersionUrl(conversationId, itemId, picked), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`the version read answered ${response.status}`);
        }
        setRead({ view: (await response.json()) as NotifyView, failed: false, version: picked });
      } catch {
        if (!controller.signal.aborted) {
          setRead({ view: null, failed: true, version: picked });
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, itemId, picked]);
  return picked !== null && read.version === picked ? { view: read.view, failed: read.failed } : { view: null, failed: false };
}

type ListState =
  | { state: "idle" }
  | { state: "loading"; product: string }
  | { state: "ready"; product: string; templates: ListedTemplate[]; truncated: boolean }
  | { state: "failed"; product: string; message: string };

/**
 * The product and template picker: a `notify.list` job for the product chosen, a template picked from its list grouped
 * by type, and a `notify.pull` job to load it. The owner's alone, since both jobs run on their pod.
 */
function Picker({
  conversationId,
  itemId,
  initialProduct,
  list,
  onList,
  beforeOpen,
  onLoaded,
  announce
}: {
  conversationId: string;
  /** The template a load replaces, as its next version; `null` makes a new template. */
  itemId: string | null;
  initialProduct: string;
  list: ListState;
  onList: (product: string) => void;
  /** Whether to go on, having set any unsaved draft aside; false when the person would rather keep it. */
  beforeOpen: () => boolean;
  /** The version the load answered and the template it went into, or `null` when it failed. */
  onLoaded: (loaded: { version: number; itemId: string | null } | null) => void;
  announce: (text: string) => void;
}) {
  const [product, setProduct] = useState(initialProduct);
  const [template, setTemplate] = useState("");
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const events = useHubSubscribe("assistant_pod_job");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const templates = list.state === "ready" && list.product === product ? list.templates : [];
  const groups = groupTemplates(templates);

  async function open(): Promise<void> {
    if (!beforeOpen()) {
      return;
    }
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setPulling(true);
    setError(null);
    try {
      const outcome = await runPodJob<{ version: number; item_id?: string }>(
        conversationId,
        "notify.pull",
        { product, template_id: template, ...(itemId === null ? {} : { item_id: itemId }) },
        events,
        own.signal
      );
      if (own.signal.aborted) {
        return;
      }
      onLoaded(outcome.ok ? { version: outcome.result.version, itemId: outcome.result.item_id ?? null } : null);
      if (outcome.ok) {
        announce("The Notify template is loaded");
      } else {
        setError(outcome.message);
        announce("The Notify template could not be loaded");
      }
    } catch {
      // Aborted: the panel went away.
    } finally {
      if (!own.signal.aborted) {
        setPulling(false);
      }
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-asst-field px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="notify-product" className="text-[13px] text-asst-muted">
          Product
        </label>
        <select
          id="notify-product"
          value={product}
          onChange={(event) => {
            setProduct(event.target.value);
            setTemplate("");
            setError(null);
            if (event.target.value !== "") {
              onList(event.target.value);
            }
          }}
          className={select}
        >
          <option value="">Choose a product</option>
          {PRODUCTS.map((offered) => (
            <option key={offered.id} value={offered.id}>
              {offered.label}
            </option>
          ))}
        </select>
        <label htmlFor="notify-template" className="text-[13px] text-asst-muted">
          Template
        </label>
        <select
          id="notify-template"
          value={template}
          disabled={groups.length === 0}
          onChange={(event) => setTemplate(event.target.value)}
          className={`${select} flex-1`}
        >
          <option value="">{list.state === "loading" && list.product === product ? "Loading templates…" : "Choose a template"}</option>
          {groups.map((group) => (
            <optgroup key={group.type} label={group.label}>
              {group.templates.map((listed) => (
                <option key={listed.id} value={listed.id}>
                  {listed.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" onClick={() => void open()} disabled={template === "" || pulling} className={button}>
          {pulling ? "Opening…" : "Open"}
        </button>
      </div>
      {list.state === "failed" && list.product === product ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-asst-error">
          <span className="min-w-0 flex-1">{list.message}</span>
          <button type="button" onClick={() => onList(product)} className={button}>
            Try again
          </button>
        </div>
      ) : null}
      {list.state === "ready" && list.product === product && list.templates.length === 0 ? (
        <p role="status" className="text-[13px] text-asst-muted">
          That product's Notify service has no templates.
        </p>
      ) : null}
      {list.state === "ready" && list.product === product && list.truncated ? (
        <p role="status" className="text-[13px] text-asst-muted">
          Only the first {list.templates.length} templates are listed.
        </p>
      ) : null}
      {error === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-asst-error">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => void open()} className={button}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** HTML in a frame of its own with no scripts, no same-origin access and no forms, after `sanitiseHtml`. */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const clean = useMemo(() => sanitiseHtml(html), [html]);
  return (
    <iframe
      title={title}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={clean}
      className="min-h-[320px] w-full flex-1 rounded-lg border border-asst-field bg-white"
    />
  );
}

function Preview({ view, subject, body, data }: { view: NotifyView; subject: string | null; body: string; data: JsonObject }) {
  const own = showsNotifyPreview(view, subject, body, data);
  const local = useMemo(() => (own ? null : renderLocal(view.type, subject, body, data as never)), [own, view.type, subject, body, data]);
  const shownSubject = own ? view.notify_subject : (local?.subject ?? subject);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
      <p className="text-[12px] text-asst-muted">{own ? "Notify's own preview." : "Approximate: Notify's own preview is authoritative."}</p>
      {shownSubject === null || shownSubject === undefined ? null : (
        <p className="text-[13px]">
          <span className="text-asst-muted">Subject: </span>
          {shownSubject}
        </p>
      )}
      {own ? (
        view.type === "email" ? (
          <HtmlPreview html={view.notify_preview ?? ""} title="Notify's preview" />
        ) : (
          <pre className="whitespace-pre-wrap rounded-lg bg-white p-3 font-sans text-[13px] text-black">{view.notify_preview}</pre>
        )
      ) : local?.html === undefined ? (
        <>
          <pre className="whitespace-pre-wrap rounded-lg bg-white p-3 font-sans text-[13px] text-black">{local?.text ?? ""}</pre>
          {local?.sms === undefined ? null : (
            <p className="text-[12px] text-asst-muted">
              {`${local.sms.characters} characters, ${local.sms.fragments} ${local.sms.fragments === 1 ? "text message" : "text messages"}${local.sms.unicode ? ", sent as Unicode" : ""}`}
            </p>
          )}
        </>
      ) : (
        <HtmlPreview html={local.html} title="Approximate preview" />
      )}
    </div>
  );
}

function Diff({ before, after, label }: { before: string; after: string; label: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  if (before === after) {
    return null;
  }
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-[12px] text-asst-muted">{label}</figcaption>
      <pre className="max-h-60 overflow-auto rounded-lg border border-asst-field p-2 text-[12px]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={line.kind === "added" ? "bg-asst-accent/15" : line.kind === "removed" ? "bg-asst-error/15 line-through decoration-asst-error/60" : ""}
          >
            <span aria-hidden="true">{line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}</span>
            <span className="sr-only">{line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}</span>
            {line.text}
          </div>
        ))}
      </pre>
    </figure>
  );
}

type Draft = { subject: string | null; body: string; data: JsonObject };
type Phase = "idle" | "waiting" | "saving" | "failed" | "rejected" | "conflict";

const sameDraft = (a: Draft, b: Draft): boolean => a.subject === b.subject && a.body === b.body && JSON.stringify(a.data) === JSON.stringify(b.data);
const draftOf = (view: NotifyView): Draft => ({ subject: view.subject, body: view.body, data: view.data });

async function copy(text: string, announce: (text: string) => void, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    announce(`Copied the ${what}`);
  } catch {
    announce(`Could not copy the ${what}`);
  }
}

/** Asks before a template goes: what was copied from it into Notify stays there. */
function ConfirmRemove({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-label="Remove this Notify template?"
      className="flex flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]"
    >
      <span className="min-w-0 flex-1">Remove this Notify template from the chat? Nothing in Notify changes.</span>
      <button ref={cancel} type="button" onClick={onCancel} className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active">
        Cancel
      </button>
      <button type="button" onClick={onConfirm} className="rounded-lg bg-asst-accent px-3 py-1 font-semibold text-asst-ink hover:bg-asst-accent-hover">
        Remove
      </button>
    </div>
  );
}

/**
 * One of the conversation's GOV.UK Notify templates beside the chat, in the Docmosis panel's shell. The owner picks a product
 * and template, which their pod reads from Notify (`notify.list`, `notify.pull`), fills in the personalisation, and
 * edits the subject and body, each saved 800 ms after they stop typing, one save at a time. The preview is Notify's own
 * while the draft is Notify's text with nothing filled in, and an approximate local render otherwise. A reader sees the
 * same, read-only, with no picker. Nothing here changes Notify: the person copies a draft into it.
 */
export function NotifyPanel({
  conversationId,
  notify,
  owner,
  canPick = owner,
  onClose,
  narrow,
  announce,
  onBusy,
  onRemove,
  onCreated,
  embedded = false
}: {
  conversationId: string;
  /** The template the panel shows; `null` for a new one, whose picker makes it. */
  notify: NotifySummary | null;
  owner: boolean;
  /** Whether the owner may load templates from Notify, which is a pod job: not for a chat with no pod. */
  canPick?: boolean;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  onBusy?: (busy: boolean) => void;
  /** Removes the template, answering why it could not be; left out, the panel offers no Remove. */
  onRemove?: () => Promise<string | null>;
  /** A load made no template to replace, so it made a new one: its id. */
  onCreated?: (itemId: string) => void;
  embedded?: boolean;
}) {
  const itemId = notify?.id ?? null;
  const latest = useNotifyView(notify, conversationId);
  const versions = useVersions(conversationId, itemId, notify?.version ?? 0);
  const [picked, setPicked] = useState<number | null>(null);
  const older = useOlderVersion(conversationId, itemId, picked);
  const events = useHubSubscribe("assistant_pod_job");

  const [view, setView] = useState<NotifyView | null>(null);
  const [draft, setDraft] = useState<Draft>({ subject: null, body: "", data: {} });
  const [conflict, setConflict] = useState<NotifyView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [list, setList] = useState<ListState>({ state: "idle" });
  const [saved, setSaved] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** Set once the person has removed the template, so nothing typed is saved back into it. */
  const removed = useRef(false);

  const draftNow = useRef(draft);
  const savedDraft = useRef<Draft>(draft);
  const base = useRef<{ version: number; revision: number } | null>(null);
  const conflictNow = useRef<NotifyView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  // From Open in the picker until the template it loads is taken in: nothing is saved, and what arrives is no conflict.
  const opening = useRef(false);
  const listing = useRef<AbortController | null>(null);
  const listedFor = useRef<string | null>(null);
  const announceNow = useRef(announce);
  announceNow.current = announce;
  const onBusyNow = useRef(onBusy);
  onBusyNow.current = onBusy;

  const dirty = (): boolean => !sameDraft(draftNow.current, savedDraft.current);

  function stopTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function adopt(arrived: NotifyView): void {
    stopTimer();
    const next = draftOf(arrived);
    base.current = { version: arrived.version, revision: arrived.revision };
    draftNow.current = next;
    savedDraft.current = next;
    conflictNow.current = null;
    opening.current = false;
    setView(arrived);
    setDraft(next);
    setConflict(null);
    setPhase("idle");
  }

  // A newer version or revision, or the first read. Taken in unless the person has typed past what they had, which is
  // theirs to settle; the answer to the save in flight is waited for, since the page hears of it first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is read through refs, so only an arrival or a settled save makes this worth running
  useEffect(() => {
    const arrived = latest.view;
    if (arrived === null || inFlight.current) {
      return;
    }
    const current = base.current;
    if (current === null) {
      adopt(arrived);
      return;
    }
    if (arrived.version < current.version || (arrived.version === current.version && arrived.revision <= current.revision)) {
      return;
    }
    if (dirty() && !opening.current && !sameDraft(draftOf(arrived), draftNow.current)) {
      conflictNow.current = arrived;
      stopTimer();
      setConflict(arrived);
      setPhase("conflict");
      announceNow.current(
        arrived.by === "agent" ? "The assistant changed the Notify template while you were editing it" : "The Notify template was changed somewhere else"
      );
      return;
    }
    const replaced = arrived.template_id !== view?.template_id;
    adopt(arrived);
    if (replaced) {
      setMode("preview");
    }
    announceNow.current(arrived.by === "agent" ? "The assistant updated the Notify template" : "The Notify template was updated");
  }, [latest.view, saved]);

  async function send(): Promise<void> {
    const from = base.current;
    if (from === null || itemId === null) {
      return;
    }
    inFlight.current = true;
    queued.current = false;
    setPhase("saving");
    const sent = draftNow.current;
    let response: Response | null = null;
    try {
      response = await fetch(notifySaveUrl(conversationId, itemId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ ...sent, base_version: from.version, base_revision: from.revision })
      });
    } catch {
      response = null;
    }
    inFlight.current = false;
    if (!mounted.current) {
      return;
    }
    if (response?.status === 200) {
      const body = (await response.json().catch(() => null)) as { version: number; revision: number } | null;
      if (body === null) {
        setPhase("failed");
        return;
      }
      base.current = { version: body.version, revision: body.revision };
      savedDraft.current = sent;
      setSaved((count) => count + 1);
      if (queued.current || dirty()) {
        queued.current = false;
        stopTimer();
        void flush();
        return;
      }
      setPhase("idle");
      return;
    }
    if (response?.status === 409) {
      const current = ((await response.json().catch(() => null)) as { current?: NotifyView | null } | null)?.current ?? null;
      if (current === null) {
        setPhase("failed");
        return;
      }
      if (sameDraft(draftOf(current), draftNow.current)) {
        adopt(current);
      } else {
        conflictNow.current = current;
        setConflict(current);
        setPhase("conflict");
        announceNow.current("The Notify template changed while you were editing it");
      }
      setSaved((count) => count + 1);
      return;
    }
    setPhase(response !== null && response.status >= 400 && response.status < 500 ? "rejected" : "failed");
    setSaved((count) => count + 1);
  }

  async function flush(): Promise<void> {
    timer.current = null;
    if (!owner || base.current === null || conflictNow.current !== null || removed.current) {
      return;
    }
    if (opening.current || !dirty()) {
      setPhase("idle");
      return;
    }
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    await send();
  }

  function edited(next: Draft): void {
    draftNow.current = next;
    setDraft(next);
    if (conflictNow.current !== null) {
      return;
    }
    setPhase((before) => (before === "saving" ? before : "waiting"));
    stopTimer();
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  }

  function keepMine(theirs: NotifyView): void {
    base.current = { version: theirs.version, revision: theirs.revision };
    savedDraft.current = draftOf(theirs);
    conflictNow.current = null;
    setView(theirs);
    setConflict(null);
    announceNow.current("Keeping your changes");
    void flush();
  }

  function beforeOpen(): boolean {
    if ((dirty() || conflictNow.current !== null) && !window.confirm("Opening a template discards the changes you have not saved. Open it anyway?")) {
      return false;
    }
    stopTimer();
    draftNow.current = savedDraft.current;
    setDraft(savedDraft.current);
    conflictNow.current = null;
    setConflict(null);
    setPhase((before) => (before === "saving" ? before : "idle"));
    opening.current = true;
    return true;
  }

  function onLoaded(loaded: { version: number; itemId: string | null } | null): void {
    // A failed load, or one that wrote nothing new, brings no version to take in.
    if (loaded === null || (base.current !== null && loaded.version <= base.current.version)) {
      opening.current = false;
    }
    if (loaded?.itemId != null && itemId === null) {
      onCreated?.(loaded.itemId);
    }
    latest.refresh();
  }

  async function remove(): Promise<void> {
    if (onRemove === undefined) {
      return;
    }
    removed.current = true;
    stopTimer();
    const problem = await onRemove().catch(() => "could not remove the Notify template");
    if (problem !== null && mounted.current) {
      removed.current = false;
      setRemoving(false);
      setRemoveError(problem);
    }
  }

  async function listTemplates(product: string): Promise<void> {
    listing.current?.abort();
    const own = new AbortController();
    listing.current = own;
    listedFor.current = product;
    setList({ state: "loading", product });
    try {
      const outcome = await runPodJob<{ templates: ListedTemplate[]; truncated: boolean }>(conversationId, "notify.list", { product }, events, own.signal);
      if (!own.signal.aborted) {
        setList(outcome.ok ? { state: "ready", product, ...outcome.result } : { state: "failed", product, message: outcome.message });
      }
    } catch {
      // Aborted: another product was chosen, or the panel went away.
    }
  }

  // The owner's list of the open template's product, which the picker starts from and the stale banner reads.
  const openProduct = view?.product ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a different product is worth listing again
  useEffect(() => {
    if (owner && canPick && openProduct !== null && listedFor.current !== openProduct) {
      void listTemplates(openProduct);
    }
  }, [owner, canPick, openProduct]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the panel comes and goes
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimer();
      listing.current?.abort();
      onBusyNow.current?.(false);
    };
  }, []);

  const busy = owner && (phase === "waiting" || phase === "saving" || phase === "failed" || phase === "rejected" || phase === "conflict");
  useEffect(() => {
    onBusyNow.current?.(busy);
  }, [busy]);

  function requestClose(): void {
    if (busy && !window.confirm("Your changes are still being saved. Close anyway and lose them?")) {
      return;
    }
    onClose();
  }

  const lookingBack = picked !== null && base.current !== null && picked !== base.current.version;
  const shown = lookingBack ? older.view : view;
  const shownDraft = lookingBack && older.view !== null ? draftOf(older.view) : draft;
  const readOnly = !owner || lookingBack;
  const placeholders = useMemo(() => findPlaceholders(shownDraft.subject, shownDraft.body), [shownDraft.subject, shownDraft.body]);
  const schema = useMemo(() => personalisationSchema(placeholders) as unknown as ObjectSchema, [placeholders]);
  const values = useMemo(() => formValues(placeholders, shownDraft.data as never) as FormData, [placeholders, shownDraft.data]);

  const handlers: DocmosisFormHandlers = {
    set: (path, value) => {
      const [name] = path;
      if (typeof name !== "string") {
        return;
      }
      const data = { ...draftNow.current.data };
      const key = dataKey(data as never, name);
      if (value === undefined || value === "") {
        delete data[key];
      } else {
        data[key] = value;
      }
      edited({ ...draftNow.current, data });
    },
    addRow: () => undefined,
    removeRow: () => undefined
  };

  const listed =
    list.state === "ready" && shown !== null && list.product === shown.product ? list.templates.find((entry) => entry.id === shown.template_id) : undefined;
  const newer = listed !== undefined && shown !== null && listed.version > shown.notify_version ? listed.version : null;
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-notify-width",
    label: "Resize Notify panel",
    initial: 860,
    min: ARTEFACT_MIN_WIDTH,
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });
  const name = shown?.name ?? notify?.name ?? "GOV.UK Notify";
  const changed = shown !== null && (shownDraft.subject !== shown.notify_subject || shownDraft.body !== shown.notify_body);

  return (
    <section
      aria-label="Notify template"
      className={
        embedded
          ? "flex h-full min-h-0 w-full flex-col bg-asst-panel"
          : `z-[25] flex h-full shrink-0 flex-col border-l border-asst-line bg-asst-panel ${narrow ? "fixed inset-0" : "relative"}`
      }
      style={narrow || embedded ? undefined : { width: resize.width }}
    >
      {narrow || embedded ? null : (
        <div
          {...resize.separator}
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-hidden"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-asst-field pl-4 pr-3">
        <span aria-hidden="true" className="shrink-0 font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft">
          Notify
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-asst-text">{name}</h2>
        {onRemove === undefined || notify === null ? null : (
          <button
            type="button"
            onClick={() => setRemoving(true)}
            className="h-8 shrink-0 rounded-lg px-2 text-[13px] text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            Remove
          </button>
        )}
        {embedded ? null : (
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close Notify template"
            className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            ×
          </button>
        )}
      </div>
      {removing ? <ConfirmRemove onCancel={() => setRemoving(false)} onConfirm={() => void remove()} /> : null}
      {removeError === null ? null : (
        <p role="alert" className="border-b border-asst-field px-4 py-2 text-[13px] text-asst-error">
          {removeError}
        </p>
      )}
      {owner && canPick ? (
        <Picker
          key={openProduct ?? ""}
          conversationId={conversationId}
          itemId={itemId}
          initialProduct={openProduct ?? ""}
          list={list}
          onList={(product) => void listTemplates(product)}
          beforeOpen={beforeOpen}
          onLoaded={onLoaded}
          announce={announce}
        />
      ) : null}
      {shown === null ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2 text-[13px]">
          <span className="text-asst-muted">{`${productLabel(shown.product)} · ${TYPE_NAMES[shown.type]} · Notify version ${shown.notify_version}`}</span>
          <label htmlFor="notify-version" className="sr-only">
            Version
          </label>
          <select
            id="notify-version"
            value={lookingBack ? (picked ?? "") : (base.current?.version ?? shown.version)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setPicked(next === base.current?.version ? null : next);
            }}
            className={select}
          >
            {(versions.length === 0 ? [{ version: shown.version, by: shown.by, summary: shown.summary }] : versions).map((entry) => (
              <option key={entry.version} value={entry.version}>
                {`Version ${entry.version}, by ${entry.by === "agent" ? "assistant" : owner ? "you" : "the owner"}${entry.summary === null ? "" : `: ${entry.summary}`}`}
              </option>
            ))}
          </select>
          <span role="status" className="min-w-0 flex-1 truncate text-asst-muted">
            {lookingBack ? "" : statusLine(phase, owner)}
          </span>
          <a href={templateAdminUrl(shown.service_id, shown.template_id)} target="_blank" rel="noopener noreferrer" className={`${button} no-underline`}>
            Open in Notify
          </a>
        </div>
      )}
      {newer === null || shown === null ? null : (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">{`Notify has a newer version of this template (version ${newer}) than this draft was taken from (version ${shown.notify_version}).`}</span>
        </div>
      )}
      {lookingBack ? (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {older.failed ? `Couldn't load version ${picked}.` : `Version ${picked} is not the latest, so it can't be edited.`}
          </span>
          <button type="button" onClick={() => setPicked(null)} className={button}>
            Back to the latest
          </button>
        </div>
      ) : null}
      {conflict === null ? null : (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {conflict.by === "agent" ? "The assistant has changed this Notify template." : "This Notify template was changed somewhere else."} Use that version,
            or keep what you have typed.
          </span>
          <button
            type="button"
            onClick={() => {
              adopt(conflict);
              announce("Using the newer version");
            }}
            className={button}
          >
            Use the newer version
          </button>
          <button type="button" onClick={() => keepMine(conflict)} className={button}>
            Keep my changes
          </button>
        </div>
      )}
      {(phase === "failed" || phase === "rejected") && owner ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2.5 text-[13px] text-asst-error">
          <span className="min-w-0 flex-1">
            {phase === "failed"
              ? "Your changes could not be saved."
              : "The hub turned your changes down, so retrying will not help. Shorten the text and try again."}
          </span>
          {phase === "failed" ? (
            <button type="button" onClick={() => void flush()} className={button}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {shown === null ? (
        notify === null && latest.view === null ? (
          <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
            {owner && canPick ? "Choose a product and one of its templates to work on it here." : "This chat has no Notify template."}
          </p>
        ) : latest.failed ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-4 py-5 text-[13px] text-asst-error">
            Could not load the Notify template.
            <button type="button" onClick={latest.refresh} className={button}>
              Try again
            </button>
          </div>
        ) : (
          <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
            {lookingBack ? `Loading version ${picked}…` : "Loading the Notify template…"}
          </p>
        )
      ) : (
        <div className="@container flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col @[640px]:flex-row">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-b border-asst-field px-4 py-3 @[640px]:max-w-[45%] @[640px]:border-b-0 @[640px]:border-r">
              {readOnly ? null : (
                <div role="tablist" aria-label="Notify template view" className="flex gap-1.5">
                  {(["preview", "edit"] as const).map((each) => (
                    <button
                      key={each}
                      type="button"
                      role="tab"
                      aria-selected={mode === each}
                      onClick={() => setMode(each)}
                      className={`${button} ${mode === each ? "border-asst-accent bg-asst-field" : ""}`}
                    >
                      {each === "preview" ? "Personalise" : "Edit"}
                    </button>
                  ))}
                </div>
              )}
              {mode === "edit" && !readOnly ? (
                <Editor view={shown} draft={draft} changed={changed} onChange={(next) => edited({ ...draftNow.current, ...next })} announce={announce} />
              ) : (
                <DocmosisForm schema={schema} data={values} issues={new Map()} readOnly={readOnly} handlers={handlers} />
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <Preview view={shown} subject={shownDraft.subject} body={shownDraft.body} data={shownDraft.data} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Editor({
  view,
  draft,
  changed,
  onChange,
  announce
}: {
  view: NotifyView;
  draft: Draft;
  changed: boolean;
  onChange: (next: Partial<Draft>) => void;
  announce: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {draft.subject === null ? null : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <label htmlFor="notify-subject" className="flex-1 text-[13px] font-medium">
              Subject
            </label>
            <button type="button" onClick={() => void copy(draft.subject ?? "", announce, "subject")} className={button}>
              Copy subject
            </button>
          </div>
          <textarea id="notify-subject" rows={2} value={draft.subject} onChange={(event) => onChange({ subject: event.target.value })} className={field} />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <label htmlFor="notify-body" className="flex-1 text-[13px] font-medium">
            {view.type === "sms" ? "Message" : "Body"}
          </label>
          <button type="button" onClick={() => void copy(draft.body, announce, "body")} className={button}>
            Copy body
          </button>
        </div>
        <textarea
          id="notify-body"
          rows={14}
          value={draft.body}
          onChange={(event) => onChange({ body: event.target.value })}
          className={`${field} font-plex-mono text-[12px]`}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            onChange({ subject: view.notify_subject, body: view.notify_body });
            announce("Reverted to Notify's text");
          }}
          className={button}
        >
          Revert to Notify's text
        </button>
      </div>
      {draft.subject === null || view.notify_subject === null ? null : (
        <Diff before={view.notify_subject} after={draft.subject} label={`Subject, changed from Notify version ${view.notify_version}`} />
      )}
      <Diff
        before={view.notify_body}
        after={draft.body}
        label={`${view.type === "sms" ? "Message" : "Body"}, changed from Notify version ${view.notify_version}`}
      />
    </div>
  );
}

function statusLine(phase: Phase, owner: boolean): string {
  switch (phase) {
    case "waiting":
      return "Changes not yet saved";
    case "saving":
      return "Saving…";
    case "failed":
    case "rejected":
    case "conflict":
      return "";
    default:
      return owner ? "Saved" : "";
  }
}

/** The Notify template on a shared chat's page, read-only, in a box of its own. */
export function SharedNotify({ conversationId, notify }: { conversationId: string; notify: NotifySummary }) {
  const template = useAnnouncer("Notify template");
  return (
    <div className="h-[min(640px,80vh)] overflow-hidden rounded-2xl border border-asst-line">
      <NotifyPanel
        conversationId={conversationId}
        notify={notify}
        owner={false}
        narrow={false}
        announce={template.announce}
        onClose={() => undefined}
        embedded
      />
      <AnnouncerRegion text={template.text} />
    </div>
  );
}
