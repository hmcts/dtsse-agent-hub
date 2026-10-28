/**
 * The Claude models the HMCTS Assistant runs on. One choice per person, stored against them and sent to their pod in
 * every wake and every message frame.
 *
 * The id is a bare family alias — `sonnet`, `opus` — and never a version. The version is pinned per family in the
 * pod, as `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL`: by hai on the `bedrock` route, and by
 * stage 1 itself on `gateway`, where hai resolves nothing. So Claude Code resolves the alias to that family's Bedrock
 * inference profile there, and to the current model of the family on a person's own Claude licence.
 *
 * **That is what keeps this catalogue honest about the gateway, and why it names no version.** The gateway refuses any
 * model id outside its application's `allowedModels` with a 404, and the pins stage 1 sets are ids on that list — so
 * every alias here resolves to one, and a `/model` switch cannot name something the gateway will refuse. A versioned
 * id offered from here could not make that promise, because the list is the gateway's to change.
 *
 * So the hub names no version and builds no profile id, and the pod hands the alias straight to `--model` and
 * `/model`. Every alias works on every model route, so there is nothing to discover per person.
 */

export interface AssistantModel {
  id: string;
  label: string;
  /** What it is for, in a line the settings show under the name. */
  description: string;
}

export const CATALOGUE: readonly AssistantModel[] = [
  { id: "sonnet", label: "Sonnet", description: "Fast and capable, for most work" },
  { id: "opus", label: "Opus", description: "The most thorough, for harder problems" }
];

/** What a person runs on until they choose, and what a choice the catalogue no longer holds stands for. */
export const DEFAULT_MODEL = "sonnet";

export function isKnownModel(id: unknown): id is string {
  return typeof id === "string" && CATALOGUE.some((model) => model.id === id);
}

/** The display name of an id; one the catalogue does not know shows as itself rather than failing. */
export function modelLabel(id: string): string {
  return CATALOGUE.find((model) => model.id === id)?.label ?? id;
}
