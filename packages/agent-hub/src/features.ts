/**
 * What this build of the client understands of the hub's optional wire fields, reported on every register so the hub
 * can leave out a field this build would ignore. See the Client features section of `docs/agent-api.md`.
 *
 * The hub and the clients talking to it are released separately, and a field a client has never heard of is not an
 * error it reports: it is dropped on the floor, and the person who caused the hub to send it reads that as success.
 * A hand-maintained list is the whole mechanism — nothing is derived from the package version, which the release
 * workflow sets from the npm feed at publish time and so says nothing about what the code in a build can do.
 */

/** Every feature name the hub and this client have agreed on, whether or not this build claims it. */
export type ClientFeature = "attachments";

/**
 * What this build claims. A name belongs here only once this client reads the field it names, and in the same change
 * that makes it read it: claiming a field it ignores is exactly the silence this list exists to prevent.
 *
 * Empty today, honestly: every field the hub sends this client is one it already reads. The Assistant's file
 * attachments are the first field that will not be — to turn that on, this becomes `["attachments"]` in the change
 * that teaches `parseAssistantFrame` to carry `raw.attachments`, alongside the one conditional named in
 * `assistantFrame` (`src/assistant/store.ts`).
 */
export const CLIENT_FEATURES: readonly ClientFeature[] = [];
