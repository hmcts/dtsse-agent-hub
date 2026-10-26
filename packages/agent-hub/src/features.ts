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
export type ClientFeature = "attachments" | "files" | "lookups" | "memory" | "memory-anon" | "stop";

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
 *
 * `lookups` is claimed because the assistant supervisor answers the sessions stream's `lookup` frame, searching the
 * owner's Jira or Confluence with twg. The hub gates on it, answering `unsupported` to a pod that did not claim it.
 *
 * `memory-anon` is claimed because the assistant supervisor reads its own container's memory cgroup and reports it,
 * including `anon_bytes` from `memory.stat`, which the hub's memory route requires and computes its low-memory
 * warning from. This is the name the current hub gates the Size section on, so that it can tell a pod that cannot
 * report apart from one that has not reported yet rather than showing either as using none.
 *
 * `memory` is claimed **for hubs older than `memory-anon`**, and for nothing else. No gate in the current hub reads
 * it. It is here because this list travels in the other direction too: the client is published on merge and a pod
 * installs the current one when it boots, so a build can be talking to a hub that has not deployed yet, and that
 * hub's Size section gates on `memory`. Dropping it would make such a pod read as an older client to the one hub
 * that still cares. It can go once no hub predating `anon_bytes` is running anywhere.
 */
export const CLIENT_FEATURES: readonly ClientFeature[] = ["attachments", "files", "lookups", "memory", "memory-anon", "stop"];
