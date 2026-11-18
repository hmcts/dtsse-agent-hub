import { HttpError, noContent, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkVideoPosted, isVideoId } from "@/assistant/video";
import { recordPosted } from "@/assistant/video-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Records that the pod attached the video to a Jira issue, so the panel shows the link on every later visit. */
export const POST = ownedAgentRoute<{ agentId: string; videoId: string }>(async ({ agent, request, params }) => {
  const body = await readJson(request);
  const videoId = params.videoId.toLowerCase();
  if (!isVideoId(videoId)) {
    throw new HttpError(400, "the video id must be the one the upload was given");
  }
  const checked = checkVideoPosted(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await recordPosted(prisma, { conversationId: conversation.id, videoId, issueKey: checked.value.issue_key });
  return noContent();
});
