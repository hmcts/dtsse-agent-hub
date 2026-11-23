"use client";

import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { addField, addSection, moveField, moveSection, removeField, removeSection } from "@/bulk-scan/edit";
import { BADGE_WORDS, type Badge, fieldFlags, fieldName, matchesQuery, needsReview, reviewTotal } from "@/bulk-scan/outline";
import { AddButton, FOCUS, Icon, IconButton, type IconName, INPUT } from "@/components/assistant/BulkScanParts";

/** The section, and the field of it, whose details are showing; no field means the section itself. */
export interface Selection {
  section: number;
  field: number | null;
}

const BADGE_CLASS: Record<Badge, string> = {
  mandatory: "border border-asst-accent-line bg-asst-active text-asst-accent-soft",
  optional: "border border-asst-line text-asst-muted",
  conditional: "bg-asst-warn/25 text-asst-text",
  "not-read": "border border-dashed border-asst-line text-asst-muted"
};

function Flag({ icon, label, count }: Readonly<{ icon: IconName; label: string; count?: number }>) {
  return (
    <span role="img" aria-label={label} title={label} className="flex items-center gap-0.5 text-[11px] text-asst-warn">
      <Icon name={icon} className="h-3.5 w-3.5" />
      {count !== undefined && count > 1 ? count : null}
    </span>
  );
}

/**
 * The form as an outline: sections that collapse, and a line per field with what to look at first. Arrow keys move
 * between lines and Enter opens one. `onSpec` takes the changed spec and says whether rows moved, which makes the issues
 * of the last save point at the wrong rows.
 */
export function BulkScanOutline({
  spec,
  selection,
  issues,
  query,
  onlyReview,
  onSelect,
  onSpec,
  onQuery,
  onOnlyReview
}: Readonly<{
  spec: FormSpec;
  selection: Selection | null;
  issues: ReadonlyMap<string, string[]>;
  query: string;
  onlyReview: boolean;
  onSelect: (selection: Selection) => void;
  onSpec: (spec: FormSpec, moved: boolean) => void;
  onQuery: (query: string) => void;
  onOnlyReview: (on: boolean) => void;
}>) {
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const filtering = onlyReview || query.trim() !== "";
  const total = reviewTotal(spec);

  const toggle = (s: number) =>
    setClosed((before) => {
      const next = new Set(before);
      if (!next.delete(s)) {
        next.add(s);
      }
      return next;
    });

  function steer(event: KeyboardEvent<HTMLDivElement>): void {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) {
      return;
    }
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-outline-item]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) {
      return;
    }
    event.preventDefault();
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key] ?? at;
    items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border border-asst-line bg-asst-panel p-3">
      <h2 id={headingId} className="sr-only">
        Outline of the form
      </h2>
      <div className="flex flex-col gap-2">
        <label className="relative block">
          <span className="sr-only">Search fields</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-asst-muted" />
          <input
            type="search"
            value={query}
            placeholder="Search by id, label, key or CCD id"
            className={`${INPUT} w-full pl-8`}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          aria-pressed={onlyReview}
          onClick={() => onOnlyReview(!onlyReview)}
          className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs font-medium ${FOCUS} ${
            onlyReview ? "border-asst-accent-line bg-asst-active text-asst-accent-soft" : "border-asst-line text-asst-text hover:bg-asst-hover"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Icon name="review" className="h-3.5 w-3.5" />
            {`Needs review (${total})`}
          </span>
          <span className="text-asst-muted">{onlyReview ? "Showing only these" : "Show only these"}</span>
        </button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the buttons inside, which are what take focus */}
      <div ref={list} onKeyDown={steer} className="flex flex-col gap-1">
        {spec.sections.map((section, s) => {
          const visible = section.fields
            .map((field, f) => ({ field, f }))
            .filter(({ field }) => matchesQuery(field, query) && (!onlyReview || needsReview(field)));
          if (filtering && visible.length === 0) {
            return null;
          }
          const open = filtering || !closed.has(s);
          const selected = selection?.section === s && selection.field === null;
          const listId = `${headingId}-s${s}`;
          return (
            // A section has no identity but its place in the form, which is what its controls change.
            <div key={s} className="flex flex-col gap-0.5">
              <div className={`group flex items-center gap-1 rounded-lg ${selected ? "bg-asst-active" : ""}`}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-label={`${open ? "Collapse" : "Expand"} section ${s + 1}`}
                  title={`${open ? "Collapse" : "Expand"} section ${s + 1}`}
                  onClick={() => toggle(s)}
                  disabled={filtering}
                  className={`grid h-7 w-6 shrink-0 place-items-center rounded-lg text-asst-muted hover:bg-asst-hover disabled:opacity-40 ${FOCUS}`}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}>
                    <path d="M7 5l6 5-6 5V5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  data-outline-item
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect({ section: s, field: null })}
                  className={`flex min-w-0 flex-1 items-baseline gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] font-semibold text-asst-text hover:bg-asst-hover ${FOCUS}`}
                >
                  <span className="shrink-0 text-asst-muted">{section.id || "–"}</span> <span className="truncate">{section.title || "Untitled section"}</span>{" "}
                  <span className="ml-auto shrink-0 text-[11px] font-normal text-asst-muted">{section.fields.length}</span>
                </button>
                <span className="flex shrink-0 gap-1 pr-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    label={`Add a field to section ${s + 1}`}
                    icon="plus"
                    onClick={() => {
                      onSpec(addField(spec, s), true);
                      onSelect({ section: s, field: section.fields.length });
                    }}
                  />
                  <IconButton
                    label={`Move section ${s + 1} up`}
                    icon="up"
                    disabled={s === 0}
                    onClick={() => {
                      onSpec(moveSection(spec, s, -1), true);
                      onSelect({ section: s - 1, field: selection?.section === s ? selection.field : null });
                    }}
                  />
                  <IconButton
                    label={`Move section ${s + 1} down`}
                    icon="down"
                    disabled={s === spec.sections.length - 1}
                    onClick={() => {
                      onSpec(moveSection(spec, s, 1), true);
                      onSelect({ section: s + 1, field: selection?.section === s ? selection.field : null });
                    }}
                  />
                  <IconButton
                    label={`Remove section ${s + 1}`}
                    icon="remove"
                    onClick={() => {
                      onSpec(removeSection(spec, s), true);
                      onSelect({ section: Math.max(0, Math.min(s, spec.sections.length - 2)), field: null });
                    }}
                  />
                </span>
              </div>
              {open ? (
                <ul id={listId} aria-label={`Fields of section ${s + 1}`} className="flex flex-col gap-0.5 pl-3">
                  {visible.map(({ field, f }) => (
                    <FieldLine
                      key={f}
                      field={field}
                      name={fieldName(field, f)}
                      selected={selection?.section === s && selection.field === f}
                      problems={issues.get(`${s}.${f}`)?.length ?? 0}
                      first={f === 0}
                      last={f === section.fields.length - 1}
                      onSelect={() => onSelect({ section: s, field: f })}
                      onMove={(by) => {
                        onSpec(moveField(spec, s, f, by), true);
                        onSelect({ section: s, field: f + by });
                      }}
                      onRemove={() => {
                        onSpec(removeField(spec, s, f), true);
                        onSelect({ section: s, field: section.fields.length > 1 ? Math.max(0, f - 1) : null });
                      }}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
        {filtering && spec.sections.every((section) => section.fields.every((field) => !matchesQuery(field, query) || (onlyReview && !needsReview(field)))) ? (
          <p role="status" className="px-2 py-3 text-[13px] text-asst-muted">
            No fields match.
          </p>
        ) : null}
      </div>

      <div>
        <AddButton
          label="Add a section"
          text="Add a section"
          onClick={() => {
            onSpec(addSection(spec), true);
            onSelect({ section: spec.sections.length, field: null });
          }}
        />
      </div>
    </section>
  );
}

function FieldLine({
  field,
  name,
  selected,
  problems,
  first,
  last,
  onSelect,
  onMove,
  onRemove
}: Readonly<{
  field: Field;
  name: string;
  selected: boolean;
  problems: number;
  first: boolean;
  last: boolean;
  onSelect: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const flags = fieldFlags(field);
  return (
    <li className={`group flex items-center gap-1 rounded-lg ${selected ? "bg-asst-active" : ""}`}>
      <button
        type="button"
        data-outline-item
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] text-asst-text hover:bg-asst-hover ${FOCUS}`}
      >
        <span className="w-9 shrink-0 truncate font-mono text-xs text-asst-muted">{field.id ?? ""}</span>{" "}
        <span className="min-w-0 flex-1 truncate">{field.label.split("\n")[0] || field.keys[0] || "Untitled field"}</span>{" "}
        <span className="shrink-0 text-[11px] text-asst-muted">{field.inputType}</span>{" "}
        <span className={`shrink-0 rounded-full px-1.5 py-px text-[11px] ${BADGE_CLASS[field.mandatory]}`}>{BADGE_WORDS[field.mandatory]}</span>{" "}
        {flags.review > 0 ? (
          <Flag icon="review" count={flags.review} label={`${flags.review} ${flags.review === 1 ? "review marker" : "review markers"}`} />
        ) : null}
        {flags.todo > 0 ? <Flag icon="todo" count={flags.todo} label={`${flags.todo} ${flags.todo === 1 ? "TODO" : "TODOs"}`} /> : null}
        {flags.english ? <Flag icon="english" label="Unparsed English" /> : null}
        {problems > 0 ? (
          <span role="img" aria-label={`${problems} ${problems === 1 ? "error" : "errors"}`} title={`${problems} errors`} className="text-asst-error">
            <Icon name="error" className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </button>
      {selected ? (
        <span className="flex shrink-0 gap-1 pr-1">
          <IconButton label={`Move ${name} up`} icon="up" disabled={first} onClick={() => onMove(-1)} />
          <IconButton label={`Move ${name} down`} icon="down" disabled={last} onClick={() => onMove(1)} />
          <IconButton label={`Remove ${name}`} icon="remove" onClick={onRemove} />
        </span>
      ) : null}
    </li>
  );
}
