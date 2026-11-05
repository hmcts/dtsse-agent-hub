"use client";

import { CATALOGUE } from "@/assistant/models";
import type { FormAction } from "@/components/ActionForm";
import { useSettingsDraft } from "@/components/assistant/useSettingsDraft";

/**
 * The Claude model the person's chats run on, as the Assistant's settings edit it: the one stored choice
 * `assistantModel` reads, and the action the dialog's Save replaces it with. The models and their words are
 * `src/assistant/models.ts`'s, so nothing here is a second list.
 */
export interface AssistantModelSetting {
  model: string;
  /** Whether the pod running their assistant takes the choice now; `assistantModelChoice`'s answer. */
  honoured: boolean;
  save: FormAction;
}

/**
 * The model part of the Assistant section of the settings.
 *
 * One choice for every chat, new and existing, rather than one per chat: which model answers is a preference about how
 * a person likes to work, not a property of a subject they are working on. It says so in plain words, and says when a
 * change takes effect — a chat mid-answer finishes it on the model it started, and picks the new one up with the next
 * message, because the pod switches the session before it delivers that message.
 *
 * No version numbers: hai pins the version of each family in the pod, so naming one here would be a second answer to
 * that question and the one that goes stale.
 *
 * A pod whose client predates the family aliases cannot act on the choice, and the section says so rather than hiding
 * or disabling the control: the choice is stored against the person, not the pod, so saving it is worth doing and the
 * pod takes it when it next starts. Nothing is gated on the claim.
 */
export function ModelSettings({ model }: Readonly<{ model: AssistantModelSetting }>) {
  const chosen = useSettingsDraft("model", model.model);
  return (
    <section aria-labelledby="assistant-settings-model" className="flex flex-col gap-2.5">
      <h4 id="assistant-settings-model" className="text-[13px] font-semibold">
        Model
      </h4>
      <p className="text-pretty text-[13px] text-asst-muted">
        Which Claude model answers you. This applies to all of your chats. A chat writing an answer finishes it on the model it started, and takes the change
        with your next message.
      </p>
      {model.honoured ? null : <p className="text-pretty text-[13px] text-asst-muted">Your assistant picks your choice up the next time it starts.</p>}
      <div role="radiogroup" aria-label="Choose the model your chats run on" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
        {CATALOGUE.map((option) => (
          <label key={option.id} className="flex cursor-pointer items-start gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0 hover:bg-asst-active">
            <input
              type="radio"
              name="model"
              value={option.id}
              checked={option.id === chosen.value}
              onChange={() => chosen.set(option.id)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-asst-accent"
            />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-asst-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      {chosen.error === null ? null : (
        <p role="alert" className="text-xs text-asst-error">
          {chosen.error}
        </p>
      )}
    </section>
  );
}
