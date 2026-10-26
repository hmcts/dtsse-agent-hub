import type { NextRequest } from "next/server";
import { canSuggestPerson, peopleLookup } from "@/access/rules";
import { json } from "@/agent-api/http";
import { prisma } from "@/store/prisma";
import { searchUsers } from "@/users/store";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * People the share dialog can offer: `?q=`, matched against the names and addresses of everyone who has used the hub.
 *
 * It is an access surface of its own — it says who uses the hub — so what it may answer is `peopleLookup`'s and
 * `canSuggestPerson`'s rather than this handler's. A query too short to be specific gets an empty list rather than
 * everyone, which is what keeps it from being a way to read the hub's user list.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const lookup = peopleLookup(request.nextUrl.searchParams.get("q") ?? "");
  if (!lookup.ok) {
    return json({ people: [] });
  }
  // One more than the rules allow, so taking the viewer out of the matches cannot shorten the answer below the cap.
  const matched = await searchUsers(prisma, lookup.query, lookup.limit + 1);
  const people = matched
    .filter((person) => canSuggestPerson(viewer.oid, person))
    .slice(0, lookup.limit)
    .map((person) => ({ oid: person.oid, name: person.name, email: person.email }));
  return json({ people });
}
