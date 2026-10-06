"use server";

import { revalidatePath } from "next/cache";
import { credentialBackend } from "@/credentials/backend";
import { isCredentialKind } from "@/credentials/names";
import { deleteCredential, putCredential } from "@/credentials/store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Saving and deleting the signed-in person's own credentials. The owner is the session's identity, never a value
 * from the form. Neither action returns a value, and no action reads one.
 *
 * A GitHub token, a Bedrock API key, a Jenkins API token and, for someone on their own licence, a Claude token can be
 * pasted: the Azure token cache comes from the virtual agent's own device-code login. A Bedrock key is accepted on
 * either route, since the workspace on a laptop reads it back too.
 *
 * A CLAUDE.md and a git identity each have their own two actions, because they are written and reset on the virtual
 * agents page rather than pasted, and only exist for virtual agents.
 */

/** The standalone page, and the virtual agents page that has them as a section when the feature is on. */
const CREDENTIALS_PATHS = ["/settings/credentials", "/virtual"] as const;

function revalidate(): void {
  for (const path of CREDENTIALS_PATHS) {
    revalidatePath(path);
  }
}

const PASTEABLE = { github: "GitHub token", claude: "Claude token", bedrock: "Bedrock API key", jenkins: "Jenkins API token" } as const;

function isPasteable(kind: string): kind is keyof typeof PASTEABLE {
  return Object.hasOwn(PASTEABLE, kind);
}

export async function saveCredential(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save credential", async () => {
    const viewer = await requireViewer();
    const kind = text(form.get("kind"));
    if (!isPasteable(kind)) {
      return { ok: false, error: "only a GitHub token, a Claude token, a Bedrock API key or a Jenkins API token can be pasted here" };
    }
    if (kind === "claude" && viewer.modelRoute !== "own-licence") {
      return { ok: false, error: "your virtual agents use Amazon Bedrock, so they need no Claude token" };
    }
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await putCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind, value: form.get("value"), via: "web" });
    revalidate();
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
    revalidate();
    return { ok: true };
  });
}

const VIRTUAL_AGENTS_OFF: { ok: false; error: string } = { ok: false, error: "virtual agents are not available on this deployment" };

export async function saveClaudeMd(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save CLAUDE.md", async () => {
    if (!virtualAgentsEnabled()) {
      return VIRTUAL_AGENTS_OFF;
    }
    const viewer = await requireViewer();
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await putCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind: "claude_md", value: form.get("value"), via: "web" });
    revalidate();
    return { ok: true, confirmation: "Your CLAUDE.md is saved. Each agent uses it from its next Claude start" };
  });
}

export async function resetClaudeMd(): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("reset CLAUDE.md", async () => {
    if (!virtualAgentsEnabled()) {
      return VIRTUAL_AGENTS_OFF;
    }
    const viewer = await requireViewer();
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await deleteCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind: "claude_md" });
    revalidate();
    return { ok: true, confirmation: "Your CLAUDE.md is back to the default" };
  });
}

export async function saveGitIdentity(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save git identity", async () => {
    if (!virtualAgentsEnabled()) {
      return VIRTUAL_AGENTS_OFF;
    }
    const viewer = await requireViewer();
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    const value = JSON.stringify({ name: text(form.get("name")), email: text(form.get("email")) });
    await putCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind: "git_identity", value, via: "web" });
    revalidate();
    return { ok: true, confirmation: "Your git identity is saved. Each agent uses it from its next Claude start" };
  });
}

export async function clearGitIdentity(): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("clear git identity", async () => {
    if (!virtualAgentsEnabled()) {
      return VIRTUAL_AGENTS_OFF;
    }
    const viewer = await requireViewer();
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    await deleteCredential(prisma, backend.store, { actorOid: viewer.oid, ownerOid: viewer.oid, kind: "git_identity" });
    revalidate();
    return { ok: true, confirmation: "Your virtual agents are back to the default git identity" };
  });
}
