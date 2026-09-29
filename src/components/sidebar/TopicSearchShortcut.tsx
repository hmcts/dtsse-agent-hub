"use client";

import { useEffect } from "react";

/** The topic search inputs, the `/topics` page's own before the sidebar's, so `/` on that page lands on the one in view. */
export const TOPIC_SEARCH_IDS = ["topic-search", "sidebar-topic-search"] as const;

const NOT_TYPED_INTO = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/** Whether a keypress here would type a character, so `/` must be left alone. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !NOT_TYPED_INTO.has(target.type);
  }
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable === true;
}

/** `/` focuses the topic search from anywhere that is not a text field, as in Slack and GitHub. */
export function TopicSearchShortcut() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTextField(event.target)) {
        return;
      }
      const search = TOPIC_SEARCH_IDS.map((id) => document.getElementById(id)).find((element) => element !== null);
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
