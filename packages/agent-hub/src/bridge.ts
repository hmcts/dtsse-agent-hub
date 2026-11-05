// The per-session daemon: one SSE stream to agent-hub for as long as the Claude process lives, with heartbeats,
// the transcript upload and the delivery of direct messages into Claude Code's inbox hanging off it. Nothing
// here may throw its way out of the loop — a bridge that exits leaves the session silently unreachable — so
// every failure is logged and retried, and a message is acked only once it is in the inbox.
import fs from "node:fs";
import { claimsCurrentFeatures, loadAgent, registerAgent, type StoredAgent } from "./agent.ts";
import { type Api, ApiError, createApi } from "./api.ts";
import { fetchAttachments, readAttachments, unfetchedAttachments } from "./assistant/attachments.ts";
import { switchModel } from "./assistant/models.ts";
import { createTmux, type Tmux } from "./assistant/tmux.ts";
import { peerOf, recordDirect } from "./directs.ts";
import type { Env } from "./env.ts";
import { type AssistantFrame, type AttachmentOutcome, chooseEnvelope, routeDelivery, type SessionKind } from "./envelope.ts";
import { asRecord, parseAssistantFrame, parseAssistantProduct, parseDirectEventMessage } from "./frames.ts";
import { describeInbound, type InboundOptions, type InboundResult, inboundAccepted, inboundFix } from "./inbound.ts";
import { RAPID_CLOSE_MS, type ReconnectDecision, reconnectDelay } from "./reconnect.ts";
import { acquirePidFile, conversationId, isEnabled, log, pidAlive, readJson, readText, releasePidFile, sessionInfo, statePath, writeJson } from "./session.ts";
import { collectSkills, type SkillListing, skillsHash } from "./skills.ts";
import { deliverToSocket, NO_MESSAGING_TOKEN } from "./socket.ts";
import { createSseParser, type SseEvent } from "./sse.ts";
import { createTranscriptSync, type TranscriptSync, transcriptOff } from "./transcript-sync.ts";
import { virtualAgent } from "./virtual-agent.ts";

// Acked ids are remembered so a replay that races the ack is not written to the inbox twice.
const DELIVERED_MEMORY = 1000;

export function readStatus(sid: string): "busy" | "idle" {
  return readText(statePath(sid, "status")) === "busy" ? "busy" : "idle";
}

// The product area of the last message delivered to an assistant conversation, to tell the session when it changes.
const productPath = (sid: string) => statePath(sid, "assistant-product.json");

/** Where this session runs, for `routeDelivery`: a conversation's id is set only by a pod's supervisor. */
export function sessionKind(env: Env): SessionKind {
  if (conversationId(env) !== null) {
    return "conversation";
  }
  return virtualAgent(env) !== null ? "pod" : "laptop";
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
  /** What types `/model` into a conversation's pane; a test passes its own. */
  tmux?: Pick<Tmux, "sendKeys">;
  modelSettleMs?: number;
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
  inbound = inboundAccepted,
  tmux = createTmux({ env: env as NodeJS.ProcessEnv }),
  modelSettleMs
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

  /**
   * Registers again when the saved registration was made by a build with other `client_features`, which a resumed
   * session finds on its volume, so the hub stops reading the older client's claim. Only while the session is idle:
   * a registration sets the agent `idle`, and the name and its source it sends are the ones every heartbeat sends.
   */
  async function reportFeatures(): Promise<void> {
    if (!agent?.agent_id || claimsCurrentFeatures(agent) || readStatus(sid) !== "idle") {
      return;
    }
    try {
      agent = (await registerAgent(api, sid, { cwd: agent.cwd, env, collectSkills: listSkills })).agent;
      log(sid, "registered again to report this client's features");
    } catch (e) {
      log(sid, `could not register this client's features: ${(e as Error).message}`);
    }
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
    await reportFeatures();
    const current = agent;
    if (!current?.agent_id) {
      return;
    }
    const agentId = current.agent_id;
    const skills = changedSkills();
    const status = readStatus(sid);
    sentStatus = status;
    try {
      // The name and where it came from together, on every heartbeat: a /rename part-way through a session is how
      // the person says what it is, and the service keeps the chat in the Assistant on that name rather than on the
      // session's first prompt. Reading them apart would let a rename arrive as a name of unknown origin.
      const session = sessionInfo(sid, env);
      await api.heartbeat(agentId, { status, name: session.name, name_source: session.nameSource, ...(skills ? { skills } : {}) });
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

  /**
   * The files on an assistant frame, written to this pod's disk.
   *
   * Empty only for a frame that names no file: an outcome missing from this list is a file the prompt says nothing
   * about, and a message delivered without a word about the file attached to it leaves the person believing it was
   * read. So a frame that names files this pod cannot go and get — no conversation id to build a path from, no agent
   * id to fetch with, or entries the client will not act on — answers with an error outcome for each of them.
   */
  async function fetchForDelivery(messageId: string, assistant: AssistantFrame | null): Promise<AttachmentOutcome[]> {
    const conversationId = assistant?.conversation_id;
    const agentId = agent?.agent_id;
    const { attachments, dropped } = readAttachments(assistant?.attachments);
    if (attachments.length === 0) {
      return dropped;
    }
    if (conversationId === undefined || agentId === undefined) {
      const reason = conversationId === undefined ? "the frame named no conversation to fetch it for" : "this session has no agent id to fetch it with";
      log(sid, `#${messageId}: cannot fetch ${attachments.length} attached file(s): ${reason}`);
      return [...unfetchedAttachments(attachments, reason), ...dropped];
    }
    const outcomes = await fetchAttachments({
      api,
      agentId,
      conversationId,
      attachments,
      env,
      say: (m) => log(sid, `#${messageId}: ${m}`)
    });
    return [...outcomes, ...dropped];
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
      const delivery = routeDelivery({
        fromOwner,
        session: sessionKind(env),
        frame: parseAssistantFrame(payload.assistant),
        transcriptUploaded: !transcriptOff(sid, env)
      });
      // The frame is what the model switch, the attachment fetch and the recorded product act on.
      const assistant = delivery.kind === "conversation" ? delivery.frame : null;
      const previousProduct = assistant ? parseAssistantProduct(readJson(productPath(sid))) : null;
      // Fetched before the message is delivered, so the prompt can name the absolute path and the session has the
      // file the moment it reads about it. Nothing here throws: a file that could not be fetched comes back as an
      // outcome the prompt says so about, because a message delivered with the attachment silently missing would
      // leave the person believing the agent had read it.
      const attachments = await fetchForDelivery(message.id, assistant);
      // Before the message, so a model the person picked since the last one answers this one. Nothing here throws: a
      // switch that could not be made leaves the message to be answered by the model the session is already on.
      if (assistant) {
        await switchModel({
          sid,
          conversationId: assistant.conversation_id,
          model: assistant.model ?? null,
          tmux,
          write: (file, text) => fs.writeFileSync(file, text, { mode: 0o600 }),
          settleMs: modelSettleMs,
          say: (m) => log(sid, `#${message.id}: ${m}`)
        });
      }
      try {
        const skills = skillNames();
        const content = chooseEnvelope(message, delivery, { skills, attachments, previousProduct });
        await deliver(info.socketPath, env.CLAUDE_CODE_MESSAGING_TOKEN, content);
        remember(message.id);
        if (assistant) {
          try {
            writeJson(productPath(sid), { product: assistant.product ?? null, product_label: assistant.product_label ?? null });
          } catch (e) {
            log(sid, `could not record the product of #${message.id}: ${(e as Error).message}`);
          }
        }
        if (delivery.kind !== "conversation") {
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
