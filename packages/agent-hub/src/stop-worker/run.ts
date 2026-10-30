// The Stop hook's background pass: read what is new in the transcript and the feed, decide whether either is
// due, ask Haiku for a post and a note, and keep the registration on the repo the session is actually working
// in. Everything it may do is rate limited by `cursors.json`, which is also the only state it keeps.
import fs from "node:fs";
import os from "node:os";
import { gitBranch, loadAgent, repoName, type StoredAgent, slugify, TOPIC_RE, workspaceRepoName, workspaceRoot } from "../agent.ts";
import { type Api, createApi } from "../api.ts";
import { CLIENT_FEATURES } from "../features.ts";
import { holdNote } from "../held-notes.ts";
import { findSecret } from "../secret-scan.ts";
import {
  acquirePidFile,
  type Config,
  DEFAULT_CONFIG,
  isEnabled,
  log,
  readJson,
  releasePidFile,
  removeFile,
  sessionInfo,
  statePath,
  writeJson
} from "../session.ts";
import { candidateTopics } from "./candidates.ts";
import { runHaiku } from "./haiku.ts";
import { buildPrompt, formatFeed, parseHaikuResult, validateHaikuOutput } from "./summarise.ts";
import { NO_TOUCHES, type Touches, workedInRepos } from "./touches.ts";
import { readTranscriptSlice, type TranscriptSlice } from "./transcript.ts";

const MAX_PASSES = 3;

/** Everything `cursors.json` holds: where the transcript and the feed were last read to, and when the worker last acted. */
export type Cursors = {
  transcript_path?: string;
  transcript_offset?: number;
  feed_cursor?: string;
  last_publish_at?: number;
  last_notify_at?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Null for a file that is not an object. Every field is dropped unless it has the shape this module writes. */
export function parseCursors(value: unknown): Cursors | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    transcript_path: asString(raw.transcript_path),
    transcript_offset: asNumber(raw.transcript_offset),
    feed_cursor: asString(raw.feed_cursor),
    last_publish_at: asNumber(raw.last_publish_at),
    last_notify_at: asNumber(raw.last_notify_at)
  };
}

/** An agent.json the hub has answered for: without an id there is nothing to summarise for. */
type WorkerAgent = StoredAgent & { agent_id: string };

function isRegistered(agent: StoredAgent | null): agent is WorkerAgent {
  return typeof agent?.agent_id === "string" && agent.agent_id.length > 0;
}

export type Decision = {
  offerPublish: boolean;
  offerNotify: boolean;
  callHaiku: boolean;
  advanceTranscript: boolean;
  advanceFeed: boolean;
};

export type DecideOptions = {
  now: number;
  cursors: Cursors;
  config: Config;
  sliceText: string;
  secretInSlice: boolean;
  feedCount: number;
};

export function decide({ now, cursors, config, sliceText, secretInSlice, feedCount }: DecideOptions): Decision {
  const publishEvery = config.publish_interval_minutes * 60000;
  const notifyEvery = config.notify_interval_minutes * 60000;
  const publishDue = now - (cursors.last_publish_at || 0) >= publishEvery;
  const notifyDue = now - (cursors.last_notify_at || 0) >= notifyEvery;
  const offerPublish = publishDue && !secretInSlice && sliceText.length > 0;
  const offerNotify = notifyDue && feedCount > 0;
  return {
    offerPublish,
    offerNotify,
    callHaiku: offerPublish || offerNotify,
    // Held back while publishing is rate limited, so the next allowed pass still sees
    // it. Dropped when it holds a secret: it must never reach the model.
    advanceTranscript: offerPublish || secretInSlice || sliceText.length === 0,
    // Held back while notifying is rate limited, so the items are considered later.
    advanceFeed: offerNotify
  };
}

/** The hub calls the summariser makes. A subset of `Api`, so a test can stand in for it without the rest. */
export type StopWorkerApi = Pick<Api, "feed" | "post" | "setCursor" | "subscriptions" | "topics" | "register" | "subscribe">;

export type Haiku = (prompt: string) => Promise<string>;

export type PassContext = {
  sid: string;
  api: StopWorkerApi;
  haiku: Haiku;
  now: () => number;
  config: Config;
  transcriptPath?: string;
  root?: string;
  branchOf?: (dir: string) => string | null;
};

export async function runPass(ctx: PassContext): Promise<void> {
  const { sid } = ctx;
  const root = ctx.root || workspaceRoot();
  const agent = loadAgent(sid);
  if (!isRegistered(agent)) {
    log(sid, "stop-worker: not registered; skipping");
    return;
  }
  const cursorsFile = statePath(sid, "cursors.json");
  const cursors = parseCursors(readJson(cursorsFile)) || {};
  const transcriptPath = ctx.transcriptPath || cursors.transcript_path;
  if (transcriptPath && transcriptPath !== cursors.transcript_path) {
    cursors.transcript_path = transcriptPath;
    cursors.transcript_offset = 0;
  }

  const slice: TranscriptSlice = transcriptPath
    ? readTranscriptSlice(transcriptPath, cursors.transcript_offset || 0, { root })
    : { text: "", touches: NO_TOUCHES, end: 0 };
  try {
    await summarise(ctx, { agent, cursors, cursorsFile, slice, root });
  } finally {
    await followWork(ctx, { agent, touches: slice.touches, root });
  }
}

type SummariseState = {
  agent: WorkerAgent;
  cursors: Cursors;
  cursorsFile: string;
  slice: TranscriptSlice;
  root: string;
};

async function summarise(ctx: PassContext, { agent, cursors, cursorsFile, slice, root }: SummariseState): Promise<void> {
  const { sid, api, haiku, now, config } = ctx;
  const secretInSlice = findSecret(slice.text) !== null;
  if (secretInSlice) {
    log(sid, "stop-worker: secret-shaped string in transcript slice; not publishing");
  }

  const feed = await api.feed(agent.agent_id, { since: cursors.feed_cursor ?? undefined, limit: 100 });
  const messages = feed?.messages || [];

  const d = decide({ now: now(), cursors, config, sliceText: slice.text, secretInSlice, feedCount: messages.length });
  if (!d.callHaiku) {
    log(
      sid,
      `stop-worker: skipped (transcript ${slice.text.length} chars, ${messages.length} feed items, publish ${d.offerPublish ? "due" : "not due"}, notify ${d.offerNotify ? "due" : "not due"})`
    );
  }

  if (d.callHaiku) {
    const [subs, topics] = await Promise.all([api.subscriptions(agent.agent_id), api.topics({ limit: 50 })]);
    const prompt = buildPrompt({
      agentName: sessionInfo(sid).name || agent.name || "",
      subscriptions: subs?.topics || [],
      activeTopics: (topics?.topics || []).map((t) => t.slug),
      candidates: candidateTopics({
        text: secretInSlice ? "" : slice.text,
        touches: slice.touches,
        cwd: agent.cwd,
        repo: agent.repo,
        branch: agent.branch,
        root
      }),
      sliceText: secretInSlice ? "" : slice.text,
      feedText: d.offerNotify ? formatFeed(messages) : "",
      offerPublish: d.offerPublish,
      offerNotify: d.offerNotify
    });
    let parsed: unknown;
    try {
      parsed = parseHaikuResult(await haiku(prompt));
    } catch (e) {
      // Nothing advances, so the next Stop retries this material.
      log(sid, `stop-worker: haiku failed: ${(e as Error).message}`);
      return;
    }
    const valid = validateHaikuOutput(parsed);
    if (!valid.ok) {
      log(sid, `stop-worker: rejected haiku output: ${valid.error}`);
    } else {
      const { publish, notify } = valid.value;
      if (!publish && !notify) {
        log(sid, `stop-worker: haiku found nothing to publish or notify (${slice.text.length} chars, ${messages.length} feed items)`);
      }
      if (publish && d.offerPublish) {
        if (findSecret(`${publish.topics.join(" ")}\n${publish.title}\n${publish.body}`) !== null) {
          log(sid, "stop-worker: secret-shaped string in proposed post; dropped");
        } else {
          const res = await api.post(agent.agent_id, publish);
          cursors.last_publish_at = now();
          log(sid, `stop-worker: published #${res?.message?.id ?? "?"} [${publish.topics.join(", ")}]`);
        }
      }
      if (notify && d.offerNotify) {
        if (findSecret(notify) !== null) {
          log(sid, "stop-worker: secret-shaped string in notification; dropped");
        } else {
          // Held for the user's next prompt: delivering it now would start a turn of its own.
          holdNote(sid, notify, now());
          cursors.last_notify_at = now();
          log(sid, "stop-worker: held note for next prompt");
        }
      }
    }
  }

  if (d.advanceTranscript) {
    cursors.transcript_offset = slice.end;
  }
  if (d.advanceFeed && feed?.cursor !== undefined && feed.cursor !== null) {
    cursors.feed_cursor = String(feed.cursor);
    try {
      await api.setCursor(agent.agent_id, cursors.feed_cursor);
    } catch (e) {
      log(sid, `stop-worker: cursor sync failed: ${(e as Error).message}`);
    }
  }
  writeJson(cursorsFile, cursors);
}

export type FollowWorkState = {
  agent: WorkerAgent;
  touches: Touches;
  root: string;
};

// Keeps the registration and subscriptions on the repos the session actually works in.
export async function followWork(ctx: PassContext, { agent, touches, root }: FollowWorkState): Promise<void> {
  const { sid, api } = ctx;
  const branchOf = ctx.branchOf || gitBranch;
  const worked = workedInRepos(touches, workspaceRepoName(root));
  if (!worked.length) {
    return;
  }
  const top = worked[0]!;
  if (top.slug !== slugify(agent.repo || "")) {
    try {
      const repo = repoName(top.dir) || top.slug;
      const branch = branchOf(top.dir);
      // `client_features` and `name_source` go on this register too, not just the one in `agent.ts`: the service
      // replaces both columns with whatever a register reports, so leaving either off here would downgrade a capable
      // session to "claims nothing", and a session the person had renamed to one whose name came from nowhere, the
      // first time their edits moved to another repo.
      //
      // The name and where it came from are both read from the session registry, in one call. `agent.json` holds the
      // name of the first registration and no /rename rewrites it, so reporting that name beside a live `name_source`
      // would tell the service the person chose a handle they had since replaced — and the next transcript batch
      // would pin the chat's title to the handle they moved away from.
      const session = sessionInfo(sid);
      await api.register({
        session_id: sid,
        name: session.name,
        name_source: session.nameSource,
        cwd: agent.cwd,
        repo,
        branch,
        host: os.hostname(),
        client_features: [...CLIENT_FEATURES]
      });
      Object.assign(agent, { repo, branch });
      writeJson(statePath(sid, "agent.json"), { ...(loadAgent(sid) || agent), repo, branch });
      log(sid, `stop-worker: now working in ${repo}${branch ? ` (${branch})` : ""}`);
    } catch (e) {
      log(sid, `stop-worker: re-register failed: ${(e as Error).message}`);
    }
  }
  try {
    const wanted = [...new Set(worked.flatMap((r) => [r.slug, ...(r.products || [])]))].filter((t) => TOPIC_RE.test(t));
    const current = new Set((await api.subscriptions(agent.agent_id))?.topics || []);
    const missing = wanted.filter((t) => !current.has(t));
    if (!missing.length) {
      return;
    }
    await api.subscribe(agent.agent_id, missing);
    const latest = loadAgent(sid) || agent;
    writeJson(statePath(sid, "agent.json"), { ...latest, topics: [...new Set([...(latest.topics || []), ...missing])] });
    log(sid, `stop-worker: subscribed to ${missing.join(", ")}`);
  } catch (e) {
    log(sid, `stop-worker: subscribe failed: ${(e as Error).message}`);
  }
}

export type RunStopWorkerOptions = {
  sid: string;
  transcriptPath?: string;
  api?: StopWorkerApi;
  haiku?: Haiku;
  now?: () => number;
  config?: Config;
  root?: string;
  branchOf?: (dir: string) => string | null;
};

/** Single-flight: a second worker marks the session dirty and the holder reruns for it, up to `MAX_PASSES` times. */
export async function runStopWorker({
  sid,
  transcriptPath,
  api = createApi(),
  haiku = (prompt) => runHaiku(prompt),
  now = Date.now,
  config = DEFAULT_CONFIG,
  root = workspaceRoot(),
  branchOf = gitBranch
}: RunStopWorkerOptions): Promise<void> {
  const lock = statePath(sid, "worker.lock");
  const dirty = statePath(sid, "dirty");
  if (!acquirePidFile(lock)) {
    fs.writeFileSync(dirty, `${now()}\n`);
    return;
  }
  try {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      removeFile(dirty);
      if (!isEnabled(sid)) {
        break;
      }
      try {
        await runPass({ sid, api, haiku, now, config, transcriptPath, root, branchOf });
      } catch (e) {
        log(sid, `stop-worker: pass failed: ${(e as Error).message}`);
      }
      if (!fs.existsSync(dirty)) {
        break;
      }
    }
  } finally {
    releasePidFile(lock);
  }
}
