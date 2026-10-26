"use client";

import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Connection, type ConnectionsData, connections, connectionsWarning } from "@/assistant/connections";
import type { AssistantPluginsData } from "@/assistant/settings";
import { type Theme, themeOf } from "@/assistant/theme";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { type AssistantClaudeMd, ClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import { SETTINGS_TWO_PANE_MIN_WIDTH } from "@/components/assistant/layout";
import { type AssistantTemplates, Templates } from "@/components/assistant/TemplateSettings";
import { ThemeSwitch } from "@/components/assistant/ThemeSwitch";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import { pluginChoices } from "@/components/virtual-agents/PluginsField";

/** The plugins the dialog shows, with the action it posts a change to: the one the hub's `/agents/{id}` page uses. */
export type AssistantPlugins = AssistantPluginsData & { save: FormAction };

interface SettingsView {
  theme: Theme;
  list: Connection[];
  unavailable: string | null;
  warning: string | null;
  plugins: AssistantPlugins | undefined;
  claudeMd: AssistantClaudeMd | undefined;
  templates: AssistantTemplates | undefined;
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
 */
export const FOCUSABLE = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "[tabindex]"]
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
export const SETTINGS_TWO_PANE = `(min-width: ${SETTINGS_TWO_PANE_MIN_WIDTH}px)`;

const STATE_CLASS: Record<Connection["state"], string> = {
  connected: "text-asst-ok",
  // A sign-in being renewed behind a working one is news, not a problem, so it is not coloured like one.
  refreshing: "text-asst-muted",
  "signing-in": "text-asst-accent-soft",
  expired: "text-asst-warn",
  failed: "text-asst-error",
  waiting: "text-asst-muted"
};

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

function Row({ row }: { row: Connection }) {
  return (
    <li className="flex items-center gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-asst-active text-xs font-semibold">
        {row.initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{row.name}</span>
        <span className="truncate text-xs text-asst-muted">{row.accountLabel ?? row.desc}</span>
      </div>
      <span className={`shrink-0 text-xs font-medium ${STATE_CLASS[row.state]}`}>{row.detail}</span>
    </li>
  );
}

function Appearance({ theme }: { theme: Theme }) {
  return (
    <section aria-labelledby="assistant-settings-appearance" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-appearance" className="text-sm font-semibold">
        Appearance
      </h3>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-asst-muted">Light, dark, or whatever your device is set to.</p>
        <ThemeSwitch initial={theme} />
      </div>
    </section>
  );
}

function Connections({ list, unavailable, warning }: Pick<SettingsView, "list" | "unavailable" | "warning">) {
  return (
    <section aria-labelledby="assistant-settings-connections" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-connections" className="text-sm font-semibold">
        Connections
      </h3>
      {warning === null ? null : (
        <div className="flex flex-col gap-1 rounded-[10px] border border-asst-warn bg-asst-raised px-3.5 py-3">
          <p className="text-[13px] font-semibold text-asst-text">{warning}</p>
          <p className="text-pretty text-[13px] text-asst-body">
            You are not signed in to these, so your assistant cannot use them. You can carry on chatting, and it asks you to sign in when it next needs one.
          </p>
        </div>
      )}
      {unavailable === null ? null : <p className="text-[13px] text-asst-error">{unavailable}</p>}
      {list.length === 0 ? null : (
        <ul aria-label="Connections" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
          {list.map((row) => (
            <Row key={row.kind} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The plugins in plain words: whatever the hub's configuration says each one is for, with its marketplace name
 * underneath for anyone who knows it. A plugin the hub has stopped offering can be unticked but not ticked again,
 * which is `pluginChoices`'s rule and the hub's own page's.
 */
function Plugins({ plugins }: { plugins: AssistantPlugins }) {
  const choices = pluginChoices(plugins.available, plugins.checked);
  return (
    <section aria-labelledby="assistant-settings-plugins" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-plugins" className="text-sm font-semibold">
        Team tools
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Extra skills your assistant can use for a team's own work.{" "}
        {plugins.podRunning ? "Saving restarts your assistant; your chats are kept." : "Your assistant loads them the next time it starts."}
      </p>
      <ActionForm action={plugins.save} label="Change your assistant's team tools" keepValues className="flex flex-col gap-2.5">
        <input type="hidden" name="id" value={plugins.assistantId} />
        <ul className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
          {choices.map((choice) => (
            <li key={choice.name} className="border-b border-asst-line last:border-b-0">
              <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3 hover:bg-asst-active">
                <input
                  type="checkbox"
                  name="plugins"
                  value={choice.name}
                  defaultChecked={plugins.checked.includes(choice.name)}
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
        <button
          type="submit"
          className="self-start rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover"
        >
          Save team tools
        </button>
      </ActionForm>
    </section>
  );
}

/** A heading the navigation puts above the sections it gathers, or `null` for one that stands on its own. */
type SettingsGroup = "General" | "Agent" | null;

/**
 * One section of the dialog: the label the navigation shows for it, the group it sits under, whether the page passed
 * anything for it to show, and its panel.
 *
 * A section is a row of `SECTIONS` and nothing else — its own component file, one field of `SettingsView`, and one
 * entry here — so adding or removing one never touches the navigation, the focus trap or the layout.
 */
interface SettingsSection {
  id: string;
  label: string;
  group: SettingsGroup;
  shown: (view: SettingsView) => boolean;
  panel: (view: SettingsView) => ReactNode;
}

/** In the order the navigation offers them. The first one the page has anything for is the one it opens on. */
const SECTIONS: readonly SettingsSection[] = [
  { id: "appearance", label: "Appearance", group: "General", shown: () => true, panel: (view) => <Appearance theme={view.theme} /> },
  {
    id: "claude-md",
    label: "Claude.md",
    group: "Agent",
    shown: (view) => view.claudeMd !== undefined,
    panel: (view) => (view.claudeMd === undefined ? null : <ClaudeMd claudeMd={view.claudeMd} />)
  },
  {
    id: "tools",
    label: "Tools",
    group: "Agent",
    // Nothing at all when the hub offers no plugin and the assistant loads none: a navigation item leading to an
    // empty panel is worse than no item, and `pluginChoices` is the one place that decides what there is to tick.
    shown: (view) => view.plugins !== undefined && pluginChoices(view.plugins.available, view.plugins.checked).length > 0,
    panel: (view) => (view.plugins === undefined ? null : <Plugins plugins={view.plugins} />)
  },
  {
    id: "connections",
    label: "Connections",
    group: null,
    shown: (view) => view.list.length > 0 || view.unavailable !== null,
    panel: (view) => <Connections list={view.list} unavailable={view.unavailable} warning={view.warning} />
  },
  {
    id: "templates",
    label: "Templates",
    group: null,
    shown: (view) => view.templates !== undefined,
    panel: (view) => (view.templates === undefined ? null : <Templates templates={view.templates} />)
  }
];

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

const NAV_ITEM = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] leading-tight";
const GROUP_LABEL = "px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-asst-muted first:pt-0";

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
  tabId,
  panelId
}: {
  items: readonly SettingsSection[];
  section: string;
  onSelect: (id: string) => void;
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
function SectionList({ items, onSelect }: { items: readonly SettingsSection[]; onSelect: (id: string) => void }) {
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

/**
 * The settings themselves, over the page: a navigation of the sections and the one the person has open. Focus moves
 * into it as it opens and stays in it while it is open; closing it, by Escape, the close button or the page behind
 * it, puts focus back on the cog, which is what `onClose` is for.
 */
function Dialog({ view, onClose }: { view: SettingsView; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const wide = useTwoPane();
  const items = SECTIONS.filter((item) => item.shown(view));
  // Nothing open is the narrow interface showing its list. Wide has no such state: it always has a section beside the
  // navigation, so a chosen section that the page has stopped passing anything for falls back to the first offered one.
  const [chosen, setChosen] = useState<string | null>(wide ? (items[0]?.id ?? null) : null);
  const section = items.some((item) => item.id === chosen) ? chosen : wide ? (items[0]?.id ?? null) : null;
  const tabId = (id: string) => `${prefix}-tab-${id}`;
  const panelId = `${prefix}-panel`;
  const open = items.find((item) => item.id === section);
  const showing = useRef({ wide, section });

  useEffect(() => {
    // The navigation, so what has focus says where in the settings the person is rather than only how to leave.
    focusNavigation(panel.current);
  }, []);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape dismisses the innermost thing only. The shell closes its drawer on Escape from `window`, which is
        // the next stop after `document`, so the dialog would otherwise take the whole sidebar with it — and the cog
        // focus is handed back to goes `inert` with it, which drops focus to the body.
        event.stopPropagation();
        onClose();
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
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5 font-plex text-[15px] leading-normal text-asst-text">
      <button type="button" aria-label="Close settings" onClick={onClose} className="absolute inset-0 bg-black/60" />
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
            onClick={onClose}
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
            <Nav items={items} section={section ?? ""} onSelect={setChosen} tabId={tabId} panelId={panelId} />
          ) : section === null ? (
            <SectionList items={items} onSelect={setChosen} />
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
              className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-0.5 outline-none focus-visible:outline-1 focus-visible:outline-asst-accent-line"
            >
              {open?.panel(view) ?? null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The cog beside the person's name in the sidebar, and the settings it opens. It carries a warning when a sign-in
 * needs them: the mark is a `!` rather than only a colour, and the cog's own name says which sign-ins, so the prompt
 * does not depend on seeing the yellow.
 */
export function AssistantSettings({
  theme = "system",
  connections: data,
  plugins,
  claudeMd,
  templates
}: {
  theme?: Theme;
  connections?: ConnectionsData;
  plugins?: AssistantPlugins;
  claudeMd?: AssistantClaudeMd;
  templates?: AssistantTemplates;
}) {
  const cog = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Read once, and again whenever the dialog opens: a sign-in's deadline moves slowly and a timer on every page to
  // watch it would cost more than it is worth.
  const [now, setNow] = useState(() => Date.now());
  // The appearance the switch starts from. `ThemeSwitch` writes the person's choice to the cookie and to the theme
  // root, not to the server tree, so `theme` keeps the value the page was rendered with and the dialog, which
  // unmounts when it closes, would otherwise reopen showing a choice the page has moved on from.
  const [shownTheme, setShownTheme] = useState<Theme>(theme);

  const list = connections(data, (stored, login) => checklistState(stored, login, now));
  const warning = connectionsWarning(list);

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

  function close(): void {
    setOpen(false);
    cog.current?.focus();
  }

  return (
    <>
      <button
        ref={cog}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={warning === null ? "Settings" : `Settings. ${warning}`}
        title="Settings"
        onClick={() => {
          setNow(Date.now());
          setShownTheme(shownNow());
          setOpen(true);
        }}
        // 36px, the size of the composer's own buttons, with the two extra pixels each way taken out of the margin
        // again so the footer row stays the height the 32px avatar beside it sets.
        className="relative -my-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-hover hover:text-asst-text"
      >
        <CogIcon />
        {warning === null ? null : (
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
            <Dialog view={{ theme: shownTheme, list, unavailable: data?.unavailable ?? null, warning, plugins, claudeMd, templates }} onClose={close} />,
            themeRoot()
          )
        : null}
    </>
  );
}
