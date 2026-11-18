import { HttpError, json } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { isVideoId, videoPath } from "@/assistant/video";
import { videoBlobs } from "@/assistant/video-blob";
import { deleteReplacedBlobs, finishVideo, uploadOf } from "@/assistant/video-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Makes an upload the conversation's video once its blob is in storage at the size the upload declared. A blob that is
 * missing or the wrong size is a 409, and the upload stays open for the session to put it again.
 */
export const POST = ownedAgentRoute<{ agentId: string; videoId: string }>(async ({ agent, params }) => {
  const blobs = videoBlobs();
  if (blobs === undefined) {
    throw new HttpError(503, "this hub has no storage for journey videos");
  }
  const videoId = params.videoId.toLowerCase();
  if (!isVideoId(videoId)) {
    throw new HttpError(400, "the video id must be the one the upload was given");
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const declared = await uploadOf(prisma, conversation.id, videoId);
  if (declared === undefined) {
    throw new HttpError(404, "that upload is not one of this conversation's");
  }
  const stat = await blobs.statOf(videoPath(conversation.id, videoId));
  if (stat === undefined) {
    throw new HttpError(409, "the video has not been put to the upload URL yet");
  }
  if (stat.size !== declared.bytes) {
    throw new HttpError(409, `the video in storage is ${stat.size} bytes and the upload declared ${declared.bytes}`);
  }
  const { replaced } = await finishVideo(prisma, { conversationId: conversation.id, videoId, etag: stat.etag });
  await deleteReplacedBlobs(blobs, conversation.id, replaced);
  return json({ video_id: videoId });
});
