/**
 * Where the browser reads one deck's outline and its .pptx, and the conversation's pictures:
 * `src/app/api/ui/assistant/decks/`. Pictures are the conversation's, whichever of its decks names them.
 */
export function deckUrl(conversationId: string, itemId: string): string {
  return `/api/ui/assistant/decks/${encodeURIComponent(conversationId)}/${encodeURIComponent(itemId)}`;
}

export function deckAssetUrl(conversationId: string, sha256: string): string {
  return `/api/ui/assistant/decks/${encodeURIComponent(conversationId)}/assets/${sha256}`;
}

export function deckPptxUrl(conversationId: string, itemId: string, version: number): string {
  return `${deckUrl(conversationId, itemId)}/versions/${version}/pptx`;
}

/** The masters' artwork, which `public/assistant/slides/` serves as the plugin ships it. */
export const backgroundSrc = (image: string): string => `/assistant/slides/${image}`;
