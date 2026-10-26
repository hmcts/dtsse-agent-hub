/**
 * What this build of the client understands of the hub's optional wire fields, reported on every register so the hub
 * can leave out a field this build would ignore. See the Client features section of `docs/agent-api.md`.
 *
 * The hub and the clients talking to it are released separately, and a field a client has never heard of is not an
 * error it reports: it is dropped on the floor, and the person who caused the hub to send it reads that as success.
 * A hand-maintained list is the whole mechanism — nothing is derived from the package version, which the release
 * workflow sets from the npm feed at publish time and so says nothing about what the code in a build can do.
 */

/**
 * Every feature name the hub and this client have agreed on, whether or not this build claims it. Mirrored by
 * `ClientFeature` in the service's `src/agents/client-features.ts`, which gates on the same names and cannot import
 * from here; keep the two in step, so a name only one side knows is a type error on that side.
 */
export type ClientFeature = "attachments" | "files" | "stop";

/**
 * What this build claims. A name belongs here only once this client reads the field it names, and in the same change
 * that makes it read it: claiming a field it ignores is exactly the silence this list exists to prevent, and claiming
 * nothing while reading a field is the trap the other way round, since a hub that then gates on it drops a field this
 * build would have acted on.
 *
 * `attachments` is claimed because `parseAssistantFrame` carries `raw.attachments` and the bridge fetches each file to
 * disk before it delivers the message.
 *
 * `stop` is claimed because the assistant supervisor acts on the sessions stream's `interrupt` frame, sending `Escape`
 * to the conversation's pane. The hub gates the stop on this claim, so a build that did not claim it offers the person
 * no stop control at all rather than one that does nothing.
 *
 * `files` is claimed because the assistant supervisor reports what its uploads directory holds and acts on the
 * sessions stream's `delete_uploads` frame. The hub gates both on this claim, so a build that did not claim it is
 * told plainly in the settings that it cannot report or delete, rather than shown an empty disk.
 */
export const CLIENT_FEATURES: readonly ClientFeature[] = ["attachments", "files", "stop"];
