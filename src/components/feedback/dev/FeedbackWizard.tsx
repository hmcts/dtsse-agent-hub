"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { ProbeOutcome } from "@/feedback/probe";
import type { FeedbackProjectView } from "@/feedback/store";
import type { ActionResult } from "@/web/action";
import { FIELD, isTargetUrl, LINK, PRIMARY, plural, reviewPath, SECONDARY } from "./look";
import { CopyField, call, PeoplePicker, type PickedPerson, useOrigin } from "./parts";

/**
 * Setting up a feedback project in three steps: the prototype (its name and the links reviewers open), the people and
 * settings, and a last look, after which the share links to send are shown. Nothing is saved until Create, so going
 * back and forth loses nothing, and a refusal there leaves every answer as it was.
 *
 * A link row left wholly blank is dropped rather than refused, so an extra "Add another link" costs nothing, and a
 * link given no label is named after its address.
 *
 * Each link is checked as it is entered (`probeFeedbackLink`): an address no link may point at stops the wizard, and
 * one the hub could not reach just now is a warning the owner can carry on past.
 */

export interface WizardActions {
  probe: (input: { url: unknown }) => Promise<ActionResult<{ probe: ProbeOutcome }>>;
  create: (input: unknown) => Promise<ActionResult<{ project: FeedbackProjectView }>>;
}

interface LinkRow {
  key: number;
  label: string;
  url: string;
  version: string;
  /** The check of `checkedUrl`, which is stale once the URL is edited. */
  probe: ProbeOutcome | "checking" | null;
  checkedUrl: string;
}

const STEPS = ["Prototype", "People and settings", "Check and create"] as const;

/** The step after the last numbered one: the project is made and its links are shown to share. */
const DONE = STEPS.length;

const MAX_NAME = 120;
const MAX_LABEL = 80;
const MAX_VERSION = 100;
export const DEFAULT_RETENTION = 90;

function blankRow(key: number): LinkRow {
  return { key, label: "", url: "", version: "", probe: null, checkedUrl: "" };
}

/** A row with nothing typed in it, which the wizard leaves out rather than refuses. */
export function blank(row: Pick<LinkRow, "label" | "url" | "version">): boolean {
  return row.label.trim() === "" && row.url.trim() === "" && row.version.trim() === "";
}

/** The label a link is saved with: the one given, or its address without the scheme, cut to fit. */
export function labelOf(row: Pick<LinkRow, "label" | "url">): string {
  const given = row.label.trim();
  if (given !== "") {
    return given;
  }
  const bare = row.url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  return bare.length > MAX_LABEL ? `${bare.slice(0, MAX_LABEL - 1)}…` : bare;
}

function rowError(row: LinkRow, allowHttp: boolean): string | null {
  if (row.label.trim().length > MAX_LABEL) {
    return `Keep the label to ${MAX_LABEL} characters`;
  }
  if (!isTargetUrl(row.url, allowHttp)) {
    return "Enter the prototype's address, starting https://";
  }
  if (row.version.trim().length > MAX_VERSION) {
    return `Keep the version to ${MAX_VERSION} characters`;
  }
  return null;
}

function currentProbe(row: LinkRow): ProbeOutcome | "checking" | null {
  return row.checkedUrl === row.url.trim() ? row.probe : null;
}

export function FeedbackWizard({
  actions,
  origin: givenOrigin,
  allowHttp = false
}: Readonly<{ actions: WizardActions; origin?: string; allowHttp?: boolean }>) {
  const origin = useOrigin(givenOrigin);
  const ids = useId();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<LinkRow[]>([blankRow(0)]);
  const nextKey = useRef(1);
  const [people, setPeople] = useState<PickedPerson[]>([]);
  const [maskInputs, setMaskInputs] = useState(false);
  const [retention, setRetention] = useState(String(DEFAULT_RETENTION));
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<FeedbackProjectView | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Focus moves to the new step's heading, so a keyboard or screen reader user is told where they are now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving to a step is the trigger, so the effect keys on the step it does not read
  useEffect(() => {
    if (moved.current) {
      heading.current?.focus();
    }
  }, [step]);

  function go(next: number): void {
    moved.current = true;
    setError(null);
    setWarned(false);
    setStep(next);
  }

  function updateRow(key: number, change: Partial<LinkRow>): void {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  async function probe(row: LinkRow): Promise<ProbeOutcome | null> {
    const url = row.url.trim();
    if (!isTargetUrl(url, allowHttp)) {
      return null;
    }
    const known = currentProbe(row);
    if (known !== null && known !== "checking") {
      return known;
    }
    updateRow(row.key, { probe: "checking", checkedUrl: url });
    const result = await call(() => actions.probe({ url }));
    const outcome: ProbeOutcome = result.ok ? result.probe : { result: "warn", status: null, reason: result.error };
    setRows((current) => current.map((other) => (other.key === row.key && other.checkedUrl === url ? { ...other, probe: outcome } : other)));
    return outcome;
  }

  const filled = rows.filter((row) => !blank(row));

  async function nextFromPrototype(): Promise<void> {
    if (name.trim() === "") {
      setError("Give the project a name");
      return;
    }
    if (name.trim().length > MAX_NAME) {
      setError(`Keep the name to ${MAX_NAME} characters`);
      return;
    }
    if (filled.length === 0) {
      setError("Enter the prototype's address, so reviewers have something to open");
      return;
    }
    const invalid = rows.findIndex((row) => !blank(row) && rowError(row, allowHttp) !== null);
    if (invalid !== -1) {
      setError(`Link ${invalid + 1}: ${rowError(rows[invalid] as LinkRow, allowHttp)}`);
      return;
    }
    setBusy(true);
    setError(null);
    const outcomes = await Promise.all(rows.map((row) => (blank(row) ? Promise.resolve(null) : probe(row))));
    setBusy(false);
    const refused = outcomes.findIndex((outcome) => outcome?.result === "refused");
    if (refused !== -1) {
      setError(`Link ${refused + 1} cannot be used: ${(outcomes[refused] as { reason: string }).reason}.`);
      return;
    }
    const warning = outcomes.findIndex((outcome) => outcome?.result === "warn");
    if (warning !== -1 && !warned) {
      setWarned(true);
      setError(`Link ${warning + 1} may not work: ${(outcomes[warning] as { reason: string }).reason}. Check it, or press Next again to carry on.`);
      return;
    }
    go(1);
  }

  function nextFromTeam(): void {
    const days = Number(retention);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError("Keep comments and recordings for between 1 and 365 days");
      return;
    }
    go(2);
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await call(() =>
      actions.create({
        name: name.trim(),
        links: filled.map((row) => ({
          label: labelOf(row),
          url: row.url.trim(),
          ...(row.version.trim() === "" ? {} : { prototype_version: row.version.trim() })
        })),
        member_oids: people.map((person) => person.oid),
        mask_inputs: maskInputs,
        retention_days: Number(retention)
      })
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated(result.project);
    go(DONE);
  }

  const back =
    step > 0 && step < DONE ? (
      <button type="button" className={SECONDARY} disabled={busy} onClick={() => go(step - 1)}>
        Back
      </button>
    ) : null;

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-5">
      <ol aria-label="Steps" className={`flex flex-wrap gap-x-4 gap-y-1 text-[13px] ${step === DONE ? "hidden" : ""}`}>
        {STEPS.map((title, index) => (
          <li
            key={title}
            aria-current={index === step ? "step" : undefined}
            className={`flex items-center gap-1.5 ${index === step ? "font-semibold text-asst-text" : "text-asst-muted"}`}
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${index < step ? "bg-asst-accent text-asst-ink" : "border border-asst-strong"}`}
            >
              {index < step ? "✓" : index + 1}
            </span>
            <span>
              <span className="sr-only">{index < step ? "Done: " : index === step ? "Current step: " : ""}</span>
              {title}
            </span>
          </li>
        ))}
      </ol>

      <h2 id={`${ids}-title`} ref={heading} tabIndex={-1} className="text-[17px] font-semibold outline-hidden">
        {step === DONE ? "Ready to share" : `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
      </h2>

      {step === 0 ? (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void nextFromPrototype();
          }}
        >
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${ids}-name`}>Project name</label>
            <p id={`${ids}-name-hint`} className="text-xs text-asst-faint">
              What the team will know it by, such as the service and the round of research.
            </p>
            <input
              id={`${ids}-name`}
              value={name}
              maxLength={MAX_NAME + 20}
              aria-describedby={`${ids}-name-hint`}
              aria-invalid={error !== null && (name.trim() === "" || name.trim().length > MAX_NAME)}
              onChange={(event) => setName(event.target.value)}
              className={`${FIELD} max-w-md`}
            />
          </div>
          <p className="text-pretty text-[13px] text-asst-body">
            Paste the address of the prototype reviewers will open. The hub shows it to them with the comment and record tools on top, so the prototype needs no
            changes. Add more than one link if you want a separate share link for each journey.
          </p>
          <ol className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <LinkFields
                key={row.key}
                index={index}
                row={row}
                removable={rows.length > 1}
                onChange={(change) => updateRow(row.key, change)}
                onRemove={() => setRows((current) => current.filter((other) => other.key !== row.key))}
                onCheck={() => void probe(row)}
                allowHttp={allowHttp}
              />
            ))}
          </ol>
          <div>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => {
                setRows((current) => [...current, blankRow(nextKey.current)]);
                nextKey.current += 1;
              }}
            >
              Add another link
            </button>
          </div>
          <Problem error={error} warning={warned} />
          <div className="flex gap-2">
            {back}
            <button type="submit" className={PRIMARY} disabled={busy}>
              {busy ? "Checking the prototype…" : "Next"}
            </button>
          </div>
        </form>
      ) : null}

      {step === 1 ? (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            nextFromTeam();
          }}
        >
          <p className="text-pretty text-[13px] text-asst-body">
            Optional. The team sees every comment and recording, and can reply, resolve and @mention each other. Anyone signed in to the hub who is sent a share
            link can review through it. You can change all of this later.
          </p>
          <div className="max-w-md">
            <PeoplePicker label="Team members" people={people} onChange={setPeople} />
          </div>
          <div className="flex items-start gap-2 text-[13px]">
            <input id={`${ids}-mask`} type="checkbox" checked={maskInputs} onChange={(event) => setMaskInputs(event.target.checked)} className="mt-0.5" />
            <label htmlFor={`${ids}-mask`} className="flex flex-col">
              <span>Hide what reviewers type in recordings</span>
              <span className="text-xs text-asst-faint">Passwords are always hidden. Tick this if reviewers may type real personal details.</span>
            </label>
          </div>
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${ids}-retention`}>Keep comments and recordings for (days)</label>
            <input
              id={`${ids}-retention`}
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
              className={`${FIELD} w-28`}
            />
          </div>
          <Problem error={error} />
          <div className="flex gap-2">
            {back}
            <button type="submit" className={PRIMARY}>
              Next
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-asst-muted">Name</dt>
            <dd>{name.trim()}</dd>
            <dt className="text-asst-muted">Links</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {filled.map((row) => (
                  <li key={row.key}>
                    {labelOf(row)} <span className="text-asst-faint">{row.url.trim()}</span>
                    {row.version.trim() === "" ? null : <span className="text-asst-faint"> · version {row.version.trim()}</span>}
                  </li>
                ))}
              </ul>
            </dd>
            <dt className="text-asst-muted">Team</dt>
            <dd>{people.length === 0 ? "Just you" : people.map((person) => person.name).join(", ")}</dd>
            <dt className="text-asst-muted">Typing in recordings</dt>
            <dd>{maskInputs ? "Hidden" : "Shown, except passwords"}</dd>
            <dt className="text-asst-muted">Kept for</dt>
            <dd>{plural(Number(retention), "day")}</dd>
          </dl>
          <Problem error={error} />
          <div className="flex gap-2">
            {back}
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </div>
      ) : null}

      {step === DONE && created !== null ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-[13px] text-asst-body">
            {created.name} is ready. Send each link to the people reviewing it. They sign in to the hub, and see the prototype with tools to comment on it and
            record what they think as they go.
          </p>
          <ul className="flex flex-col gap-4">
            {created.links.map((link) => (
              <li key={link.id} className="flex flex-col gap-1 rounded-xl border border-asst-line px-4 py-3">
                <span className="text-sm font-semibold">{link.label}</span>
                <span className="break-all text-xs text-asst-faint">{link.targetUrl}</span>
                <CopyField label={`Share link for ${link.label}`} value={`${origin}${reviewPath(link.token)}`} openLabel="Open" />
              </li>
            ))}
          </ul>
          <div>
            <Link href={`/assistant/feedback/${created.id}`} className={PRIMARY}>
              Go to project
            </Link>
          </div>
        </div>
      ) : null}

      {step < DONE ? (
        <p className="text-[13px]">
          <Link href="/assistant/feedback" className={LINK}>
            Cancel
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function Problem({ error, warning = false }: Readonly<{ error: string | null; warning?: boolean }>) {
  return (
    <p role="alert" className={`text-[13px] ${warning ? "text-asst-warn" : "text-asst-error"} ${error === null ? "sr-only" : ""}`}>
      {error ?? ""}
    </p>
  );
}

function LinkFields({
  index,
  row,
  removable,
  onChange,
  onRemove,
  onCheck,
  allowHttp
}: Readonly<{
  index: number;
  row: LinkRow;
  removable: boolean;
  onChange: (change: Partial<LinkRow>) => void;
  onRemove: () => void;
  onCheck: () => void;
  allowHttp: boolean;
}>) {
  const ids = useId();
  const probe = currentProbe(row);
  const n = index + 1;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-asst-line px-4 py-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Link {n}</legend>
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${ids}-label`}>Label (optional)</label>
            <input id={`${ids}-label`} value={row.label} onChange={(event) => onChange({ label: event.target.value })} className={FIELD} />
          </div>
          <div className="flex flex-col gap-1 text-[13px]">
            <label htmlFor={`${ids}-url`}>Prototype address</label>
            <input
              id={`${ids}-url`}
              type="url"
              inputMode="url"
              placeholder="https://"
              value={row.url}
              aria-describedby={`${ids}-probe`}
              onChange={(event) => onChange({ url: event.target.value })}
              onBlur={onCheck}
              className={FIELD}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1 text-[13px]">
          <label htmlFor={`${ids}-version`}>Prototype version (optional)</label>
          <input
            id={`${ids}-version`}
            value={row.version}
            onChange={(event) => onChange({ version: event.target.value })}
            className={`${FIELD} max-w-[240px]`}
          />
        </div>
      </fieldset>
      <p id={`${ids}-probe`} aria-live="polite" className="text-xs">
        <ProbeLine probe={probe} url={row.url} allowHttp={allowHttp} />
      </p>
      {removable ? (
        <div>
          <button type="button" onClick={onRemove} className="rounded-md px-1.5 text-xs text-asst-error hover:bg-asst-field">
            Remove link {n}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ProbeLine({ probe, url, allowHttp }: Readonly<{ probe: ProbeOutcome | "checking" | null; url: string; allowHttp: boolean }>) {
  if (probe === "checking") {
    return <span className="text-asst-muted">Checking the address…</span>;
  }
  if (probe === null) {
    return url.trim() !== "" && !isTargetUrl(url, allowHttp) ? <span className="text-asst-error">The address must start https://</span> : null;
  }
  if (probe.result === "pass") {
    return <span className="text-asst-ok">✓ The prototype answered: {probe.reason}.</span>;
  }
  if (probe.result === "refused") {
    return <span className="text-asst-error">✗ This address cannot be used: {probe.reason}.</span>;
  }
  return <span className="text-asst-warn">! Could not confirm the prototype: {probe.reason}. You can still carry on.</span>;
}
