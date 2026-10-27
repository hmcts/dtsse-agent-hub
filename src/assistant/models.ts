/**
 * The Claude models a conversation can run on, and which of them a person is offered. The id is stored on the
 * conversation and sent to its session's pod in every wake and every message frame; the pod turns it into what its
 * launcher needs on the route it runs (a region-prefixed inference profile on Amazon Bedrock, the id itself on a
 * person's own Claude licence).
 *
 * `CATALOGUE` is every model the hub knows how to describe, in menu order. Which a person is *offered* is not
 * configured: their own pod asks each one with their own credential, and only those that answered are offered (see
 * Model access in `docs/agent-api.md`). The pod client keeps the same list, as `CHECKED_MODELS`.
 */

export interface AssistantModel {
  id: string;
  label: string;
  /** What it is for, in a line the menu shows under the name. */
  description: string;
}

export const CATALOGUE: readonly AssistantModel[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and capable, for most work" },
  { id: "claude-opus-5-5", label: "Opus 5.5", description: "The most thorough, for harder problems" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", description: "The quickest, for simple questions" },
  { id: "claude-fable-5-1", label: "Fable 5.1", description: "The most capable, for the hardest work" }
];

/**
 * What a new conversation starts on when it is offered, and the one model offered before anyone has checked: the
 * default every route's launcher already runs, so offering it promises nothing a pod has not been doing all along.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** A definite answer from a model check. `unknown` is never stored, so it never appears here. */
export type ModelStatus = "available" | "unavailable";

/** What one person is offered on one route: the models, in menu order, and the one a new conversation starts on. */
export interface ModelOffer {
  models: AssistantModel[];
  defaultModel: string;
}

export function isKnownModel(id: unknown): id is string {
  return typeof id === "string" && CATALOGUE.some((model) => model.id === id);
}

const ONLY_THE_DEFAULT: ModelOffer = { models: CATALOGUE.filter((model) => model.id === DEFAULT_MODEL), defaultModel: DEFAULT_MODEL };

/**
 * The offer from the last stored answers, or `undefined` when there is nothing to go on: no check has finished, or the
 * pod's client does not claim `model-check` and so will never check again. Either way only the default is offered.
 *
 * The models answered `available`, in catalogue order. Nothing answered is not a reason to offer nothing: the default
 * is offered anyway, and the chat's own error says why it fails, which is more use than an empty menu.
 */
export function modelOffer(statuses: ReadonlyMap<string, ModelStatus> | undefined): ModelOffer {
  if (statuses === undefined || statuses.size === 0) {
    return ONLY_THE_DEFAULT;
  }
  const models = CATALOGUE.filter((model) => statuses.get(model.id) === "available");
  if (models.length === 0) {
    return ONLY_THE_DEFAULT;
  }
  return { models, defaultModel: models.some((model) => model.id === DEFAULT_MODEL) ? DEFAULT_MODEL : (models[0] as AssistantModel).id };
}

export function isOffered(offer: ModelOffer, id: unknown): id is string {
  return typeof id === "string" && offer.models.some((model) => model.id === id);
}

/**
 * The offered model a conversation's stored id stands for: one no longer offered stands for the default. This is what
 * every page shows and also what the pod is sent, because a model the person's credential stopped answering is one a
 * session started on it would fail every turn with.
 */
export function storedModel(offer: ModelOffer, id: string): string {
  return isOffered(offer, id) ? id : offer.defaultModel;
}

/** The display name of an id; one the catalogue does not know shows as itself rather than failing. */
export function modelLabel(id: string): string {
  return CATALOGUE.find((model) => model.id === id)?.label ?? id;
}
