"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Connection, type ConnectionsData, connections, connectionsWarning } from "@/assistant/connections";
import type { AssistantPluginsData } from "@/assistant/settings";
import { type Theme, themeOf } from "@/assistant/theme";
import { ActionForm, type FormAction } from "@/components/ActionForm";
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
  templates: AssistantTemplates | undefined;
}

/**
 * Everything in the dialog a Tab can reach, and so everything its focus trap has to account for. Exported so a test
 * asks the dialog which its own tab stops are rather than keeping a second copy of this list, which would pass while
 * a control the trap has been left out of still takes focus off the end of it.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STATE_CLASS: Record<Connection["state"], string> = {
  connected: "text-asst-ok",
  // A sign-in being renewed behind a working one is news, not a problem, so it is not coloured like one.
  refreshing: "text-asst-muted",
  "signing-in": "text-asst-accent-soft",
  expired: "text-asst-warn",
  failed: "text-asst-error",
  waiting: "text-asst-muted"
};

function CogIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.2l1 1.9 2.1-.5 1.3 1.8-1.3 1.7.9 1.9 2.1.4v2.2l-2.1.4-.9 1.9 1.3 1.7-1.3 1.8-2.1-.5-1 1.9h-.9l-1-1.9-2.1.5-1.3-1.8 1.3-1.7-.9-1.9-2.1-.4V9.4l2.1-.4.9-1.9L4.7 5.4 6 3.6l2.1.5 1-1.9Z" />
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

/**
 * The plugins in plain words: whatever the hub's configuration says each one is for, with its marketplace name
 * underneath for anyone who knows it. A plugin the hub has stopped offering can be unticked but not ticked again,
 * which is `pluginChoices`'s rule and the hub's own page's.
 */
function Plugins({ plugins }: { plugins: AssistantPlugins }) {
  const choices = pluginChoices(plugins.available, plugins.checked);
  if (choices.length === 0) {
    return null;
  }
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

function Sections({ theme, list, unavailable, warning, plugins, templates }: SettingsView) {
  return (
    <>
      <section aria-labelledby="assistant-settings-appearance" className="flex flex-col gap-2.5">
        <h3 id="assistant-settings-appearance" className="text-sm font-semibold">
          Appearance
        </h3>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-asst-muted">Light, dark, or whatever your device is set to.</p>
          <ThemeSwitch initial={theme} />
        </div>
      </section>
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
      {plugins === undefined ? null : <Plugins plugins={plugins} />}
      {templates === undefined ? null : <Templates templates={templates} />}
    </>
  );
}

/**
 * The settings themselves, over the page: the appearance, the person's sign-ins, their team tools and their own saved
 * templates. Focus moves into it as it opens and stays in it while it is open; closing it, by Escape, the close
 * button or the page behind it, puts focus back on the cog, which is what `onClose` is for.
 */
function Dialog({ view, onClose }: { view: SettingsView; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

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
        className="relative flex max-h-full w-full max-w-[460px] flex-col gap-5 overflow-y-auto rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl"
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
        <Sections {...view} />
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
  templates
}: {
  theme?: Theme;
  connections?: ConnectionsData;
  plugins?: AssistantPlugins;
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
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-hover hover:text-asst-text"
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
            <Dialog view={{ theme: shownTheme, list, unavailable: data?.unavailable ?? null, warning, plugins, templates }} onClose={close} />,
            themeRoot()
          )
        : null}
    </>
  );
}
