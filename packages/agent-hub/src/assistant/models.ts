// Which Claude model a conversation's session runs on: the hub's model id, as the wake and every message frame carry
// it, turned into what `hai` hands Claude Code as `--model` or `/model` on the route this pod runs.
import type { Env } from "../env.ts";
import { readText, statePath } from "../session.ts";
import { type Tmux, tmuxName } from "./tmux.ts";

/**
 * The shape of a model id the hub may send: `claude-<family>-<version>`. Checked here as well as on the hub because
 * the id goes onto a command line and into a pane as keys, and checked by shape rather than against a list so that a
 * model the hub starts offering works on a pod that booted with an older client.
 */
const MODEL_RE = /^claude-[a-z]+-[0-9]+(-[0-9]+)?$/;

/** The families whose Bedrock profile hai runs with the 1M-token context, which `[1m]` asks Claude Code for. */
const LONG_CONTEXT = /^claude-(opus|sonnet)-/;

/** The model id on a wake or a frame, or null for one that is missing or not the shape of an id. */
export function parseModel(value: unknown): string | null {
  return typeof value === "string" && MODEL_RE.test(value) ? value : null;
}

/**
 * The cross-region inference profile prefix for the Bedrock region a pod's sessions run in. hai calls Bedrock in
 * `eu-west-2` unless `AWS_REGION` says otherwise, and a profile in another geography is refused there. Null for a
 * region with no known prefix, where naming any model would be a guess.
 */
function bedrockPrefix(region: string | undefined): string | null {
  const name = region === undefined || region === "" ? "eu-west-2" : region;
  if (name.startsWith("eu-")) {
    return "eu";
  }
  if (name.startsWith("us-")) {
    return "us";
  }
  if (name.startsWith("ap-")) {
    return "apac";
  }
  return null;
}

/**
 * What the launcher is given for a model: the id itself on the person's own Claude licence, and on Amazon Bedrock the
 * region's inference profile, `eu.anthropic.claude-sonnet-5-5[1m]` — the same shape as the defaults hai sets for each
 * family, so picking Sonnet gives the session exactly what it would have run on by default. Null when the id is not
 * one or the region has no profile, which leaves the session on hai's own default rather than on a model that fails.
 *
 * The route is `AGENT_HUB_MODEL_ROUTE`, which the entrypoint exports before the supervisor starts; anything but
 * `own_licence` is Bedrock, as it is in the entrypoint.
 */
export function launcherModel(model: string | null, env: Env = process.env): string | null {
  if (model === null || !MODEL_RE.test(model)) {
    return null;
  }
  if (env.AGENT_HUB_MODEL_ROUTE === "own_licence") {
    return model;
  }
  const prefix = bedrockPrefix(env.AWS_REGION);
  if (prefix === null) {
    return null;
  }
  return `${prefix}.anthropic.${model}${LONG_CONTEXT.test(model) ? "[1m]" : ""}`;
}

/** Where a session's current model is kept: the hub's id, written when it starts on it and when it is switched. */
export const modelPath = (sid: string) => statePath(sid, "assistant-model");

/**
 * How long a pane is given to act on `/model` before the message is delivered. The two travel separately — keys
 * through tmux, the message through Claude Code's messaging socket — so without a pause the message could be read
 * first and answered by the previous model.
 */
export const MODEL_SETTLE_MS = 1000;

export type SwitchModelOptions = {
  sid: string;
  conversationId: string | undefined;
  model: string | null;
  env?: Env;
  tmux: Pick<Tmux, "sendKeys">;
  write: (file: string, text: string) => void;
  settleMs?: number;
  say?: (message: string) => void;
};

export type SwitchOutcome = "unchanged" | "switched" | "skipped" | "failed";

/**
 * Puts the conversation's session on `model` before a message is delivered to it, with `/model` typed into its pane:
 * the same command its own keyboard would use, which changes the model for the next turn and keeps the conversation.
 *
 * Nothing is done when the session is already on it, which is every message but the first after a change. The model
 * is recorded only once the keys have gone, so a switch that failed is tried again with the next message rather than
 * believed to have happened; the message itself is delivered either way, on whatever model the session is on.
 */
export async function switchModel({
  sid,
  conversationId,
  model,
  env = process.env,
  tmux,
  write,
  settleMs = MODEL_SETTLE_MS,
  say = () => {}
}: SwitchModelOptions): Promise<SwitchOutcome> {
  if (model === null || conversationId === undefined || readText(modelPath(sid)) === model) {
    return "unchanged";
  }
  const launched = launcherModel(model, env);
  if (launched === null) {
    say(`not switching to ${model}: no launcher model for it on this route`);
    return "skipped";
  }
  const name = tmuxName(conversationId);
  try {
    // `-l` sends the text as characters, so nothing in it is read as the name of a key.
    await tmux.sendKeys(name, "-l", `/model ${launched}`);
    await tmux.sendKeys(name, "Enter");
  } catch (e) {
    say(`could not switch to ${model}: ${(e as Error).message}`);
    return "failed";
  }
  try {
    write(modelPath(sid), `${model}\n`);
  } catch (e) {
    say(`switched to ${model} but could not record it: ${(e as Error).message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  say(`switched the session to ${model} (${launched})`);
  return "switched";
}
