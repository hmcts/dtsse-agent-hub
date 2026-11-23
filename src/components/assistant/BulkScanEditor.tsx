"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { issuesByField, patchHeader } from "@/bulk-scan/edit";
import type { BulkScanEditorView } from "@/bulk-scan/editor-view";
import { identitiesOf, reconcileIdentities, reviewTotal } from "@/bulk-scan/outline";
import { BulkScanDetail } from "@/components/assistant/BulkScanDetail";
import { BulkScanDownloads } from "@/components/assistant/BulkScanDownloads";
import { BulkScanHeaderCaseType } from "@/components/assistant/BulkScanHeaderCaseType";
import { BulkScanOutline, type Selection } from "@/components/assistant/BulkScanOutline";
import { FOCUS, INPUT, Labelled } from "@/components/assistant/BulkScanParts";
import { BulkScanSimulator } from "@/components/assistant/BulkScanSimulator";
import { BulkScanVersions, type SignOffAction } from "@/components/assistant/BulkScanVersions";
import { noteOwnSave } from "@/components/assistant/ownSave";
import { PRIMARY } from "@/components/assistant/WelshParts";
import { ukDate } from "@/web/format";

const TABS = ["Edit", "Simulate", "Download", "Versions"] as const;
type Tab = (typeof TABS)[number];

const day = (iso: string) => ukDate(new Date(iso));

/** The first thing there is to look at: the first field of the first section that has one, else the first section. */
function firstSelection(spec: FormSpec): Selection | null {
  const s = spec.sections.findIndex((section) => section.fields.length > 0);
  return s >= 0 ? { section: s, field: 0 } : spec.sections.length > 0 ? { section: 0, field: null } : null;
}

type EditorProps = Readonly<{ view: BulkScanEditorView; signOff: SignOffAction; podConversationId?: string | null }>;

/**
 * One spec, started afresh from what was stored whenever the spec or its version changes: by a save, a change of
 * version or another form. `requested` is the version the address asks for, so a change in it is the person moving.
 * A different latest version under the same address is a refresh, which the stream sends when another tab saves, and
 * it never replaces edits that are not saved: they stay on the version they started from, and saving them is refused as
 * a conflict if that is no longer the latest.
 */
export function BulkScanEditor({ view, requested, ...rest }: EditorProps & Readonly<{ requested?: number }>) {
  const [held, setHeld] = useState({ view, requested });
  const unsaved = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => {
    unsaved.current = dirty;
  }, []);
  let shown = view;
  if (held.view !== view) {
    const moved = view.id !== held.view.id || requested !== held.requested;
    if (!unsaved.current || moved || view.version === held.view.version) {
      setHeld({ view, requested });
    } else {
      shown = held.view;
    }
  }
  return <EditorBody key={`${shown.id}:${shown.version}`} view={shown} onDirtyChange={onDirtyChange} {...rest} />;
}

/**
 * The spec's form details, an outline of its fields beside the details of the one chosen, a save that makes the next
 * version, and tabs for the simulator, the downloads and the sign-off, which all work on the version saved.
 */
function EditorBody({ view, signOff, podConversationId = null, onDirtyChange }: EditorProps & Readonly<{ onDirtyChange: (dirty: boolean) => void }>) {
  const router = useRouter();
  const [spec, setSpec] = useState<FormSpec>(view.spec);
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<ReturnType<typeof issuesByField>>({ fields: new Map(), form: [] });
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);
  const fresh = () => `k${counter.current++}`;
  const [ids, setIds] = useState(() => identitiesOf(view.spec, fresh));
  const [selection, setSelection] = useState<Selection | null>(() => firstSelection(view.spec));
  const [query, setQuery] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [tab, setTab] = useState<Tab>("Edit");
  const latest = Math.max(...view.versions.map((v) => v.version));
  const superseded = view.version !== latest;
  const toReview = reviewTotal(spec, problems.fields);
  const current = view.versions.find((v) => v.version === view.version);

  /** The spec as the last change left it, which a change that arrives later (a case type's fields) is made against, not the one rendered when it began. */
  const latestSpec = useRef(spec);

  /** `next` as a function is applied to the latest spec, for a change that arrives after others have been made. */
  function change(next: FormSpec | ((current: FormSpec) => FormSpec), moved = false): void {
    const before = latestSpec.current;
    const made = typeof next === "function" ? next(before) : next;
    latestSpec.current = made;
    setIds((prev) => reconcileIdentities(before, made, prev, fresh));
    setSpec(made);
    setDirty(true);
    if (moved) {
      setProblems({ fields: new Map(), form: problems.form });
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/ui/assistant/bulk-scan/${encodeURIComponent(view.id)}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: view.version, spec })
      });
      const body = (await response.json().catch(() => ({}))) as { version?: unknown; issues?: { path: string; message: string }[]; error?: unknown };
      if (response.ok && typeof body.version === "number") {
        setProblems({ fields: new Map(), form: [] });
        setDirty(false);
        noteOwnSave();
        router.push(`/assistant/bulk-scan/${view.id}`);
        router.refresh();
        return;
      }
      setProblems(issuesByField(body.issues ?? []));
      const marked = (body.issues ?? []).length > 0 ? ", marked in the outline" : "";
      setError(typeof body.error === "string" ? `${body.error}${marked}` : "That did not save. Try again.");
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="@container flex flex-col gap-4">
      <section aria-labelledby="bulk-scan-form" className="flex flex-col gap-3 rounded-xl border border-asst-line bg-asst-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 id="bulk-scan-form" className="text-sm font-semibold">
            Form details
          </h2>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-asst-muted">
            <span>{`Version ${view.version}${current ? `, saved by ${current.savedBy}, ${day(current.savedAt)}` : ""}`}</span>
            {current?.signedOffAt && current.signedOffBy ? (
              <span className="text-asst-ok">{`Signed off by ${current.signedOffBy}, ${day(current.signedOffAt)}`}</span>
            ) : (
              <span>Not signed off</span>
            )}
            {toReview > 0 ? (
              <button
                type="button"
                className={`rounded-full bg-asst-warn/25 px-2.5 py-0.5 font-medium text-asst-text hover:bg-asst-warn/40 ${FOCUS}`}
                onClick={() => {
                  setTab("Edit");
                  setQuery("");
                  setOnlyReview(true);
                }}
              >
                {`${toReview} to review`}
              </button>
            ) : (
              <span>Nothing to review</span>
            )}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 @min-[960px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <Labelled label="Form name">
            <input value={spec.form.name} className={INPUT} onChange={(e) => change(patchHeader(spec, { name: e.target.value }))} />
          </Labelled>
          <Labelled label="Form type (document_sub_type)">
            <input value={spec.form.formType} className={INPUT} onChange={(e) => change(patchHeader(spec, { formType: e.target.value }))} />
          </Labelled>
          <Labelled label="PO box">
            <input value={spec.form.poBox ?? ""} className={INPUT} onChange={(e) => change(patchHeader(spec, { poBox: e.target.value }))} />
          </Labelled>
          <BulkScanHeaderCaseType spec={spec} conversationId={podConversationId} onSpec={change} />
        </div>
      </section>

      <Tabs tab={tab} onTab={setTab} />

      <div role="tabpanel" id="bulk-scan-panel-Edit" aria-labelledby="bulk-scan-tab-Edit" hidden={tab !== "Edit"}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @min-[960px]:grid-cols-[440px_minmax(0,1fr)] @min-[960px]:items-start">
          <div className="max-h-[60dvh] overflow-y-auto rounded-xl @min-[960px]:sticky @min-[960px]:top-3 @min-[960px]:max-h-[calc(100dvh-7rem)]">
            <BulkScanOutline
              spec={spec}
              selection={selection}
              ids={ids}
              reviewCount={toReview}
              issues={problems.fields}
              query={query}
              onlyReview={onlyReview}
              onSelect={setSelection}
              onSpec={change}
              onQuery={setQuery}
              onOnlyReview={setOnlyReview}
            />
          </div>
          <BulkScanDetail spec={spec} ids={ids} selection={selection} issues={problems.fields} onSpec={change} />
        </div>
      </div>

      <div role="tabpanel" id="bulk-scan-panel-Simulate" aria-labelledby="bulk-scan-tab-Simulate" hidden={tab !== "Simulate"}>
        {view.simulatorProblem === null ? (
          <BulkScanSimulator specId={view.id} version={view.version} scenarios={view.scenarios} keys={view.keys} sample={view.sample} />
        ) : (
          <p role="alert" className="text-[13px] text-asst-error">{`The simulator cannot run this version: ${view.simulatorProblem}`}</p>
        )}
      </div>
      <div role="tabpanel" id="bulk-scan-panel-Download" aria-labelledby="bulk-scan-tab-Download" hidden={tab !== "Download"}>
        <BulkScanDownloads specId={view.id} version={view.version} targets={view.targets} />
      </div>
      <div role="tabpanel" id="bulk-scan-panel-Versions" aria-labelledby="bulk-scan-tab-Versions" hidden={tab !== "Versions"}>
        <BulkScanVersions specId={view.id} viewing={view.version} versions={view.versions} signOff={signOff} />
      </div>

      <div className="sticky bottom-0 z-10 -mx-5 flex flex-wrap items-center gap-3 border-t border-asst-line bg-asst-bg px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]" aria-live="polite">
          {superseded ? (
            <span className="text-asst-muted">{`This is not the latest version: open version ${latest} to change it.`}</span>
          ) : dirty ? (
            <span className="font-medium text-asst-text">Unsaved changes</span>
          ) : (
            <span className="text-asst-muted">No changes</span>
          )}
          {dirty && !superseded ? <span className="text-xs text-asst-muted">The simulator and downloads use the saved version.</span> : null}
        </div>
        {error === null && problems.form.length === 0 ? null : (
          <div role="alert" className="text-[13px] text-asst-error">
            {error ? <p>{error}</p> : null}
            {problems.form.length > 0 ? (
              <ul className="list-disc pl-5">
                {problems.form.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <button type="button" className={`${PRIMARY} ${FOCUS}`} disabled={saving || !dirty || superseded} onClick={() => void save()}>
          {saving ? "Saving…" : `Save as version ${latest + 1}`}
        </button>
      </div>
    </div>
  );
}

function Tabs({ tab, onTab }: Readonly<{ tab: Tab; onTab: (tab: Tab) => void }>) {
  function steer(event: KeyboardEvent<HTMLDivElement>): void {
    const at = TABS.indexOf(tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (to === undefined) {
      return;
    }
    event.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length] as Tab;
    onTab(next);
    document.getElementById(`bulk-scan-tab-${next}`)?.focus();
  }
  return (
    <div role="tablist" aria-label="Form views" onKeyDown={steer} className="flex gap-1 border-b border-asst-line">
      {TABS.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          id={`bulk-scan-tab-${name}`}
          aria-selected={tab === name}
          aria-controls={`bulk-scan-panel-${name}`}
          tabIndex={tab === name ? 0 : -1}
          onClick={() => onTab(name)}
          className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] font-medium ${FOCUS} ${
            tab === name ? "border-asst-accent text-asst-text" : "border-transparent text-asst-muted hover:text-asst-text"
          }`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
