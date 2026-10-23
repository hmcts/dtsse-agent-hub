// The per-session daemon: one SSE stream to agent-hub for as long as the Claude process lives, with heartbeats,
// the transcript upload and the delivery of direct messages into Claude Code's inbox hanging off it. Nothing
// here may throw its way out of the loop — a bridge that exits leaves the session silently unreachable — so
// every failure is logged and retried, and a message is acked only once it is in the inbox.
import fs from "node:fs";
import { loadAgent, registerAgent, type StoredAgent } from "./agent.ts";
import { type Api, ApiError, createApi } from "./api.ts";
import { peerOf, recordDirect } from "./directs.ts";
import type { Env } from "./env.ts";
import {
  type AssistantFrame,
  type AssistantProduct,
  assistantEnvelope,
  directEnvelope,
  type EnvelopeOptions,
  type JiraExportFrame,
  ownerDirectEnvelope,
  ownerEnvelope
} from "./envelope.ts";
import { describeInbound, type InboundOptions, type InboundResult, inboundAccepted, inboundFix } from "./inbound.ts";
import { acquirePidFile, isEnabled, log, pidAlive, readJson, readText, releasePidFile, sessionInfo, statePath, writeJson } from "./session.ts";
import { collectSkills, type SkillListing, skillsHash } from "./skills.ts";
import { deliverToSocket, NO_MESSAGING_TOKEN } from "./socket.ts";
import { createSseParser, type SseEvent } from "./sse.ts";
import { createTranscriptSync, type TranscriptSync, transcriptOff } from "./transcript-sync.ts";
import { virtualAgent } from "./virtual-agent.ts";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
// The service ends every stream within about 25s and the client reconnects at once. A stream that
// ends this soon after opening, this many times running, is a server that cannot hold one, so back off.
export const RAPID_CLOSE_MS = 2000;
export const RAPID_CLOSES_BEFORE_BACKOFF = 3;
// Acked ids are remembered so a replay that races the ack is not written to the inbox twice.
const DELIVERED_MEMORY = 1000;

export function nextBackoff(current: number): number {
  return Math.min(MAX_BACKOFF_MS, current ? current * 2 : MIN_BACKOFF_MS);
}

/** How the last stream ended, as `reconnectDelay` reads it. */
export type StreamEnd = {
  clean: boolean;
  lastedMs: number;
};

export type RetryState = {
  backoff?: number;
  rapidCloses?: number;
};

export type ReconnectDecision = {
  delay: number;
  backoff: number;
  rapidCloses: number;
};

// How long to wait before the next connection. `clean` is a stream that ended without an error,
// with or without a `reconnect` event; `lastedMs` is how long it was open.
export function reconnectDelay({ backoff = 0, rapidCloses = 0 }: RetryState = {}, { clean, lastedMs }: StreamEnd): ReconnectDecision {
  if (!clean) {
    const next = nextBackoff(lastedMs > 60000 ? 0 : backoff);
    return { delay: next, backoff: next, rapidCloses: 0 };
  }
  if (lastedMs >= RAPID_CLOSE_MS) {
    return { delay: 0, backoff: 0, rapidCloses: 0 };
  }
  const rapid = rapidCloses + 1;
  if (rapid < RAPID_CLOSES_BEFORE_BACKOFF) {
    return { delay: 0, backoff: 0, rapidCloses: rapid };
  }
  const next = nextBackoff(backoff);
  return { delay: next, backoff: next, rapidCloses: rapid };
}

export function readStatus(sid: string): "busy" | "idle" {
  return readText(statePath(sid, "status")) === "busy" ? "busy" : "idle";
}

// The product area of the last message delivered to an assistant conversation, to tell the session when it changes.
const productPath = (sid: string) => statePath(sid, "assistant-product.json");

// Structural, and every field optional: it is the shape both `directs` and `envelope` read, so a message
// narrowed here fits either without this module choosing one of their author types over the other.
export type DirectEventAuthor = {
  type?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
};

/** Exactly the fields of a `direct` event's message that the bridge, the envelopes and `directs` read. */
export type DirectEventMessage = {
  id: string;
  body: string;
  in_reply_to?: string | null;
  created_at?: string;
  author?: DirectEventAuthor;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function parseAuthor(value: unknown): DirectEventAuthor | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  return {
    type: asOptionalString(raw.type),
    agent_id: asNullableString(raw.agent_id),
    agent_name: asNullableString(raw.agent_name),
    owner_name: asNullableString(raw.owner_name),
    owner_email: asNullableString(raw.owner_email)
  };
}

/**
 * The message on a `direct` stream event, or null when there is none to deliver. The stream is untrusted
 * input and may come from a hub older or newer than this client, so a missing body is delivered as an empty
 * one rather than dropped: a message the bridge drops is never acked, and the hub replays it for ever.
 */
export function parseDirectEventMessage(value: unknown): DirectEventMessage | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : "";
  if (!id) {
    return null;
  }
  return {
    id,
    body: typeof raw.body === "string" ? raw.body : "",
    in_reply_to: asNullableString(raw.in_reply_to),
    created_at: asOptionalString(raw.created_at),
    author: parseAuthor(raw.author)
  };
}

/**
 * The `assistant` object on a `direct` frame, or null when the frame carries none. Every field the envelope and
 * the recorded product read is listed here, so a hub that sends one this client does not know about is the only
 * way a field goes missing.
 */
export function parseAssistantFrame(value: unknown): AssistantFrame | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    conversation_id: asOptionalString(raw.conversation_id),
    product: asNullableString(raw.product),
    product_label: asNullableString(raw.product_label),
    artefact_version: typeof raw.artefact_version === "number" ? raw.artefact_version : null,
    artefact_updated_by: asNullableString(raw.artefact_updated_by),
    jira_export: parseJiraExportFrame(raw.jira_export)
  };
}

const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const WORD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A pending Jira export on the frame, or null. Its values go into the `twg` command the session is told to run, so
 * anything but an id, a project key and plain words is dropped rather than passed on.
 */
export function parseJiraExportFrame(value: unknown): JiraExportFrame | null {
  const raw = asRecord(value);
  if (
    !raw ||
    typeof raw.export_id !== "string" ||
    !EXPORT_ID_RE.test(raw.export_id) ||
    typeof raw.project !== "string" ||
    !PROJECT_RE.test(raw.project) ||
    typeof raw.issue_type !== "string" ||
    !WORD_RE.test(raw.issue_type) ||
    !Array.isArray(raw.labels) ||
    !raw.labels.every((label) => typeof label === "string" && WORD_RE.test(label))
  ) {
    return null;
  }
  return { export_id: raw.export_id, project: raw.project, issue_type: raw.issue_type, labels: raw.labels as string[] };
}

/** The recorded product of the last delivery, which only this module writes; null for anything else. */
export function parseAssistantProduct(value: unknown): AssistantProduct | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    product: typeof raw.product === "string" ? raw.product : null,
    product_label: typeof raw.product_label === "string" ? raw.product_label : null
  };
}

/** `deliverToSocket`, or a test's stand-in for it. */
export type Deliver = (socketPath: string | null | undefined, token: string | null | undefined, content: string) => Promise<void>;

export type RunBridgeOptions = {
  sid: string;
  env?: Env;
  api?: Api;
  deliver?: Deliver;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  transcriptMs?: number;
  skillsMs?: number;
  skills?: () => SkillListing[];
  transcriptSync?: TranscriptSync;
  inbound?: (opts: InboundOptions) => InboundResult;
};

export async function runBridge({
  sid,
  env = process.env,
  api = createApi(),
  deliver = deliverToSocket,
  heartbeatMs = Number(env.AGENT_HUB_HEARTBEAT_MS) || 30000,
  idleTimeoutMs = Number(env.AGENT_HUB_STREAM_IDLE_MS) || 45000,
  transcriptMs = Number(env.AGENT_HUB_TRANSCRIPT_MS) || 3000,
  skillsMs = Number(env.AGENT_HUB_SKILLS_MS) || 5 * 60 * 1000,
  skills: listSkills = collectSkills,
  transcriptSync,
  inbound = inboundAccepted
}: RunBridgeOptions): Promise<void> {
  // Connected without it, the bridge would take every message off the stream and fail to deliver it.
  if (!env.CLAUDE_CODE_MESSAGING_TOKEN) {
    log(sid, `bridge not started: ${NO_MESSAGING_TOKEN}`);
    return;
  }
  const pidFile = statePath(sid, "bridge.pid");
  if (!acquirePidFile(pidFile)) {
    log(sid, "bridge already running; exiting");
    return;
  }

  let agent: StoredAgent | null = loadAgent(sid);
  let stopping = false;
  let stopped: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let transcriptTimer: NodeJS.Timeout | undefined;
  let transcriptRun: Promise<unknown> | null = null;
  let wake: (() => void) | null = null;
  const delivered = new Set<string>();
  const remember = (id: string) => {
    delivered.add(id);
    if (delivered.size > DELIVERED_MEMORY) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) {
        delivered.delete(oldest);
      }
    }
  };
  let claudePid = sessionInfo(sid, env).pid;
  if (!claudePid) {
    log(sid, "no Claude pid found yet; looking again on each heartbeat");
  }
  const resolveClaudePid = () => {
    if (claudePid) {
      return;
    }
    claudePid = sessionInfo(sid, env).pid;
    if (claudePid) {
      log(sid, `found claude pid ${claudePid}`);
    }
  };

  // While Claude Code would hold messages they stay unacked on the hub, which replays them on the next stream.
  let holding = false;
  let replayHeld = false;
  function inboundOpen(): boolean {
    const result = inbound({ sid, env, claudePid });
    if (result.accepted === false) {
      return false;
    }
    if (holding) {
      holding = false;
      replayHeld = true;
      log(sid, `incoming messages: ${describeInbound(result)}; reconnecting to replay the held ones`);
      controller?.abort();
    }
    return true;
  }
  function hold(id: string): void {
    if (holding) {
      return;
    }
    holding = true;
    const result = inbound({ sid, env, claudePid });
    log(sid, `holding direct #${id}, and any after it, unacked on agent-hub. Incoming messages: ${describeInbound(result)}. Fix: ${inboundFix(result)}`);
  }

  function skillNames(): Set<string> {
    try {
      return new Set(listSkills().map((skill) => skill.name));
    } catch {
      return new Set();
    }
  }

  // Read on the first heartbeat and every skillsMs after, and sent only when the list differs from the one the hub last took.
  // The first check is immediate because a bridge starting from a saved agent does not re-register, the only other place skills are sent.
  let skillsCheckedAt = 0;
  function changedSkills(): SkillListing[] | null {
    if (Date.now() - skillsCheckedAt < skillsMs) {
      return null;
    }
    skillsCheckedAt = Date.now();
    try {
      const skills = listSkills();
      return skillsHash(skills) === agent?.skills_hash ? null : skills;
    } catch (e) {
      log(sid, `could not read skills: ${(e as Error).message}`);
      return null;
    }
  }

  const transcript = transcriptSync || createTranscriptSync({ sid, api, env, agentId: () => agent?.agent_id ?? null });

  // Runs never overlap: a tick still uploading when the next is due makes that one a no-op.
  function syncTranscript(opts?: { deadline?: number }): Promise<unknown> {
    if (transcriptRun) {
      return transcriptRun;
    }
    transcriptRun = transcript
      .tick(opts)
      .catch((e) => log(sid, `transcript sync error: ${(e as Error).message}`))
      .finally(() => {
        transcriptRun = null;
      });
    return transcriptRun;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  function shutdown(reason: string): Promise<void> {
    if (!stopped) {
      stopped = doShutdown(reason);
    }
    return stopped;
  }

  async function doShutdown(reason: string): Promise<void> {
    stopping = true;
    log(sid, `bridge stopping: ${reason}`);
    clearInterval(heartbeatTimer);
    clearInterval(transcriptTimer);
    controller?.abort();
    wake?.();
    // A final upload of the last turn, bounded so the stop still finishes within stopBridge's wait.
    const deadline = Date.now() + 1500;
    if (transcriptRun) {
      await Promise.race([
        transcriptRun,
        new Promise<void>((r) => {
          setTimeout(r, 1500).unref();
        })
      ]);
    }
    if (!transcriptRun && Date.now() < deadline) {
      await syncTranscript({ deadline });
    }
    if (agent?.agent_id) {
      try {
        await api.offline(agent.agent_id, { timeoutMs: 5000 });
      } catch (e) {
        log(sid, `offline failed: ${(e as Error).message}`);
      }
    }
    releasePidFile(pidFile);
  }

  function shouldStop(): string | null {
    resolveClaudePid();
    if (fs.existsSync(statePath(sid, "bridge.stop"))) {
      return "stop file";
    }
    if (!isEnabled(sid)) {
      return "comms disabled";
    }
    if (claudePid && !pidAlive(claudePid)) {
      return `claude pid ${claudePid} exited`;
    }
    return null;
  }

  // The status the hub last heard, so a turn starting or ending is sent at once rather than on the next heartbeat.
  let sentStatus: "busy" | "idle" | null = null;
  function statusChanged(): void {
    if (!agent?.agent_id || sentStatus === null || readStatus(sid) === sentStatus) {
      return;
    }
    heartbeat().catch((e) => log(sid, `heartbeat error: ${(e as Error).message}`));
  }

  async function heartbeat(): Promise<void> {
    const reason = shouldStop();
    if (reason) {
      await shutdown(reason);
      return;
    }
    if (holding) {
      inboundOpen();
    }
    const current = agent;
    if (!current?.agent_id) {
      return;
    }
    const agentId = current.agent_id;
    const skills = changedSkills();
    const status = readStatus(sid);
    sentStatus = status;
    try {
      await api.heartbeat(agentId, { status, name: sessionInfo(sid, env).name, ...(skills ? { skills } : {}) });
      if (skills) {
        const hash = skillsHash(skills);
        agent = { ...current, skills_hash: hash };
        writeJson(statePath(sid, "agent.json"), { ...(loadAgent(sid) || agent), skills_hash: hash });
        log(sid, `sent ${skills.length} skills`);
      }
    } catch (e) {
      if (skills) {
        skillsCheckedAt = 0;
      }
      log(sid, `heartbeat failed: ${(e as Error).message}`);
    }
  }

  async function handleDirect(event: SseEvent): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      log(sid, `unparseable direct event id=${event.id}`);
      return;
    }
    const payload = asRecord(parsed);
    if (!payload) {
      log(sid, `unparseable direct event id=${event.id}`);
      return;
    }
    const message = parseDirectEventMessage(payload.message);
    if (!message) {
      return;
    }
    const fromOwner = payload.from_owner === true;
    if (!delivered.has(message.id)) {
      if (!inboundOpen()) {
        hold(message.id);
        return;
      }
      const info = sessionInfo(sid, env);
      const fromUser = virtualAgent(env) !== null && fromOwner;
      // The owner reads this session's transcript on the hub, so a conversational answer reaches them and a
      // CLI reply would duplicate it — but only while the upload is on, or that reply is their only channel.
      const ownerReads = !fromUser && fromOwner && !transcriptOff(sid, env);
      // Only the person whose conversation it is gets the assistant framing; anyone else is still a peer.
      const assistant = fromUser ? parseAssistantFrame(payload.assistant) : null;
      const previousProduct = assistant ? parseAssistantProduct(readJson(productPath(sid))) : null;
      const envelope: (message: DirectEventMessage, options?: EnvelopeOptions) => string = fromUser
        ? ownerEnvelope
        : ownerReads
          ? ownerDirectEnvelope
          : directEnvelope;
      try {
        const content = assistant ? assistantEnvelope(message, assistant, previousProduct) : envelope(message, { skills: skillNames() });
        await deliver(info.socketPath, env.CLAUDE_CODE_MESSAGING_TOKEN, content);
        remember(message.id);
        if (assistant) {
          try {
            writeJson(productPath(sid), { product: assistant.product ?? null, product_label: assistant.product_label ?? null });
          } catch (e) {
            log(sid, `could not record the product of #${message.id}: ${(e as Error).message}`);
          }
        }
        if (!fromUser) {
          try {
            recordDirect(sid, message, { direction: "in", peer: peerOf(message.author) });
          } catch (e) {
            log(sid, `could not record direct #${message.id}: ${(e as Error).message}`);
          }
        }
        log(sid, `delivered direct #${message.id}`);
      } catch (e) {
        // Unacked, so the service resends it on the next connection.
        log(sid, `socket delivery of #${message.id} failed: ${(e as Error).message}`);
        return;
      }
    }
    try {
      await api.ack(agent?.agent_id as string, message.id);
    } catch (e) {
      log(sid, `ack of #${message.id} failed: ${(e as Error).message}`);
    }
  }

  async function consume(res: Response): Promise<{ lastEventId: string; reconnect: boolean }> {
    const decoder = new TextDecoder();
    let chain: Promise<void> = Promise.resolve();
    let idleTimer: NodeJS.Timeout | undefined;
    let reconnect = false;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log(sid, `no stream traffic for ${idleTimeoutMs}ms; reconnecting`);
        controller?.abort();
      }, idleTimeoutMs);
    };
    const parser = createSseParser({
      onEvent: (event) => {
        if (event.event === "direct") {
          chain = chain.then(() => handleDirect(event));
        } else if (event.event === "reconnect") {
          reconnect = true;
        }
      }
    });
    resetIdle();
    try {
      for await (const chunk of res.body ?? []) {
        resetIdle();
        parser.push(decoder.decode(chunk as Uint8Array, { stream: true }));
        if (reconnect) {
          break;
        }
      }
    } finally {
      clearTimeout(idleTimer);
      await chain;
    }
    return { lastEventId: parser.lastEventId, reconnect };
  }

  process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));

  log(sid, `bridge started (claude pid ${claudePid ?? "unknown"})`);
  heartbeatTimer = setInterval(() => {
    heartbeat().catch((e) => log(sid, `heartbeat error: ${(e as Error).message}`));
  }, heartbeatMs);
  transcriptTimer = setInterval(() => {
    statusChanged();
    // syncTranscript settles its own errors into the log, so there is nothing here to catch.
    void syncTranscript();
  }, transcriptMs);

  let retry: ReconnectDecision = { delay: 0, backoff: 0, rapidCloses: 0 };
  let lastEventId = "";
  let clean = false;
  while (!stopping) {
    const reason = shouldStop();
    if (reason) {
      await shutdown(reason);
      break;
    }
    let opened = Date.now();
    const afterClean = clean;
    clean = false;
    try {
      if (!agent?.agent_id) {
        agent = (await registerAgent(api, sid, { cwd: agent?.cwd, env, collectSkills: listSkills })).agent;
      }
      controller = new AbortController();
      const res = await api.stream(agent.agent_id as string, { signal: controller.signal, lastEventId });
      opened = Date.now();
      if (!afterClean) {
        log(sid, "stream connected");
        await heartbeat();
      }
      const ended = await consume(res);
      lastEventId = ended.lastEventId || lastEventId;
      clean = true;
      if (!ended.reconnect) {
        log(sid, "stream ended without a reconnect event");
      }
    } catch (e) {
      if (stopping) {
        break;
      }
      if (replayHeld && (e as Error).name === "AbortError") {
        clean = true;
      }
      if (e instanceof ApiError && e.status === 404) {
        log(sid, "agent unknown to the service; re-registering");
        agent = { ...agent, agent_id: undefined };
      } else if ((e as Error).name !== "AbortError") {
        log(sid, `stream error: ${(e as Error).message}`);
      }
    }
    if (stopping) {
      break;
    }
    replayHeld = false;
    retry = reconnectDelay(retry, { clean, lastedMs: Date.now() - opened });
    if (clean && retry.delay > 0) {
      log(sid, `streams keep ending within ${RAPID_CLOSE_MS}ms; backing off ${retry.delay}ms`);
    }
    if (retry.delay > 0) {
      await sleep(retry.delay);
    }
  }
  clearInterval(heartbeatTimer);
  clearInterval(transcriptTimer);
  await stopped;
}
