"use server";

import { revalidatePath } from "next/cache";
import { revokeGrant, setGrant } from "@/access/load";
import { prisma } from "@/store/prisma";
import { usersByEmail } from "@/users/store";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Grants and revocations, always of the signed-in person's own agents: the owner is the session's identity, never
 * a value from the form, so nobody can change another owner's grants.
 */

export async function grantAccess(form: FormData): Promise<ActionResult<{ granted: string }>> {
  return await runAction<{ granted: string }>("grant", async () => {
    const viewer = await requireViewer();
    const email = text(form.get("email"));
    const level = form.get("level") === "write" ? "write" : "read";
    if (email === "") {
      return { ok: false, error: "enter the address of the person to grant access to" };
    }
    const matches = await usersByEmail(prisma, email);
    if (matches.length === 0) {
      return { ok: false, error: `nobody at ${email} has used the hub yet; they need to sign in or enable comms once first` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `more than one person has used the hub as ${email}, so it cannot say which you mean` };
    }
    const grantee = matches[0]!;
    await setGrant(prisma, viewer.oid, grantee.oid, level);
    revalidatePath("/access");
    return { ok: true, granted: `${grantee.name} now has ${level} access to your agents` };
  });
}

export async function revokeAccess(form: FormData): Promise<ActionResult> {
  return await runAction("revoke", async () => {
    const viewer = await requireViewer();
    const grantee = text(form.get("grantee"));
    if (grantee === "") {
      return { ok: false, error: "no grant was named" };
    }
    await revokeGrant(prisma, viewer.oid, grantee);
    revalidatePath("/access");
    return { ok: true };
  });
}
