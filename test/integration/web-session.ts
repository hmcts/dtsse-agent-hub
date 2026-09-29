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
