// In-memory implementation of docs/agent-api.md for tests.
// Auth is X-Dev-User (`<oid>|<name>|<email>`), as the service's AGENT_AUTH_DISABLED mode, or a
// virtual agent's launch token as the bearer, which acts as the agent's owner.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { MAX_POST_TOPICS } from "../limits.ts";

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRANSCRIPT_KEY_RE = /^[A-Za-z0-9:_-]{1,200}$/;
const TRANSCRIPT_ROLES = new Set(["user", "assistant", "tool_use", "tool_result", "system"]);
const TRANSCRIPT_MAX_REQUEST = 256 * 1024;
const TRANSCRIPT_MAX_CONTENT = 16384;

export type Person = { oid: string; name?: string; email?: string | null };
export type Skill = { name?: unknown; description?: unknown };
export type LaunchToken = { virtualId: string; owner: Person };

export type StoredAgent = {
  id: string;
  owner_oid: string;
  session_id?: string;
  name?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  host?: string;
  status?: string;
  skills?: Skill[];
  /** As the service stores it: whatever the last register reported, and undefined when one reported nothing. */
  client_features?: string[];
  last_heartbeat_at?: string | null;
  read_cursor?: number;
  conversation_id?: string;
};

export type Wake = { conversation_id: string; session_id: string; resume?: boolean };
export type SessionsReport = { sessions: { conversation_id: string; state: string; detail?: string }[]; max: number };
export type Artefact = { title: string | null; markdown: string; version: number; updated_by: string | null; updated_at: string | null };

export type StoredMessage = {
  id: number;
  created_at: string;
  kind: string;
  topics: string[];
  author_oid: string;
  author_agent_id?: string | null;
  target_agent_id?: string | null;
  title?: string | null;
  body?: string;
  in_reply_to?: string | null;
  from_owner?: boolean;
  assistant?: Record<string, unknown>;
};

export type VirtualRecord = {
  owner: Person;
  status: Record<string, unknown>[];
  credentials: Map<string, string>;
  prompts: Record<string, unknown>[];
  codes: Map<string, string>;
  completes: Record<string, unknown>[];
  /** Sign-ins the pod relayed and gave up on; see `POST /api/virtual/{id}/login/{kind}/failed`. */
  loginFailures: Record<string, unknown>[];
  ports: Record<string, unknown>[];
  wakes: Wake[];
  sessionReports: SessionsReport[];
  /** What the pod said its volume holds, newest last; see `PUT /api/virtual/{id}/uploads`. */
  uploadsReports: Record<string, unknown>[];
};

export type RecordedCall = {
  method?: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, any>;
  headers: http.IncomingHttpHeaders;
  at?: number;
};

type Body = Record<string, any>;

// Why the service would refuse a transcript batch with 400, or null.
function transcriptProblem(body: Body, rawBytes: number): string | null {
  if (rawBytes > TRANSCRIPT_MAX_REQUEST) {
    return "request too large";
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return "session_id required";
  }
  if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 100) {
    return "entries must hold 1-100 items";
  }
  for (const e of body.entries) {
    if (typeof e.key !== "string" || !TRANSCRIPT_KEY_RE.test(e.key)) {
      return "bad key";
    }
    if (!TRANSCRIPT_ROLES.has(e.role)) {
      return "bad role";
    }
    if (!e.content || typeof e.content !== "object") {
      return "content required";
    }
    if (Buffer.byteLength(JSON.stringify(e.content)) > TRANSCRIPT_MAX_CONTENT) {
      return "content too large";
    }
    if (typeof e.truncated !== "boolean" || typeof e.redacted !== "boolean") {
      return "flags must be booleans";
    }
    if (e.message_id !== null && typeof e.message_id !== "string") {
      return "bad message_id";
    }
    if (typeof e.occurred_at !== "string" || Number.isNaN(Date.parse(e.occurred_at))) {
      return "bad occurred_at";
    }
  }
  return null;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;
const CLIENT_FEATURE_NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;

function skillsProblem(skills: unknown): string | null {
  if (!Array.isArray(skills) || skills.length > 200) {
    return "skills: at most 200";
  }
  for (const s of skills) {
    if (typeof s?.name !== "string" || s.name.length > 100 || !SKILL_NAME_RE.test(s.name)) {
      return "skills: bad name";
    }
    if (s.description !== undefined && s.description !== null && typeof s.description !== "string") {
      return "skills: bad description";
    }
  }
  return null;
}

/**
 * What the service stores for a reported list: sorted, de-duplicated, with anything that is not a name dropped, and
 * nothing at all for a register that reported none. Over the cap it refuses, like `boundedArray` does. Reproduced
 * here so a client test cannot pass on a value the service would never have kept.
 */
function storedClientFeatures(features: unknown): string[] | "too many" | undefined {
  if (features === undefined) {
    return undefined;
  }
  if (!Array.isArray(features) || features.length > 50) {
    return "too many";
  }
  const names = features.filter((f): f is string => typeof f === "string" && f.length <= 50 && CLIENT_FEATURE_NAME_RE.test(f));
  return [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export type MockHubOptions = {
  pingMs?: number;
  maxLifetimeMs?: number;
  reconnectEvent?: boolean;
  replayAcked?: boolean;
  launchTokens?: Record<string, LaunchToken>;
};

// `maxLifetimeMs` ends each stream like the service does, with `event: reconnect` unless
// `reconnectEvent` is false. `replayAcked` replays delivered messages too, as a replay that raced
// the ack would.
export function createMockHub({ pingMs = 15000, maxLifetimeMs = 0, reconnectEvent = true, replayAcked = false, launchTokens = {} }: MockHubOptions = {}) {
  const options = { maxLifetimeMs, reconnectEvent, replayAcked };
  const failures: { stream: number[]; ack: number[]; transcript: number[] } = { stream: [], ack: [], transcript: [] };
  // Set through onBeforeRespond, for a caller that keeps a copy of what the hub recorded.
  let beforeRespond: (() => void) | null = null;
  const transcripts = new Map<string, Map<string, Record<string, unknown>>>();
  const users = new Map<string, Person>();
  const agents = new Map<string, StoredAgent>();
  const messages: StoredMessage[] = [];
  const subscriptions = new Map<string, Set<string>>();
  const deliveries = new Map<string, { message_id: number; agent_id: string; state: string }>();
  const streams = new Map<string, ServerResponse>();
  const calls: RecordedCall[] = [];
  const waiters: { match: (call: RecordedCall) => boolean; resolve: (call: RecordedCall) => void; timer?: NodeJS.Timeout }[] = [];
  // virtual agent id → the open sessions stream
  const sessionStreams = new Map<string, ServerResponse>();
  // agent id → the conversation's document, for conversations' agents
  const artefacts = new Map<string, Artefact>();
  const jiraReports: Record<string, unknown>[] = [];
  const confluenceReports: Record<string, unknown>[] = [];
  // Every answer a supervisor gave to a lookup, in the order they came.
  const lookupAnswers: { virtual_id: string; lookup_id: string; body: Record<string, unknown> }[] = [];
  // upload id → the parts the pod may still fetch, and whether it has reported having the whole file
  const attachments = new Map<string, { parts: Uint8Array[]; fetched: boolean }>();
  // virtual agent id → { owner, status: [], credentials: Map, prompts: [], codes: Map, completes: [], ports: [], wakes: [], sessionReports: [] }
  const virtuals = new Map<string, VirtualRecord>();
  // person oid → Map(kind → value), the /api/agent/credentials routes
  const personCredentials = new Map<string, Map<string, string>>();
  for (const { virtualId, owner } of Object.values(launchTokens)) {
    virtuals.set(virtualId, {
      owner,
      status: [],
      credentials: new Map(),
      prompts: [],
      codes: new Map(),
      completes: [],
      loginFailures: [],
      ports: [],
      wakes: [],
      sessionReports: [],
      uploadsReports: []
    });
  }
  let nextId = 1000;

  function record(call: RecordedCall) {
    call.at = Date.now();
    calls.push(call);
    for (const w of [...waiters]) {
      if (w.match(call)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(call);
      }
    }
  }

  function waitFor(match: (call: RecordedCall) => boolean, timeoutMs = 5000): Promise<RecordedCall> {
    const existing = calls.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w: (typeof waiters)[number] = { match, resolve };
      waiters.push(w);
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) {
          waiters.splice(i, 1);
          reject(new Error("timed out waiting for mock call"));
        }
      }, timeoutMs);
    });
  }

  function authorOf(msg: StoredMessage) {
    const owner = users.get(msg.author_oid) || ({} as Person);
    const agent = msg.author_agent_id ? agents.get(msg.author_agent_id) : null;
    return {
      type: agent ? "agent" : "user",
      agent_id: agent?.id ?? null,
      agent_name: agent?.name ?? null,
      owner_name: owner.name ?? "unknown",
      owner_email: owner.email ?? null
    };
  }

  function view(msg: StoredMessage) {
    return {
      id: String(msg.id),
      kind: msg.kind,
      title: msg.title ?? null,
      body: msg.body,
      topics: msg.topics,
      in_reply_to: msg.in_reply_to ?? null,
      target_agent_id: msg.target_agent_id ?? null,
      created_at: msg.created_at,
      author: authorOf(msg)
    };
  }

  function sendEvent(agentId: string, msg: StoredMessage | undefined) {
    const res = streams.get(agentId);
    if (res && msg) {
      const frame = { message: view(msg), from_owner: msg.from_owner === true, ...(msg.assistant ? { assistant: msg.assistant } : {}) };
      res.write(`id: ${msg.id}\nevent: direct\ndata: ${JSON.stringify(frame)}\n\n`);
    }
  }

  function addMessage(fields: Partial<StoredMessage> & { kind: string; author_oid: string }): StoredMessage {
    const msg: StoredMessage = { id: nextId++, created_at: new Date().toISOString(), topics: [], ...fields };
    messages.push(msg);
    if (msg.kind === "direct" && msg.target_agent_id) {
      deliveries.set(`${msg.id}:${msg.target_agent_id}`, { message_id: msg.id, agent_id: msg.target_agent_id, state: "queued" });
      sendEvent(msg.target_agent_id, msg);
    }
    return msg;
  }

  function send(res: ServerResponse, status: number, body?: unknown) {
    // Before the response is written, so a caller that reads the hook's record the moment its own request
    // returns cannot be a request behind.
    beforeRespond?.();
    res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<{ body: Body; rawBytes: number }> {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    return { body: raw ? JSON.parse(raw) : {}, rawBytes: Buffer.byteLength(raw) };
  }

  function checkTopics(list: unknown, min: number, max: number): string[] | null {
    if (!Array.isArray(list)) {
      return null;
    }
    const out = list.map((t) => String(t).toLowerCase());
    if (out.length < min || out.length > max || !out.every((t) => TOPIC_RE.test(t))) {
      return null;
    }
    return [...new Set(out)];
  }

  const PHASES = new Set(["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running", "failed"]);
  const KINDS = new Set(["github", "azure", "claude", "bedrock", "jenkins", "atlassian", "claude_md", "git_identity"]);
  const DEFAULT_CLAUDE_MD = "You are running in a pod in Preview and connected via the agent hub.";

  function handleVirtual(req: IncomingMessage, res: ServerResponse, parts: string[], body: Body, launch: LaunchToken | null | undefined) {
    const [, , id, area, kind, sub] = parts;
    if (!launch || launch.virtualId !== id || !id) {
      return send(res, 403, { error: "forbidden" });
    }
    const v = virtuals.get(id) as VirtualRecord;
    if (req.method === "POST" && area === "status" && !kind) {
      if (!PHASES.has(body.phase)) {
        return send(res, 400, { error: "bad phase" });
      }
      v.status.push(body.detail ? { phase: body.phase, detail: body.detail } : { phase: body.phase });
      return send(res, 204);
    }
    if (req.method === "GET" && area === "conversations" && !kind) {
      const ids = new Set([...agents.values()].filter((a) => a.conversation_id).map((a) => a.conversation_id as string));
      return send(res, 200, { conversations: [...ids].map((conversationId) => ({ id: conversationId })) });
    }
    if (req.method === "PUT" && area === "lookups" && kind && !sub) {
      const answered = Array.isArray(body.results) ? body.results.length <= 10 : ["signed_out", "failed", "superseded"].includes(body.error);
      if (!answered) {
        return send(res, 400, { error: "bad lookup answer" });
      }
      lookupAnswers.push({ virtual_id: id, lookup_id: kind, body });
      return send(res, 204);
    }
    if (req.method === "PUT" && area === "uploads" && !kind) {
      const whole = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
      // The hub requires both lists to be present, since a missing one would read as an authoritative empty list.
      if (
        !whole(body.uploads_bytes) ||
        !whole(body.volume_used_bytes) ||
        !whole(body.volume_total_bytes) ||
        !whole(body.files_total) ||
        !Array.isArray(body.files) ||
        !Array.isArray(body.deleted)
      ) {
        return send(res, 400, { error: "bad uploads report" });
      }
      v.uploadsReports.push(body);
      return send(res, 204);
    }
    if (area === "sessions" && !kind) {
      if (req.method === "PUT") {
        const states = new Set(["starting", "live", "queued"]);
        const ok =
          Array.isArray(body.sessions) &&
          body.sessions.length <= 50 &&
          body.sessions.every(
            (e: Body) =>
              typeof e.conversation_id === "string" &&
              states.has(e.state) &&
              (e.detail === undefined || (typeof e.detail === "string" && e.detail.length <= 200))
          ) &&
          Number.isInteger(body.max) &&
          body.max >= 1 &&
          body.max <= 20;
        if (!ok) {
          return send(res, 400, { error: "bad sessions report" });
        }
        v.sessionReports.push(body as SessionsReport);
        return send(res, 204);
      }
      if (req.method === "GET") {
        beforeRespond?.();
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.flushHeaders();
        res.write(": connected\nretry: 1000\n\n");
        sessionStreams.set(id, res);
        const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
        const lifetime = options.maxLifetimeMs
          ? setTimeout(() => {
              if (options.reconnectEvent) {
                res.write("event: reconnect\ndata: {}\n\n");
              }
              res.end();
            }, options.maxLifetimeMs)
          : null;
        req.on("close", () => {
          clearInterval(ping);
          if (lifetime) {
            clearTimeout(lifetime);
          }
          if (sessionStreams.get(id) === res) {
            sessionStreams.delete(id);
          }
        });
        for (const w of v.wakes) {
          res.write(`event: wake\ndata: ${JSON.stringify(w)}\n\n`);
        }
        return;
      }
    }
    if (req.method === "PUT" && area === "ports" && !kind) {
      const valid = (list: unknown) => Array.isArray(list) && list.length <= 10 && list.every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535);
      if (!valid(body.ports) || !(body.local_only === undefined || valid(body.local_only))) {
        return send(res, 400, { error: "bad ports" });
      }
      v.ports.push(body);
      return send(res, 204);
    }
    if (!kind || !KINDS.has(kind)) {
      return send(res, 404, { error: "not found" });
    }
    if (area === "credentials" && !sub) {
      if (req.method === "GET") {
        if (v.credentials.has(kind)) {
          return send(res, 200, { value: v.credentials.get(kind) });
        }
        return kind === "claude_md" ? send(res, 200, { value: DEFAULT_CLAUDE_MD }) : send(res, 404, { error: "no credential" });
      }
      if (req.method === "PUT") {
        if (kind === "claude_md" || kind === "git_identity") {
          return send(res, 403, { error: "only its owner can change this credential" });
        }
        if (typeof body.value !== "string" || !body.value) {
          return send(res, 400, { error: "value required" });
        }
        if ((kind === "azure" || kind === "atlassian") && body.value.length > 24000) {
          return send(res, 400, { error: "too large" });
        }
        v.credentials.set(kind, body.value);
        return send(res, 204);
      }
    }
    if (area === "login") {
      if (req.method === "POST" && !sub) {
        v.prompts.push({ kind, ...body });
        return send(res, 204);
      }
      if (req.method === "GET" && sub === "code") {
        if (!v.codes.has(kind)) {
          return send(res, 204);
        }
        const code = v.codes.get(kind);
        v.codes.delete(kind);
        return send(res, 200, { code });
      }
      if (req.method === "POST" && sub === "failed") {
        if (!v.prompts.some((prompt) => prompt.kind === kind)) {
          return send(res, 404, { error: `there is no ${kind} sign-in to report on` });
        }
        v.loginFailures.push({ kind, ...body });
        return send(res, 204);
      }
      if (req.method === "POST" && sub === "complete") {
        v.completes.push({ kind, ...body });
        if (kind === "azure" && body.account_oid !== v.owner.oid) {
          v.credentials.delete("azure");
          v.status.push({ phase: "failed", detail: "azure account is not the owner" });
          return send(res, 409, { error: "account is not the owner" });
        }
        return send(res, 204);
      }
    }
    return send(res, 404, { error: "not found" });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
    const launch = bearer ? launchTokens[bearer] : null;
    const dev = launch ? `${launch.owner.oid}|${launch.owner.name}|${launch.owner.email}` : req.headers["x-dev-user"];
    let body: Body = {};
    let rawBytes = 0;
    try {
      if (req.method !== "GET") {
        const read = await readBody(req);
        body = read.body;
        rawBytes = read.rawBytes;
      }
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    record({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
    if (!dev) {
      return send(res, 401, { error: "unauthenticated" });
    }
    const [oid = "", name, email] = String(dev).split("|");
    users.set(oid, { oid, name, email });

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api" && parts[1] === "virtual") {
      return handleVirtual(req, res, parts, body, launch);
    }
    if (parts[0] !== "api" || parts[1] !== "agent") {
      return send(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && parts[2] === "register") {
      let agent = [...agents.values()].find((a) => a.session_id === body.session_id);
      if (!agent) {
        agent = { id: randomUUID(), owner_oid: oid };
        agents.set(agent.id, agent);
        subscriptions.set(agent.id, new Set());
      }
      if (body.skills !== undefined) {
        const problem = skillsProblem(body.skills);
        if (problem) {
          return send(res, 400, { error: problem });
        }
      }
      const features = storedClientFeatures(body.client_features);
      if (features === "too many") {
        return send(res, 400, { error: "client_features: at most 50" });
      }
      Object.assign(agent, {
        session_id: body.session_id,
        name: body.name,
        cwd: body.cwd,
        repo: body.repo,
        branch: body.branch,
        host: body.host,
        status: "idle",
        // Replaced by every register, unlike the skills below: the service records the build that is running now.
        client_features: features
      });
      if (body.conversation_id !== undefined) {
        if (!launch) {
          return send(res, 409, { error: "conversation_id needs a launch token" });
        }
        agent.conversation_id = body.conversation_id;
        const v = virtuals.get(launch.virtualId) as VirtualRecord;
        v.wakes = v.wakes.filter((w) => w.conversation_id !== body.conversation_id);
      }
      if (body.skills !== undefined) {
        agent.skills = body.skills;
      } else {
        agent.skills ??= [];
      }
      return send(res, 200, { agent_id: agent.id, name: agent.name });
    }
    if (req.method === "GET" && parts[2] === "topics" && parts[4] === "messages") {
      const posts = messages.filter((m) => m.kind === "post" && m.topics.includes(parts[3] as string));
      const limit = Math.min(100, Number(url.searchParams.get("limit") || 100));
      const since = url.searchParams.get("since");
      const out = since === null ? posts.slice(-limit) : posts.filter((m) => m.id > Number(since)).slice(0, limit);
      return send(res, 200, { messages: out.map(view) });
    }
    if (req.method === "GET" && parts[2] === "topics") {
      const counts = new Map<string, { slug: string; message_count: number; last_message_at: string }>();
      for (const m of messages) {
        for (const t of m.topics) {
          counts.set(t, { slug: t, message_count: (counts.get(t)?.message_count || 0) + 1, last_message_at: m.created_at });
        }
      }
      return send(res, 200, { topics: [...counts.values()].filter((t) => t.slug.startsWith(url.searchParams.get("prefix") || "")).reverse() });
    }
    if (req.method === "GET" && parts[2] === "agents") {
      return send(res, 200, {
        agents: [...agents.values()]
          .filter((a) => a.owner_oid === oid)
          .map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            repo: a.repo,
            branch: a.branch,
            last_heartbeat_at: a.last_heartbeat_at ?? null,
            owner: users.get(a.owner_oid)
          }))
      });
    }
    if (req.method === "GET" && parts[2] === "messages") {
      const msg = messages.find((m) => String(m.id) === parts[3]);
      return msg ? send(res, 200, { message: view(msg) }) : send(res, 404, { error: "no such message" });
    }

    if (parts[2] === "credentials" && parts.length === 4) {
      const kind = parts[3] as string;
      if (!KINDS.has(kind)) {
        return send(res, 404, { error: "not found" });
      }
      if (!personCredentials.has(oid)) {
        personCredentials.set(oid, new Map());
      }
      const mine = personCredentials.get(oid) as Map<string, string>;
      if (req.method === "GET") {
        if (kind !== "bedrock" && kind !== "claude_md") {
          return send(res, 405, { error: "write-only" });
        }
        return mine.has(kind) ? send(res, 200, { value: mine.get(kind) }) : send(res, 404, { error: "no credential" });
      }
      if (req.method === "PUT") {
        if (typeof body.value !== "string" || !body.value) {
          return send(res, 400, { error: "value required" });
        }
        mine.set(kind, body.value);
        return send(res, 204);
      }
      if (req.method === "DELETE") {
        return mine.delete(kind) ? send(res, 204) : send(res, 404, { error: "no credential" });
      }
    }

    const agent = agents.get(parts[2] as string);
    if (!agent) {
      return send(res, 404, { error: "no such agent" });
    }
    if (agent.owner_oid !== oid) {
      return send(res, 403, { error: "forbidden" });
    }
    const action = parts[3];

    if (req.method === "POST" && action === "heartbeat") {
      if (body.skills !== undefined) {
        const problem = skillsProblem(body.skills);
        if (problem) {
          return send(res, 400, { error: problem });
        }
        agent.skills = body.skills;
      }
      Object.assign(agent, { status: body.status, name: body.name || agent.name, last_heartbeat_at: new Date().toISOString() });
      return send(res, 204);
    }
    if (req.method === "POST" && action === "offline") {
      agent.status = "offline";
      streams.get(agent.id)?.end();
      return send(res, 204);
    }
    if (req.method === "GET" && action === "stream") {
      const status = failures.stream.shift();
      if (status) {
        return send(res, status, { error: "stream refused" });
      }
      beforeRespond?.();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      streams.set(agent.id, res);
      const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
      const lifetime = options.maxLifetimeMs
        ? setTimeout(() => {
            if (options.reconnectEvent) {
              res.write("event: reconnect\ndata: {}\n\n");
            }
            res.end();
          }, options.maxLifetimeMs)
        : null;
      req.on("close", () => {
        clearInterval(ping);
        if (lifetime) {
          clearTimeout(lifetime);
        }
        if (streams.get(agent.id) === res) {
          streams.delete(agent.id);
        }
      });
      for (const d of deliveries.values()) {
        if (d.agent_id === agent.id && (d.state === "queued" || options.replayAcked)) {
          sendEvent(
            agent.id,
            messages.find((m) => m.id === d.message_id)
          );
        }
      }
      return;
    }
    if (req.method === "POST" && action === "deliveries" && parts[5] === "ack") {
      const d = deliveries.get(`${parts[4]}:${agent.id}`);
      if (!d) {
        return send(res, 404, { error: "no such delivery" });
      }
      const status = failures.ack.shift();
      if (status) {
        return send(res, status, { error: "ack failed" });
      }
      d.state = "delivered";
      return send(res, 204);
    }
    if (req.method === "GET" && action === "feed") {
      const subs = subscriptions.get(agent.id) as Set<string>;
      const since = Number(url.searchParams.get("since") ?? agent.read_cursor ?? 0);
      const limit = Math.min(100, Number(url.searchParams.get("limit") || 100));
      const out = messages
        .filter((m) => m.kind === "post" && m.id > since && m.author_agent_id !== agent.id && m.topics.some((t) => subs.has(t)))
        .slice(0, limit);
      return send(res, 200, { messages: out.map(view), cursor: String(out.length ? (out[out.length - 1] as StoredMessage).id : since) });
    }
    if (req.method === "POST" && action === "cursor") {
      agent.read_cursor = Number(body.cursor);
      return send(res, 204);
    }
    if (req.method === "POST" && action === "posts") {
      const topics = checkTopics(body.topics, 1, MAX_POST_TOPICS);
      if (!topics) {
        return send(res, 400, { error: `topics must be 1-${MAX_POST_TOPICS} valid slugs` });
      }
      const msg = addMessage({
        kind: "post",
        author_agent_id: agent.id,
        author_oid: oid,
        topics,
        title: body.title,
        body: body.body,
        in_reply_to: body.in_reply_to
      });
      return send(res, 201, { message: view(msg) });
    }
    if (req.method === "POST" && action === "direct") {
      let target: StoredAgent | null = null;
      let inReplyTo: string | null = null;
      if (body.reply_to_message) {
        const orig = messages.find((m) => String(m.id) === String(body.reply_to_message));
        if (!orig) {
          return send(res, 404, { error: "no such message" });
        }
        target = orig.author_agent_id ? (agents.get(orig.author_agent_id) ?? null) : null;
        inReplyTo = String(orig.id);
      } else {
        const matches = [...agents.values()].filter((a) => a.id === body.to_agent || a.name === body.to_agent);
        if (matches.length > 1) {
          return send(res, 409, {
            error: "ambiguous",
            candidates: matches.map((a) => ({ id: a.id, name: a.name, owner_name: users.get(a.owner_oid)?.name }))
          });
        }
        if (!matches.length) {
          return send(res, 404, { error: "no such agent" });
        }
        target = matches[0] as StoredAgent;
      }
      const msg = addMessage({
        kind: "direct",
        author_agent_id: agent.id,
        author_oid: oid,
        target_agent_id: target?.id ?? null,
        body: body.body,
        in_reply_to: inReplyTo
      });
      return send(res, 201, { message: view(msg) });
    }
    if (req.method === "POST" && action === "transcript") {
      const status = failures.transcript.shift();
      if (status) {
        return send(res, status, { error: "transcript failed" });
      }
      const problem = transcriptProblem(body, rawBytes);
      if (problem) {
        return send(res, 400, { error: problem });
      }
      if (!transcripts.has(agent.id)) {
        transcripts.set(agent.id, new Map());
      }
      const stored = transcripts.get(agent.id) as Map<string, Record<string, unknown>>;
      let accepted = 0;
      for (const e of body.entries) {
        if (stored.has(e.key)) {
          continue;
        }
        stored.set(e.key, { ...e, session_id: body.session_id });
        accepted++;
      }
      return send(res, 200, { accepted });
    }
    if (action === "artefact") {
      if (!agent.conversation_id) {
        return send(res, 404, { error: "not a conversation" });
      }
      const doc = artefacts.get(agent.id) || { title: null, markdown: "", version: 0, updated_by: null, updated_at: null };
      if (req.method === "GET") {
        return send(res, 200, doc);
      }
      if (req.method === "PUT") {
        if (typeof body.markdown !== "string" || body.markdown.length > 100000 || !Number.isInteger(body.base_version)) {
          return send(res, 400, { error: "bad artefact" });
        }
        if (body.base_version !== doc.version) {
          return send(res, 409, { error: "version conflict", current: doc });
        }
        const next: Artefact = {
          title: body.title ?? doc.title,
          markdown: body.markdown,
          version: doc.version + 1,
          updated_by: "agent",
          updated_at: new Date().toISOString()
        };
        artefacts.set(agent.id, next);
        return send(res, 200, { version: next.version });
      }
    }
    if (action === "jira" && req.method === "PUT") {
      if (!agent.conversation_id) {
        return send(res, 404, { error: "not a conversation" });
      }
      const keyed = typeof body.key === "string" && /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/.test(body.key);
      const failed = typeof body.error === "string" && body.error.trim() !== "" && body.error.length <= 300;
      if (typeof body.export_id !== "string" || keyed === failed) {
        return send(res, 400, { error: "bad jira report" });
      }
      jiraReports.push({ agent_id: agent.id, ...body });
      return send(res, 204);
    }
    if (action === "confluence" && req.method === "PUT") {
      if (!agent.conversation_id) {
        return send(res, 404, { error: "not a conversation" });
      }
      const created = typeof body.page_id === "string" && /^[0-9]{1,20}$/.test(body.page_id);
      const failed = typeof body.error === "string" && body.error.trim() !== "" && body.error.length <= 300;
      if (typeof body.export_id !== "string" || created === failed) {
        return send(res, 400, { error: "bad confluence report" });
      }
      confluenceReports.push({ agent_id: agent.id, ...body });
      return send(res, 204);
    }
    // The pod-facing half of an Assistant attachment: one part's raw bytes, and the report that deletes them.
    if (action === "attachments") {
      const upload = attachments.get(parts[4] as string);
      if (!upload) {
        return send(res, 404, { error: "no such upload" });
      }
      if (req.method === "POST" && parts[5] === "fetched") {
        upload.fetched = true;
        upload.parts = [];
        return send(res, 204);
      }
      if (req.method === "GET" && parts[5] === "parts") {
        const part = upload.parts[Number(parts[6])];
        if (!part) {
          return send(res, 404, { error: "no such part of this file" });
        }
        beforeRespond?.();
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(part.byteLength) });
        return res.end(Buffer.from(part));
      }
    }
    if (action === "subscriptions") {
      const subs = subscriptions.get(agent.id) as Set<string>;
      if (req.method === "GET") {
        return send(res, 200, { topics: [...subs].sort(compareStrings) });
      }
      const topics = checkTopics(body.topics, 1, 200);
      if (!topics) {
        return send(res, 400, { error: "invalid topics" });
      }
      for (const t of topics) {
        if (req.method === "PUT") {
          subs.add(t);
        } else {
          subs.delete(t);
        }
      }
      return send(res, 200, { topics: [...subs].sort(compareStrings) });
    }
    return send(res, 404, { error: "not found" });
  });

  return {
    server,
    calls,
    waitFor,
    agents,
    subscriptions,
    messages,
    deliveries,
    streams,
    transcripts,
    options,
    virtuals,
    personCredentials,
    artefacts,
    jiraReports,
    confluenceReports,
    lookupAnswers,
    attachments,
    sessionStreams,
    // A wake for one of a virtual agent's conversations: kept, and sent on every sessions stream, until a session
    // registers for it.
    sendWake(virtualId: string, data: Wake) {
      const v = virtuals.get(virtualId) as VirtualRecord;
      v.wakes.push(data);
      sessionStreams.get(virtualId)?.write(`event: wake\ndata: ${JSON.stringify(data)}\n\n`);
    },
    // Stopping an answer. Unlike a wake it is not kept: the hub sends one once and never replays it.
    sendInterrupt(virtualId: string, data: { conversation_id: string }) {
      sessionStreams.get(virtualId)?.write(`event: interrupt\ndata: ${JSON.stringify(data)}\n\n`);
    },
    // The person asking for files on the pod's own volume to go. Replayed by the hub until a report stops naming
    // them, so unlike an interrupt a test may send it more than once.
    sendDeleteUploads(virtualId: string, data: { conversation_id: string; upload_ids: string[] }) {
      sessionStreams.get(virtualId)?.write(`event: delete_uploads\ndata: ${JSON.stringify(data)}\n\n`);
    },
    // The owner searching their Jira or Confluence. Sent once and never replayed, as the hub does.
    sendLookup(virtualId: string, data: Record<string, unknown>) {
      sessionStreams.get(virtualId)?.write(`event: lookup\ndata: ${JSON.stringify(data)}\n\n`);
    },
    sendClose(virtualId: string, data: { conversation_id: string }) {
      const v = virtuals.get(virtualId) as VirtualRecord;
      v.wakes = v.wakes.filter((w) => w.conversation_id !== data.conversation_id);
      sessionStreams.get(virtualId)?.write(`event: close\ndata: ${JSON.stringify(data)}\n\n`);
    },
    // The person editing their conversation's document in the web UI.
    editArtefactAsUser(agentId: string, markdown: string, title = "Draft") {
      const doc = artefacts.get(agentId);
      artefacts.set(agentId, { title, markdown, version: (doc?.version ?? 0) + 1, updated_by: "user", updated_at: new Date().toISOString() });
    },
    // Runs as each response is written, before the caller can see it. A test that mirrors the hub's state
    // somewhere a process outside this one reads — `src/virtual-agent-boot.test.ts` writes a file the boot
    // script's jq asserts on — has to write it here: a write hung on the response's `finish` lands after the
    // data has gone to the socket, so the caller can be reading one request behind. The stream handlers call
    // it themselves, because they write their own head rather than going through `send`; a new response that
    // does the same has to do likewise, or whatever it mutates is missing from the record.
    onBeforeRespond(hook: () => void) {
      beforeRespond = hook;
    },
    // The next `count` stream requests, acks or transcript uploads answer `status` instead.
    failNextStreams(count: number, status = 500) {
      for (let i = 0; i < count; i++) {
        failures.stream.push(status);
      }
    },
    failNextAcks(count: number, status = 500) {
      for (let i = 0; i < count; i++) {
        failures.ack.push(status);
      }
    },
    failNextTranscripts(count: number, status = 500) {
      for (let i = 0; i < count; i++) {
        failures.transcript.push(status);
      }
    },
    async listen(): Promise<string> {
      await new Promise<void>((r) => {
        server.listen(0, "127.0.0.1", () => r());
      });
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    async close(): Promise<void> {
      for (const s of [...streams.values(), ...sessionStreams.values()]) {
        s.destroy();
      }
      server.closeAllConnections?.();
      await new Promise<void>((r) => {
        server.close(() => r());
      });
    },
    // Test hooks: a human (UI) or another agent sending to an agent.
    sendDirectFromUser(
      targetAgentId: string,
      bodyText: string,
      user: Person = { oid: "u-alice", name: "Alice Smith", email: "alice@example.com" },
      { assistant }: { assistant?: Record<string, unknown> } = {}
    ) {
      users.set(user.oid, user);
      return view(addMessage({ kind: "direct", author_oid: user.oid, target_agent_id: targetAgentId, body: bodyText, assistant }));
    },
    sendDirectFromOwner(targetAgentId: string, bodyText: string, { assistant }: { assistant?: Record<string, unknown> } = {}) {
      const agent = agents.get(targetAgentId) as StoredAgent;
      const user = users.get(agent.owner_oid) || { oid: agent.owner_oid, name: "Owner", email: null };
      return view(addMessage({ kind: "direct", author_oid: user.oid, target_agent_id: targetAgentId, body: bodyText, from_owner: true, assistant }));
    },
    addPost({
      topics,
      title,
      bodyText,
      fromAgent = null,
      user = { oid: "u-bob", name: "Bob Jones", email: "bob@example.com" }
    }: {
      topics: string[];
      title?: string;
      bodyText?: string;
      fromAgent?: string | null;
      user?: Person;
    }) {
      users.set(user.oid, user);
      let author: StoredAgent | null = null;
      if (fromAgent) {
        author = { id: randomUUID(), owner_oid: user.oid, name: fromAgent, status: "idle" };
        agents.set(author.id, author);
        subscriptions.set(author.id, new Set());
      }
      return view(addMessage({ kind: "post", author_oid: user.oid, author_agent_id: author?.id ?? null, topics, title, body: bodyText }));
    }
  };
}

export type MockHub = ReturnType<typeof createMockHub>;

// Strings sort by code point; never a bare `.sort()`.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
