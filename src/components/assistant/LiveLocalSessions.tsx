"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { LOCAL_SESSION, type LocalSession } from "@/assistant/local-session";
import { useHubEvent } from "@/components/live/HubStream";
import type { AgentStatus } from "@/realtime/events";

/** A status that arrived live, and the server's mark for the chat at the moment it did. */
interface Live {
  session: LocalSession;
  over: LocalSession | undefined;
}

const NONE: ReadonlyMap<string, LocalSession> = new Map();

const LiveSessions = createContext<ReadonlyMap<string, LocalSession>>(NONE);

/** The live state of each chat whose live status still holds, keyed by conversation. */
function holding(live: ReadonlyMap<string, Live>): ReadonlyMap<string, LocalSession> {
  return new Map([...live].map(([id, entry]) => [id, entry.session]));
}

/**
 * The sessions of the person's chats on their own computer as their `agent_status` frames arrive, for every mark
 * under it: the sidebar's rows and the search's results. One subscription for the whole list, however many rows.
 *
 * `served` is the server render's state for each local chat in the list. A live status holds while the server still
 * says what it said when the status arrived; once a re-read brings anything else, that re-read is the newer and the
 * live status is dropped for good, so a later re-read that happens to bring back the earlier mark cannot revive it. A
 * re-read that brings the same mark may have been read before the change committed, so the status stays. A status
 * missed while disconnected arrives with the `resync` re-read.
 *
 * Nothing announces a change: a list of sessions flipping between busy and idle read out at every turn would drown
 * out the chat. The words a mark says change with its colour, since both are drawn from the one state.
 */
export function LiveLocalSessions({ served, children }: { served: ReadonlyMap<string, LocalSession>; children: React.ReactNode }) {
  const [live, setLive] = useState<ReadonlyMap<string, Live>>(new Map());
  const [seen, setSeen] = useState(served);
  if (seen !== served) {
    setSeen(served);
    setLive((current) => new Map([...current].filter(([id, entry]) => entry.over === served.get(id))));
  }
  useHubEvent<{ conversation_id: string | null; status: AgentStatus }>("agent_status", ({ conversation_id, status }) => {
    if (conversation_id !== null) {
      setLive((current) => new Map(current).set(conversation_id, { session: LOCAL_SESSION[status], over: served.get(conversation_id) }));
    }
  });
  const sessions = useMemo(() => holding(live), [live]);
  return <LiveSessions.Provider value={sessions}>{children}</LiveSessions.Provider>;
}

/** The live state of a local chat's session, when one has arrived and still holds. */
export function useLiveLocalSession(conversationId: string): LocalSession | undefined {
  return useContext(LiveSessions).get(conversationId);
}
