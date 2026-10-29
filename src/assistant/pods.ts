/**
 * Whether a conversation runs on a pod. Pure, so every surface asks the same question of the same field.
 *
 * A conversation's `virtualAgentId` is null when it is a person's own local Claude Code session, which runs on their
 * laptop rather than on a virtual agent's pod.
 */

/**
 * Whether the conversation runs on a virtual agent's pod.
 *
 * A type guard rather than a boolean, so narrowing it carries into the body: everything a pod conversation does needs
 * the id — a wake, a launch token, a NOTIFY the pod listens for — and a boolean would leave each of those sites with
 * `string | null` and a non-null assertion beside the check. One guard here is also what makes the compiler, rather
 * than a person reading a screen, the thing that finds the next site added.
 */
export function hasPod<T extends { virtualAgentId: string | null }>(c: T): c is T & { virtualAgentId: string } {
  return c.virtualAgentId !== null;
}
