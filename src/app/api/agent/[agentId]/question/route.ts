import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { questionPostBody } from "@/questions/questions";
import { recordQuestion } from "@/questions/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A question this session's model asked with `AskUserQuestion`, which the client's `PreToolUse` hook intercepted
 * because nobody is at that keyboard. The owner reads it as a card in the chat and answers with an ordinary message.
 *
 * Any agent with a chat in the Assistant, not a pod conversation's alone, since the hook runs in every session and the
 * card shows in that chat. An agent with none is refused with `409`, as a second question is.
 *
 * `204` covers two of `recordQuestion`'s four outcomes — the question written, and the same question posted again,
 * which is already on screen. Both mean the hook may tell the model to wait for an answer. The other two refuse with
 * the `409` their errors carry, because nothing was written and the model has to ask in words instead.
 */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(questionPostBody, await readJson(request));
  await recordQuestion(prisma, agent, body);
  return noContent();
});
