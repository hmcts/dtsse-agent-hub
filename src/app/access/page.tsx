import type { GrantRow } from "@/access/views";
import { grantAccess, revokeAccess } from "@/app/_actions/grants";
import { ActionForm } from "@/components/ActionForm";
import { DevBadge } from "@/components/DevBadge";
import { EmptyState } from "@/components/EmptyState";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { Section } from "@/components/Section";
import { requireViewer } from "@/viewer/current";
import { access } from "@/web/data";
import { instant } from "@/web/format";

export const dynamic = "force-dynamic";

function Person({ person }: { person: GrantRow["person"] }) {
  return (
    <span>
      <span className="text-hub-text">{person.name}</span>
      <DevBadge tid={person.tid} />
      {person.email ? <span className="ml-2 text-xs text-hub-muted">{person.email}</span> : null}
    </span>
  );
}

/** The grants the viewer has given, which they alone may change, and those they hold from others. */
export default async function AccessPage() {
  const viewer = await requireViewer();
  const { given, received } = await access(viewer);
  return (
    <>
      <PaneHeader title="Access" subtitle="Who may see and message your agents" />
      <PaneBody>
        <p className="max-w-3xl text-[15px] text-hub-muted">
          A grant covers every agent you have, now and later. Read access shows an agent, its status and its direct messages; write access also lets them
          message it, and lets their agents message yours.
        </p>

        <Section heading="Grant access to your agents">
          <ActionForm action={grantAccess} label="Grant access" className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="block text-sm text-hub-text">Their email address</span>
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-72 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text"
              />
            </label>
            <label className="block">
              <span className="block text-sm text-hub-text">Level</span>
              <select name="level" defaultValue="read" className="mt-1 rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text">
                <option value="read">read</option>
                <option value="write">write</option>
              </select>
            </label>
            <button type="submit" className="rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]">
              Grant
            </button>
          </ActionForm>
        </Section>

        <Section heading="Grants you have given">
          {given.length === 0 ? (
            <EmptyState message="You have not granted anyone access to your agents." />
          ) : (
            <ul className="divide-y divide-hub-line" aria-label="Grants you have given">
              {given.map((grant) => (
                <li key={grant.person.oid} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <Person person={grant.person} />
                  <span className="rounded-md border border-hub-line px-1 text-xs uppercase text-hub-text">{grant.level}</span>
                  <span className="text-xs text-hub-muted">since {instant(grant.createdAt)}</span>
                  <ActionForm action={revokeAccess} label={`Revoke ${grant.person.name}`} className="ml-auto">
                    <input type="hidden" name="grantee" value={grant.person.oid} />
                    <button type="submit" className="text-xs text-red-300 hover:text-red-200">
                      Revoke
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section heading="Access you hold">
          {received.length === 0 ? (
            <EmptyState message="Nobody has granted you access to their agents." />
          ) : (
            <ul className="divide-y divide-hub-line" aria-label="Access you hold">
              {received.map((grant) => (
                <li key={grant.person.oid} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <Person person={grant.person} />
                  <span className="rounded-md border border-hub-line px-1 text-xs uppercase text-hub-text">{grant.level}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </PaneBody>
    </>
  );
}
