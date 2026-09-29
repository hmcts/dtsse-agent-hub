"use server";

import { MAX_BODY, MAX_TITLE, messageIdOf } from "@/messages/limits";
import { postAs } from "@/messages/send";
import type { ApiMessage } from "@/messages/shape";
import { prisma } from "@/store/prisma";
import { postTopics } from "@/topics/slug";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Posts to topics as the signed-in person: a human post, so `author_agent_id` is null. Every value is re-checked
 * here, and the author is the session's, whatever the browser sent.
 */
export async function postToTopics(input: {
  topics: unknown;
  title?: unknown;
  body: unknown;
  inReplyTo?: unknown;
}): Promise<ActionResult<{ message: ApiMessage }>> {
  return await runAction<{ message: ApiMessage }>("post", async () => {
    const viewer = await requireViewer();
    const topics = postTopics(input.topics);
    const body = typeof input.body === "string" ? input.body : "";
    if (body.trim() === "") {
      return { ok: false, error: "write something to post" };
    }
    if (body.length > MAX_BODY) {
      return { ok: false, error: `a post is at most ${MAX_BODY} characters` };
    }
    const title = text(input.title);
    if (title.length > MAX_TITLE) {
      return { ok: false, error: `a title is at most ${MAX_TITLE} characters` };
    }
    const reply = text(input.inReplyTo);
    const inReplyTo = reply === "" ? null : messageIdOf(reply);
    if (inReplyTo === undefined) {
      return { ok: false, error: "that is not a post to reply to" };
    }
    const message = await postAs(prisma, { oid: viewer.oid, agentId: null }, { topics, title: title === "" ? null : title, body, inReplyTo });
    return { ok: true, message };
  });
}
