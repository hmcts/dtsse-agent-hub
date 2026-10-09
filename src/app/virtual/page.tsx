import { notFound } from "next/navigation";
import { clearGitIdentity, removeCredential, resetClaudeMd, saveClaudeMd, saveCredential, saveGitIdentity } from "@/app/_actions/credentials";
import { createVirtualAgent } from "@/app/_actions/virtual-agents";
import { ClaudeMdSection } from "@/components/credentials/ClaudeMdSection";
import { CredentialsSection } from "@/components/credentials/CredentialSettingsView";
import { GitIdentityCard } from "@/components/credentials/GitIdentityCard";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { VirtualAgentsView } from "@/components/virtual-agents/VirtualAgentsView";
import { requireViewer } from "@/viewer/current";
import { availablePlugins } from "@/virtual-agents/plugins";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { claudeMdSettings, credentialSettings, gitIdentitySettings, virtualAgentsPage } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * The viewer's own virtual agents, the form to create one, the credentials and git identity they use and the CLAUDE.md they share. Not
 * found while the feature is off. A credential saved elsewhere, such as from the CLI, reaches this page as a resync.
 */
export default async function VirtualAgentsPage() {
  if (!virtualAgentsEnabled()) {
    notFound();
  }
  const viewer = await requireViewer();
  const [page, credentials, claudeMd, gitIdentity] = await Promise.all([
    virtualAgentsPage(viewer),
    credentialSettings(viewer),
    claudeMdSettings(viewer),
    gitIdentitySettings(viewer)
  ]);
  return (
    <>
      <VirtualAgentRefresh />
      <PaneHeader title="Virtual agents" subtitle="Claude Code sessions the hub runs for you" />
      <PaneBody>
        <VirtualAgentsView agents={page.agents} route={page.modelRoute} create={createVirtualAgent} now={Date.now()} plugins={availablePlugins()} />
        <CredentialsSection settings={credentials} actions={{ save: saveCredential, remove: removeCredential }}>
          <GitIdentityCard settings={gitIdentity} actions={{ save: saveGitIdentity, clear: clearGitIdentity }} />
        </CredentialsSection>
        <ClaudeMdSection settings={claudeMd} actions={{ save: saveClaudeMd, reset: resetClaudeMd }} />
      </PaneBody>
    </>
  );
}
