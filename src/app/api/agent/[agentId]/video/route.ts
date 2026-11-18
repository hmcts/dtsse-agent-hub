import { HttpError, json, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkVideoBegin, VIDEO_READ_TTL_MS, VIDEO_UPLOAD_TTL_MS, videoPath } from "@/assistant/video";
import { videoBlobs } from "@/assistant/video-blob";
import { beginVideo, readyVideo } from "@/assistant/video-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireBlobs() {
  const blobs = videoBlobs();
  if (blobs === undefined) {
    throw new HttpError(503, "this hub has no storage for journey videos");
  }
  return blobs;
}

/** The conversation's ready video, with a URL to download it from that lasts `VIDEO_READ_TTL_MS`. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const blobs = requireBlobs();
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const video = await readyVideo(prisma, conversation.id);
  if (video === null) {
    throw new HttpError(404, "the conversation has no journey video");
  }
  const downloadUrl = await blobs.readUrl(videoPath(conversation.id, video.video_id), VIDEO_READ_TTL_MS);
  return json({ ...video, download_url: downloadUrl });
});

/** Records an upload and answers the write-only URL for its MP4. The video is the conversation's once `…/complete` is called. */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = await readJson(request);
  const blobs = requireBlobs();
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkVideoBegin(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const videoId = await beginVideo(prisma, { conversationId: conversation.id, body: checked.value });
  const uploadUrl = await blobs.uploadUrl(videoPath(conversation.id, videoId), VIDEO_UPLOAD_TTL_MS);
  return json({ video_id: videoId, upload_url: uploadUrl, expires_in: VIDEO_UPLOAD_TTL_MS / 1000 });
});
