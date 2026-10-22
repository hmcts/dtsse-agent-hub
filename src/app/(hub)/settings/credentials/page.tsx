import { redirect } from "next/navigation";
import { removeCredential, saveCredential } from "@/app/_actions/credentials";
import { CREDENTIALS_ANCHOR, CredentialSettingsView } from "@/components/credentials/CredentialSettingsView";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { credentialSettings } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * The viewer's own credentials: whether each is stored, never what it is. With virtual agents on they are a section
 * of `/virtual`, so this sends people there; with them off this is their only page, since a laptop's workspace reads
 * the Bedrock API key too.
 */
export default async function CredentialsPage() {
  if (virtualAgentsEnabled()) {
    redirect(`/virtual#${CREDENTIALS_ANCHOR}`);
  }
  const viewer = await requireViewer();
  const settings = await credentialSettings(viewer);
  return (
    <>
      <PaneHeader title="Credentials" subtitle="What your virtual agents use on your behalf" />
      <PaneBody>
        <CredentialSettingsView settings={settings} actions={{ save: saveCredential, remove: removeCredential }} />
      </PaneBody>
    </>
  );
}
