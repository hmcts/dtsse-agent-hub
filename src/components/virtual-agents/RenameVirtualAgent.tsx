import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import { MAX_NAME_LENGTH } from "@/virtual-agents/limits";
import type { VirtualAgentCard } from "@/virtual-agents/views";

const INPUT = "mt-1 w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

/** Its session is renamed with it, so other people address it by the new name; one being deleted keeps its name. */
export function RenameVirtualAgent({ agent, rename }: { agent: Pick<VirtualAgentCard, "id" | "name" | "desired">; rename: FormAction }) {
  if (agent.desired === "deleted") {
    return null;
  }
  return (
    <Section heading="Name">
      <ActionForm action={rename} label={`Rename ${agent.name}`} className="space-y-3 text-sm">
        <input type="hidden" name="id" value={agent.id} />
        <label className="block">
          <span className="block text-hub-text">New name</span>
          <input name="name" required defaultValue={agent.name} maxLength={MAX_NAME_LENGTH} autoComplete="off" spellCheck={false} className={INPUT} />
        </label>
        <p className="text-xs text-hub-muted">Lowercase letters, digits and hyphens. Its session takes the new name, and people message it by that name.</p>
        <button type="submit" className={BUTTON}>
          Rename
        </button>
      </ActionForm>
    </Section>
  );
}
