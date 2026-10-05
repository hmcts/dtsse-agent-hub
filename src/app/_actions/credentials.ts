"use server";

import { revalidatePath } from "next/cache";
import { credentialBackend } from "@/credentials/backend";
import { isCredentialKind } from "@/credentials/names";
import { deleteCredential, putCredential } from "@/credentials/store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Saving and deleting the signed-in person's own credentials. The owner is the session's identity, never a value
 * from the form. Neither action returns a value, and no action reads one.
 *
 * A GitHub token, a Bedrock API key and, for someone on their own licence, a Claude token can be pasted: the Azure
 * token cache comes from the virtual agent's own device-code login. A Bedrock key is accepted on either route, since
 * the workspace on a laptop reads it back too.
 */

const CREDENTIALS_PATH = "/settings/credentials";

const PASTEABLE = { github: "GitHub token", claude: "Claude token", bedrock: "Bedrock API key" } as const;

function isPasteable(kind: string): kind is keyof typeof PASTEABLE {
  return Object.hasOwn(PASTEABLE, kind);
}

export async function saveCredential(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save credential", async () => {
    const viewer = await requireViewer();
    const kind = text(form.get("kind"));
    if (!isPasteable(kind)) {
      return { ok: false, error: "only a GitHub token, a Claude token or a Bedrock API key can be pasted here" };
    }
    if (kind === "claude" && viewer.modelRoute !== "own-licence") {
      return { ok: false, error: "your virtual agents use Amazon Bedrock, so they need no Claude token" };
    }
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await putCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind, value: form.get("value"), via: "web" });
    revalidatePath(CREDENTIALS_PATH);
    return { ok: true, confirmation: `Your ${PASTEABLE[kind]} is stored` };
  });
}

export async function removeCredential(form: FormData): Promise<ActionResult> {
  return await runAction("delete credential", async () => {
    const viewer = await requireViewer();
    const kind = text(form.get("kind"));
    if (!isCredentialKind(kind)) {
      return { ok: false, error: "no credential was named" };
    }
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await deleteCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind });
    revalidatePath(CREDENTIALS_PATH);
    return { ok: true };
  });
}
