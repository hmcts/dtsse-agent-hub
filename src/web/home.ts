/** Where `/` goes. Pure, because it is the one decision that makes every other page reachable or not. */

/** The hub's own pages all sit under this prefix, so `/` is free for the default UI. */
const HUB = "/hub";

const ASSISTANT = "/assistant";

/**
 * The HMCTS Assistant is the default UI, so `/` is the Assistant wherever it runs. It runs on a virtual agent, and
 * its pages answer 404 while virtual agents are off, so those deployments get the hub instead.
 */
export function defaultUi(virtualAgents: boolean): string {
  return virtualAgents ? ASSISTANT : HUB;
}
