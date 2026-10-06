"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useEndSession } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import { sessionEnded } from "@/components/live/session";
import type { ActionResult } from "@/web/action";

export type FormAction = (form: FormData) => Promise<ActionResult<object & { confirmation?: string }>>;

/**
 * A form posting to a server action, showing its refusal or confirmation, and re-rendering the page on success, or
 * going to the page `navigate` names for the result. A form whose fields are controlled by its parent passes
 * `keepValues`, since resetting them would show stale text.
 */
export function ActionForm<T extends object & { confirmation?: string }>({
  action,
  label,
  className,
  keepValues = false,
  onSuccess,
  navigate,
  children
}: {
  action: (form: FormData) => Promise<ActionResult<T>>;
  label: string;
  className?: string;
  keepValues?: boolean;
  onSuccess?: () => void;
  navigate?: (result: T) => string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const endSession = useEndSession();
  const [signedOut, setSignedOut] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setMessage(null);
    try {
      const result = await action(new FormData(form));
      if (result.ok && navigate !== undefined) {
        router.push(navigate(result));
      } else if (result.ok) {
        if (!keepValues) {
          form.reset();
        }
        onSuccess?.();
        setMessage(result.confirmation ? { ok: true, text: result.confirmation } : null);
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    } catch {
      if (await sessionEnded()) {
        setSignedOut(true);
        endSession();
      } else {
        setMessage({ ok: false, text: "that could not be done; try again" });
      }
    } finally {
      setPending(false);
    }
  }

  // A submit React does not intercept (before hydration, or when the page's script failed to load) is a native one,
  // and a native GET would put every field, a pasted credential included, in the URL.
  return (
    <form method="post" onSubmit={submit} aria-label={label} aria-busy={pending} className={className}>
      {children}
      {signedOut ? (
        <p role="status" className="text-xs text-red-300">
          <SessionEndedMessage />
        </p>
      ) : message ? (
        <p role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-green-300" : "text-red-300"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
