/**
 * What this build of the client understands of the hub's optional wire fields, reported on every register, and on every
 * pod status report, so the hub can leave out a field this build would ignore. See the
 * Client features section of `docs/agent-api.md`.
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
export type ClientFeature = "attachments" | "files" | "github-lookups" | "lookups" | "memory-anon" | "model-alias" | "stop" | "welsh" | "welsh-review";

/**
 * What this build claims. A name belongs here only once this client reads the field it names, and in the same change
 * that makes it read it: claiming a field it ignores is exactly the silence this list exists to prevent, and claiming
 * nothing while reading a field is the trap the other way round, since a hub that then gates on it drops a field this
 * build would have acted on.
 *
 * **Adding a name here means changing `features.test.ts` too**, and it will tell you which part. This line and the
 * `ClientFeature` union above are what every such change edits, so two branches adding a feature conflict on them,
 * and a resolution taking either side drops the other's name with nothing to notice: a shorter array of the same type
 * still typechecks. That test is what turns a lost name into a failure.
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
 * `github-lookups` is claimed because the assistant supervisor also answers a `lookup` frame of kind `github_repo`
 * or `github_project`, searching the owner's GitHub repositories or Projects with gh. A build that claims only
 * `lookups` would drop such a frame as one it does not know, so the hub gates the GitHub kinds on this name.
 *
 * `welsh` is claimed because the assistant supervisor answers the sessions stream's `welsh` frame, running
 * the welsh plugin's `scripts/welsh` for the CFT Workspace's Welsh page. The hub gates on it, answering `unsupported`
 * to a pod that did not claim it.
 *
 * `welsh-review` is claimed because the assistant supervisor also runs the `welsh` frame's `request` and
 * `keep_english` kinds: the Welsh Language Unit's spreadsheet of only the strings a BA ticked, and a draft pull
 * request keeping what they left out in English. A build that claims only `welsh` ignores those two, so the hub gates
 * them on this name and answers `unsupported`, which the page reads as "needs an update", rather than a job that
 * times out.
 *
 * `memory-anon` is claimed because the assistant supervisor reads its own container's memory cgroup and reports it,
 * including `anon_bytes` from `memory.stat`, which the hub's memory route requires and computes its low-memory
 * warning from. This is the name the current hub gates the Size section on, so that it can tell a pod that cannot
 * report apart from one that has not reported yet rather than showing either as using none.
 *
 * `model-alias` is claimed because the assistant supervisor starts a session with `--model` from the wake's `model`,
 * the bridge types `/model` into the pane when a message's frame names another, and `parseModel` here takes the hub's
 * bare family alias, `sonnet` or `opus`, and hands it to both unchanged. No write is gated on it: the person's model
 * setting is theirs to save whenever they like. What reads it is the settings' Model section, which says their choice
 * waits for the assistant's next start when its pod's own session did not claim it.
 */
export const CLIENT_FEATURES: readonly ClientFeature[] = [
  "attachments",
  "files",
  "github-lookups",
  "lookups",
  "memory-anon",
  "model-alias",
  "stop",
  "welsh",
  "welsh-review"
];
