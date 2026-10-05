import { removeCredential, saveCredential } from "@/app/_actions/credentials";
import { CredentialSettingsView } from "@/components/credentials/CredentialSettingsView";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { requireViewer } from "@/viewer/current";
import { credentialSettings } from "@/web/data";

export const dynamic = "force-dynamic";

/** The viewer's own credentials for their virtual agents: whether each is stored, never what it is. */
export default async function CredentialsPage() {
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
