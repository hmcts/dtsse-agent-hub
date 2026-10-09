"use client";

import { ActionForm } from "@/components/ActionForm";
import { MAX_NAME_LENGTH } from "@/virtual-agents/limits";
import type { PluginOption } from "@/virtual-agents/plugins";
import type { ActionResult } from "@/web/action";
import { PluginsField } from "./PluginsField";
import { SizeSelect } from "./SizePanel";

/** Creating one opens its page. */
export type CreateAction = (form: FormData) => Promise<ActionResult<{ id: string; confirmation: string }>>;

const INPUT = "mt-1 w-72 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const BUTTON = "rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567] disabled:opacity-60";

/**
 * A client component because `navigate` is a function, which cannot cross from a Server Component; `create` is a
 * server action, which can.
 */
export function CreateVirtualAgentForm({ create, plugins = [] }: { create: CreateAction; plugins?: readonly PluginOption[] }) {
  return (
    <ActionForm action={create} navigate={(created) => `/agents/${created.id}`} label="Create a virtual agent" className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="block text-hub-text">Name</span>
        <input name="name" required maxLength={MAX_NAME_LENGTH} autoComplete="off" spellCheck={false} className={INPUT} />
      </label>
      <SizeSelect />
      <PluginsField available={plugins} />
      <button type="submit" className={BUTTON}>
        Create
      </button>
    </ActionForm>
  );
}
