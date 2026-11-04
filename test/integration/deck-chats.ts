// The people, conversations and pictures the deck integration tests share. A test file mocks `next/headers` and
// `next/cache` itself; the web session and the actions are imported here only when a chat is started, so they load
// with those mocks in place.
import { createHash } from "node:crypto";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { imageInfo } from "../../src/assistant/deck.ts";
import { putDeckAsset } from "../../src/assistant/deck-store.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { type Person, prisma } from "./database.ts";

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

export const ALICE = persona("alice");
export const BOB = persona("bob");
export const CAROL = persona("carol");

export const viewerOf = (who: Person) => ({ ...who, tid: "dev", modelRoute: "own-licence" as const });

/** The first bytes of a zip, which is all the hub checks a .pptx for. */
export const PPTX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

export interface Chat {
  id: string;
  agentId: string;
  virtualAgentId: string;
  row: { id: string; virtualAgentId: string | null; ownerOid: string };
}

/** A conversation of Alice's on her assistant, started as she would start one. */
export async function chat(): Promise<Chat> {
  const { actAs } = await import("./web-session.ts");
  const assistantActions = await import("../../src/app/_actions/assistant.ts");
  actAs("alice");
  await ensureAssistant(prisma, viewerOf(ALICE));
  const started = await assistantActions.startConversation({ product: "general", body: "Make me some slides" });
  const id = (started as { ok: true; id: string }).id;
  const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id }, select: { agentId: true, virtualAgentId: true, ownerOid: true } });
  return { id, agentId: row.agentId!, virtualAgentId: row.virtualAgentId!, row: { id, virtualAgentId: row.virtualAgentId, ownerOid: row.ownerOid } };
}

/** A 640 × 320 PNG header, made distinct by `seed` so each one hashes differently. */
export function png(seed: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(320, 20);
  bytes.writeUInt32BE(seed, 28);
  return bytes;
}

export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Stores a picture for the chat's deck, as an upload would, and gives its sha256. */
export async function store(of: Chat, bytes: Buffer): Promise<string> {
  const sha = digest(bytes);
  await putDeckAsset(prisma, of.id, sha, bytes, imageInfo(bytes)!);
  return sha;
}
