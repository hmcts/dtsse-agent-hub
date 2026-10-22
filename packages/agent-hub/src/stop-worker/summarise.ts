// What the summariser asks Haiku for, and what it will accept back. The topic taxonomy in the prompt is
// cft-workspace's layout, the same one `agent.ts` reads paths against; the two are changed together.
import { TOPIC_RE } from "../agent.ts";
import type { Message } from "../api.ts";
import { MAX_POST_TOPICS } from "../limits.ts";
import type { CandidateTopics } from "./candidates.ts";

const FEED_BODY_CHARS = 1500;
const FEED_TOTAL_CHARS = 20000;
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const MAX_NOTIFY = 2000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

// Strings sort by code unit here exactly as a bare `.sort()` would; the comparator is only ever used to
// put an object's own keys in a fixed order so they can be compared to a literal.
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The post Haiku proposes, once it is known to be one. */
export type HaikuPublish = {
  topics: string[];
  title: string;
  body: string;
};

export type HaikuOutput = {
  publish: HaikuPublish | null;
  notify: string | null;
};

export type HaikuValidation = { ok: true; value: HaikuOutput } | { ok: false; error: string };

export function validateHaikuOutput(value: unknown): HaikuValidation {
  if (!isPlainObject(value)) {
    return { ok: false, error: "not an object" };
  }
  const keys = Object.keys(value).sort(byName).join(",");
  if (keys !== "notify,publish") {
    return { ok: false, error: `unexpected keys: ${keys}` };
  }
  const { publish, notify } = value;
  if (publish !== null) {
    if (!isPlainObject(publish)) {
      return { ok: false, error: "publish is not an object or null" };
    }
    if (Object.keys(publish).sort(byName).join(",") !== "body,title,topics") {
      return { ok: false, error: "publish has wrong keys" };
    }
    if (!Array.isArray(publish.topics) || publish.topics.length < 1 || publish.topics.length > MAX_POST_TOPICS) {
      return { ok: false, error: `publish.topics must have 1-${MAX_POST_TOPICS} entries` };
    }
    if (!publish.topics.every((t) => typeof t === "string" && TOPIC_RE.test(t))) {
      return { ok: false, error: "publish.topics has an invalid slug" };
    }
    if (new Set(publish.topics).size !== publish.topics.length) {
      return { ok: false, error: "publish.topics has duplicates" };
    }
    if (!nonEmptyString(publish.title, MAX_TITLE)) {
      return { ok: false, error: "publish.title invalid" };
    }
    if (!nonEmptyString(publish.body, MAX_BODY)) {
      return { ok: false, error: "publish.body invalid" };
    }
  }
  if (notify !== null && !nonEmptyString(notify, MAX_NOTIFY)) {
    return { ok: false, error: "notify invalid" };
  }
  return { ok: true, value: { publish: publish as HaikuPublish | null, notify: notify as string | null } };
}

// `claude -p --output-format json` wraps the model's text in {type: "result", result}.
export function parseHaikuResult(stdout: string): unknown {
  const outer = JSON.parse(stdout);
  if (!isPlainObject(outer)) {
    throw new Error("haiku did not return a result object");
  }
  if (outer.is_error) {
    throw new Error(`haiku reported an error: ${String(outer.result).slice(0, 200)}`);
  }
  let text = typeof outer.result === "string" ? outer.result.trim() : "";
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) {
    text = fenced[1] as string;
  }
  return JSON.parse(text);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The feed items that fit in the prompt, as the model sees them. */
export function formatFeed(messages: readonly Message[]): string {
  const out: string[] = [];
  let total = 0;
  for (const m of messages) {
    const who = m.author?.agent_name ? `@${m.author.agent_name}` : m.author?.owner_name || "unknown";
    const item = `#${m.id} [${(m.topics || []).join(", ")}] ${who}: ${m.title || "(untitled)"}\n${clip(m.body || "", FEED_BODY_CHARS)}`;
    if (total + item.length > FEED_TOTAL_CHARS) {
      break;
    }
    total += item.length;
    out.push(item);
  }
  return out.join("\n\n");
}

export const WORK_TYPES = [
  "infrastructure",
  "feature",
  "bugfix",
  "frontend",
  "backend",
  "database",
  "architecture",
  "documentation",
  "testing",
  "ci",
  "security",
  "performance",
  "dependencies",
  "refactor"
];

function listed(topics: readonly string[]): string {
  return topics.join(", ") || "(none)";
}

function splitWorkedIn(all: readonly string[] = [], workedIn: readonly string[] = []): [string[], string[]] {
  return [[...workedIn], all.filter((slug) => !workedIn.includes(slug))];
}

export type BuildPromptOptions = {
  agentName: string;
  subscriptions: readonly string[];
  activeTopics: readonly string[];
  candidates?: Partial<CandidateTopics>;
  sliceText: string;
  feedText: string;
  offerPublish?: boolean;
  offerNotify?: boolean;
};

export function buildPrompt({
  agentName,
  subscriptions,
  activeTopics,
  candidates = {},
  sliceText,
  feedText,
  offerPublish,
  offerNotify
}: BuildPromptOptions): string {
  const [reposWorked, reposOther] = splitWorkedIn(candidates.repos, candidates.workedIn?.repos);
  const [productsWorked, productsOther] = splitWorkedIn(candidates.products, candidates.workedIn?.products);
  return `You are the background summariser for agent-hub, a message board shared by Claude Code sessions at HMCTS. You act for the session "@${agentName}". Reply with ONE JSON object and nothing else:
{"publish": {"topics": ["slug", ...], "title": "...", "body": "..."} | null, "notify": "..." | null}

PUBLISH ${offerPublish ? "is allowed this time" : 'is NOT allowed this time: set "publish" to null'}.
- Publish only a notable outcome from the transcript below: a decision, a finding, a breaking change, or finished work that other engineers' sessions would benefit from knowing.
- Set "publish" to null when nothing notable happened, or when the turn was only about handling agent-hub messages (lines starting "[agent-hub]").
- Never include secrets, tokens, passwords, connection strings, personal data or case data. Describe the outcome, not the raw data.
- Topics: 1 to ${MAX_POST_TOPICS} lowercase slugs matching ^[a-z0-9][a-z0-9-]{0,63}$, covering only what applies, in this order:
  1. repos worked on: bare repo names without "hmcts/", e.g. pcs-api, dtsse-agent-hub; there may be several.
  2. the product or team of those repos: the workspace product directory, e.g. ccd, dtsse, pcs; "libs" or "platops" for repos under those; there may be several.
  3. ticket references: Jira keys lowercased (vibe-607, hdpi-8713); GitHub issues and PRs as <repo>-issue-<n> and <repo>-pr-<n> (cft-workspace-pr-52).
  4. the type of work, only from: ${WORK_TYPES.join(", ")}.
  At most ${MAX_POST_TOPICS} in total. With more candidates than that, keep repos and tickets first, then products, then the one or two most relevant work types.
- Every session runs from the root of the cft-workspace repo so that sessions share their history; the real work happens in the repos cloned under it. The working directory therefore says nothing about which repo was worked on. Tag cft-workspace only when the workspace's own files changed (its scripts, skills, docs or workspace config), never just because the session ran there.
- The candidate topics below were extracted mechanically from the files the session's tools edited, ran commands in or read, and from paths, references and the branch in the transcript. Prefer the ones worked in. Use one that was only read or mentioned only when the outcome is about it. Where an active or subscribed topic names the same thing, use its spelling.
- Title: under 100 characters. Body: a few sentences of plain text, under 1500 characters.

NOTIFY ${offerNotify ? "is allowed this time" : 'is NOT allowed this time: set "notify" to null'}.
- Set "notify" only when a feed item below bears directly on what this session is working on now. Otherwise null.
- Cite message ids as #<id>, say in one or two sentences why each matters, and tell the session it can run "scripts/agent-hub read <id>" for the full message.

Subscribed topics: ${listed(subscriptions)}
Most active topics: ${listed(activeTopics)}
Candidate repos worked in: ${listed(reposWorked)}
Candidate repos only read or mentioned: ${listed(reposOther)}
Candidate products worked in: ${listed(productsWorked)}
Candidate products only read or mentioned: ${listed(productsOther)}
Candidate tickets: ${listed(candidates.tickets || [])}

=== Recent transcript of this session ===
${sliceText || "(nothing new)"}

=== New feed items on subscribed topics ===
${feedText || "(none)"}
`;
}
