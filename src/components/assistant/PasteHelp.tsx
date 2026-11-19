import type { Connector } from "@/assistant/connections";

/**
 * Where a pasted credential comes from, under the box it goes in: a bare password box assumes the person already
 * knows where to get a Jenkins or Claude token, and most have never made one. Nothing for a kind with no help.
 */
export function PasteHelp({ help, id }: { help: Connector["help"]; id?: string }) {
  if (help === null) {
    return null;
  }
  return (
    <p id={id} className="text-pretty text-xs text-asst-muted">
      {help.text}
      {help.link === null ? null : (
        <>
          {" "}
          <a href={help.link.href} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
            {help.link.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </>
      )}
    </p>
  );
}
