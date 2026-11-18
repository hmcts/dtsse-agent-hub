// `agent-hub video put <dir>`: publishes a journey video the session recorded with the workspace's `/cft-journey-video`
// skill. The recording's directory holds `<name>.mp4`, `<name>.vtt`, `<name>.chapters.txt`, `coverage.md` and
// `content-mismatches.md`. The hub is told what the panel shows beside the player, answers a URL for the MP4,
// and the MP4 goes straight there rather than through the hub; the hub then checks the file is in place and makes it the
// conversation's video. See "Journey videos" in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import { JIRA_KEY_RE } from "../jira-export.ts";
import { withRetry } from "../retry.ts";
import { requireSessionId } from "../session.ts";
import type { VideoBeginBody, VideoChapter } from "../wire.ts";
import { type Cli, type Command, parseFlags, requireAgent, UsageError } from "./command.ts";

/** The hub's limits, checked here so a recording too big is refused before anything is sent. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_NAME = 200;
const MAX_CAPTIONS = 100_000;
const MAX_REPORT = 40_000;
const MAX_CHAPTERS = 200;
const MAX_CHAPTER_TITLE = 200;
const MAX_SUMMARY = 300;
/** The hub refuses a chapter later than this. */
const MAX_CHAPTER_SECONDS = 24 * 60 * 60;
const PUT_TIMEOUT_MS = 20 * 60_000;

export function formatStamp(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** At most `max` UTF-16 units, the hub's measure, cut between code points: the hub refuses half a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > max) {
      break;
    }
    kept += point;
  }
  return kept;
}

/**
 * `HH:MM:SS Title` lines, as `<name>.chapters.txt` has them; `MM:SS` is read too. Lines of any other shape are skipped.
 * A chapter past 24 hours is a usage error naming `file` and the line, since the hub would refuse the whole publish.
 */
export function parseChapters(text: string, file = "chapters.txt"): VideoChapter[] {
  const chapters: VideoChapter[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      return;
    }
    const at = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (at > MAX_CHAPTER_SECONDS) {
      throw new UsageError(`${file} line ${index + 1}: ${formatStamp(at)} is more than 24 hours into the video`);
    }
    chapters.push({ at, title: clip(match[4] as string, MAX_CHAPTER_TITLE) });
  });
  return chapters.sort((a, b) => a.at - b.at);
}

/** The one line of coverage.md that says how much of the stories the video shows, or `undefined`. */
export function coverageSummaryLine(markdown: string): string | undefined {
  const line = markdown.split(/\r?\n/).find((candidate) => /\d+ of \d+ stories and \d+ ACs are shown/.test(candidate));
  return line === undefined ? undefined : clip(line.trim(), MAX_SUMMARY);
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

type Recording = { mp4: string; name: string; body: VideoBeginBody };

function readRecording(dir: string, flags: Record<string, string>): Recording {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new UsageError(`${dir} is not a directory`);
  }
  const mp4s = entries.filter((entry) => entry.toLowerCase().endsWith(".mp4")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (mp4s.length !== 1) {
    throw new UsageError(
      mp4s.length === 0
        ? `${dir} has no .mp4: pass the output directory of scripts/journey-video/record`
        : `${dir} has ${mp4s.length} .mp4 files; put one recording's directory`
    );
  }
  const file = mp4s[0] as string;
  const stem = file.slice(0, -".mp4".length);
  const mp4 = path.join(dir, file);
  const bytes = fs.statSync(mp4).size;
  if (bytes < 1 || bytes > MAX_VIDEO_BYTES) {
    throw new UsageError(`${file} is ${bytes} bytes; a video is at most ${MAX_VIDEO_BYTES}`);
  }
  const jira = flags.jira?.trim();
  if (jira !== undefined && !JIRA_KEY_RE.test(jira)) {
    throw new UsageError(`--jira must be an issue key such as HDPI-1234, not ${jira}`);
  }
  const name = (flags.name ?? stem).trim();
  if (name === "" || name.length > MAX_NAME) {
    throw new UsageError(`--name must be 1 to ${MAX_NAME} characters`);
  }
  const captions = readOptional(path.join(dir, `${stem}.vtt`));
  const chapters = parseChapters(readOptional(path.join(dir, `${stem}.chapters.txt`)) ?? "", `${stem}.chapters.txt`);
  const coverage = readOptional(path.join(dir, "coverage.md")) ?? "";
  const mismatches = readOptional(path.join(dir, "content-mismatches.md")) ?? "";
  if (captions !== undefined && captions.length > MAX_CAPTIONS) {
    throw new UsageError(`${stem}.vtt is ${captions.length} characters; the captions are at most ${MAX_CAPTIONS}`);
  }
  if (chapters.length > MAX_CHAPTERS) {
    throw new UsageError(`${stem}.chapters.txt has ${chapters.length} chapters; at most ${MAX_CHAPTERS}`);
  }
  for (const [label, text] of [
    ["coverage.md", coverage],
    ["content-mismatches.md", mismatches]
  ] as const) {
    if (text.length > MAX_REPORT) {
      throw new UsageError(`${label} is ${text.length} characters; at most ${MAX_REPORT}`);
    }
  }
  const summary = coverageSummaryLine(coverage);
  return {
    mp4,
    name,
    body: {
      name,
      bytes,
      ...(captions === undefined ? {} : { captions }),
      chapters,
      coverage,
      ...(summary === undefined ? {} : { coverage_summary: summary }),
      content_mismatches: mismatches,
      ...(jira === undefined ? {} : { jira_key: jira })
    }
  };
}

/** Puts the file to the upload URL as one block blob, which Blob Storage takes up to 5000 MiB of, read from disk as it is sent. */
async function putBlob(url: string, file: string, bytes: number): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": "video/mp4", "x-ms-blob-content-type": "video/mp4", "content-length": String(bytes) },
    body: Readable.toWeb(fs.createReadStream(file)) as never,
    duplex: "half",
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
  } as RequestInit);
  if (!res.ok) {
    throw Object.assign(new Error(`storage answered ${res.status} to the upload`), { status: res.status });
  }
}

async function put(cli: Cli, argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv, ["jira", "name"]);
  const [dir, ...extra] = rest;
  if (dir === undefined) {
    throw new UsageError(`video put needs the recording's output directory: ${CLI} video put <dir> [--jira KEY]`);
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  const recording = readRecording(path.resolve(cli.cwd(), dir), flags);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  let begun: Awaited<ReturnType<typeof api.beginVideo>>;
  try {
    begun = await api.beginVideo(agent.agent_id, recording.body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      cli.printError("agent-hub video: this session is not a CFT Workspace conversation, so there is nowhere to publish a video");
      return 1;
    }
    if (e instanceof ApiError && e.status === 503) {
      cli.printError("agent-hub video: this hub has no storage for journey videos");
      return 1;
    }
    throw e;
  }
  await withRetry(() => putBlob(begun.upload_url, recording.mp4, recording.body.bytes), { attempts: 3, baseMs: 2000 });
  try {
    await withRetry(() => api.finishVideo(agent.agent_id, begun.video_id), { attempts: 3, baseMs: 1000 });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      cli.printError(`agent-hub video: the hub did not find the whole video in storage: ${e.message}. Run the command again.`);
      return 1;
    }
    throw e;
  }
  const jira = recording.body.jira_key;
  cli.print(
    `agent-hub: published "${recording.name}" (${recording.body.chapters.length} chapters) as the conversation's video; the user can watch it in the CFT Workspace${jira === undefined ? "" : ` and post it to ${jira}`}`
  );
  return 0;
}

export const video: Command = async (cli, argv) => {
  const [action, ...rest] = argv;
  if (action === "put") {
    return await put(cli, rest);
  }
  throw new UsageError("video takes put");
};
