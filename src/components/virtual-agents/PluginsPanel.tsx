import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import type { PluginOffer } from "@/virtual-agents/plugins";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import { PluginConfigurationFault, PluginsField } from "./PluginsField";

const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

/**
 * The plugins can change at any time. A change replaces a running pod, so the form says so while one may be running;
 * the ticks stay as saved, since the page re-renders with them.
 *
 * An offer that could not be read gets the fault in place of the form rather than a form that cannot be saved: a save
 * would be refused anyway, since the names it sent could not be checked against what the hub offers.
 */
export function PluginsPanel({
  agent,
  offer,
  save
}: {
  agent: Pick<VirtualAgentCard, "id" | "name" | "desired" | "status" | "plugins">;
  offer: PluginOffer;
  save: FormAction;
}) {
  if (agent.desired === "deleted") {
    return null;
  }
  if (!offer.ok) {
    return (
      <Section heading="Plugins" detail={agent.plugins.length === 0 ? "None" : agent.plugins.join(", ")}>
        <PluginConfigurationFault error={offer.error} />
      </Section>
    );
  }
  if (offer.available.length === 0 && agent.plugins.length === 0) {
    return null;
  }
  const podRunning = agent.desired === "running" && agent.status !== "requested";
  return (
    <Section heading="Plugins" detail={agent.plugins.length === 0 ? "None" : agent.plugins.join(", ")}>
      <ActionForm action={save} label={`Change the plugins of ${agent.name}`} keepValues className="space-y-3 text-sm">
        <input type="hidden" name="id" value={agent.id} />
        <PluginsField offer={offer} checked={agent.plugins} />
        {podRunning ? <p className="text-xs text-hub-muted">Saving restarts the agent; the conversation continues.</p> : null}
        <button type="submit" className={BUTTON}>
          Save plugins
        </button>
      </ActionForm>
    </Section>
  );
}
