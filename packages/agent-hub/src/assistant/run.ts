// The long-lived half: consume the virtual agent's sessions stream, hand each wake and close to the supervisor,
// and tick it so idle sessions stop and queued ones start. Reconnects as the bridge does, because the stream is
// framed as the agent stream and ends the same way.
import type { Api } from "../api.ts";
import { RAPID_CLOSE_MS, type ReconnectDecision, reconnectDelay } from "../bridge.ts";
import { createSseParser, type SseEvent } from "../sse.ts";
import { reconcileUploads } from "./attachments.ts";
import { type AssistantSupervisor, type CreateAssistantSupervisorOptions, createAssistantSupervisor, idleMinutes } from "./supervisor.ts";

const TICK_MS = 2000;
const STREAM_IDLE_MS = 45000;
/** How often the uploads on disk are reconciled against the hub's conversations. Rare: it is only a backstop. */
const RECONCILE_MS = 10 * 60 * 1000;

export type RunAssistantSupervisorOptions = Omit<CreateAssistantSupervisorOptions, "api" | "id"> & {
  api: Pick<Api, "putSessions" | "sessionsStream" | "conversations">;
  id: string;
  /** Stops the supervisor, as SIGTERM and SIGINT do; a test owns neither signal. */
  signal?: AbortSignal;
  tickMs?: number;
  idleTimeoutMs?: number;
  reconcileMs?: number;
};

/**
 * Consumes the virtual agent's sessions stream until SIGTERM, SIGINT or `signal`, reconnecting as the bridge does:
 * at once after a clean end, with backoff after an error or streams that keep ending as they open.
 */
export async function runAssistantSupervisor({
  api,
  id,
  env = process.env,
  say = () => {},
  signal,
  tickMs = Number(env.AGENT_HUB_SUPERVISOR_TICK_MS) || TICK_MS,
  idleTimeoutMs = Number(env.AGENT_HUB_STREAM_IDLE_MS) || STREAM_IDLE_MS,
  reconcileMs = Number(env.AGENT_HUB_UPLOAD_RECONCILE_MS) || RECONCILE_MS,
  ...options
}: RunAssistantSupervisorOptions): Promise<void> {
  const supervisor: AssistantSupervisor = createAssistantSupervisor({ api, id, env, say, ...options });
  let stopping = false;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    stopping = true;
    controller?.abort();
    wake?.();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  signal?.addEventListener("abort", onSignal, { once: true });

  async function consume(res: Response): Promise<{ reconnect: boolean }> {
    const decoder = new TextDecoder();
    let chain: Promise<void> = Promise.resolve();
    let idleTimer: NodeJS.Timeout | undefined;
    let reconnect = false;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        say(`no sessions stream traffic for ${idleTimeoutMs}ms; reconnecting`);
        controller?.abort();
      }, idleTimeoutMs);
    };
    const handle = (fn: (data: unknown) => Promise<void>, event: SseEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        say(`unparseable ${event.event} event`);
        return;
      }
      chain = chain.then(() => fn(data)).catch((e) => say(`${event.event} failed: ${(e as Error).message}`));
    };
    const parser = createSseParser({
      onEvent: (event) => {
        if (event.event === "wake") {
          handle(supervisor.wake, event);
        } else if (event.event === "close") {
          handle(supervisor.close, event);
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
    return { reconnect };
  }

  const timer = setInterval(() => supervisor.tick().catch((e) => say(`tick failed: ${(e as Error).message}`)), tickMs);
  // A conversation deleted while this pod was stopped left its attachments on the volume and sent no `close` anybody
  // was there to hear, so the directories are swept against the hub's list from time to time.
  const reconciler = setInterval(() => {
    reconcileUploads({ api, id, env, say, ...(options.uploadsDir === undefined ? {} : { root: options.uploadsDir }) }).catch((e) =>
      say(`reconciling uploads failed: ${(e as Error).message}`)
    );
  }, reconcileMs);
  try {
    await supervisor.adopt();
    say(`assistant supervisor started: at most ${supervisor.max} sessions at once, each stopped after ${idleMinutes(env)} idle minutes`);
    let retry: ReconnectDecision = { delay: 0, backoff: 0, rapidCloses: 0 };
    while (!stopping) {
      let opened = Date.now();
      let clean = false;
      try {
        controller = new AbortController();
        const res = await api.sessionsStream(id, { signal: controller.signal });
        opened = Date.now();
        const ended = await consume(res);
        clean = true;
        if (!ended.reconnect) {
          say("sessions stream ended without a reconnect event");
        }
      } catch (e) {
        if (stopping) {
          break;
        }
        if ((e as Error).name !== "AbortError") {
          say(`sessions stream error: ${(e as Error).message}`);
        }
      }
      if (stopping) {
        break;
      }
      retry = reconnectDelay(retry, { clean, lastedMs: Date.now() - opened });
      if (clean && retry.delay > 0) {
        say(`sessions streams keep ending within ${RAPID_CLOSE_MS}ms; backing off ${retry.delay}ms`);
      }
      if (retry.delay > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, retry.delay);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  } finally {
    clearInterval(timer);
    clearInterval(reconciler);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
