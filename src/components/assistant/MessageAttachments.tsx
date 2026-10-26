"use client";

import { useEffect, useState } from "react";
import type { MessageAttachment } from "@/assistant/upload-store";
import { fileSizeLabel } from "@/components/assistant/uploadClient";

/**
 * The chips under a message the person attached files to, each a download of their own file while the hub still has
 * it.
 *
 * The hub holds the bytes for a few hours from the upload and then drops them (`uploadHeldUntil` in
 * `src/assistant/upload-store.ts`), so this is the one place that decides whether a chip is a link or a sentence. A
 * chip that offers a download and then fails is worse than one that plainly says the file has gone, so the window is
 * watched rather than only read at render: a thread left open crosses it, and the link has to go when it does.
 */

/** What a chip whose bytes the hub no longer holds says. The one thing a person can do about it is attach it again. */
export const NO_LONGER_HELD = "Sent to the assistant. The copy here is not kept for long, and this one has gone — attach it again to send it once more.";

/** What a chip that can still be downloaded says. */
export const STILL_HELD = "Sent to the assistant. Your copy is still held here for a few hours — select to download it.";

/** When the hub stops holding this file's bytes, as a number of ms, or `null` when it is not holding them at all. */
function heldUntil(file: MessageAttachment): number | null {
  if (file.available_until === null) {
    return null;
  }
  const at = Date.parse(file.available_until);
  return Number.isNaN(at) ? null : at;
}

/** Where the bytes come back from: the owner-only route, which re-decides all of this for itself. */
function downloadHref(file: MessageAttachment): string {
  return `/api/ui/uploads/${encodeURIComponent(file.id)}/content`;
}

/**
 * The longest a timer may be set for. Node and the browsers both hold a timeout in a signed 32-bit integer and fire
 * anything larger immediately, which would make the timer below re-arm in a tight loop; capping it re-arms once a
 * month instead. The real window is hours, so nothing reaches this — but it costs one `Math.min` not to.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export function MessageAttachments({ attachments }: { attachments: readonly MessageAttachment[] }) {
  const [now, setNow] = useState(() => Date.now());

  // One timer for the list, at the first window still to close. Re-deciding only on the next render that happened to
  // come would leave a live link behind for as long as nothing else on the screen changed.
  useEffect(() => {
    const closing = attachments.map(heldUntil).filter((at): at is number => at !== null && at > now);
    if (closing.length === 0) {
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.min(...closing) - now + 1_000, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [attachments, now]);

  if (attachments.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Files sent with this message" className="flex max-w-[82%] flex-wrap justify-end gap-1.5">
      {attachments.map((file) => {
        const until = heldUntil(file);
        const held = until !== null && until > now;
        const body = (
          <>
            <span aria-hidden="true">📎</span>
            <span className="max-w-[200px] truncate">{file.name}</span>
            <span className="shrink-0 text-asst-faint">{fileSizeLabel(file.bytes)}</span>
          </>
        );
        return (
          <li
            key={file.id}
            title={held ? STILL_HELD : NO_LONGER_HELD}
            className="rounded-lg border border-asst-line text-xs text-asst-muted focus-within:ring-2 focus-within:ring-asst-accent"
          >
            {held ? (
              // `download` so the browser saves it rather than navigating, with the person's own file name on the
              // saved copy — the route's `Content-Disposition` carries the sanitised one, which is what the pod wrote.
              <a className="flex items-center gap-1.5 px-2 py-1 underline-offset-2 hover:underline" href={downloadHref(file)} download={file.name}>
                {body}
              </a>
            ) : (
              <span className="flex items-center gap-1.5 px-2 py-1">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
