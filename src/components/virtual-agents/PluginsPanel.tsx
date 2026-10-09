import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import type { PluginOption } from "@/virtual-agents/plugins";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import { PluginsField } from "./PluginsField";

const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

/**
 * The plugins can change at any time. A change replaces a running pod, so the form says so while one may be running;
 * the ticks stay as saved, since the page re-renders with them.
 */
export function PluginsPanel({
  agent,
  available,
  save
}: {
  agent: Pick<VirtualAgentCard, "id" | "name" | "desired" | "status" | "plugins">;
  available: readonly PluginOption[];
  save: FormAction;
}) {
  if (agent.desired === "deleted" || (available.length === 0 && agent.plugins.length === 0)) {
    return null;
  }
  const podRunning = agent.desired === "running" && agent.status !== "requested";
  return (
    <Section heading="Plugins" detail={agent.plugins.length === 0 ? "None" : agent.plugins.join(", ")}>
      <ActionForm action={save} label={`Change the plugins of ${agent.name}`} keepValues className="space-y-3 text-sm">
        <input type="hidden" name="id" value={agent.id} />
        <PluginsField available={available} checked={agent.plugins} />
        {podRunning ? <p className="text-xs text-hub-muted">Saving restarts the agent; the conversation continues.</p> : null}
        <button type="submit" className={BUTTON}>
          Save plugins
        </button>
      </ActionForm>
    </Section>
  );
}
