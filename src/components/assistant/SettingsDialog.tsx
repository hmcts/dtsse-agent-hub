"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ConnectionsData, checklistState, connections, connectionsWarning, inWords, microsoftConnection, modelAccess } from "@/assistant/connections";
import { memoryPressure, memoryWarning, restartQuestion } from "@/assistant/memory-report";
import type { AssistantPluginsData } from "@/assistant/settings";
import { pluginChoices } from "@/assistant/settings";
import { type Theme, themeOf } from "@/assistant/theme";
import type { FormAction } from "@/components/ActionForm";
import { AgentSettings, type AssistantAgentSettings } from "@/components/assistant/AgentSettings";
import { type AssistantClaudeMd, ClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import { type AssistantConnect, type AssistantTokens, Connections, type ConnectionsView, hasConnections } from "@/components/assistant/ConnectionSettings";
import { type AssistantExportDefaults, ExportSettings } from "@/components/assistant/ExportSettings";
import { type AssistantFiles, Files } from "@/components/assistant/FileSettings";
import { type AssistantGitIdentity, GitIdentity } from "@/components/assistant/GitIdentitySettings";
import { SETTINGS_TWO_PANE_MIN_WIDTH } from "@/components/assistant/layout";
import type { AssistantModelSetting } from "@/components/assistant/ModelSettings";
import { PortSettings } from "@/components/assistant/PortSettings";
import { type AssistantSharing, Sharing } from "@/components/assistant/SharingSettings";
import type { AssistantSize } from "@/components/assistant/SizeSettings";
import { type AssistantTemplates, Templates } from "@/components/assistant/TemplateSettings";
import { keepTheme, showTheme, ThemeChoice } from "@/components/assistant/ThemeSwitch";
import { useFocusOnMount } from "@/components/assistant/useFocusOnMount";
import {
  type DraftKey,
  type DraftStore,
  SettingsDrafts,
  type SettingsDraftsContext,
  useDraftStore,
  useSettingsDraft,
  type Values
} from "@/components/assistant/useSettingsDraft";
import { useEndSession } from "@/components/live/HubStream";
import { sessionEnded } from "@/components/live/session";
import type { ModelRoute } from "@/viewer/identity";
import type { ActionResult } from "@/web/action";
import { SETTINGS_PARAMETER, withoutSettingsParameter } from "@/web/home";

export type { AssistantConnect } from "@/components/assistant/ConnectionSettings";

/** The plugins the dialog shows, with the action its Save sends a change to, `saveVirtualAgentPod`. */
export type AssistantPlugins = AssistantPluginsData & { save: FormAction };

interface SettingsView extends ConnectionsView {
  theme: Theme;
  plugins: AssistantPlugins | undefined;
  model: AssistantModelSetting | undefined;
  claudeMd: AssistantClaudeMd | undefined;
  templates: AssistantTemplates | undefined;
  files: AssistantFiles | undefined;
  size: AssistantSize | undefined;
  exports: AssistantExportDefaults | undefined;
  sharing: AssistantSharing | undefined;
  agent: AssistantAgentSettings | undefined;
  git: AssistantGitIdentity | undefined;
}

/**
 * Everything in the dialog a Tab can reach, and so everything its focus trap has to account for. Exported so a test
 * asks the dialog which its own tab stops are rather than keeping a second copy of this list, which would pass while
 * a control the trap has been left out of still takes focus off the end of it.
 *
 * `tabindex="-1"` is excluded from every clause, not only the last, so that what this matches is what Tab can reach:
 * the navigation is a roving tabindex, and all but one of its buttons are deliberately not tab stops. The trap below
 * reads only the two ends of the list and those are the close button and the open section's last control either way,
 * with the navigation between them — so this is about the constant meaning what it says, not about fixing the wrap.
 * A hidden input is left out for the same reason: Tab never lands on one, and a form posting a hidden field (Microsoft
 * 365's Connect) would otherwise be counted as a stop.
 */
export const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]"
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(", ");

/**
 * Where the dialog has room for its navigation beside a section: the Tailwind `sm` breakpoint, which is where the
 * dialog's own `sm:` classes switch.
 *
 * Asked as the `min-width` Tailwind itself asks, rather than as a `max-width` one pixel below it like the sidebar's
 * and the document panel's queries: a fractional viewport in between — a zoomed page, a scaled display — would
 * otherwise lay out one pane inside a box the CSS had already widened for two.
 */
const SETTINGS_TWO_PANE = `(min-width: ${SETTINGS_TWO_PANE_MIN_WIDTH}px)`;

/**
 * Eight teeth around a hub, every vertex on one of two radii about (10, 10) — 7.5 at a tooth tip, 5.6 at a root — so
 * the outline is concentric with the hub circle and the whole glyph is square in its viewBox. The rest is the
 * sidebar icon set's: a 20×20 viewBox, no fill, a 1.6 `currentColor` stroke and round joins.
 */
function CogIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
    >
      <circle cx="10" cy="10" r="2.4" />
      <path d="M9.09 2.56h1.82l.35 1.98 1.71.71 1.65-1.16 1.29 1.29-1.16 1.65.71 1.71 1.98.35v1.82l-1.98.35-.71 1.71 1.16 1.65-1.29 1.29-1.65-1.16-1.71.71-.35 1.98H9.09l-.35-1.98-1.71-.71-1.65 1.16-1.29-1.29 1.16-1.65-.71-1.71-1.98-.35V9.09l1.98-.35.71-1.71-1.16-1.65 1.29-1.29 1.65 1.16 1.71-.71.35-1.98Z" />
    </svg>
  );
}

/**
 * The appearance, shown on the page as soon as the person picks one so they can see it, and kept for the next page
 * only by the dialog's Save. Discarding the change puts the page back as it was.
 */
function Appearance({ theme }: { theme: Theme }) {
  const chosen = useSettingsDraft("theme", theme);
  return (
    <section aria-labelledby="assistant-settings-appearance" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-appearance" className="text-sm font-semibold">
        Appearance
      </h3>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-asst-muted">Light, dark, or whatever your device is set to.</p>
        <ThemeChoice
          theme={chosen.value}
          onChoose={(next) => {
            chosen.set(next);
            showTheme(next);
          }}
        />
      </div>
    </section>
  );
}

/** Whether two lists of ticked names are the same set, whatever order they were ticked in. */
function samePlugins(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/**
 * The plugins in plain words: whatever the hub's configuration says each one is for, with its marketplace name
 * underneath for anyone who knows it. A plugin the hub has stopped offering can be unticked but not ticked again,
 * which is `pluginChoices`'s rule.
 */
function Plugins({ plugins }: { plugins: AssistantPlugins }) {
  const choices = pluginChoices(plugins.available, plugins.checked);
  // Only the names there is a box for: an always-on name the row still holds is kept by any save, as `pluginChoices` says.
  const stored = plugins.checked.filter((name) => choices.some((choice) => choice.name === name));
  const ticked = useSettingsDraft("plugins", stored, samePlugins);
  const toggle = (name: string, on: boolean) =>
    ticked.set(choices.map((choice) => choice.name).filter((candidate) => (candidate === name ? on : ticked.value.includes(candidate))));
  return (
    <section aria-labelledby="assistant-settings-plugins" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-plugins" className="text-sm font-semibold">
        Plugins
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Plugins add skills your assistant can use, such as a team's own tools for its work.{" "}
        {plugins.podRunning ? "Saving restarts your assistant; your chats are kept." : "Your assistant loads them the next time it starts."}
      </p>
      <ul aria-label="Your assistant's plugins" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
        {choices.map((choice) => (
          <li key={choice.name} className="border-b border-asst-line last:border-b-0">
            <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3 hover:bg-asst-active">
              <input
                type="checkbox"
                name="plugins"
                value={choice.name}
                checked={ticked.value.includes(choice.name)}
                onChange={(event) => toggle(choice.name, event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-asst-accent"
              />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-sm font-medium">{choice.description === "" ? choice.name : choice.description}</span>
                {choice.description === "" ? null : <span className="font-plex-mono text-xs text-asst-muted">{choice.name}</span>}
                {choice.offered ? null : <span className="text-xs text-asst-warn">No longer offered. Untick it to stop using it.</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {ticked.error === null ? null : (
        <p role="alert" className="text-xs text-asst-error">
          {ticked.error}
        </p>
      )}
    </section>
  );
}

/** A heading the navigation puts above the sections it gathers, or `null` for one that stands on its own. */
type SettingsGroup = "General" | "Agent" | null;

/**
 * One section of the dialog: the label the navigation shows for it, the group it sits under, whether the page passed
 * anything for it to show, its panel, and the settings in it that the dialog's Save stores.
 *
 * A section is a row of `SECTIONS` and nothing else — its own component file, the fields of `SettingsView` it reads,
 * and one entry here — so adding or removing one never touches the navigation, the focus trap or the layout.
 */
interface SettingsSection {
  id: string;
  label: string;
  group: SettingsGroup;
  shown: (view: SettingsView) => boolean;
  panel: (view: SettingsView) => ReactNode;
  drafts?: readonly DraftKey[];
}

/**
 * In the order the navigation offers them. The first one the page has anything for is the one it opens on.
 *
 * A group's items are kept together, because the heading is rendered for an item whose group differs from the one
 * before it: a group split in two would be announced twice and read as two different things.
 */
const SECTIONS: readonly SettingsSection[] = [
  { id: "appearance", label: "Appearance", group: "General", shown: () => true, panel: (view) => <Appearance theme={view.theme} />, drafts: ["theme"] },
  {
    id: "connections",
    label: "Connections",
    group: "General",
    shown: hasConnections,
    panel: (view) => <Connections view={view} />
  },
  {
    id: "templates",
    label: "Templates",
    group: "General",
    shown: (view) => view.templates !== undefined,
    panel: (view) => (view.templates === undefined ? null : <Templates templates={view.templates} />)
  },
  {
    id: "exports",
    label: "Tickets & Confluence",
    group: "General",
    shown: (view) => view.exports !== undefined,
    panel: (view) => (view.exports === undefined ? null : <ExportSettings exports={view.exports} />),
    drafts: ["exports"]
  },
  {
    id: "sharing",
    label: "Sharing",
    group: "General",
    shown: (view) => view.sharing !== undefined,
    panel: (view) => (view.sharing === undefined ? null : <Sharing sharing={view.sharing} />)
  },
  {
    id: "assistant",
    label: "Assistant",
    group: "Agent",
    shown: (view) => view.agent !== undefined || view.model !== undefined || view.size !== undefined,
    panel: (view) => <AgentSettings agent={view.agent} model={view.model} size={view.size} />,
    drafts: ["model", "size"]
  },
  {
    id: "claude-md",
    label: "Claude.md",
    group: "Agent",
    shown: (view) => view.claudeMd !== undefined,
    panel: (view) => (view.claudeMd === undefined ? null : <ClaudeMd claudeMd={view.claudeMd} />),
    drafts: ["claudeMd"]
  },
  {
    id: "git",
    label: "Git identity",
    group: "Agent",
    shown: (view) => view.git !== undefined,
    panel: (view) => (view.git === undefined ? null : <GitIdentity git={view.git} />),
    drafts: ["git"]
  },
  {
    id: "plugins",
    label: "Plugins",
    group: "Agent",
    // Nothing at all when the hub offers no plugin and the assistant loads none: a navigation item leading to an
    // empty panel is worse than no item, and `pluginChoices` is the one place that decides what there is to tick.
    shown: (view) => view.plugins !== undefined && pluginChoices(view.plugins.available, view.plugins.checked).length > 0,
    panel: (view) => (view.plugins === undefined ? null : <Plugins plugins={view.plugins} />),
    drafts: ["plugins"]
  },
  {
    id: "ports",
    label: "Web servers",
    group: "Agent",
    shown: (view) => view.agent !== undefined,
    panel: (view) => (view.agent === undefined ? null : <PortSettings load={view.agent.load} />)
  },
  {
    id: "files",
    label: "Files",
    group: null,
    shown: (view) => view.files !== undefined,
    panel: (view) => (view.files === undefined ? null : <Files files={view.files} />)
  }
];

/**
 * Section ids an address may carry that name part of another section, mapped to the section that holds it, so a saved
 * link or a pod on an older client still lands where the thing it named is: a pasted token is in Connections; the
 * model, the size and the agent itself are in Assistant; the plugins are in Plugins.
 */
const SECTION_ALIASES: ReadonlyMap<string, string> = new Map([
  ["credentials", "connections"],
  ["model", "assistant"],
  ["size", "assistant"],
  ["tools", "plugins"]
]);

/**
 * Whether the dialog has room for its navigation beside a section.
 *
 * Read from the viewport rather than left to CSS, because the two widths are different interfaces and not one
 * interface laid out twice: wide is a tablist over a panel, narrow is a list the person drills into. Hiding one of
 * them with CSS would leave its controls in the DOM, where the focus trap counts them and a screen reader reads them.
 *
 * A browser without `matchMedia` is treated as wide, which is what jsdom is: a unit test that wants the narrow
 * interface says so by defining one.
 */
function useTwoPane(): boolean {
  const [wide, setWide] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia(SETTINGS_TWO_PANE).matches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(SETTINGS_TWO_PANE);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return wide;
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4 shrink-0">
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4 shrink-0">
      <path d="M12.5 4.5 7 10l5.5 5.5" />
    </svg>
  );
}

/**
 * The mark on a section holding changes the Save has not stored. A dot for the eye and words for a screen reader, which
 * become part of the section's name, so the mark does not depend on seeing it.
 */
function Unsaved() {
  return (
    <>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-asst-accent" />
      <span className="sr-only">, unsaved changes</span>
    </>
  );
}

const NAV_ITEM = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] leading-tight";
const GROUP_LABEL = "px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-asst-muted not-first:mt-4 first:pt-0";

/**
 * The navigation, as a vertical tablist over the panel beside it.
 *
 * Arrows move focus and Enter or Space opens a section, rather than opening whichever section the arrows reach. Every
 * panel here is a form, and automatic activation would throw away half-typed notes on the way past.
 *
 * The group headings are `aria-hidden`: a tablist owns tabs and nothing else, so the grouping is shown rather than
 * announced, and each tab's own panel heading says in full what the short label stands for.
 */
function Nav({
  items,
  section,
  onSelect,
  unsaved,
  tabId,
  panelId
}: {
  items: readonly SettingsSection[];
  section: string;
  onSelect: (id: string) => void;
  unsaved: (item: SettingsSection) => boolean;
  tabId: (id: string) => string;
  panelId: string;
}) {
  const list = useRef<HTMLDivElement>(null);

  /**
   * Moves focus, wrapping at either end so the navigation is a ring rather than something a person can arrow off.
   *
   * By index into the rendered tabs rather than by id: the group headings sit between them, so the tabs are not the
   * container's children and `nth-child` would count the wrong things.
   */
  function move(to: number): void {
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[(to + items.length) % items.length]?.focus();
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings sections"
      className="flex w-[164px] shrink-0 flex-col overflow-y-auto border-r border-asst-line pr-3"
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.group !== null && item.group !== items[index - 1]?.group ? (
            <p aria-hidden="true" className={GROUP_LABEL}>
              {item.group}
            </p>
          ) : null}
          <button
            type="button"
            role="tab"
            id={tabId(item.id)}
            aria-selected={item.id === section}
            aria-controls={panelId}
            // Only the open section is a tab stop, so the dialog's trap sees exactly one of these and Tab back into
            // the navigation lands on where the person is. The arrows reach the rest, which `move` focuses directly.
            tabIndex={item.id === section ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              const to =
                event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "ArrowUp"
                    ? index - 1
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : null;
              if (to !== null) {
                event.preventDefault();
                move(to);
              }
            }}
            className={`${NAV_ITEM} ${item.id === section ? "bg-asst-active font-semibold text-asst-text" : "text-asst-body hover:bg-asst-hover hover:text-asst-text"}`}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {unsaved(item) ? <Unsaved /> : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The same sections on a screen too narrow for two of them side by side: the list first, then one section at a time
 * with a way back to the list. A real list rather than a tablist, because that is what it behaves like — nothing is
 * selected while the list is showing, and opening a section replaces it.
 */
function SectionList({
  items,
  onSelect,
  unsaved
}: {
  items: readonly SettingsSection[];
  onSelect: (id: string) => void;
  unsaved: (item: SettingsSection) => boolean;
}) {
  return (
    <ul aria-label="Settings sections" className="flex shrink-0 flex-col gap-0.5 overflow-y-auto">
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.group !== null && item.group !== items[index - 1]?.group ? (
            <li aria-hidden="true" className={GROUP_LABEL}>
              {item.group}
            </li>
          ) : null}
          <li>
            <button
              type="button"
              data-settings-nav=""
              onClick={() => onSelect(item.id)}
              className={`${NAV_ITEM} text-asst-body hover:bg-asst-hover hover:text-asst-text`}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {unsaved(item) ? <Unsaved /> : null}
              <Chevron />
            </button>
          </li>
        </Fragment>
      ))}
    </ul>
  );
}

function BackToList({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      data-settings-nav=""
      onClick={onBack}
      className="flex shrink-0 items-center gap-1 self-start rounded-lg py-1 pr-2 text-[13px] text-asst-muted hover:text-asst-text"
    >
      <BackIcon />
      Back to settings
    </button>
  );
}

/**
 * Where focus belongs when the dialog opens, and whenever something takes it away: the open section's own tab, the
 * head of the list a narrow screen shows, or the way back out of a section. One selector for all three, so the
 * entry point is a property of whichever interface is showing rather than something each caller works out.
 */
const NAV_ENTRY = '[role="tab"][aria-selected="true"], [data-settings-nav]';

/** Puts focus there, or on the first thing in the dialog that will take it when no interface is showing one. */
function focusNavigation(dialog: HTMLElement | null): void {
  (dialog?.querySelector<HTMLElement>(NAV_ENTRY) ?? dialog?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
}

type SaveResult = ActionResult<object & { confirmation?: string }>;

/** What the last save said: a line for each thing it stored, then what it could not; `ok` when it stored them all. */
interface Said {
  ok: boolean;
  lines: { ok: boolean; text: string }[];
}

/** One server action the Save runs, the drafts it stores, and what is said for it when its action confirms nothing. */
interface SaveTask {
  keys: DraftKey[];
  done: string;
  run: () => Promise<SaveResult>;
}

function formOf(fields: Record<string, string | readonly string[]>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of typeof value === "string" ? [value] : value) {
      form.append(name, one);
    }
  }
  return form;
}

/**
 * The server actions that store the drafts still to be saved, each through the action its section always used, and
 * only for what changed. The size and the plugins are one task, because `saveVirtualAgentPod` writes both in one
 * transaction and so replaces a running pod once for the two. The appearance is the browser's own cookie and needs no
 * server.
 */
function saveTasks(view: SettingsView, dirty: Values): SaveTask[] {
  const tasks: SaveTask[] = [];
  const { theme, model, size, plugins, claudeMd, git, exports } = dirty;
  if (theme !== undefined) {
    tasks.push({
      keys: ["theme"],
      done: "Your appearance is saved",
      run: async () => {
        keepTheme(theme);
        return { ok: true };
      }
    });
  }
  if (model !== undefined && view.model !== undefined) {
    const save = view.model.save;
    tasks.push({ keys: ["model"], done: "Your model is saved", run: () => save(formOf({ model })) });
  }
  const pod = view.size ?? view.plugins;
  const sizing = size !== undefined && view.size !== undefined ? size : undefined;
  const plugging = plugins !== undefined && view.plugins !== undefined ? plugins : undefined;
  if (pod !== undefined && (sizing !== undefined || plugging !== undefined)) {
    tasks.push({
      keys: [...(sizing === undefined ? [] : ["size" as const]), ...(plugging === undefined ? [] : ["plugins" as const])],
      done: "Your assistant's size and plugins are saved",
      run: () =>
        pod.save(
          formOf({
            id: pod.assistantId,
            ...(sizing === undefined ? {} : { size: sizing }),
            ...(plugging === undefined ? {} : { pluginsChosen: "true", plugins: plugging })
          })
        )
    });
  }
  if (claudeMd !== undefined && view.claudeMd !== undefined) {
    const save = view.claudeMd.save;
    tasks.push({ keys: ["claudeMd"], done: "Your CLAUDE.md is saved", run: () => save(formOf({ value: claudeMd })) });
  }
  if (git !== undefined && view.git !== undefined) {
    const save = view.git.save;
    tasks.push({ keys: ["git"], done: "Your git identity is saved", run: () => save(formOf(git)) });
  }
  if (exports !== undefined && view.exports !== undefined) {
    const save = view.exports.save;
    tasks.push({ keys: ["exports"], done: "Your ticket and Confluence defaults are saved", run: () => save(exports) });
  }
  return tasks;
}

/**
 * What saving does to a pod that is up: a change of size or of plugins replaces it, and the Save asks once, naming
 * both, before it does.
 */
function restartsFor(view: SettingsView, dirty: Values): string[] {
  return [
    dirty.size !== undefined && view.size?.view.rollsPod === true ? "size" : null,
    dirty.plugins !== undefined && view.plugins?.podRunning === true ? "plugins" : null
  ].filter((change): change is string => change !== null);
}

const PRIMARY = "shrink-0 rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40";
const SECONDARY = "shrink-0 rounded-[10px] border border-asst-strong px-3 py-2 text-[13px] hover:bg-asst-active";

function Question({
  children,
  confirm,
  cancel,
  onConfirm,
  onCancel
}: {
  children: ReactNode;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The way back is focused rather than the way on: both questions are there to stop something the person may not mean.
  const back = useFocusOnMount<HTMLButtonElement>();
  return (
    <div className="flex w-full flex-col gap-2">
      {children}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button ref={back} type="button" onClick={onCancel} className={SECONDARY}>
          {cancel}
        </button>
        <button type="button" onClick={onConfirm} className={PRIMARY}>
          {confirm}
        </button>
      </div>
    </div>
  );
}

/**
 * The footer every section shares: what is waiting to be saved, or what the last save said, and the one Save and the
 * way to throw the changes away. Its two questions take its place while they are asked.
 */
function Footer({
  unsaved,
  said,
  saving,
  asking,
  restarts,
  openChats,
  saveButton,
  onSave,
  onDiscard,
  onClose,
  onCancel
}: {
  unsaved: readonly string[];
  said: Said | null;
  saving: boolean;
  asking: "restart" | "close" | null;
  restarts: readonly string[];
  openChats: number;
  saveButton: React.RefObject<HTMLButtonElement | null>;
  onSave: (confirmed: boolean) => void;
  onDiscard: () => void;
  onClose: () => void;
  onCancel: () => void;
}) {
  if (asking === "restart") {
    return (
      <Question confirm="Save and restart" cancel="Cancel" onConfirm={() => onSave(true)} onCancel={onCancel}>
        <p className="text-pretty text-[13px] font-semibold">{restartQuestion(restarts, openChats)}</p>
        <p className="text-pretty text-[13px] text-asst-body">
          Your chats are all kept and carry on where they left off. Only what one of them was working on at the moment you save is lost.
        </p>
      </Question>
    );
  }
  if (asking === "close") {
    return (
      <Question confirm="Discard and close" cancel="Keep editing" onConfirm={onClose} onCancel={onCancel}>
        <p className="text-pretty text-[13px] font-semibold">Discard your unsaved changes to {inWords(unsaved)}?</p>
      </Question>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-3">
      {/* What the last save said is announced; what is waiting to be saved is not, since it changes as the person types. */}
      {said === null ? (
        <p className="min-w-0 flex-1 text-[13px] text-asst-muted">{unsaved.length === 0 ? null : `Unsaved changes in ${inWords(unsaved)}.`}</p>
      ) : (
        <div role={said.ok ? "status" : "alert"} className="min-w-0 flex-1 text-[13px]">
          {said.lines.map((line) => (
            <p key={line.text} className={line.ok ? "text-asst-ok" : "text-asst-error"}>
              {line.text}
            </p>
          ))}
        </div>
      )}
      {unsaved.length === 0 ? null : (
        <button type="button" onClick={onDiscard} disabled={saving} className={SECONDARY}>
          Discard changes
        </button>
      )}
      <button ref={saveButton} type="button" onClick={() => onSave(false)} disabled={unsaved.length === 0 || saving} className={PRIMARY}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/**
 * The settings themselves, over the page: a navigation of the sections, the one the person has open, and one Save for
 * every setting in all of them. Focus moves into it as it opens and stays in it while it is open; closing it, by
 * Escape, the close button or the page behind it, puts focus back on the cog, which is what `onClose` is for. Closing
 * with changes still to save asks first.
 *
 * The drafts are `store`'s, which `AssistantSettings` holds (see `useDraftStore`). A section never opened has no
 * draft, and so adds nothing to a save.
 */
function Dialog({
  view,
  store,
  closeAsked,
  onClose,
  initial: named = null
}: {
  view: SettingsView;
  store: DraftStore;
  /** Counts the closes asked of the dialog from outside it, by the address losing its section, which it answers as it would its own. */
  closeAsked: number;
  onClose: () => void;
  initial?: string | null;
}) {
  const initial = named === null ? null : (SECTION_ALIASES.get(named) ?? named);
  const panel = useRef<HTMLDivElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const prefix = useId();
  const wide = useTwoPane();
  const router = useRouter();
  const endSession = useEndSession();
  const items = SECTIONS.filter((item) => item.shown(view));
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<"restart" | "close" | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const dirty = store.drafts;
  const unsavedIn = (item: SettingsSection) => (item.drafts ?? []).some((key) => dirty[key] !== undefined);
  const unsaved = items.filter(unsavedIn).map((item) => item.label);
  const restarts = restartsFor(view, dirty);
  // Nothing open is the narrow interface showing its list. Wide has no such state: it always has a section beside the
  // navigation, so a chosen section that the page has stopped passing anything for falls back to the first offered one.
  // A section the address names is open from the start at either width, which on the narrow one is drilled into.
  const [chosen, setChosen] = useState<string | null>(
    initial !== null && items.some((item) => item.id === initial) ? initial : wide ? (items[0]?.id ?? null) : null
  );
  const section = items.some((item) => item.id === chosen) ? chosen : wide ? (items[0]?.id ?? null) : null;
  const tabId = (id: string) => `${prefix}-tab-${id}`;
  const panelId = `${prefix}-panel`;
  const open = items.find((item) => item.id === section);
  const showing = useRef({ wide, section });

  const context: SettingsDraftsContext = {
    ...store,
    change: (key, value, stored) => {
      store.change(key, value, stored);
      setSaid(null);
      // A different change is a different question, so a restart already being asked about stops being the one asked.
      setAsking((last) => (last === "restart" ? null : last));
    }
  };

  function discard(): void {
    // A picked appearance is shown before it is saved, so throwing it away puts back the one last kept.
    if (dirty.theme !== undefined) {
      showTheme(store.saved.theme ?? view.theme);
    }
    store.discard();
    setSaid(null);
    setAsking(null);
  }

  // Nothing closes the dialog while a save is in flight: its answers, and any refusal, are said in it.
  function requestClose(): void {
    if (saving) {
      return;
    }
    if (Object.keys(dirty).length > 0) {
      setAsking("close");
      return;
    }
    onClose();
  }

  async function save(confirmed: boolean): Promise<void> {
    if (!confirmed && restarts.length > 0) {
      setAsking("restart");
      return;
    }
    const sent = dirty;
    setAsking(null);
    setSaving(true);
    setSaid(null);
    const results = await Promise.all(
      saveTasks(view, sent).map(async (task) => {
        try {
          return { task, result: await task.run() };
        } catch {
          return { task, result: (await sessionEnded()) ? null : ({ ok: false, error: "that could not be done; try again" } as const) };
        }
      })
    );
    setSaving(false);
    if (results.some(({ result }) => result === null)) {
      endSession();
      return;
    }
    const stored = results.filter(({ result }) => result?.ok === true).flatMap(({ task }) => task.keys);
    const refused = results.flatMap(({ task, result }) => (result === null || result.ok ? [] : task.keys.map((key) => [key, result.error] as const)));
    store.commit(sent, stored, refused);
    if (stored.length > 0) {
      router.refresh();
    }
    // Every task that stored something is acknowledged, in its action's words where it has them.
    const lines = results.flatMap(({ task, result }) => (result?.ok === true ? [{ ok: true, text: result.confirmation || task.done }] : []));
    const notSaved = items.filter((item) => (item.drafts ?? []).some((key) => refused.some(([refusedKey]) => refusedKey === key))).map((item) => item.label);
    setSaid(
      refused.length === 0
        ? { ok: true, lines }
        : { ok: false, lines: [...lines, { ok: false, text: `${inWords(notSaved)} could not be saved. Your changes are kept, and each section says why.` }] }
    );
  }

  const askedBefore = useRef(closeAsked);
  // biome-ignore lint/correctness/useExhaustiveDependencies: answers a new ask only, with the dialog as it stands then
  useEffect(() => {
    if (askedBefore.current !== closeAsked) {
      askedBefore.current = closeAsked;
      requestClose();
    }
  }, [closeAsked]);

  useEffect(() => {
    // The navigation, so what has focus says where in the settings the person is rather than only how to leave.
    focusNavigation(panel.current);
  }, []);

  useEffect(() => {
    // A question in the footer is replaced by the buttons it stood in for as it is answered, and the button focus was
    // on goes with it: Save, where it can take focus, or the navigation.
    if (asking === null && !saving && !panel.current?.contains(document.activeElement)) {
      if (saveButton.current !== null && !saveButton.current.disabled) {
        saveButton.current.focus();
      } else {
        focusNavigation(panel.current);
      }
    }
  }, [asking, saving]);

  useEffect(() => {
    const moved = showing.current.wide !== wide || showing.current.section !== section;
    showing.current = { wide, section };
    if (!moved) {
      return;
    }
    // The narrow interface replaces its whole pane as a section is opened or left, and a change of width replaces
    // whichever navigation was showing — either way the element focus was on can leave the document, and focus falls
    // to the body, outside the trap and with nothing to read. On the wide interface a click leaves focus on the tab
    // it was given to, which is where a tablist keeps it, so that case is left alone.
    if (wide && panel.current?.contains(document.activeElement)) {
      return;
    }
    focusNavigation(panel.current);
  }, [wide, section]);

  // Escape answers what is asked: a question in the footer is put away, and otherwise the dialog is closed.
  const onEscape = useRef(() => {});
  onEscape.current = () => (asking === null ? requestClose() : setAsking(null));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape dismisses the innermost thing only. The shell closes its drawer on Escape from `window`, which is
        // the next stop after `document`, so the dialog would otherwise take the whole sidebar with it — and the cog
        // focus is handed back to goes `inert` with it, which drops focus to the body.
        event.stopPropagation();
        onEscape.current();
        return;
      }
      const items = event.key === "Tab" ? [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])] : [];
      if (items.length === 0) {
        return;
      }
      // Tab off either end of the dialog wraps to the other, so it never reaches the page behind.
      const edge = event.shiftKey ? items[0] : items.at(-1);
      if (document.activeElement === edge || !panel.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5 font-plex text-[15px] leading-normal text-asst-text">
      <button type="button" aria-label="Close settings" onClick={requestClose} className="absolute inset-0 bg-black/60" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="assistant-settings-title"
        // A set height once there are two panes, so moving between sections does not resize the dialog under the
        // navigation; the panel scrolls inside it instead. Short screens still win through `max-h-full`.
        className="relative flex max-h-full w-full max-w-[460px] flex-col gap-4 overflow-hidden rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl sm:h-[560px] sm:max-w-[700px]"
      >
        <div className="flex items-start gap-3">
          <h2 id="assistant-settings-title" className="flex-1 text-lg font-semibold">
            Settings
          </h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close settings"
            className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-active hover:text-asst-text"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </div>
        {/*
         * One row of two slots at both widths — the navigation, then the open section — rather than two layouts with
         * a panel each. The section's own component then survives a change of width: a phone turned on its side
         * crosses the breakpoint, and remounting the panel there would throw away a half-typed CLAUDE.md.
         */}
        <div className={`flex min-h-0 flex-1 ${wide ? "gap-4" : "flex-col gap-3.5"}`}>
          {wide ? (
            <Nav items={items} section={section ?? ""} onSelect={setChosen} unsaved={unsavedIn} tabId={tabId} panelId={panelId} />
          ) : section === null ? (
            <SectionList items={items} onSelect={setChosen} unsaved={unsavedIn} />
          ) : (
            <BackToList onBack={() => setChosen(null)} />
          )}
          {section === null && !wide ? null : (
            <div
              // A tab panel only beside a tablist. The narrow interface is a list the person drills into, where the
              // same element is the scrolling pane of one section and nothing is selected for it to be the panel of.
              {...(wide ? { role: "tabpanel", id: panelId, "aria-labelledby": section === null ? undefined : tabId(section) } : {})}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a section holding nothing focusable, as Connections is, has to be focusable itself or a keyboard cannot reach or scroll it
              tabIndex={0}
              // `outline-hidden` leaves the outline style at `none`, and a width and a colour alone draw nothing, so
              // the focus ring says `outline-solid` as well.
              className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-0.5 outline-hidden focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-asst-accent-line"
            >
              <SettingsDrafts.Provider value={context}>{open?.panel(view) ?? null}</SettingsDrafts.Provider>
            </div>
          )}
        </div>
        <div className="flex shrink-0 border-t border-asst-line pt-3.5">
          <Footer
            unsaved={unsaved}
            said={said}
            saving={saving}
            asking={asking}
            restarts={restarts}
            // The size's read is the one count of open chats the page passes. It is absent only where there is no
            // agent of the person's to count for, and no count reads as whatever the assistant is working on.
            openChats={view.size?.view.openChats ?? 0}
            saveButton={saveButton}
            onSave={(confirmed) => void save(confirmed)}
            onDiscard={discard}
            onClose={() => {
              discard();
              onClose();
            }}
            onCancel={() => setAsking(null)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The cog beside the person's name in the sidebar, and the settings it opens. It carries a warning when something in
 * them needs the person: the mark is a `!` rather than only a colour, and the cog's own name says what, so the prompt
 * does not depend on seeing the yellow.
 *
 * **One mark, however many reasons.** A sign-in that has lapsed and an assistant short of memory both put the person
 * in the same dialog, and a second badge beside this one would be two things competing to be noticed and neither
 * read. So the reasons are joined into the cog's accessible name instead, in the order the dialog's own sections
 * come.
 */
export function AssistantSettings({
  theme = "system",
  connections: data,
  viewerRoute,
  connect,
  now: from,
  plugins,
  model,
  claudeMd,
  templates,
  files,
  size,
  exports,
  sharing,
  agent,
  git,
  tokens
}: {
  theme?: Theme;
  connections?: ConnectionsData;
  /** The viewer's own model route, which Microsoft 365's Connect is judged on; without it Connect is not offered. */
  viewerRoute?: ModelRoute;
  /** How a row connects a sign-in made on request; without it the rows only say where each stands. */
  connect?: AssistantConnect;
  /** The page's own clock, so the cog's name and badge are the same in the HTML as in the first render. */
  now: number;
  plugins?: AssistantPlugins;
  model?: AssistantModelSetting;
  claudeMd?: AssistantClaudeMd;
  templates?: AssistantTemplates;
  files?: AssistantFiles;
  size?: AssistantSize;
  exports?: AssistantExportDefaults;
  sharing?: AssistantSharing;
  agent?: AssistantAgentSettings;
  git?: AssistantGitIdentity;
  tokens?: AssistantTokens;
}) {
  // `get` is the first value, so an address carrying the parameter twice still names one section.
  const addressed = useSearchParams().get(SETTINGS_PARAMETER);
  const cog = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const fromAddress = useRef(false);
  // The page's own clock to begin with, then the browser's as it takes over and again whenever the dialog opens. A
  // sign-in's deadline moves slowly and a timer on every page to watch it would cost more than it is worth, but the
  // first read has to be the page's: `Date.now()` here would be the server's clock in the HTML and the browser's in
  // the first render, and a deadline falling between the two is a badge and an accessible name that disagree.
  const [now, setNow] = useState(from);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  // The appearance the switch starts from. The dialog's Save writes the person's choice to the cookie and to the theme
  // root, not to the server tree, so `theme` keeps the value the page was rendered with and the dialog, which
  // unmounts when it closes, would otherwise reopen showing a choice the page has moved on from.
  const [shownTheme, setShownTheme] = useState<Theme>(theme);
  const store = useDraftStore();
  const [closeAsked, setCloseAsked] = useState(0);
  // A picked appearance is shown before it is saved, so a page that goes while one is unsaved puts back the one kept.
  const unshown = useRef(() => {});
  unshown.current = () => {
    if (store.drafts.theme !== undefined) {
      showTheme(store.saved.theme ?? shownTheme);
    }
  };
  useEffect(() => () => unshown.current(), []);

  const list = connections(data, checklistState, now);
  // Only ever a status, so it is left out of the warning and of the badge: the sign-in it is read from is in `list`
  // and raises both for itself, and the same thing said twice is read as two.
  const access = data === undefined ? null : modelAccess(data.route, list);
  const warning = connectionsWarning(list);
  const memory = size === undefined ? null : memoryWarning(memoryPressure(size.view.use, size.view.openChats, size.view.size));
  // In the order the dialog's sections come — Connections under General, then the size in Assistant under Agent — so
  // the name reads as a route through it. Empty is no mark at all.
  const attention = [warning, memory].filter((reason): reason is string => reason !== null);

  /**
   * The element the `--asst-*` colours are declared on. The dialog is rendered into it rather than into `body`: it
   * has to leave the sidebar, which is transformed and would clip anything `fixed` inside it, but a sibling of the
   * theme root inherits none of the custom properties the Assistant's every colour is built from. The theme root
   * sets no containing block of its own, so `fixed` still means the viewport.
   */
  function themeRoot(): HTMLElement {
    return cog.current?.closest<HTMLElement>(".asst-theme") ?? document.body;
  }

  /** What the page is actually showing, or the appearance it was rendered with when nothing is there to say. */
  function shownNow(): Theme {
    const live = themeRoot().dataset.theme;
    return live === undefined ? theme : themeOf(live);
  }

  function show(section: string | null): void {
    setNow(Date.now());
    // Read only as the dialog opens: one already open may be showing an appearance the person has not saved.
    if (!open) {
      setShownTheme(shownNow());
    }
    setOpening(section);
    setOpen(true);
  }

  // `?settings=<section>` opens the dialog there, which is where retired pages and the share dialog send people. It is
  // read on the client, so opening and closing the dialog never re-renders the page on the server. Opened after the
  // first render rather than in it, because the dialog is portalled into the theme root and the server has no document
  // to find one in. Shut by the address too, so the back button closes a dialog the address opened, with focus back on
  // the cog as any other close leaves it, and asks first as any other close does when there are changes to save; one
  // the cog opened is left alone. A second section named while it is open remounts the dialog there, and the drafts,
  // which are held here, go with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the address alone, since `show` reads the page as it stands when the address changes
  useEffect(() => {
    if (addressed !== null) {
      fromAddress.current = true;
      show(addressed);
    } else if (fromAddress.current) {
      fromAddress.current = false;
      setCloseAsked((count) => count + 1);
    }
  }, [addressed]);

  function close(): void {
    store.reset();
    setOpen(false);
    cog.current?.focus();
    // Replaced rather than navigated, which Next keeps `useSearchParams` in step with, so a reload does not open the
    // dialog again. The parameter is cut out as text, so the rest of the query keeps the encoding it came with. A `null`
    // state, not the current one: Next's patched `replaceState` leaves a state carrying its `__NA` marker to itself, so
    // the router would keep the parameter, the same link would not open the dialog again and the next refresh would put
    // it back.
    if (addressed !== null) {
      const { pathname, search, hash } = window.location;
      window.history.replaceState(null, "", `${pathname}${withoutSettingsParameter(search)}${hash}`);
    }
  }

  return (
    <>
      <button
        ref={cog}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={attention.length === 0 ? "Settings" : `Settings. ${attention.join(". ")}`}
        title="Settings"
        onClick={() => show(null)}
        // 36px, the size of the composer's own buttons, with the two extra pixels each way taken out of the margin
        // again so the footer row stays the height the 32px avatar beside it sets.
        className="relative -my-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-hover hover:text-asst-text"
      >
        <CogIcon />
        {attention.length === 0 ? null : (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-asst-warn text-[10px] font-bold leading-none text-asst-rail"
          >
            !
          </span>
        )}
      </button>
      {open
        ? createPortal(
            <Dialog
              view={{
                theme: shownTheme,
                list,
                logins: data?.logins ?? [],
                now,
                access,
                connect,
                microsoft: microsoftConnection(data, viewerRoute),
                route: data?.route ?? "own-licence",
                unavailable: data?.unavailable ?? null,
                warning,
                plugins,
                model,
                claudeMd,
                templates,
                files,
                size,
                exports,
                sharing,
                agent,
                git,
                tokens
              }}
              // Remounted for a section the address names while the dialog is already open, so it opens on that one.
              key={opening ?? ""}
              initial={opening}
              store={store}
              closeAsked={closeAsked}
              onClose={close}
            />,
            themeRoot()
          )
        : null}
    </>
  );
}
