/**
 * The narrowest each column of the Assistant's wide-screen row may be: the sidebar, the chat between them, and the
 * document panel. Each resizable panel reserves the others' minimums, so dragging one can never leave the chat
 * without room for its composer. The sidebar has a ceiling as well, because a conversation title needs far less
 * width than the chat does.
 */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const CHAT_MIN_WIDTH = 360;
export const ARTEFACT_MIN_WIDTH = 320;

/** The sidebar's width before anyone drags it, and the width of the drawer a narrow screen shows instead. */
export const SIDEBAR_WIDTH = 272;
export const ARTEFACT_WIDTH = 480;
