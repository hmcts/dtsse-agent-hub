// The long-lived half: consume the virtual agent's sessions stream, hand each wake, interrupt and close to the
// supervisor, and tick it so idle sessions stop and queued ones start. Reconnects as the bridge does, because the
// stream is framed as the agent stream and ends the same way.
import type { Api } from "../api.ts";
import { RAPID_CLOSE_MS, type ReconnectDecision, reconnectDelay } from "../bridge.ts";
import { createSseParser, type SseEvent } from "../sse.ts";
import { atlassianLogin } from "../virtual/atlassian.ts";
import { run } from "../virtual/sign-in.ts";
import { deleteUploads, readDeleteUploads, reconcileUploads } from "./attachments.ts";
import { type DiskFs, reportUploads } from "./disk.ts";
import { createLookupRunner, type LookupDeps, type Run } from "./lookups.ts";
import { type MemoryFs, reportMemory } from "./memory.ts";
import { type AssistantSupervisor, type CreateAssistantSupervisorOptions, createAssistantSupervisor, idleMinutes } from "./supervisor.ts";
import { createWelshRunner } from "./welsh.ts";

const TICK_MS = 2000;
const STREAM_IDLE_MS = 45000;
/**
 * How often the uploads on disk are reconciled against the hub's conversations, and reported to it.
 *
 * Rare, because the reconciliation is only a backstop and the report is of figures nobody watches change. It is also
 * the interval the hub's wording promises a deletion within, so moving it means moving that too.
 */
const RECONCILE_MS = 10 * 60 * 1000;

export type RunAssistantSupervisorOptions = Omit<CreateAssistantSupervisorOptions, "api" | "id"> & {
  api: Pick<Api, "putSessions" | "sessionsStream" | "conversations" | "putUploads" | "putLookup" | "putMemory" | "putWelsh" | "putWelshFile" | "welshFile">;
  id: string;
  /** The filesystem the uploads report and the deletions use; a test passes its own. */
  uploadsFs?: DiskFs;
  /** Where the memory cgroup is read from, and with what; a test passes its own rather than a real cgroup. */
  cgroupRoot?: string;
  memoryFs?: MemoryFs;
  /** How lookups run twg and sign it in; a test passes its own rather than a twg on PATH. */
  /** How Welsh jobs run cft-workspace's scripts/welsh, and where that checkout is; a test passes its own. */
  welsh?: { run?: Run; workspace?: string };
  lookups?: Partial<LookupDeps>;
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
  uploadsFs,
  lookups: lookupDeps = {},
  welsh: welshDeps = {},
  cgroupRoot,
  memoryFs,
  ...options
}: RunAssistantSupervisorOptions): Promise<void> {
  const supervisor: AssistantSupervisor = createAssistantSupervisor({ api, id, env, say, ...options });
  // Lookups run beside the supervisor rather than on its chain: see `createLookupRunner`.
  const lookups = createLookupRunner({
    api,
    id,
    env,
    say,
    run: lookupDeps.run ?? ((cmd, args, opts) => run(cmd, args, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs })),
    login: lookupDeps.login ?? (async () => (await atlassianLogin({ env })) !== "not-signed-in"),
    ...(lookupDeps.env === undefined ? {} : { env: lookupDeps.env })
  });
  // Welsh jobs run beside the supervisor too: a quick one has somebody waiting on the page, and a long one runs for
  // minutes that no wake should wait behind.
  const welsh = createWelshRunner({
    api,
    id,
    env,
    say,
    run: welshDeps.run ?? ((cmd, args, opts) => run(cmd, args, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs })),
    workspace: welshDeps.workspace ?? env.VIRTUAL_AGENT_WORKSPACE ?? "/workspace/cft-workspace"
  });
  const uploads = {
    api,
    id,
    env,
    say,
    ...(options.uploadsDir === undefined ? {} : { root: options.uploadsDir }),
    ...(uploadsFs === undefined ? {} : { fs: uploadsFs })
  };
  const memory = {
    api,
    id,
    say,
    ...(cgroupRoot === undefined ? {} : { root: cgroupRoot }),
    ...(memoryFs === undefined ? {} : { fs: memoryFs })
  };

  /**
   * The files the person asked to be deleted, and a report acknowledging the ones that are gone.
   *
   * That report is what ends the request, so sending it here rather than waiting for the next reconcile is the
   * difference between the settings saying "waiting for your assistant" for seconds and for ten minutes.
   *
   * Nothing is sent when it deleted nothing. There would be nothing to acknowledge, and a report for every frame
   * would be a loop between the two ends with no backoff and nothing giving up: the hub asks again when this pod's
   * stream next opens, which is the right cadence for a file that cannot be removed at all.
   */
  async function removeUploads(data: unknown): Promise<void> {
    const asked = readDeleteUploads(data);
    if (asked === undefined) {
      return;
    }
    const { deleted, failed } = deleteUploads({ ...uploads, conversationId: asked.conversationId, uploadIds: asked.uploadIds });
    if (failed.length > 0) {
      say(`conversation ${asked.conversationId}: ${failed.length} file(s) could not be deleted; the hub will ask again`);
    }
    if (deleted.length > 0) {
      await reportUploads({ ...uploads, deleted });
    }
  }

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
        } else if (event.event === "interrupt") {
          handle(supervisor.interrupt, event);
        } else if (event.event === "close") {
          handle(supervisor.close, event);
        } else if (event.event === "lookup") {
          // Not through `handle`, whose chain runs one event after another: somebody is typing and waiting for this.
          try {
            lookups.lookup(JSON.parse(event.data));
          } catch {
            say("unparseable lookup event");
          }
        } else if (event.event === "welsh") {
          // Not through `handle` either: a job can run for minutes, and the wakes behind it must not wait.
          try {
            welsh.welsh(JSON.parse(event.data));
          } catch {
            say("unparseable welsh event");
          }
        } else if (event.event === "delete_uploads") {
          handle(removeUploads, event);
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

  // One report at a time, however many things ask for one. Two overlapping `PUT`s can be stored in either order, and
  // the later-stored one wins, so an older measurement could end up as the hub's current figure. Skipping rather than
  // queueing, because every caller here only ever wants the latest reading and the next trigger is seconds away.
  let reportingMemory = false;
  const sendMemory = async () => {
    if (reportingMemory) {
      return;
    }
    reportingMemory = true;
    try {
      await reportMemory(memory);
    } finally {
      reportingMemory = false;
    }
  };

  // A session starting or ending steps the container's `anon` by about one conversation, and nothing else steps it,
  // so the hub is told on the step rather than left to find out on the next reconcile. It is the figure the hub's
  // low-memory warning is computed from, and a warning that lags a chat being closed by up to ten minutes is one the
  // person has already acted on and been ignored for. Work inside a session moves `anon` too, without any step to
  // trigger on, which is what the reconcile below is for. The most this can send is one report per tick, so a couple
  // a minute at the default and never more than the guard above allows at once.
  let reportedSessions = supervisor.sessions.size;
  const timer = setInterval(() => {
    supervisor
      .tick()
      .then(() => {
        if (supervisor.sessions.size !== reportedSessions) {
          reportedSessions = supervisor.sessions.size;
          return sendMemory();
        }
        return undefined;
      })
      .catch((e) => say(`tick failed: ${(e as Error).message}`));
  }, tickMs);
  // A conversation deleted while this pod was stopped left its attachments on the volume and sent no `close` anybody
  // was there to hear, so the directories are swept against the hub's list from time to time.
  const reconciler = setInterval(() => {
    reconcileUploads(uploads)
      // On the same timer, because the hub has no other way to learn what this volume holds and the figures it shows
      // are dated with the report rather than presented as current.
      .then(() => reportUploads(uploads))
      .catch((e) => say(`reconciling uploads failed: ${(e as Error).message}`));
    // On the same timer and not chained onto it: the memory report is four reads of this container's own cgroup, so
    // a volume this pod cannot measure must not cost it the memory figures, and a cgroup it cannot read must not cost
    // it the disk figures. The longest this pod will leave the hub without a fresh figure, rather than the cadence —
    // the tick above reports whenever the number of sessions changes, which is what moves the figure it warns on.
    sendMemory().catch((e) => say(`reporting memory failed: ${(e as Error).message}`));
  }, reconcileMs);
  try {
    await supervisor.adopt();
    // Before the loop, because the hub drops the last pod's report when it asks for this one: until the first report
    // of this boot lands there is nothing to show, and both timers above fire a tick or ten minutes from now. A pod
    // the kubelet restarted after an OOM kill is the case that matters — the hub was never told it was replaced, so
    // this is the only thing that moves the figures off the ones that got it killed.
    await sendMemory().catch((e) => say(`reporting memory failed: ${(e as Error).message}`));
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
