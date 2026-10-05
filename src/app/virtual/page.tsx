import { notFound } from "next/navigation";
import { removeCredential, saveCredential } from "@/app/_actions/credentials";
import { createVirtualAgent } from "@/app/_actions/virtual-agents";
import { CredentialsSection } from "@/components/credentials/CredentialSettingsView";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { VirtualAgentsView } from "@/components/virtual-agents/VirtualAgentsView";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { credentialSettings, virtualAgentsPage } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * The viewer's own virtual agents, the form to create one, and the credentials they use. Not found while the feature
 * is off. A credential saved elsewhere, such as from the CLI, reaches this page as a resync.
 */
export default async function VirtualAgentsPage() {
  if (!virtualAgentsEnabled()) {
    notFound();
  }
  const viewer = await requireViewer();
  const [page, credentials] = await Promise.all([virtualAgentsPage(viewer), credentialSettings(viewer)]);
  return (
    <>
      <VirtualAgentRefresh />
      <PaneHeader title="Virtual agents" subtitle="Claude Code sessions the hub runs for you" />
      <PaneBody>
        <VirtualAgentsView agents={page.agents} route={page.modelRoute} create={createVirtualAgent} now={Date.now()} />
        <CredentialsSection settings={credentials} actions={{ save: saveCredential, remove: removeCredential }} />
      </PaneBody>
    </>
  );
}
