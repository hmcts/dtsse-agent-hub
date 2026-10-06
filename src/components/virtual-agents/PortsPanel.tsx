import { Section } from "@/components/Section";
import type { VirtualAgentCard } from "@/virtual-agents/views";

/**
 * The web servers the agent's pod reports listening on, each linked at its URL, and why any on loopback have none.
 * The page refreshes on the agent's `virtual_agent` event, so a server appears here soon after it starts.
 */
export function PortsPanel({ agent }: { agent: Pick<VirtualAgentCard, "desired" | "exposedPorts" | "localOnlyPorts"> }) {
  if (agent.desired === "deleted") {
    return null;
  }
  const ports = agent.exposedPorts;
  return (
    <Section heading="Web servers">
      <div className="space-y-3 text-sm">
        {ports.length === 0 ? (
          <p className="text-hub-muted">No web servers running</p>
        ) : (
          <ul aria-label="Web server URLs" className="space-y-2">
            {ports.map(({ port, url }) => (
              <li key={port}>
                <a href={url} target="_blank" rel="noreferrer noopener" className="break-all text-hub-link underline">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        )}
        {agent.localOnlyPorts.length === 0 ? null : (
          <ul aria-label="Ports listening on 127.0.0.1 only" className="space-y-1 text-xs text-amber-200">
            {agent.localOnlyPorts.map((port) => (
              <li key={port}>port {port} is listening on 127.0.0.1 only — start it on 0.0.0.0 to open it here</li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
