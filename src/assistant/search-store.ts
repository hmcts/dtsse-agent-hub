import type { AgentStatus } from "../realtime/events.ts";
import type { Database } from "../store/prisma.ts";
import type { SessionState } from "./conversation-row.ts";
import { storedProduct } from "./products.ts";
import { SEARCH_LIMIT, SNIPPET_MAX_WORDS, SNIPPET_MIN_WORDS, searchTerms, visibleMatches } from "./search.ts";

export interface ConversationMatchRow {
  id: string;
  ownerOid: string;
  /** Null for a match that is a session on the owner's own computer, which a result says as the sidebar's list does. */
  virtualAgentId: string | null;
  title: string | null;
  product: string;
  lastActiveAt: Date;
  /** The status of the chat's current agent, as `ConversationListRow` carries it, so a result is marked as a row is. */
  agentStatus: AgentStatus;
  /** What the chat's pod last reported of its session, as `ConversationRow` carries it; null for no session. */
  sessionState: SessionState | null;
  /** The words of a message around the match, when a message rather than the title is why the chat matched. */
  excerpt: string | null;
}

/**
 * The owner's conversations whose title, or one of whose messages, carries every word of `query`; most recently
 * active first, the same order as the sidebar's list, and only those the list would show (`first_content_at`): a local
 * chat with nothing in it still carries its session's name as a title, which a search would otherwise find.
 *
 * Searching what was said and not only the titles is the point: a title is the first sixty characters of the first
 * message until someone renames it, so titles alone answer little more than "what did I open this with". Both halves
 * of the chat are searched, since what the Assistant answered is as much a landmark as what was asked.
 *
 * Every term is its own query, and each may be satisfied by the title or by any one message, so the words a person
 * remembers need not have been said together. `message_direct_body_search_idx` is what makes that affordable: the
 * index answers each term, and the owner's conversations are what the candidates are then joined back to. Nothing is
 * written on send beyond that index entry, and no body is carried out of the database — a result takes the words
 * around its own match through `ts_headline` and leaves the message where it is.
 *
 * A term the English dictionary has nothing to match on, such as "the", leaves `to_tsquery` empty; those are dropped
 * rather than left to refuse every chat. A query of nothing but those matches nothing at all, because `hit` is then
 * crossed with no queries.
 *
 * Transcript entries are left out on purpose. They are the session's whole working-out — tool calls, their results
 * and system lines — which the thread deliberately never shows, so matching them would answer with chats whose only
 * mention of "possession" was a file a search tool happened to open.
 */
export async function searchConversations(db: Database, ownerOid: string, query: string, limit = SEARCH_LIMIT): Promise<ConversationMatchRow[]> {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const rows = await db.$queryRaw<
    {
      id: string;
      ownerOid: string;
      virtualAgentId: string | null;
      title: string | null;
      product: string;
      lastActiveAt: Date;
      agentStatus: AgentStatus | null;
      sessionState: string | null;
      excerpt: string | null;
    }[]
  >`
    WITH query AS (
      -- quote_literal is what makes a typed term safe to put in a query. A single-quoted string in a tsquery is
      -- re-lexed by the text-search parser, and several tokens out of one become a phrase, joined by <->, never
      -- boolean operators: so quoting a term can only narrow what it matches, and can never widen or negate it.
      -- It holds only on quote_literal's plain '…' form, which is why searchTerms has already taken the backslashes
      -- out: one of those switches it to E'…', which is not valid tsquery input at all. An empty query is a term the
      -- dictionary has nothing to match on, which is dropped rather than left to refuse every chat.
      SELECT n, tsq
        FROM unnest(${terms}::text[]) WITH ORDINALITY AS u(term, n),
             LATERAL (SELECT to_tsquery('english', quote_literal(u.term) || ':*') AS tsq) q
       WHERE tsq <> ''::tsquery
    ),
    owned AS (
      -- LEFT JOIN, with the null counted in: a conversation with no pod is one of the viewer's own chats and is
      -- searchable like any other. An inner join would drop every local chat from the sidebar's search, since there
      -- is no virtual_agent row for it to match. The current agent is joined the same way and for the same reason:
      -- a chat with no agent yet is still a chat, and its status reads as offline.
      SELECT c.id, c.owner_oid, c.virtual_agent_id, c.title, c.product, c.last_active_at, cur.status::text AS agent_status, c.session_state
        FROM assistant_conversation c
        LEFT JOIN virtual_agent v ON v.id = c.virtual_agent_id
        LEFT JOIN agent cur ON cur.id = c.agent_id
       WHERE c.owner_oid = ${ownerOid} AND (v.id IS NULL OR v.desired <> 'deleted')
         AND c.first_content_at IS NOT NULL
    ),
    in_body AS (
      SELECT DISTINCT ON (o.id, q.n) o.id AS conversation_id, q.n, m.body
        FROM query q
        JOIN message m ON m.kind = 'direct' AND to_tsvector('english', m.body) @@ q.tsq
        JOIN agent a ON m.target_agent_id = a.id OR m.author_agent_id = a.id
        JOIN owned o ON o.id = a.assistant_conversation_id
       ORDER BY o.id, q.n, m.id DESC
    ),
    hit AS (
      SELECT o.id, q.n, q.tsq, b.body
        FROM owned o
       CROSS JOIN query q
        LEFT JOIN in_body b ON b.conversation_id = o.id AND b.n = q.n
       WHERE to_tsvector('english', COALESCE(o.title, '')) @@ q.tsq OR b.body IS NOT NULL
    )
    SELECT o.id::text AS id, o.owner_oid AS "ownerOid", o.virtual_agent_id::text AS "virtualAgentId", o.title, o.product,
           o.last_active_at AS "lastActiveAt", o.agent_status AS "agentStatus", o.session_state AS "sessionState", e.excerpt
      FROM owned o
      JOIN (SELECT id FROM hit GROUP BY id HAVING count(*) = (SELECT count(*) FROM query)) matched ON matched.id = o.id
      LEFT JOIN LATERAL (
        SELECT ts_headline('english', h.body, h.tsq, ${`StartSel="", StopSel="", MaxWords=${SNIPPET_MAX_WORDS}, MinWords=${SNIPPET_MIN_WORDS}, MaxFragments=1`}) AS excerpt
          FROM hit h
         WHERE h.id = o.id AND h.body IS NOT NULL
         ORDER BY h.n
         LIMIT 1
      ) e ON TRUE
     ORDER BY o.last_active_at DESC, o.id
     LIMIT ${limit}
  `;
  // Nothing leaves the store carrying a product the list no longer offers, as `toRow` does for a whole conversation.
  return visibleMatches(
    ownerOid,
    rows.map((row) => ({
      ...row,
      product: storedProduct(row.product),
      agentStatus: row.agentStatus ?? "offline",
      sessionState: row.sessionState === "starting" || row.sessionState === "live" || row.sessionState === "queued" ? row.sessionState : null
    }))
  );
}
