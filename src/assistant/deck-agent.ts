import { HttpError, json, noContent, parse, readJson } from "../agent-api/http.ts";
import type { AgentRow } from "../agents/store.ts";
import { prisma } from "../store/prisma.ts";
import { UUID_RE } from "./artefact-store.ts";
import { requireConversationOfAgent } from "./conversation-store.ts";
import { checkOutline, deckPutBody, isPptx, KEEP_PPTX, MAX_PPTX_BYTES } from "./deck.ts";
import { versionParam } from "./deck-build.ts";
import { readDeckVersionOutline } from "./deck-history-store.ts";
import { type Deck, DeckConflict, listDeckSummaries, putDeckPptx, readDeck, readDeckItem, removeDeck, writeDeck } from "./deck-store.ts";
import { readBytes } from "./upload-body.ts";

/**
 * What `/api/agent/{id}/deck`, which reads and writes the conversation's primary deck, and `/decks/{itemId}`, which
 * names one, both answer: `item` is the deck's id, or `undefined` for the primary.
 */

const MISSING = "the conversation has no such deck";

/** The id in a path, or a 404 for what no deck can have. */
export function deckId(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new HttpError(404, MISSING);
  }
  return value;
}

function deckBody(deck: Deck) {
  return {
    ...(deck.id === "" ? {} : { id: deck.id }),
    title: deck.title,
    outline: deck.outline,
    version: deck.version,
    revision: deck.revision,
    updated_by: deck.updatedBy,
    updated_at: deck.updatedAt?.toISOString() ?? null,
    pptx: deck.pptx
  };
}

/** The latest version, or with `?version=N` one kept version, with the version the deck is at now. */
export async function getDeck(agent: AgentRow, request: Request, item?: string): Promise<Response> {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const latest = item === undefined ? await readDeck(prisma, conversation.id) : await readDeckItem(prisma, conversation.id, item);
  if (latest === undefined) {
    throw new HttpError(404, MISSING);
  }
  const asked = new URL(request.url).searchParams.get("version");
  if (asked === null) {
    return json(deckBody(latest));
  }
  const version = versionParam(asked);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const found = latest.id === "" ? undefined : await readDeckVersionOutline(prisma, latest.id, version);
  if (found === undefined) {
    throw new HttpError(404, `the deck does not keep version ${version}`);
  }
  return json({
    id: latest.id,
    title: found.title,
    outline: found.outline,
    version: found.version,
    updated_by: found.by,
    updated_at: found.updated_at,
    pptx: found.pptx,
    latest_version: latest.version
  });
}

/**
 * Writes the deck: the primary (made at base 0 while there is none), the one `item` names, or, with `create`, a new
 * one. A new deck answers `201`.
 */
export async function putDeck(agent: AgentRow, request: Request, target: { item?: string; create?: boolean }): Promise<Response> {
  const body = parse(deckPutBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  if (target.create === true && body.base_version !== 0) {
    throw new HttpError(400, "base_version must be 0 for a new deck");
  }
  const checked = checkOutline(body.outline);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  try {
    const written = await writeDeck(prisma, conversation, {
      outline: checked.outline,
      baseVersion: body.base_version,
      ...(body.base_revision === undefined ? {} : { baseRevision: body.base_revision }),
      by: "agent",
      summary: body.summary ?? null,
      ...(target.item === undefined ? {} : { itemId: target.item }),
      ...(target.create === true ? { create: true } : {})
    });
    return json(written, target.create === true ? 201 : 200);
  } catch (error) {
    if (error instanceof DeckConflict) {
      throw new HttpError(409, error.message, { current: deckBody(error.current) });
    }
    throw error;
  }
}

/** Every deck of the conversation, oldest first, without its outline. */
export async function listDecks(agent: AgentRow): Promise<Response> {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const decks = await listDeckSummaries(prisma, conversation.id);
  return json({
    decks: decks.map((deck) => ({
      id: deck.id,
      title: deck.title,
      version: deck.version,
      revision: deck.revision,
      updated_by: deck.updatedBy,
      pptx: deck.pptx
    }))
  });
}

export async function deleteDeck(agent: AgentRow, item: string): Promise<Response> {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await removeDeck(prisma, conversation, item);
  return noContent();
}

/** The .pptx the pod built from one version of the deck `item` names, or of the primary. */
export async function putPptx(agent: AgentRow, request: Request, versionText: string, item?: string): Promise<Response> {
  const version = versionParam(versionText);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_PPTX_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a .pptx is at most ${MAX_PPTX_BYTES} bytes`) : error;
  });
  if (!isPptx(bytes)) {
    throw new HttpError(400, "that is not a .pptx");
  }
  const deck = item === undefined ? await readDeck(prisma, conversation.id) : await readDeckItem(prisma, conversation.id, item);
  const result = deck === undefined || deck.id === "" ? "no_such_version" : await putDeckPptx(prisma, conversation, deck.id, version, bytes);
  if (result === "no_such_version") {
    throw new HttpError(404, "the deck has no such version");
  }
  if (result === "too_old") {
    throw new HttpError(409, `only the latest ${KEEP_PPTX} versions of a deck keep their .pptx`);
  }
  return noContent();
}
