"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ActionResult } from "@/web/action";

export type FormAction = (form: FormData) => Promise<ActionResult<object & { granted?: string }>>;

/** A form posting to a server action, showing its refusal or confirmation, and re-rendering the page on success. */
export function ActionForm({ action, label, className, children }: { action: FormAction; label: string; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setMessage(null);
    try {
      const result = await action(new FormData(form));
      if (result.ok) {
        form.reset();
        setMessage(result.granted ? { ok: true, text: result.granted } : null);
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error });
      }
    } catch {
      setMessage({ ok: false, text: "that could not be done; try again" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label={label} aria-busy={pending} className={className}>
      {children}
      {message ? (
        <p role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-green-300" : "text-red-300"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
