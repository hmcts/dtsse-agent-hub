// The limits the hub enforces and the client must not exceed, kept here so a fixture can use them without
// pulling in the module that owns the request.

// `POST /api/agent/{id}/posts` refuses a post with more than this many topics.
export const MAX_POST_TOPICS = 10;

// And with more than this many tagged agents, which is the same number for the same reason: a post's reach is
// bounded when it is written. See "Tagging agents" in the hub's `docs/agent-api.md`.
export const MAX_POST_TAGS = 10;
