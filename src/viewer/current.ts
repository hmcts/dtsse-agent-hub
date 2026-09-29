import "server-only";
import { cookies } from "next/headers";
import { prisma } from "../store/prisma.ts";
import type { Identity } from "../users/identity.ts";
import { upsertUser } from "../users/store.ts";
import { NotSignedIn, viewerFrom } from "./identity.ts";

/**
 * The viewer of this request, recorded as a `user` so the rows they write have an owner. `upsertUser` skips the
 * write unless something changed, so calling this from the layout and the page costs a read each.
 */
export async function currentViewer(): Promise<Identity | undefined> {
  const jar = await cookies();
  const viewer = await viewerFrom((name) => jar.get(name)?.value);
  if (viewer !== undefined) {
    await upsertUser(prisma, viewer);
  }
  return viewer;
}

/** For pages and server actions, which the proxy only lets through with a session, so its absence is an error. */
export async function requireViewer(): Promise<Identity> {
  const viewer = await currentViewer();
  if (viewer === undefined) {
    throw new NotSignedIn("there is no signed-in person on this request");
  }
  return viewer;
}
