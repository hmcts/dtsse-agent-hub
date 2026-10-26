"use client";

import { useRouter } from "next/navigation";
import type { SharePerson } from "@/assistant/shares";
import { type ShareAction, ShareDialog } from "@/components/assistant/ShareDialog";

/**
 * Shows the share dialog over the chat while `?share=1` is on the chat's own address.
 *
 * An address rather than a button, so the dialog can be reached from anywhere — the chat's options menu, a row of the
 * sidebar, the shared-chats page, the browser's history — and closing it takes the parameter off, which leaves the
 * chat exactly as it was.
 *
 * Whether it is showing is read from the prop on every render and held nowhere else. That is the whole of the
 * component, and it has to be: opening the dialog from the chat you are already looking at is a query-only
 * navigation, which Next answers by re-rendering this page rather than by remounting its subtree, so anything
 * remembered here from the first mount would survive the navigation and the dialog would never appear. The same
 * single source is what lets the back button close it, and what hands the dialog the list of people as it is now
 * rather than as it was when the chat was opened.
 */
export function ShareGate({
  conversationId,
  open,
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

  if (!open) {
    return null;
  }
  return (
    <ShareDialog
      conversationId={conversationId}
      people={people}
      share={share}
      unshare={unshare}
      onClose={() => router.replace(`/assistant/${conversationId}`)}
    />
  );
}
