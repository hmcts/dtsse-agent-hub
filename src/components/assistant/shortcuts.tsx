"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AssistantModal } from "@/components/assistant/AssistantModal";

/**
 * The CFT Workspace's keyboard shortcuts, the dialog that lists them, and the one preference beside them: which key
 * sends a message.
 */

/** Which key sends a message: Enter, with Shift+Enter for a new line, or Ctrl/Cmd+Enter, with Enter for a new line. */
export type SendKey = "enter" | "mod-enter";

const SEND_KEY = "asst-send-key";
/** Told within the tab, since `storage` only reaches other tabs. */
const SEND_KEY_CHANGED = "asst-send-key-changed";

function readSendKey(): SendKey {
  try {
    return window.localStorage.getItem(SEND_KEY) === "mod-enter" ? "mod-enter" : "enter";
  } catch {
    return "enter";
  }
}

/**
 * The person's send key, kept in this browser. Read after mount, as storage is not there on the server, and followed
 * across every composer and tab, so changing it in the dialog changes the box they are typing in.
 */
export function useSendKey(): [SendKey, (next: SendKey) => void] {
  const [key, setKey] = useState<SendKey>("enter");
  useEffect(() => {
    const follow = () => setKey(readSendKey());
    // The choice itself, not storage read back: a choice storage refused still applies to this tab.
    const told = (event: Event) => setKey((event as CustomEvent<SendKey>).detail);
    follow();
    window.addEventListener("storage", follow);
    window.addEventListener(SEND_KEY_CHANGED, told);
    return () => {
      window.removeEventListener("storage", follow);
      window.removeEventListener(SEND_KEY_CHANGED, told);
    };
  }, []);
  const choose = (next: SendKey) => {
    try {
      if (next === "enter") {
        window.localStorage.removeItem(SEND_KEY);
      } else {
        window.localStorage.setItem(SEND_KEY, next);
      }
    } catch {
      // Not remembered; it still applies until the page is left.
    }
    setKey(next);
    window.dispatchEvent(new CustomEvent<SendKey>(SEND_KEY_CHANGED, { detail: next }));
  };
  return [key, choose];
}

/** Whether this key press sends, for the composer's box. Composing text in an input method is never a send. */
export function sendsMessage(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }, key: SendKey): boolean {
  if (event.key !== "Enter" || event.isComposing) {
    return false;
  }
  return key === "enter" ? !event.shiftKey && !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey;
}

/** "⌘" on a Mac, "Ctrl" elsewhere: the modifier the shortcuts are written with. Ctrl until there is a browser to ask. */
export function useModifierName(): string {
  const [name, setName] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(window.navigator.platform || window.navigator.userAgent)) {
      setName("⌘");
    }
  }, []);
  return name;
}

/** Whether a key press is meant for what has focus: typing in a box, or choosing in a list, takes the plain keys. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * The shortcuts that work anywhere in the CFT Workspace, for the shell to listen for. Each acts only when nothing
 * already took the key, and none fires inside a dialog: a dialog is its own small page, with its own keys.
 */
export function useShellShortcuts(handlers: { newChat: () => void; search: () => void; toggleSidebar: () => void; showShortcuts: () => void }): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]') !== null) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && key === "k") {
        event.preventDefault();
        current.current.search();
      } else if (mod && event.shiftKey && key === "o") {
        event.preventDefault();
        current.current.newChat();
      } else if (mod && event.shiftKey && key === "s") {
        event.preventDefault();
        current.current.toggleSidebar();
      } else if (event.shiftKey && event.key === "Escape") {
        const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        if (box !== null) {
          event.preventDefault();
          box.focus();
        }
      } else if (event.key === "?" && !mod && !typing(event.target)) {
        event.preventDefault();
        current.current.showShortcuts();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** What the dialog lists, with `mod` standing for Ctrl or ⌘. */
function shortcutList(mod: string): readonly { keys: string; does: string }[] {
  return [
    { keys: `${mod}+K`, does: "Search your chats" },
    { keys: `${mod}+Shift+O`, does: "Start a new chat" },
    { keys: `${mod}+Shift+S`, does: "Open or close the sidebar" },
    { keys: "Shift+Esc", does: "Go to the message box" },
    { keys: "Esc", does: "Stop the answer being written" },
    { keys: "?", does: "Show these shortcuts" }
  ];
}

/** The shortcuts, and which key sends a message, which is a choice about the keyboard too. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mod = useModifierName();
  const [sendKey, setSendKey] = useSendKey();
  const legend = useId();
  return (
    <AssistantModal title="Keyboard shortcuts" onClose={onClose} closeLabel="Close keyboard shortcuts" className="max-w-[460px]">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[13px]">
        {shortcutList(mod).map((shortcut) => (
          <div key={shortcut.does} className="contents">
            <dt>
              <kbd className="rounded-md border border-asst-strong bg-asst-field px-1.5 py-0.5 font-plex-mono text-xs">{shortcut.keys}</kbd>
            </dt>
            <dd className="text-asst-body">{shortcut.does}</dd>
          </div>
        ))}
      </dl>
      <fieldset className="flex flex-col gap-1.5 text-[13px]" aria-labelledby={legend}>
        <legend id={legend} className="mb-1 text-sm font-semibold">
          Sending a message
        </legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="send-key" checked={sendKey === "enter"} onChange={() => setSendKey("enter")} />
          Enter sends. Shift+Enter starts a new line.
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="send-key" checked={sendKey === "mod-enter"} onChange={() => setSendKey("mod-enter")} />
          {mod}+Enter sends. Enter starts a new line.
        </label>
      </fieldset>
    </AssistantModal>
  );
}
