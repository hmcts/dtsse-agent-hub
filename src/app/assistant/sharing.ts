import { readSharedChats } from "@/app/_actions/assistant-settings";
import { offerChatFork, withdrawChatFork } from "@/app/_actions/forks";
import { shareChat, unshareChat } from "@/app/_actions/shares";
import type { AssistantSharing } from "@/components/assistant/SharingSettings";

/** What the settings' Sharing section reads its lists through and changes who a chat is shared with or offered to by. */
export const SHARING_SETTINGS: AssistantSharing = {
  load: readSharedChats,
  share: shareChat,
  unshare: unshareChat,
  offer: offerChatFork,
  withdraw: withdrawChatFork
};
