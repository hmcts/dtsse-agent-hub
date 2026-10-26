import { ensureAssistant } from "../../src/assistant/store.ts";
import { devIdentity, type Viewer } from "../../src/viewer/identity.ts";
import { insertUser, type Person, prisma } from "./database.ts";

/**
 * The scaffolding every suite about an assistant's own pod needs: who is signed in, and an assistant with a
 * supervisor session whose client claims whatever the suite is about.
 *
 * Shared because the setup is the same question each time — "a running pod whose own session claims X" — and three
 * copies of it had already drifted in their defaults. What each suite keeps is its `vi.mock` calls, which Vitest
 * hoists per file, and the fixtures that are about its own feature.
 */

/** A development persona, as the `X-Dev-User` header and the persona cookie name one. */
export function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

export const ALICE = persona("alice");
export const BOB = persona("bob");

/** That persona as a page's viewer. Every one of these suites runs with `AUTH_DISABLED=true`. */
export function viewer(who: Person): Viewer {
  return { ...who, tid: "dev", modelRoute: "own-licence" };
}

export interface PodSession {
  /** Whether a supervisor session has ever registered. Without one nothing has claimed anything either way. */
  session?: boolean;
}

/**
 * The person's assistant, with its own session registered as its current agent — which is where a client-feature
 * claim lives, because the supervisor is what reports and what acts on the sessions stream, not a conversation's
 * session.
 *
 * `features` is explicit rather than defaulted: which feature a suite is about is the whole point of the fixture,
 * and `null` is a client from before client features existed, which is a different state from claiming none.
 */
export async function assistantOf(
  who: Person,
  features: string[] | null,
  status: "running" | "stopped" = "running",
  { session = true }: PodSession = {}
): Promise<string> {
  await insertUser(who);
  const assistant = await ensureAssistant(prisma, viewer(who));
  if (!session) {
    await prisma.virtualAgent.update({ where: { id: assistant.id }, data: { status } });
    return assistant.id;
  }
  const agent = await prisma.agent.create({
    data: {
      ownerOid: who.oid,
      sessionId: `${who.oid}-pod`,
      name: "assistant",
      virtualAgentId: assistant.id,
      ...(features === null ? {} : { clientFeatures: features })
    },
    select: { id: true }
  });
  await prisma.virtualAgent.update({ where: { id: assistant.id }, data: { status, agentId: agent.id } });
  return assistant.id;
}

export type AssistantFixture = (who: Person, features?: string[] | null, status?: "running" | "stopped", options?: PodSession) => Promise<string>;

/**
 * `assistantOf` bound to the client feature a suite is about, so each of its call sites says only who and in what
 * state. `null` still means a client from before client features existed, since that is not the same as `undefined`.
 */
export function podFixture(claimed: string[]): AssistantFixture {
  return (who, features = claimed, status = "running", options = {}) => assistantOf(who, features, status, options);
}

/** A server action's form. */
export function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}
