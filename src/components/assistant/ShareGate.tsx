"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SharePerson } from "@/assistant/shares";
import { type ShareAction, ShareDialog } from "@/components/assistant/ShareDialog";

/**
 * Opens the share dialog over the chat, from `?share=1` on the chat's own address.
 *
 * An address rather than a button, so the dialog can be reached from anywhere — the shared-chats page, a link in a
 * message, the browser's history — and so the entry point in the chat's own header is one `href` whenever it is
 * added. Closing it takes the parameter off, which leaves the chat exactly as it was.
 */
export function ShareGate({
  conversationId,
  open: initiallyOpen,
  people,
  share,
  unshare
}: {
  conversationId: string;
  open: boolean;
  people: readonly SharePerson[];
  share: ShareAction;
  unshare: ShareAction;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initiallyOpen);

  if (!open) {
    return null;
  }
  return (
    <ShareDialog
      conversationId={conversationId}
      people={people}
      share={share}
      unshare={unshare}
      onClose={() => {
        setOpen(false);
        router.replace(`/assistant/${conversationId}`);
      }}
    />
  );
}
