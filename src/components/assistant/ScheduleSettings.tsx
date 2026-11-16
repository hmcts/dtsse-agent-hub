"use client";

import { useId } from "react";
import type { FormAction } from "@/components/ActionForm";
import { useSettingsData } from "@/components/assistant/useSettingsData";
import { useSettingsDraft } from "@/components/assistant/useSettingsDraft";
import { NO_AUTO_START } from "@/virtual-agents/schedule";
import type { ScheduleSettings } from "@/web/data";

/**
 * When the hub starts the person's assistant for them and when it shuts it down for being idle: read through
 * `readSchedule` once the section opens and saved by the dialog's Save through `saveSchedule`. Which values are
 * allowed is `src/virtual-agents/schedule.ts`'s, so nothing here is a second list.
 */
export interface AssistantScheduleSetting {
  load: () => Promise<ScheduleSettings>;
  save: FormAction;
}

const SELECT = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";

function sameSchedule(a: { autoStart: string; idleAfter: string }, b: { autoStart: string; idleAfter: string }): boolean {
  return a.autoStart === b.autoStart && a.idleAfter === b.idleAfter;
}

function Form({ settings }: Readonly<{ settings: ScheduleSettings }>) {
  const id = useId();
  const draft = useSettingsDraft("schedule", { autoStart: settings.autoStart, idleAfter: settings.idleAfter }, sameSchedule);
  const { autoStart, idleAfter } = draft.value;
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={`${id}-start`} className="text-[13px] font-medium">
        Auto start time
      </label>
      <select
        id={`${id}-start`}
        name="autoStart"
        value={autoStart}
        onChange={(event) => draft.set({ autoStart: event.target.value, idleAfter })}
        className={SELECT}
      >
        <option value={NO_AUTO_START}>None</option>
        {settings.autoStartTimes.map((time) => (
          <option key={time} value={time}>
            {time}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-idle`} className="text-[13px] font-medium">
        Shut down when idle after
      </label>
      <select
        id={`${id}-idle`}
        name="idleAfter"
        value={idleAfter}
        onChange={(event) => draft.set({ autoStart, idleAfter: event.target.value })}
        className={SELECT}
      >
        {settings.idleOffers.map((offer) => (
          <option key={offer.value} value={offer.value}>
            {offer.label}
          </option>
        ))}
      </select>
      {draft.error === null ? null : (
        <p role="alert" className="text-xs text-asst-error">
          {draft.error}
        </p>
      )}
    </div>
  );
}

/**
 * The Schedule section of the settings.
 *
 * Starting an assistant takes a while, so this lets it be ready before the person is. The times begin at 07:30 because
 * the environment is not up before 07:00, and end with the last whose window is before the evening stop; the section
 * says the environment is off outside working hours, since that is what overrides both choices.
 */
export function Schedule({ schedule }: Readonly<{ schedule: AssistantScheduleSetting }>) {
  const { data: settings, failed } = useSettingsData("schedule", schedule.load);
  return (
    <section aria-labelledby="assistant-settings-schedule" aria-busy={settings === undefined && !failed} className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-schedule" className="text-sm font-semibold">
        Schedule
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Your assistant takes a little while to start. Choose a time and it is started for you on weekdays, so it is ready when you are. Times are UK time. It is
        started once a day, and not again if it is stopped later. It pauses after two weeks without you using your assistant, and resumes once you use it again.
      </p>
      {failed ? (
        <p className="text-[13px] text-asst-error">Your schedule could not be read. Close settings and open them again.</p>
      ) : settings === undefined ? (
        <p className="text-[13px] text-asst-muted">Reading your schedule…</p>
      ) : (
        <Form settings={settings} />
      )}
      <p className="text-pretty text-[13px] text-asst-muted">
        The whole environment is shut down from 8pm to 7am and at weekends. Your assistant is stopped then whatever you choose here, and it is only auto started
        on weekdays.
      </p>
      <p className="text-pretty text-[13px] text-asst-muted">
        Never still stops your assistant at the evening stop. An assistant opened in the evening or at a weekend uses the usual idle time instead.
      </p>
    </section>
  );
}
