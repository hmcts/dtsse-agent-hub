import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import { DEFAULT_SIZE, sizeChangeRefusal, sizeLabel, VIRTUAL_AGENT_SIZES, type VirtualAgentSize } from "@/virtual-agents/size";
import type { VirtualAgentCard } from "@/virtual-agents/views";

const SELECT = "mt-1 w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text";
const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

export function SizeSelect({ value = DEFAULT_SIZE }: { value?: VirtualAgentSize }) {
  return (
    <label className="block">
      <span className="block text-hub-text">Size</span>
      <select name="size" defaultValue={value} className={SELECT}>
        {VIRTUAL_AGENT_SIZES.map((size) => (
          <option key={size} value={size}>
            {sizeLabel(size)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The size can change only while no pod is running, so the form is offered then and otherwise says why not. */
export function SizePanel({ agent, resize }: { agent: Pick<VirtualAgentCard, "id" | "name" | "desired" | "status" | "size">; resize: FormAction }) {
  if (agent.desired === "deleted") {
    return null;
  }
  const refusal = sizeChangeRefusal(agent);
  return (
    <Section heading="Size" detail={sizeLabel(agent.size)}>
      {refusal === undefined ? (
        <ActionForm action={resize} label={`Change the size of ${agent.name}`} className="space-y-3 text-sm">
          <input type="hidden" name="id" value={agent.id} />
          <SizeSelect value={agent.size} />
          <button type="submit" className={BUTTON}>
            Change size
          </button>
        </ActionForm>
      ) : (
        <p className="text-sm text-hub-muted">Stop it to change its size.</p>
      )}
    </Section>
  );
}
