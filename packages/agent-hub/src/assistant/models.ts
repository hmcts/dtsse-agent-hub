// Which Claude model a conversation's session runs on: the hub's model id, as the wake and every message frame carry
// it, handed to `hai` as `--model` or typed into the pane as `/model`.
import { readText, statePath } from "../session.ts";
import { type Tmux, tmuxName } from "./tmux.ts";

/**
 * The shape of a model id the hub may send: a bare family alias, `sonnet` or `opus`. Checked here as well as on the
 * hub because the id goes onto a command line and into a pane as keys, and checked by shape rather than against a
 * list so that a family the hub starts offering works on a pod that booted with an older client.
 *
 * Letters alone, which is what rules out the versioned ids an older hub sends (`claude-sonnet-5-5`). Those are not
 * aliases hai pins a version for, so on Bedrock one would reach Claude Code as a model id that does not exist there
 * and fail every turn; refusing it leaves the session on hai's default, which is the family the person asked for.
 */
const MODEL_RE = /^[a-z]{1,32}$/;

/** The model id on a wake or a frame, or null for one that is missing or not the shape of an id. */
export function parseModel(value: unknown): string | null {
  return typeof value === "string" && MODEL_RE.test(value) ? value : null;
}

/**
 * What the launcher is given for a model: the id itself, on both model routes. Nothing is prefixed or suffixed here
 * because hai pins the version of each family in the pod — it exports `ANTHROPIC_DEFAULT_SONNET_MODEL` and
 * `ANTHROPIC_DEFAULT_OPUS_MODEL`, so Claude Code resolves `sonnet` and `opus` to that family's Bedrock inference
 * profile on `bedrock` and to the family's current model on a person's own Claude licence. Null when the id is not
 * one, which leaves the session on hai's own default rather than on a model that fails.
 */
export function launcherModel(model: string | null): string | null {
  return model !== null && MODEL_RE.test(model) ? model : null;
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
  tmux,
  write,
  settleMs = MODEL_SETTLE_MS,
  say = () => {}
}: SwitchModelOptions): Promise<SwitchOutcome> {
  if (model === null || conversationId === undefined || readText(modelPath(sid)) === model) {
    return "unchanged";
  }
  const launched = launcherModel(model);
  if (launched === null) {
    say(`not switching to ${model}: it is not the shape of a model id`);
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
  say(`switched the session to ${model}`);
  return "switched";
}
