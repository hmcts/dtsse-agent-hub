import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import type { PluginOffer } from "@/virtual-agents/plugins";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import { PluginConfigurationFault, PluginsField } from "./PluginsField";

const BUTTON = "rounded-sm border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

/**
 * The plugins can change at any time. A change replaces a running pod, so the form says so while one may be running;
 * the ticks stay as saved, since the page re-renders with them.
 *
 * An offer that could not be read gets the fault in place of the ticks, because nothing can be ticked: a save carrying
 * names would be refused, since they could not be checked against what the hub offers. A save carrying none would not
 * — `checkPlugins` never reads the offer list for an empty list — so an agent that has plugins keeps a form, whose one
 * control removes them all. That is the save worth offering here: a plugin breaking its own pod is exactly when its
 * owner needs to take it off, and a configuration they can neither see nor fix is exactly when they cannot wait.
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
  const detail = agent.plugins.length === 0 ? "None" : agent.plugins.join(", ");
  if (offer.ok && offer.available.length === 0 && agent.plugins.length === 0) {
    return null;
  }
  // Nothing to tick and nothing to remove, so no form at all — only why the ticks are missing.
  if (!offer.ok && agent.plugins.length === 0) {
    return (
      <Section heading="Plugins" detail={detail}>
        <PluginConfigurationFault error={offer.error} />
      </Section>
    );
  }
  const podRunning = agent.desired === "running" && agent.status !== "requested";
  return (
    <Section heading="Plugins" detail={detail}>
      <ActionForm action={save} label={`Change the plugins of ${agent.name}`} keepValues className="space-y-3 text-sm">
        <input type="hidden" name="id" value={agent.id} />
        <PluginsField offer={offer} checked={agent.plugins} />
        {podRunning ? (
          <p className="text-xs text-hub-muted">
            {offer.ok ? "Saving restarts the agent; the conversation continues." : "Removing them restarts the agent; the conversation continues."}
          </p>
        ) : null}
        {/* No `plugins` field is rendered while the offer is unreadable, so this submits an empty list. */}
        <button type="submit" className={BUTTON}>
          {offer.ok ? "Save plugins" : "Remove all plugins"}
        </button>
      </ActionForm>
    </Section>
  );
}
