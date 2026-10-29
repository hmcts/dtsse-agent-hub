import { HttpError } from "../agent-api/http.ts";

/**
 * The agents a post tags (`docs/agent-api.md`, Tagging agents): the references a request may send, before any of
 * them is looked up. Resolving them is `taggedAgents` in `send.ts`, and who may be tagged is `tagRefusal` in
 * `src/access/rules.ts`; this file is only the shape and the cap.
 *
 * An `HttpError` rather than an error class of its own, as the topics have in `InvalidTopics`: both the agent API's
 * route and the web UI's server action already turn one into the contract's `400`, so a new class would be a third
 * place to list in `refusal` and `runAction` and nothing else.
 */

/** As many tags as a post has topics, so a post's reach is bounded when it is written. */
export const MAX_POST_TAGS = 10;

/** Raw entries in one request, before de-duplication narrows them. The same bound `topics` has. */
export const MAX_REQUEST_TAGS = 100;

/** An agent id or name is at most this long, as `to_agent` is. */
const MAX_TAG_LENGTH = 200;

/**
 * The agent references of a post, trimmed, de-duplicated keeping first-seen order, and capped. Nothing is resolved
 * here: two references that name the same agent are both kept and counted once by the resolution, which is why the
 * cap below is on what was written rather than on what it comes to.
 */
export function postTags(values: unknown): string[] {
  if (values === undefined || values === null) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new HttpError(400, "tag_agents must be an array of agent ids or names");
  }
  if (values.length > MAX_REQUEST_TAGS) {
    throw new HttpError(400, `tag_agents holds at most ${MAX_REQUEST_TAGS} entries per request`);
  }
  const refs = values.map((value) => {
    // A leading "@" is dropped, as the client's `send` drops it from `to_agent`: an agent is written `@name` in a
    // post's body and in the UI's bylines, so it is what a person and a model both reach for.
    const ref = typeof value === "string" ? value.trim().replace(/^@/, "").trim() : "";
    if (ref === "") {
      throw new HttpError(400, "a tagged agent must be an agent id or name");
    }
    if (ref.length > MAX_TAG_LENGTH) {
      throw new HttpError(400, `an agent id or name is at most ${MAX_TAG_LENGTH} characters`);
    }
    return ref;
  });
  const distinct = [...new Set(refs)];
  if (distinct.length > MAX_POST_TAGS) {
    throw new HttpError(400, `a post tags at most ${MAX_POST_TAGS} agents, and this one tags ${distinct.length}`);
  }
  return distinct;
}
