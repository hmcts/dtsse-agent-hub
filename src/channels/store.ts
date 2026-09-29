import { isUuid } from "../agents/store.ts";
import type { Match } from "../messages/feed.ts";
import type { Database } from "../store/prisma.ts";
import type { ChannelDraft } from "./rules.ts";

/** Saved channels. A channel is a view over topics and holds no messages of its own. */

export interface ChannelSummary {
  id: string;
  name: string;
  topics: string[];
  match: Match;
  shared: boolean;
  owner: { oid: string; name: string };
}

const SELECT = { id: true, name: true, topics: true, match: true, shared: true, owner: { select: { oid: true, name: true } } } as const;

/** Who may open a channel: its owner, and anyone once it is shared. */
function visibleTo(oid: string) {
  return { OR: [{ ownerOid: oid }, { shared: true }] };
}

export async function saveChannel(db: Database, ownerOid: string, draft: ChannelDraft): Promise<string> {
  const row = await db.channel.create({ data: { ownerOid, ...draft }, select: { id: true } });
  return row.id;
}

export const MAX_LISTED_CHANNELS = 100;

/** The viewer's own channels, then the ones others share, each by name. */
export async function listChannels(db: Database, oid: string): Promise<{ mine: ChannelSummary[]; shared: ChannelSummary[] }> {
  const rows = await db.channel.findMany({ where: visibleTo(oid), select: SELECT, orderBy: [{ name: "asc" }, { id: "asc" }], take: MAX_LISTED_CHANNELS });
  return { mine: rows.filter((row) => row.owner.oid === oid), shared: rows.filter((row) => row.owner.oid !== oid) };
}

/** The channel, if the viewer may open it; someone else's unshared channel reads as missing. */
export async function findChannel(db: Database, oid: string, id: string): Promise<ChannelSummary | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.channel.findFirst({ where: { AND: [{ id }, visibleTo(oid)] }, select: SELECT });
  return row ?? undefined;
}

export async function deleteChannel(db: Database, ownerOid: string, id: string): Promise<boolean> {
  if (!isUuid(id)) {
    return false;
  }
  const { count } = await db.channel.deleteMany({ where: { id, ownerOid } });
  return count > 0;
}
