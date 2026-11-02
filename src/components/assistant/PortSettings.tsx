"use client";

import { useSettingsData } from "@/components/assistant/useSettingsData";
import type { AssistantAgent } from "@/web/data";

/**
 * The web servers the assistant's pod reports listening on, each linked where it can be opened, and why any bound to
 * loopback have no link. The page re-reads on the agent's `virtual_agent` event, so a server shows here soon after it
 * starts.
 *
 * With the viewer on, the first link is the viewer's `https://<viewer>/<id>/<port>/`, which works off the VPN. It is
 * given with its trailing slash because that is the prefix everything under it hangs from: the port's cookie is
 * scoped to it, and a page's `<base href>` from `/` is moved under it. Opened without the cookie, it goes through the
 * hub to sign the person in and comes back to the same place. The VPN address follows it.
 */
export function PortSettings({ load }: { load: () => Promise<AssistantAgent | null> }) {
  const { data: agent, failed } = useSettingsData("ports", load, true);
  return (
    <section aria-labelledby="assistant-settings-ports" aria-busy={agent === undefined && !failed} className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-ports" className="text-sm font-semibold">
        Web servers
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Servers your assistant starts on 0.0.0.0 can be opened here. Only you can open them through these links.
      </p>
      {failed ? (
        <p className="text-[13px] text-asst-error">Your web servers could not be read. Close settings and open them again.</p>
      ) : agent === undefined ? (
        <p className="text-[13px] text-asst-muted">Reading your web servers…</p>
      ) : agent === null ? (
        <p className="text-[13px] text-asst-muted">You have no assistant yet, so nothing is running.</p>
      ) : (
        <Ports agent={agent} />
      )}
    </section>
  );
}

function Ports({ agent }: { agent: AssistantAgent }) {
  const ports = agent.exposedPorts;
  return (
    <>
      {ports.length === 0 ? (
        <p className="text-[13px] text-asst-body">{agent.desired === "running" ? "No web servers running." : "None while your assistant is stopped."}</p>
      ) : (
        <ul aria-label="Web server URLs" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
          {ports.map(({ port, url, viewerUrl }) => (
            <li key={port} className="flex flex-col gap-0.5 border-b border-asst-line px-3.5 py-3 last:border-b-0">
              <span className="text-sm font-medium">Port {port}</span>
              <a href={viewerUrl ?? url} target="_blank" rel="noreferrer noopener" className="break-all text-[13px] text-asst-accent-soft underline">
                {viewerUrl ?? url}
              </a>
              {viewerUrl === undefined ? null : (
                <span className="text-xs text-asst-muted">
                  On the VPN:{" "}
                  <a href={url} target="_blank" rel="noreferrer noopener" className="break-all underline hover:text-asst-text">
                    {url}
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {agent.localOnlyPorts.length === 0 ? null : (
        <ul aria-label="Ports listening on 127.0.0.1 only" className="flex flex-col gap-1 text-xs text-asst-warn">
          {agent.localOnlyPorts.map((port) => (
            <li key={port}>Port {port} is listening on 127.0.0.1 only. Start it on 0.0.0.0 to open it here.</li>
          ))}
        </ul>
      )}
    </>
  );
}
