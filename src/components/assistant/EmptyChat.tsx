"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_PRODUCT } from "@/assistant/products";
import type { Starter, Template } from "@/assistant/starters";
import { SidebarToggle } from "@/components/assistant/AssistantShell";
import { Composer } from "@/components/assistant/Composer";
import { ProductSelect } from "@/components/assistant/ProductSelect";
import type { ActionResult } from "@/web/action";

export type StartAction = (input: { product: unknown; body: unknown }) => Promise<ActionResult<{ id: string }>>;

/**
 * A new chat: what the person is working on, as a starter card or their own words, and which product it is about.
 * The first message creates the conversation, and the page moves to it.
 */
export function EmptyChat({ starters, templates, start }: { starters: readonly Starter[]; templates: readonly Template[]; start: StartAction }) {
  const router = useRouter();
  const [product, setProduct] = useState(DEFAULT_PRODUCT);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function begin(body: string): Promise<string | null> {
    const result = await start({ product, body });
    if (!result.ok) {
      return result.error;
    }
    router.push(`/assistant/${result.id}`);
    return null;
  }

  async function starter(prompt: string): Promise<void> {
    setStarting(true);
    setError(null);
    const failure = await begin(prompt);
    if (failure !== null) {
      setError(failure);
      setStarting(false);
    }
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-asst-field px-4">
        <SidebarToggle />
        <h1 className="truncate text-[15px] font-medium">New chat</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center gap-7 px-5 py-10">
          <h2 className="text-balance text-center text-[28px] font-medium tracking-tight">What are you working on?</h2>
          <ul aria-label="Starters" className="grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-2">
            {starters.map((card) => (
              <li key={card.title}>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => void starter(card.prompt)}
                  className="flex h-full w-full flex-col gap-0.5 rounded-xl border border-asst-line bg-asst-raised px-4 py-3.5 text-left hover:border-asst-accent-line hover:bg-asst-hover disabled:opacity-60"
                >
                  <span className="text-sm font-medium">{card.title}</span>
                  <span className="text-[13px] text-asst-muted">{card.sub}</span>
                </button>
              </li>
            ))}
          </ul>
          <ProductSelect value={product} onChange={setProduct} />
          {error === null ? null : (
            <p role="alert" className="text-[13px] text-asst-error">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-3.5">
        <div className="mx-auto max-w-[760px]">
          <Composer templates={templates} onSend={begin} disabled={starting} />
        </div>
      </div>
    </>
  );
}
