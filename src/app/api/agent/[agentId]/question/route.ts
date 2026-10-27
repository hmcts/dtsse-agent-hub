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
 * Any agent's, not a conversation's alone: an owner watching a pod agent's page gets the same card there.
 */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(questionPostBody, await readJson(request));
  await recordQuestion(prisma, agent, body);
  return noContent();
});
