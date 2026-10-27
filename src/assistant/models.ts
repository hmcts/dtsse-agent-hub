/**
 * The Claude models a person can pick for a conversation. The id is stored on the conversation and sent to its
 * session's pod in every wake and every message frame; the pod turns it into what its launcher needs on the route it
 * runs (a region-prefixed inference profile on Amazon Bedrock, the id itself on a person's own Claude licence).
 *
 * Only models both routes can run are offered, because a conversation's route is not the person's to choose: a model
 * one route cannot run would be a choice that fails on the first message. Every id here has an `eu.` inference
 * profile on Bedrock in `eu-west-2`, the region hai defaults a pod to, and is on a Claude licence. Claude Fable 5.1 is
 * not offered: hai provisions no Bedrock profile for it, and it needs 30-day data retention, which is not known to
 * hold for either route's account.
 */

export interface AssistantModel {
  id: string;
  label: string;
  /** What it is for, in a line the menu shows under the name. */
  description: string;
}

export const MODELS: readonly AssistantModel[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and capable, for most work" },
  { id: "claude-opus-5-5", label: "Opus 5.5", description: "The most thorough, for harder problems" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", description: "The quickest, for simple questions" }
];

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function isModel(id: unknown): id is string {
  return typeof id === "string" && MODELS.some((model) => model.id === id);
}

/**
 * The offered model a conversation's stored id stands for: one no longer offered stands for the default. Unlike a
 * product, which the session is told as stored, this is also what the pod is sent, because a model that is not
 * offered is one this list no longer vouches for running, and starting a session on it could fail every turn.
 */
export function storedModel(id: string): string {
  return isModel(id) ? id : DEFAULT_MODEL;
}

/** The display name of a stored id; one no longer offered shows as itself rather than failing. */
export function modelLabel(id: string): string {
  return MODELS.find((model) => model.id === id)?.label ?? id;
}
