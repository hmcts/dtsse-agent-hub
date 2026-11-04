"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { statusLabel } from "@/components/assistant/labels";
import { type AssistantModelSetting, ModelSettings } from "@/components/assistant/ModelSettings";
import { type AssistantSize, Size } from "@/components/assistant/SizeSettings";
import { useSettingsData } from "@/components/assistant/useSettingsData";
import type { AssistantAgent } from "@/web/data";

/**
 * The virtual agent the person's Assistant runs on, as its settings manage it: where it stands, and a restart. There
 * is no stop and no delete. Opening the Assistant starts the agent and creates one when there is none, so either
 * would be undone by the next page the person loads, this one's own refresh included; the idle sweep is what stops it
 * when nobody is using it.
 */
export interface AssistantAgentSettings {
  /** `readAssistantAgent`, read once the section opens: `null` when the person has no assistant yet. */
  load: () => Promise<AssistantAgent | null>;
  restart: FormAction;
}

const PRIMARY = "self-start rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover";
const SECONDARY = "self-start rounded-[10px] border border-asst-strong px-3 py-2 text-[13px] hover:bg-asst-hover";

/**
 * The restart, behind a question that says what it ends before the person commits, as the size's does: a new pod
 * ends whatever each chat is working on, and nothing else.
 */
function Restart({ agent, restart }: { agent: AssistantAgent; restart: FormAction }) {
  const [asking, setAsking] = useState(false);
  // The action's own confirmation, said outside the form, which closes on success so the question is not left open
  // to be answered twice.
  const [restarted, setRestarted] = useState<string | null>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) {
      confirm.current?.focus();
    }
  }, [asking]);

  if (agent.desired !== "running") {
    return <p className="text-[13px] text-asst-muted">It is not running, so there is nothing to restart. It starts when you next open a chat.</p>;
  }
  if (!asking) {
    return (
      <>
        {restarted === null ? null : (
          <p role="status" className="text-[13px] text-asst-ok">
            {restarted}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setRestarted(null);
            setAsking(true);
          }}
          className={SECONDARY}
        >
          Restart your assistant
        </button>
      </>
    );
  }
  return (
    <ActionForm
      action={restart}
      label="Restart your assistant"
      onSuccess={(result: { confirmation?: string }) => {
        setAsking(false);
        setRestarted(result.confirmation ?? "Restarting.");
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="id" value={agent.id} />
      <p className="text-pretty text-[13px] font-semibold">
        Restart your assistant? Anything a chat is working on right now stops. Your chats are all kept and carry on where they left off.
      </p>
      <div className="flex items-center gap-3">
        <button ref={confirm} type="submit" className={PRIMARY}>
          Restart
        </button>
        <button type="button" onClick={() => setAsking(false)} className="text-[13px] font-medium text-asst-muted hover:text-asst-text">
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

/** Where the agent stands, read only once the section is open, since no page needs it for a dialog that is shut. */
function Status({ settings }: { settings: AssistantAgentSettings }) {
  const { data: agent, failed } = useSettingsData("assistant", settings.load, true);
  return (
    <div aria-busy={agent === undefined && !failed} className="flex flex-col gap-3">
      {failed ? (
        <p className="text-[13px] text-asst-error">Your assistant could not be read. Close settings and open them again.</p>
      ) : agent === undefined ? (
        <p className="text-[13px] text-asst-muted">Reading your assistant…</p>
      ) : agent === null ? (
        <p className="text-[13px] text-asst-muted">You have no assistant yet. Opening a chat sets one up.</p>
      ) : (
        <>
          <p className="text-[13px] text-asst-body">
            <span className="font-medium">{agent.name}</span> · {statusLabel(agent.status, agent.desired)}
          </p>
          {agent.statusDetail === null ? null : <p className="text-pretty text-[13px] text-asst-muted">{agent.statusDetail}</p>}
          <Restart agent={agent} restart={settings.restart} />
        </>
      )}
    </div>
  );
}

/**
 * The Assistant section: the agent itself, then the model its chats run on, then its size, each part shown when the
 * page passed something for it. One panel because all three are about the agent rather than about this screen.
 */
export function AgentSettings({ agent, model, size }: { agent?: AssistantAgentSettings; model?: AssistantModelSetting; size?: AssistantSize }) {
  return (
    <section aria-labelledby="assistant-settings-agent" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <h3 id="assistant-settings-agent" className="text-sm font-semibold">
          Your assistant
        </h3>
        {agent === undefined ? null : <Status settings={agent} />}
      </div>
      {model === undefined ? null : <ModelSettings model={model} />}
      {size === undefined ? null : <Size size={size} />}
    </section>
  );
}
