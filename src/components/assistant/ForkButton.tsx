"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ActionResult } from "@/web/action";

export type ForkChatAction = (input: { conversationId: unknown }) => Promise<ActionResult<{ id: string }>>;

/**
 * "Continue in my Assistant", on a chat its owner offered the viewer to fork: makes their own copy, or opens the one
 * they already took. A button rather than a link for the first, because taking the copy is a write — to the viewer's
 * own Assistant, never to the chat on this page.
 */
export function ForkButton({ conversationId, copyId, forkChat }: { conversationId: string; copyId: string | null; forkChat: ForkChatAction }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (copyId !== null) {
    return (
      <Link href={`/assistant/${copyId}`} className="shrink-0 rounded-[9px] border border-asst-strong px-3 py-1.5 text-[13px] hover:bg-asst-field">
        Open your copy
      </Link>
    );
  }

  async function fork(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await forkChat({ conversationId });
      if (result.ok) {
        router.push(`/assistant/${result.id}`);
        return;
      }
      setError(result.error);
    } catch {
      setError("that could not be done; check your connection and try again");
    }
    setPending(false);
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {error === null ? null : (
        <span role="alert" className="text-xs text-asst-error">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => void fork()}
        className="rounded-[9px] bg-asst-accent px-3 py-1.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-60"
      >
        {pending ? "Copying" : "Continue in my Assistant"}
      </button>
    </span>
  );
}
