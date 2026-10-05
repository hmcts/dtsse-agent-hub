import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import { MAX_EXPOSED_PORT, MAX_EXPOSED_PORTS, MIN_EXPOSED_PORT } from "@/virtual-agents/ports";
import type { VirtualAgentCard } from "@/virtual-agents/views";

export interface PortActions {
  expose: FormAction;
  unexpose: FormAction;
}

const INPUT = "mt-1 w-32 rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";

/** The agent's exposed web ports, each linked at its URL, with forms to add one and remove each. */
export function PortsPanel({ agent, actions }: { agent: Pick<VirtualAgentCard, "id" | "desired" | "exposedPorts">; actions: PortActions }) {
  if (agent.desired === "deleted") {
    return null;
  }
  const ports = agent.exposedPorts;
  return (
    <Section heading="Web ports" detail={`${ports.length} of ${MAX_EXPOSED_PORTS}`}>
      <div className="space-y-3 text-sm">
        <p role="note" className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-amber-200">
          Anyone on the HMCTS VPN can open these URLs. Servers must listen on 0.0.0.0.
        </p>
        <p className="text-xs text-hub-muted">Adding or removing a port restarts a running agent's pod, so it is given the new URLs.</p>
        {ports.length === 0 ? null : (
          <ul aria-label="Exposed ports" className="space-y-2">
            {ports.map(({ port, url }) => (
              <li key={port} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <a href={url} target="_blank" rel="noreferrer noopener" className="break-all text-hub-link underline">
                  {url}
                </a>
                <ActionForm action={actions.unexpose} label={`Stop exposing port ${port}`} className="ml-auto">
                  <input type="hidden" name="id" value={agent.id} />
                  <input type="hidden" name="port" value={port} />
                  <button type="submit" className="text-xs text-red-300 hover:text-red-200">
                    Remove
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        {ports.length < MAX_EXPOSED_PORTS ? (
          <ActionForm action={actions.expose} label="Expose a port" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={agent.id} />
            <label className="block">
              <span className="block text-hub-text">Port</span>
              <input name="port" type="number" required min={MIN_EXPOSED_PORT} max={MAX_EXPOSED_PORT} className={INPUT} />
            </label>
            <button type="submit" className={BUTTON}>
              Expose
            </button>
          </ActionForm>
        ) : null}
      </div>
    </Section>
  );
}
