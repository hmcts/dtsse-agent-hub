import { DEV_PERSONA_COOKIE } from "../../src/viewer/identity.ts";

/**
 * Stands in for the request a server action runs in, through the `next/headers` mock each suite declares. The
 * suite runs with `AUTH_DISABLED=true`, so the viewer is the development persona in this jar, as in a preview.
 */
export const jar = new Map<string, string>();

export function actAs(persona: string): void {
  jar.set(DEV_PERSONA_COOKIE, persona);
}

export const revalidated: string[] = [];

/**
 * The `next/headers` and `next/cache` factories a suite that drives server actions mocks with.
 *
 * Here rather than written out per suite, because this module already owns the jar and the revalidation log the
 * factories reach for. Each suite still declares its own `vi.mock` calls — Vitest hoists those above the imports,
 * per file — but they are one line each: `vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock())`.
 */
export function nextHeadersMock() {
  // A promise rather than an `async` function with nothing to await: `cookies()` is awaited by everything that reads
  // it, so the shape has to match, and there is nothing asynchronous about a map.
  return { cookies: () => Promise.resolve({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }) };
}

export function nextCacheMock() {
  return {
    // A block body, so what this answers is `undefined` like the real `revalidatePath` rather than the new length of
    // the log.
    revalidatePath: (path: string) => {
      revalidated.push(path);
    }
  };
}
