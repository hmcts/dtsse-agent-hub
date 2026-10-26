import { byCodePoint } from "../topics/slug.ts";

/**
 * What the client an agent's session runs claimed it understands of this hub's optional wire fields: the ones a
 * client that has never heard of them does not read. See the Client features section of `docs/agent-api.md`.
 *
 * The hub and its clients are released separately, so a field the hub adds is not understood everywhere at once, and
 * a client that ignores one reports nothing — the person who caused the hub to send it reads the silence as success.
 * These names are what lets the hub leave such a field out instead.
 *
 * `null` is the whole of the backwards compatibility: a client from before any of this existed reports nothing, which
 * claims nothing, so there is no flag to set and nothing to adopt.
 */

/**
 * Every feature name the hub and the published client have agreed on, so a gate naming one neither side defines is a
 * type error rather than a `false` that looks exactly like "no client claims it yet".
 *
 * Mirrored by hand from `ClientFeature` in `packages/agent-hub/src/features.ts`, because the hub does not depend on
 * the client package. Reported names are *not* checked against it: an unrecognised one is kept, since it is a newer
 * client claiming a field a later hub will send.
 */
export type ClientFeature = "attachments" | "files" | "lookups" | "memory" | "memory-anon" | "stop";

export const MAX_CLIENT_FEATURES = 50;
export const MAX_CLIENT_FEATURE_NAME = 50;
export const CLIENT_FEATURE_NAME = /^[a-z0-9][a-z0-9:_-]*$/;

/**
 * Sorted and de-duplicated, with anything that is not a valid name dropped.
 *
 * Dropped rather than refused, unlike a bad skill name: a name this hub does not recognise is a *newer* client
 * claiming a field some later hub will send, and refusing its registration would lock that session out of the hub
 * entirely instead of leaving it one field short.
 */
export function normaliseClientFeatures(values: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.length <= MAX_CLIENT_FEATURE_NAME && CLIENT_FEATURE_NAME.test(value)) {
      names.add(value);
    }
  }
  return [...names].sort(byCodePoint);
}

/**
 * The stored column, read defensively. `null` when the column holds no array, which is a client that reported
 * nothing: every client from before `client_features` existed, and any row written before this column did.
 */
export function storedClientFeatures(value: unknown): string[] | null {
  return Array.isArray(value) ? normaliseClientFeatures(value.slice(0, MAX_CLIENT_FEATURES)) : null;
}

/**
 * Whether the client that registered this agent's session claimed `feature`, and so will read a field that depends
 * on it. Takes the stored column so a caller that has selected `clientFeatures` needs nothing else.
 *
 * A client that reported nothing claims nothing: the answer for an old client is the same `false` as for a current
 * one without the feature, which is what makes absence a usable signal rather than a case to special-case.
 */
export function clientSupports(stored: unknown, feature: ClientFeature): boolean {
  return storedClientFeatures(stored)?.includes(feature) === true;
}
