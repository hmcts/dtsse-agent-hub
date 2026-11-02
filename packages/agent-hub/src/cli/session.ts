// The commands that turn comms on and off for a session and say what state it is in.
import fs from "node:fs";
import { bridgePid, loadAgent, type StoredAgent, stopBridge } from "../agent.ts";
import { clearOptOut, type EnableSessionResult, enableSession, markOptedOut } from "../enable.ts";
import { CLI } from "../envelope.ts";
import { describeInbound, inboundAccepted, inboundFix, setupInbound } from "../inbound.ts";
import { ensureStateDir, isEnabled, log, logPath, readJson, readText, removeFile, requireSessionId, statePath } from "../session.ts";
import { fastForward, parseSavedState, setTranscriptOff, syncStatePath, transcriptOffByEnv, transcriptOffBySession } from "../transcript-sync.ts";
import { type Cli, type Command, errorMessage, topicsOrDie, UsageError } from "./command.ts";

export const enable: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const topics = topicsOrDie(args, { min: 0 });
  clearOptOut(sid);
  // Only the auto-enable worker passes `proceed`, so this never declines and never answers null.
  const { agent, subscribed, pid, started, baseUrl } = (await enableSession(sid, { cwd: cli.cwd(), topics, env: cli.env })) as EnableSessionResult;
  cli.print(`agent-hub: enabled as @${agent.name} (agent ${agent.agent_id}) at ${baseUrl}`);
  cli.print(`subscribed topics: ${subscribed.join(", ") || "(none)"}`);
  cli.print(`bridge: ${started ? "started" : "already running"} (pid ${pid}); log: ${logPath(sid)}`);
  const inbound = inboundAccepted({ sid, env: cli.env });
  if (inbound.accepted === false) {
    cli.print(`warning: incoming messages are ${describeInbound(inbound)}.`);
    cli.print(`fix: ${inboundFix(inbound)}`);
  }
  return 0;
};

export const disable: Command = async (cli) => {
  const sid = requireSessionId(cli.env);
  const agent = loadAgent(sid);
  const hadBridge = Boolean(bridgePid(sid));
  const stopped = await stopBridge(sid);
  if (!hadBridge && agent?.agent_id) {
    try {
      await cli.api().offline(agent.agent_id);
    } catch (e) {
      cli.printError(`warning: could not mark the agent offline: ${errorMessage(e)}`);
    }
  }
  markOptedOut(sid);
  removeFile(statePath(sid, "enabled"));
  // What happens while comms are off is never uploaded, even if they are enabled again.
  fastForward(sid);
  log(sid, "disabled");
  cli.print(`agent-hub: disabled for this session${hadBridge && !stopped ? " (bridge did not exit in time; it stops on its next heartbeat)" : ""}.`);
  return 0;
};

/** The lines `status` adds for a session the hub has registered an agent for. */
async function printAgentStatus(cli: Cli, sid: string, agent: StoredAgent & { agent_id: string }): Promise<void> {
  const pid = bridgePid(sid);
  const bridgeState = pid ? `running (pid ${pid})` : "not running";
  const upload = transcriptOffByEnv(cli.env) || transcriptOffBySession(sid) ? "off" : "on";
  cli.print(`agent:    @${agent.name} (${agent.agent_id})`);
  cli.print(`bridge:   ${bridgeState}`);
  cli.print(`status:   ${readText(statePath(sid, "status")) || "idle"}`);
  cli.print(`upload:   transcript ${upload} (${CLI} transcript status)`);
  try {
    const subs = await cli.api().subscriptions(agent.agent_id);
    cli.print(`topics:   ${subs.topics.join(", ") || "(none)"}`);
  } catch (e) {
    cli.print(`topics:   (unavailable: ${errorMessage(e)})`);
  }
  cli.print(`log:      ${logPath(sid)}`);
}

export const status: Command = async (cli) => {
  const sid = requireSessionId(cli.env);
  const agent = loadAgent(sid);
  cli.print(`session:  ${sid}`);
  cli.print(`enabled:  ${isEnabled(sid) ? "yes" : "no"}`);
  const inbound = inboundAccepted({ sid, env: cli.env });
  cli.print(`incoming: ${describeInbound(inbound)}`);
  if (inbound.accepted === false) {
    cli.print(`fix:      ${inboundFix(inbound)}`);
  }
  if (agent?.agent_id) {
    await printAgentStatus(cli, sid, { ...agent, agent_id: agent.agent_id });
  }
  return 0;
};

function transcriptOff(cli: Cli, sid: string): void {
  ensureStateDir(sid);
  setTranscriptOff(sid, true);
  fastForward(sid);
  log(sid, "transcript upload turned off");
  cli.print("agent-hub: this session's transcript is no longer uploaded. What was already uploaded stays on agent-hub.");
}

function transcriptOn(cli: Cli, sid: string): void {
  ensureStateDir(sid);
  fastForward(sid);
  setTranscriptOff(sid, false);
  log(sid, "transcript upload turned on");
  cli.print("agent-hub: this session's transcript is uploaded again while comms are enabled, from now on (not the turns while it was off).");
  if (transcriptOffByEnv(cli.env)) {
    cli.print("note: AGENT_HUB_TRANSCRIPT=off is set in the environment, which still stops it.");
  }
}

function transcriptStatus(cli: Cli, sid: string): void {
  let state = "uploaded while comms are enabled";
  if (transcriptOffByEnv(cli.env)) {
    state = "off (AGENT_HUB_TRANSCRIPT=off)";
  } else if (transcriptOffBySession(sid)) {
    state = `off for this session (${CLI} transcript on to resume)`;
  }
  cli.print(`transcript: ${state}`);
  cli.print(`comms:      ${isEnabled(sid) ? "enabled" : "not enabled"}`);
  const saved = parseSavedState(readJson(syncStatePath(sid)));
  if (!saved?.path) {
    return;
  }
  let size: number | null = null;
  try {
    size = fs.statSync(saved.path).size;
  } catch {}
  const of = size === null ? "" : ` of ${size}`;
  cli.print(`file:       ${saved.path}`);
  cli.print(`uploaded:   to byte ${saved.offset}${of}`);
}

export const transcript: Command = (cli, args) => {
  const sid = requireSessionId(cli.env);
  const action = args[0] || "status";
  if (action === "off") {
    transcriptOff(cli, sid);
  } else if (action === "on") {
    transcriptOn(cli, sid);
  } else if (action === "status") {
    transcriptStatus(cli, sid);
  } else {
    throw new UsageError("transcript takes off, on or status");
  }
  return 0;
};

export const setup: Command = (cli, args) => {
  if (args.length !== 1 || args[0] !== "inbound") {
    throw new UsageError("setup takes inbound");
  }
  const r = setupInbound();
  if (!r.changed) {
    cli.print(`agent-hub: ${r.file} already sets "crossSessionInbound": "accept"; nothing changed.`);
    return 0;
  }
  const was = r.previous === undefined ? "" : ` (it was ${JSON.stringify(r.previous)})`;
  cli.print(`agent-hub: ${r.created ? "created" : "updated"} ${r.file} with "crossSessionInbound": "accept"${was}.`);
  if (r.backup) {
    cli.print(`backup:    ${r.backup}`);
  }
  cli.print("Every Claude Code session you run now accepts messages from your other sessions and from agent-hub.");
  cli.print(
    `A session that is already running may need restarting to pick it up (exit, then claude --resume); ${CLI} status in it says whether messages are still held.`
  );
  return 0;
};
