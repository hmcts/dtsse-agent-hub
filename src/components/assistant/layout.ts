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

/**
 * The two widths at which a panel stops being a column of the row. They differ because the panels leave the row at
 * different sizes: the sidebar becomes a drawer over the page at the Tailwind `md` breakpoint, while the document
 * panel keeps its column for longer and then covers the page. Both are read by whatever reserves room for a panel,
 * so nothing keeps back a column's width for a panel that has become an overlay.
 */
export const SIDEBAR_DRAWER_MAX_WIDTH = 767;
export const ARTEFACT_OVERLAY_MAX_WIDTH = 900;

/**
 * The width at which the settings dialog has room for its navigation beside a section; below it the navigation
 * becomes a list the person drills into. Tailwind's `sm` breakpoint itself, so this and the dialog's own `sm:`
 * classes switch at the same width rather than a pixel apart.
 */
export const SETTINGS_TWO_PANE_MIN_WIDTH = 640;

/** Pixels the row keeps for the columns to the sidebar's right at a given window width. */
export function besideSidebar(viewport: number): number {
  return CHAT_MIN_WIDTH + (viewport > ARTEFACT_OVERLAY_MAX_WIDTH ? ARTEFACT_MIN_WIDTH : 0);
}
