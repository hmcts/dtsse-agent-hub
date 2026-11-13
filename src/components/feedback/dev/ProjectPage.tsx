"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { ProbeOutcome } from "@/feedback/probe";
import type { FeedbackLinkView, FeedbackPerson, FeedbackProjectView } from "@/feedback/store";
import { durationText, recentActivity, reviewersOf, reviewerTimeline, threadCounts } from "@/feedback/team-views";
import type { FeedbackCommentView, FeedbackThreadView } from "@/feedback/thread-store";
import type { ActionResult } from "@/web/action";
import type { FeedbackProjectPageData, FeedbackRecordingRow } from "@/web/feedback-data";
import { CommentsView, type ThreadHandlers } from "./CommentsView";
import { Badge, DANGER, FIELD, isHttpsUrl, LINK, PRIMARY, plural, reviewPath, SECONDARY, when } from "./look";
import { CopyField, call, PeoplePicker, type PickedPerson, useOrigin } from "./parts";

/**
 * One feedback project as its team sees it, in tabs: an overview with the share links, the comments laid out on
 * their pages, the recordings, the people, and the settings, which only the owner is shown. The tab is in the URL
 * (`?tab=`), so a link can open any of them.
 */

export const TABS = ["overview", "comments", "recordings", "people", "settings"] as const;
export type ProjectTab = (typeof TABS)[number];

const TAB_LABELS: Record<ProjectTab, string> = { overview: "Overview", comments: "Comments", recordings: "Recordings", people: "People", settings: "Settings" };

/** The tab `?tab=` names, if the viewer may see it, or the overview. */
export function projectTab(value: unknown, owner: boolean): ProjectTab {
  const tab = TABS.find((t) => t === value) ?? "overview";
  return tab === "settings" && !owner ? "overview" : tab;
}

type Id = { projectId: unknown };

export interface ProjectActions {
  addLink: (input: Id & { link: unknown }) => Promise<ActionResult<{ link: FeedbackLinkView }>>;
  revokeLink: (input: Id & { linkId: unknown }) => Promise<ActionResult>;
  rotateLink: (input: Id & { linkId: unknown }) => Promise<ActionResult<{ link: FeedbackLinkView }>>;
  setMembers: (input: Id & { memberOids: unknown }) => Promise<ActionResult<{ members: FeedbackPerson[] }>>;
  updateSettings: (input: Id & { settings: unknown }) => Promise<ActionResult<{ project: FeedbackProjectView }>>;
  archive: (input: Id) => Promise<ActionResult>;
  reply: (input: Id & { threadId: unknown; body: unknown }) => Promise<ActionResult<{ comment: FeedbackCommentView }>>;
  setStatus: (input: Id & { threadId: unknown; status: unknown }) => Promise<ActionResult<{ thread: FeedbackThreadView }>>;
  probe: (input: { url: unknown }) => Promise<ActionResult<{ probe: ProbeOutcome }>>;
}

/** The reply and resolve a thread card makes, refreshing the page once saved so every view of it agrees. */
export function useThreadHandlers(projectId: string, actions: Pick<ProjectActions, "reply" | "setStatus">): ThreadHandlers {
  const router = useRouter();
  return {
    reply: async (threadId, body) => {
      const result = await call(() => actions.reply({ projectId, threadId, body }));
      if (result.ok) {
        router.refresh();
      }
      return result.ok ? null : result.error;
    },
    status: async (threadId, status) => {
      const result = await call(() => actions.setStatus({ projectId, threadId, status }));
      if (result.ok) {
        router.refresh();
      }
      return result.ok ? null : result.error;
    }
  };
}

export function ProjectPage({
  data,
  tab,
  actions,
  origin: givenOrigin
}: Readonly<{ data: FeedbackProjectPageData; tab: ProjectTab; actions: ProjectActions; origin?: string }>) {
  const { project } = data;
  const owner = project.access === "owner";
  const archived = project.archivedAt !== null;
  const origin = useOrigin(givenOrigin);
  const handlers = useThreadHandlers(project.id, actions);
  const tabs = TABS.filter((t) => t !== "settings" || owner);

  return (
    <div className="flex flex-col gap-5">
      {archived ? (
        <p role="note" className="rounded-lg border-l-4 border-asst-warn bg-asst-field px-4 py-2.5 text-[13px]">
          This project is archived: its links no longer work, and it will be deleted soon.
        </p>
      ) : null}
      <nav aria-label="Project sections">
        <ul className="flex flex-wrap gap-1 border-b border-asst-line">
          {tabs.map((t) => (
            <li key={t}>
              <Link
                href={`/assistant/feedback/${project.id}?tab=${t}`}
                aria-current={t === tab ? "page" : undefined}
                className={`-mb-px inline-flex border-b-2 px-3 py-2 text-[13px] ${t === tab ? "border-asst-accent font-semibold text-asst-text" : "border-transparent text-asst-muted hover:text-asst-text"}`}
              >
                {TAB_LABELS[t]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "overview" ? <Overview data={data} origin={origin} actions={actions} owner={owner && !archived} /> : null}
      {tab === "comments" ? (
        <CommentsView projectId={project.id} threads={data.threads} links={project.links} people={data.people} handlers={handlers} />
      ) : null}
      {tab === "recordings" ? <Recordings projectId={project.id} recordings={data.recordings} links={project.links} /> : null}
      {tab === "people" ? <People data={data} actions={actions} owner={owner && !archived} /> : null}
      {tab === "settings" && owner ? <Settings data={data} actions={actions} origin={origin} /> : null}
    </div>
  );
}

function Overview({ data, origin, actions, owner }: Readonly<{ data: FeedbackProjectPageData; origin: string; actions: ProjectActions; owner: boolean }>) {
  const counts = threadCounts(data.threads);
  const reviewers = reviewersOf(data.threads, data.recordings);
  const activity = recentActivity(data.threads, data.recordings);
  const figures: [string, number][] = [
    ["Open comments", counts.open],
    ["Resolved", counts.resolved],
    ["Not found on the page", counts.detached],
    ["Recordings", data.recordings.length],
    ["Reviewers", reviewers.length]
  ];
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {figures.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-xl border border-asst-line px-3 py-2.5">
            <dt className="text-xs text-asst-faint">{label}</dt>
            <dd className="text-[20px] font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="feedback-links" className="flex flex-col gap-3">
        <h2 id="feedback-links" className="text-[15px] font-semibold">
          Share links
        </h2>
        <LinkList projectId={data.project.id} links={data.project.links} origin={origin} actions={actions} owner={owner} />
      </section>
      <section aria-labelledby="feedback-activity" className="flex flex-col gap-3">
        <h2 id="feedback-activity" className="text-[15px] font-semibold">
          Recent activity
        </h2>
        {activity.length === 0 ? (
          <p className="text-[13px] text-asst-muted">Nothing yet. Send a share link to the people reviewing the prototype.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {activity.map((item) => (
              <li key={`${item.kind} ${"threadId" in item ? item.threadId : item.recordingId} ${item.at}`} className="flex flex-wrap gap-x-2">
                <time dateTime={item.at} className="text-asst-faint">
                  {when(item.at)}
                </time>
                <span>
                  <strong className="font-semibold">{item.who}</strong>{" "}
                  {item.kind === "thread"
                    ? `commented on ${item.pagePath}: “${item.text.slice(0, 120)}”`
                    : item.kind === "reply"
                      ? `replied on ${item.pagePath}: “${item.text.slice(0, 120)}”`
                      : item.kind === "resolved"
                        ? `resolved a comment on ${item.pagePath}`
                        : `recorded ${durationText(item.durationMs)}`}
                </span>
                {item.kind === "recording" ? (
                  <Link href={`/assistant/feedback/${data.project.id}/recordings/${item.recordingId}`} className={LINK}>
                    Play
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Each link's share address, to copy or open, and for the owner the ways to replace or turn off its token. */
function LinkList({
  projectId,
  links,
  origin,
  actions,
  owner
}: Readonly<{ projectId: string; links: readonly FeedbackLinkView[]; origin: string; actions: ProjectActions; owner: boolean }>) {
  const router = useRouter();
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, work: () => Promise<ActionResult>): Promise<void> {
    setBusy(id);
    setError(null);
    const result = await call(work);
    setBusy(null);
    if (!result.ok) {
      setError({ id, message: result.error });
      return;
    }
    router.refresh();
  }

  if (links.length === 0) {
    return <p className="text-[13px] text-asst-muted">This project has no links.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {links.map((link) => (
        <li key={link.id} className="flex flex-col gap-2 rounded-xl border border-asst-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{link.label}</span>
            {link.prototypeVersion === null ? null : <span className="text-xs text-asst-faint">version {link.prototypeVersion}</span>}
            {link.revokedAt === null ? null : <Badge status="failed">turned off</Badge>}
          </div>
          <span className="break-all text-xs text-asst-faint">{link.targetUrl}</span>
          {link.revokedAt === null ? <CopyField label={`Share link for ${link.label}`} value={`${origin}${reviewPath(link.token)}`} openLabel="Open" /> : null}
          {owner && link.revokedAt === null ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={SECONDARY}
                disabled={busy !== null}
                onClick={() => void run(link.id, () => actions.rotateLink({ projectId, linkId: link.id }))}
              >
                <span aria-hidden="true">New share link</span>
                <span className="sr-only">{`New share link for ${link.label}`}</span>
              </button>
              <button
                type="button"
                className={DANGER}
                disabled={busy !== null}
                onClick={() => void run(link.id, () => actions.revokeLink({ projectId, linkId: link.id }))}
              >
                <span aria-hidden="true">Turn off</span>
                <span className="sr-only">{`Turn off ${link.label}`}</span>
              </button>
            </div>
          ) : null}
          {owner && link.revokedAt === null ? (
            <p className="text-xs text-asst-faint">
              A new share link stops the old one working. Turning a link off stops it for everyone and keeps its comments.
            </p>
          ) : null}
          {error?.id === link.id ? (
            <p role="alert" className="text-[13px] text-asst-error">
              {error.message}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Recordings({
  projectId,
  recordings,
  links
}: Readonly<{ projectId: string; recordings: readonly FeedbackRecordingRow[]; links: readonly FeedbackLinkView[] }>) {
  if (recordings.length === 0) {
    return <p className="text-[13px] text-asst-muted">No recordings yet. Reviewers record from the bar above the prototype.</p>;
  }
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      <caption className="sr-only">Recordings</caption>
      <thead>
        <tr className="border-b border-asst-line text-xs text-asst-faint">
          {["Reviewer", "Link", "Started", "Length", "Pages visited", "Comments"].map((heading) => (
            <th key={heading} scope="col" className="py-2 pr-3 font-medium">
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {recordings.map((recording) => (
          <tr key={recording.id} className="border-b border-asst-line">
            <td className="py-2.5 pr-3">
              {recording.status === "ready" ? (
                <Link href={`/assistant/feedback/${projectId}/recordings/${recording.id}`} className={LINK}>
                  <span aria-hidden="true">{recording.author.name}</span>
                  <span className="sr-only">{`Play ${recording.author.name}'s recording from ${when(recording.startedAt)}`}</span>
                </Link>
              ) : (
                recording.author.name
              )}
            </td>
            <td className="py-2.5 pr-3">{links.find((link) => link.id === recording.linkId)?.label ?? ""}</td>
            <td className="py-2.5 pr-3">
              <time dateTime={recording.startedAt}>{when(recording.startedAt)}</time>
            </td>
            <td className="py-2.5 pr-3">
              {recording.status === "ready" ? (
                durationText(recording.durationMs)
              ) : (
                <Badge status={recording.status}>{recording.status === "recording" ? "still recording" : "failed"}</Badge>
              )}
            </td>
            <td className="py-2.5 pr-3">{recording.pages.length === 0 ? "—" : recording.pages.join(", ")}</td>
            <td className="py-2.5">{recording.comments}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function People({ data, actions, owner }: Readonly<{ data: FeedbackProjectPageData; actions: ProjectActions; owner: boolean }>) {
  const { project } = data;
  const reviewers = reviewersOf(data.threads, data.recordings);
  const [person, setPerson] = useState<string | null>(null);
  const timeline = person === null ? [] : reviewerTimeline(person, data.threads, data.recordings);
  const chosen = reviewers.find((reviewer) => reviewer.oid === person);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="feedback-team" className="flex flex-col gap-3">
        <h2 id="feedback-team" className="text-[15px] font-semibold">
          Team
        </h2>
        <ul className="flex flex-col gap-1 text-[13px]">
          <li>
            {project.owner.name} <span className="text-asst-faint">owner</span>
          </li>
          {project.members.map((member) => (
            <li key={member.oid}>{member.name}</li>
          ))}
        </ul>
        {owner ? <MembersEditor projectId={project.id} ownerOid={project.owner.oid} members={project.members} actions={actions} /> : null}
      </section>
      <section aria-labelledby="feedback-reviewers" className="flex flex-col gap-3">
        <h2 id="feedback-reviewers" className="text-[15px] font-semibold">
          Reviewers
        </h2>
        {reviewers.length === 0 ? (
          <p className="text-[13px] text-asst-muted">Nobody has commented or recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {reviewers.map((reviewer) => (
              <li key={reviewer.oid}>
                <button
                  type="button"
                  aria-pressed={person === reviewer.oid}
                  onClick={() => setPerson(person === reviewer.oid ? null : reviewer.oid)}
                  className={`flex w-full flex-wrap gap-x-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${person === reviewer.oid ? "bg-asst-active" : "hover:bg-asst-hover"}`}
                >
                  <span className="font-semibold">{reviewer.name}</span>
                  <span className="text-asst-muted">
                    {plural(reviewer.threads, "comment")} raised · {plural(reviewer.comments, "message")} · {plural(reviewer.recordings, "recording")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {chosen === undefined ? null : (
        <section aria-labelledby="feedback-by-reviewer" className="flex flex-col gap-3">
          <h2 id="feedback-by-reviewer" className="text-[15px] font-semibold">
            By {chosen.name}
          </h2>
          <ol className="flex flex-col gap-2 text-[13px]">
            {timeline.map((item) =>
              item.kind === "thread" ? (
                <li key={`t ${item.thread.id}`} className="flex flex-col gap-0.5 rounded-lg border border-asst-line px-3 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <time dateTime={item.at} className="text-asst-faint">
                      {when(item.at)}
                    </time>
                    <span>{item.thread.pagePath}</span>
                    <Badge status={item.thread.status} />
                  </span>
                  <span className="text-asst-body">{item.thread.comments.find((comment) => comment.author.oid === chosen.oid)?.body}</span>
                </li>
              ) : (
                <li key={`r ${item.recording.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-asst-line px-3 py-2">
                  <time dateTime={item.at} className="text-asst-faint">
                    {when(item.at)}
                  </time>
                  <span>Recording, {durationText(item.recording.durationMs)}</span>
                  {item.recording.status === "ready" ? (
                    <Link href={`/assistant/feedback/${data.project.id}/recordings/${item.recording.id}`} className={LINK}>
                      Play
                    </Link>
                  ) : null}
                </li>
              )
            )}
          </ol>
        </section>
      )}
    </div>
  );
}

function MembersEditor({
  projectId,
  ownerOid,
  members,
  actions
}: Readonly<{ projectId: string; ownerOid: string; members: readonly FeedbackPerson[]; actions: ProjectActions }>) {
  const router = useRouter();
  const [people, setPeople] = useState<PickedPerson[]>([...members]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = people.length !== members.length || people.some((person) => !members.some((member) => member.oid === person.oid));

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const result = await call(() => actions.setMembers({ projectId, memberOids: people.map((person) => person.oid) }));
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setPeople(result.members);
    setMessage({ ok: true, text: "The team is saved." });
    router.refresh();
  }

  return (
    <div className="flex max-w-md flex-col gap-2">
      <PeoplePicker label="Change the team" people={people} onChange={setPeople} exclude={[ownerOid]} disabled={busy} />
      <div>
        <button type="button" className={PRIMARY} disabled={busy || !changed} onClick={() => void save()}>
          Save team
        </button>
      </div>
      <p role={message?.ok === false ? "alert" : "status"} className={`text-[13px] ${message?.ok === false ? "text-asst-error" : "text-asst-ok"}`}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}

function Settings({ data, actions, origin }: Readonly<{ data: FeedbackProjectPageData; actions: ProjectActions; origin: string }>) {
  const { project } = data;
  const router = useRouter();
  const ids = useId();
  const archived = project.archivedAt !== null;
  const [name, setName] = useState(project.name);
  const [mask, setMask] = useState(project.maskInputs);
  const [retention, setRetention] = useState(String(project.retentionDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const result = await call(() =>
      actions.updateSettings({ projectId: project.id, settings: { name: name.trim(), mask_inputs: mask, retention_days: Number(retention) } })
    );
    setBusy(false);
    setMessage(result.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: result.error });
    if (result.ok) {
      router.refresh();
    }
  }

  async function archive(): Promise<void> {
    setBusy(true);
    const result = await call(() => actions.archive({ projectId: project.id }));
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    router.push("/assistant/feedback");
  }

  return (
    <div className="flex flex-col gap-8">
      <form
        method="post"
        className="flex max-w-md flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="text-[15px] font-semibold">Project</h2>
        <div className="flex flex-col gap-1 text-[13px]">
          <label htmlFor={`${ids}-name`}>Name</label>
          <input id={`${ids}-name`} value={name} disabled={archived} onChange={(event) => setName(event.target.value)} className={FIELD} />
        </div>
        <div className="flex items-start gap-2 text-[13px]">
          <input id={`${ids}-mask`} type="checkbox" checked={mask} disabled={archived} onChange={(event) => setMask(event.target.checked)} className="mt-0.5" />
          <label htmlFor={`${ids}-mask`}>Hide what reviewers type in recordings</label>
        </div>
        <div className="flex flex-col gap-1 text-[13px]">
          <label htmlFor={`${ids}-retention`}>Keep comments and recordings for (days)</label>
          <input
            id={`${ids}-retention`}
            type="number"
            min={1}
            max={365}
            value={retention}
            disabled={archived}
            onChange={(event) => setRetention(event.target.value)}
            className={`${FIELD} w-28`}
          />
        </div>
        <div>
          <button type="submit" className={PRIMARY} disabled={busy || archived}>
            Save settings
          </button>
        </div>
        <p role={message?.ok === false ? "alert" : "status"} className={`text-[13px] ${message?.ok === false ? "text-asst-error" : "text-asst-ok"}`}>
          {message?.text ?? ""}
        </p>
      </form>

      <section aria-labelledby={`${ids}-links`} className="flex flex-col gap-3">
        <h2 id={`${ids}-links`} className="text-[15px] font-semibold">
          Links
        </h2>
        <LinkList projectId={project.id} links={project.links} origin={origin} actions={actions} owner={!archived} />
        {archived ? null : <AddLink projectId={project.id} actions={actions} />}
      </section>

      {archived ? null : (
        <section aria-labelledby={`${ids}-archive`} className="flex flex-col gap-2">
          <h2 id={`${ids}-archive`} className="text-[15px] font-semibold">
            Archive
          </h2>
          <p className="text-[13px] text-asst-body">Archiving stops every link at once. The project, its comments and recordings are deleted a week later.</p>
          <div>
            <button type="button" className={DANGER} onClick={() => setConfirming(true)}>
              Archive project
            </button>
          </div>
        </section>
      )}
      {confirming ? <ArchiveDialog name={project.name} busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void archive()} /> : null}
    </div>
  );
}

function ArchiveDialog({ name, busy, onCancel, onConfirm }: Readonly<{ name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }>) {
  const ids = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
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
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-body`}
        className="flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl"
      >
        <h2 id={`${ids}-title`} className="text-lg font-semibold">
          Archive {name}?
        </h2>
        <p id={`${ids}-body`} className="text-[13px] text-asst-body">
          Every share link stops working now, for reviewers and the team. In a week the project, its comments and its recordings are deleted for good.
        </p>
        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" className={SECONDARY} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={DANGER} disabled={busy} onClick={onConfirm}>
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}

function AddLink({ projectId, actions }: Readonly<{ projectId: string; actions: ProjectActions }>) {
  const router = useRouter();
  const ids = useId();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  async function add(): Promise<void> {
    if (label.trim() === "" || !isHttpsUrl(url)) {
      setMessage({ tone: "error", text: "Give the link a label and an address starting https://" });
      return;
    }
    setBusy(true);
    setMessage(null);
    const checked = await call(() => actions.probe({ url: url.trim() }));
    if (checked.ok && checked.probe.result === "refused") {
      setBusy(false);
      setMessage({ tone: "error", text: `This address cannot be used: ${checked.probe.reason}.` });
      return;
    }
    const result = await call(() =>
      actions.addLink({
        projectId,
        link: { label: label.trim(), url: url.trim(), ...(version.trim() === "" ? {} : { prototype_version: version.trim() }) }
      })
    );
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error });
      return;
    }
    setLabel("");
    setUrl("");
    setVersion("");
    setMessage(
      checked.ok && checked.probe.result === "warn"
        ? { tone: "warn", text: `Link added, but the prototype could not be confirmed: ${checked.probe.reason}.` }
        : { tone: "ok", text: "Link added." }
    );
    router.refresh();
  }

  return (
    <form
      method="post"
      className="flex max-w-xl flex-col gap-2 rounded-xl border border-dashed border-asst-line px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <h3 className="text-sm font-semibold">Add a link</h3>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <div className="flex flex-col gap-1 text-[13px]">
          <label htmlFor={`${ids}-label`}>Label</label>
          <input id={`${ids}-label`} value={label} onChange={(event) => setLabel(event.target.value)} className={FIELD} />
        </div>
        <div className="flex flex-col gap-1 text-[13px]">
          <label htmlFor={`${ids}-url`}>Prototype address</label>
          <input id={`${ids}-url`} type="url" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} className={FIELD} />
        </div>
      </div>
      <div className="flex flex-col gap-1 text-[13px]">
        <label htmlFor={`${ids}-version`}>Prototype version (optional)</label>
        <input id={`${ids}-version`} value={version} onChange={(event) => setVersion(event.target.value)} className={`${FIELD} max-w-[240px]`} />
      </div>
      <div>
        <button type="submit" className={PRIMARY} disabled={busy}>
          {busy ? "Adding…" : "Add link"}
        </button>
      </div>
      <p
        role={message?.tone === "error" ? "alert" : "status"}
        className={`text-[13px] ${message?.tone === "error" ? "text-asst-error" : message?.tone === "warn" ? "text-asst-warn" : "text-asst-ok"}`}
      >
        {message?.text ?? ""}
      </p>
    </form>
  );
}
