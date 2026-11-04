/** Where the browser reads a deck's outline, its pictures and its .pptx: `src/app/api/ui/assistant/decks/`. */
export function deckUrl(conversationId: string): string {
  return `/api/ui/assistant/decks/${encodeURIComponent(conversationId)}`;
}

export function deckAssetUrl(conversationId: string, sha256: string): string {
  return `${deckUrl(conversationId)}/assets/${sha256}`;
}

export function deckPptxUrl(conversationId: string, version: number): string {
  return `${deckUrl(conversationId)}/versions/${version}/pptx`;
}

/** The masters' artwork, which `public/assistant/slides/` serves as the plugin ships it. */
export const backgroundSrc = (image: string): string => `/assistant/slides/${image}`;
