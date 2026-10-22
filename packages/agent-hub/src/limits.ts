// The limits the hub enforces and the client must not exceed, kept here so a fixture can use them without
// pulling in the module that owns the request.

// `POST /api/agent/{id}/posts` refuses a post with more than this many topics.
export const MAX_POST_TOPICS = 10;
