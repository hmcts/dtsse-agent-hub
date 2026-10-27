import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { realtime } from "../../src/realtime/process.ts";
import { connectForChat, type Person, prisma, resetDatabase } from "./database.ts";
import { actAs } from "./web-session.ts";

/**
 * The hooks a suite that drives the Assistant's actions shares: the realtime listener for the run, virtual agents on
 * and the local credential store keyed for each test, an empty database in which every person named has connected
 * GitHub and Claude so `chatGate` lets them chat, and Alice as the viewer.
 *
 * Called at the top level of the suite, after its `vi.mock` calls, so the hooks belong to the file.
 */
export function assistantSuite(people: readonly Person[]): void {
  beforeAll(async () => {
    await realtime().listener.ready();
  });

  beforeEach(async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
    await resetDatabase();
    for (const person of people) {
      await connectForChat(person);
    }
    actAs("alice");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await realtime().listener.stop();
    await prisma.$disconnect();
  });
}
