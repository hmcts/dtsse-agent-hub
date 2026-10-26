// The HTTP client for the hub. Every shape below is `docs/agent-api.md` in the service's own repository,
// written out again here rather than imported from `src/agent-api/schemas.ts`: this package is published on
// its own, so nothing in it may reach into the Next app's module graph, and it carries no dependencies — the
// hook path must not pay for loading a validation library.
import { execFile } from "node:child_process";
import type { Env } from "./env.ts";
import type { PortsReport } from "./ports.ts";
import { virtualAgent } from "./virtual-agent.ts";

export const DEFAULT_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_SCOPE = "api://dtsse-agent-hub/.default";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
/** One attachment part is up to 4 MiB, which a slow pod connection will not pull inside the JSON timeout. */
const PART_TIMEOUT_MS = 60000;

/** The credential kinds `docs/agent-api.md` defines; any other gives 404. */
export const CREDENTIAL_KINDS = ["github", "azure", "claude", "bedrock", "jenkins", "atlassian", "claude_md", "git_identity"] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** The phases a pod may report with `POST /api/virtual/{id}/status`. */
export type VirtualPhase = "provisioning" | "awaiting_credentials" | "awaiting_login" | "cloning" | "running" | "failed";

export type MessageAuthor = {
  type: "agent" | "user";
  agent_id: string | null;
  agent_name: string | null;
  owner_name: string;
  owner_email: string | null;
};

export type Message = {
  id: string;
  kind: "post" | "direct";
  title: string | null;
  body: string;
  topics: string[];
  in_reply_to: string | null;
  target_agent_id: string | null;
  created_at: string;
  author: MessageAuthor;
};

/** One of the same-named agents a `409` from `direct` offers, so the caller can resend with an id. */
export type DirectCandidate = {
  id: string;
  name: string;
  status?: string;
  repo?: string | null;
  branch?: string | null;
  last_heartbeat_at?: string | null;
  owner_name?: string;
};

export type ApiErrorBody = {
  error?: string;
  candidates?: DirectCandidate[];
  /** A `409` from `putArtefact`: the document as `getArtefact` returns it, to merge the refused change into. */
  current?: Artefact;
};

export type AgentSummary = {
  id: string;
  name: string;
  status: string;
  repo: string | null;
  branch: string | null;
  last_heartbeat_at: string | null;
  owner: { name?: string; email?: string | null };
};

export type TopicSummary = {
  slug: string;
  message_count: number;
  last_message_at: string | null;
};

export type Skill = {
  name: string;
  description?: string | null;
};

export type RegisterBody = {
  session_id: string;
  name: string;
  cwd?: string | null;
  repo?: string | null;
  branch?: string | null;
  host?: string | null;
  skills?: Skill[];
  /**
   * What this build of the client understands of the hub's optional fields; see `features.ts`. Optional on the wire,
   * where leaving it out is how an older client reports nothing, but required here: the service replaces the stored
   * list with whatever a register carries, so a call site that omits it downgrades the session to "claims nothing".
   * A register this client sends always says.
   */
  client_features: string[];
  /** A pod's conversation session only: it adopts the agent the hub made with the conversation. */
  conversation_id?: string;
};

export type HeartbeatBody = {
  status: "busy" | "idle";
  name?: string | null;
  skills?: Skill[];
};

export type PostBody = {
  topics: string[];
  title?: string | null;
  body: string;
  in_reply_to?: string | null;
};

export type DirectBody = {
  to_agent?: string;
  reply_to_message?: string;
  body: string;
};

export type TranscriptEntry = {
  key: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: Record<string, unknown>;
  truncated?: boolean;
  redacted?: boolean;
  message_id?: string | null;
  occurred_at: string;
};

export type TranscriptBody = {
  session_id: string;
  entries: TranscriptEntry[];
};

export type LoginPromptBody = {
  prompt: "device_code" | "paste_code";
  verification_uri: string;
  user_code?: string;
  expires_in: number;
};

export type LoginCompleteBody = {
  account_oid?: string;
  account_label?: string;
};

/** What a conversation's session runs, as `PUT /api/virtual/{id}/sessions` takes it. */
export type SessionReport = {
  conversation_id: string;
  state: "starting" | "live" | "queued";
  detail?: string;
};

export type SessionsBody = {
  sessions: SessionReport[];
  max: number;
};

/** A conversation's Jira export result, as its session reports it: the issue key it created, or why it could not. */
export type JiraExportReport = { export_id: string; key: string } | { export_id: string; error: string };

/** A conversation's one markdown document, which the person and the session both edit. */
export type Artefact = {
  title: string | null;
  markdown: string;
  version: number;
  updated_by: "user" | "agent" | null;
  updated_at: string | null;
};

export type ArtefactBody = {
  title?: string;
  markdown: string;
  base_version: number;
};

export type ArtefactResponse = { version: number };

/** One conversation of a virtual agent, as `conversations` lists them for the uploads reconciliation. */
export type ConversationSummary = { id: string };

export type ConversationsResponse = { conversations: ConversationSummary[] };

export type RegisterResponse = { agent_id: string; name: string };
export type MessageResponse = { message: Message };
export type MessagesResponse = { messages: Message[] };
export type FeedResponse = { messages: Message[]; cursor: string };
export type TopicListResponse = { topics: string[] };
export type TopicsResponse = { topics: TopicSummary[] };
export type AgentsResponse = { agents: AgentSummary[] };
export type TranscriptResponse = { accepted: number };
export type CredentialResponse = { value: string };
export type LoginCodeResponse = { code: string };

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, method: string, path: string) {
    super(`${method} ${path} failed: ${status}${body?.error ? ` ${body.error}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

export type RunAz = (args: string[]) => Promise<string>;

function runAz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("az", args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const hint = (err as NodeJS.ErrnoException).code === "ENOENT" ? "az is not installed" : (stderr || err.message).trim();
        reject(new Error(`az ${args.slice(0, 2).join(" ")} failed: ${hint}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function requireAzureLogin(run: RunAz = runAz): Promise<void> {
  try {
    await run(["account", "show", "-o", "none"]);
  } catch (e) {
    throw new Error(`not logged in to Azure — run: az login\n(${(e as Error).message})`);
  }
}

export type AzToken = { token: string; expiresAt: number };

export function parseAzToken(stdout: string, now: number = Date.now()): AzToken {
  const parsed = JSON.parse(stdout) as { accessToken?: string; expires_on?: unknown; expiresOn?: string };
  if (!parsed.accessToken) {
    throw new Error("az returned no accessToken");
  }
  let expiresAt: number | undefined;
  if (Number.isFinite(Number(parsed.expires_on))) {
    expiresAt = Number(parsed.expires_on) * 1000;
  } else if (parsed.expiresOn) {
    expiresAt = Date.parse(parsed.expiresOn);
  }
  if (!Number.isFinite(expiresAt)) {
    expiresAt = now + 30 * 60 * 1000;
  }
  return { token: parsed.accessToken, expiresAt: expiresAt as number };
}

export type TokenProviderOptions = {
  scope?: string;
  run?: RunAz;
  now?: () => number;
};

export function createTokenProvider({ scope = DEFAULT_SCOPE, run = runAz, now = Date.now }: TokenProviderOptions = {}): () => Promise<string> {
  let cached: AzToken | null = null;
  let pending: Promise<string> | null = null;
  return async function getToken() {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
      return cached.token;
    }
    if (!pending) {
      pending = run(["account", "get-access-token", "--scope", scope, "-o", "json"])
        .then((out) => {
          cached = parseAzToken(out, now());
          return cached.token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

export type RequestOptions = {
  timeoutMs?: number;
};

export type FeedParams = { since?: string | number; limit?: number };
export type TopicsParams = { prefix?: string; limit?: number };
export type TopicMessagesParams = { since?: string | number; before?: string | number; limit?: number };
export type StreamOptions = { signal?: AbortSignal; lastEventId?: string };

export type Api = {
  baseUrl: string;
  headers: (extra?: Record<string, string>) => Promise<Record<string, string>>;
  register: (body: RegisterBody) => Promise<RegisterResponse>;
  heartbeat: (id: string, body: HeartbeatBody) => Promise<null>;
  offline: (id: string, opts?: RequestOptions) => Promise<null>;
  ack: (id: string, messageId: string) => Promise<null>;
  feed: (id: string, params?: FeedParams) => Promise<FeedResponse>;
  setCursor: (id: string, cursor: string | number) => Promise<null>;
  post: (id: string, body: PostBody) => Promise<MessageResponse>;
  direct: (id: string, body: DirectBody) => Promise<MessageResponse>;
  transcript: (id: string, body: TranscriptBody, opts?: RequestOptions) => Promise<TranscriptResponse>;
  subscriptions: (id: string) => Promise<TopicListResponse>;
  subscribe: (id: string, topics: string[]) => Promise<TopicListResponse>;
  unsubscribe: (id: string, topics: string[]) => Promise<TopicListResponse>;
  topics: (params?: TopicsParams) => Promise<TopicsResponse>;
  topicMessages: (slug: string, params?: TopicMessagesParams) => Promise<MessagesResponse>;
  agents: () => Promise<AgentsResponse>;
  message: (messageId: string) => Promise<MessageResponse>;
  virtualStatus: (id: string, phase: VirtualPhase, detail?: string) => Promise<null>;
  getCredential: (id: string, kind: CredentialKind) => Promise<string | null>;
  putCredential: (id: string, kind: CredentialKind, value: string) => Promise<null>;
  putPorts: (id: string, body: PortsReport) => Promise<null>;
  myCredential: (kind: CredentialKind) => Promise<string | null>;
  putMyCredential: (kind: CredentialKind, value: string) => Promise<null>;
  deleteMyCredential: (kind: CredentialKind) => Promise<null>;
  loginPrompt: (id: string, kind: CredentialKind, body: LoginPromptBody) => Promise<null>;
  loginCode: (id: string, kind: CredentialKind) => Promise<string | null>;
  loginComplete: (id: string, kind: CredentialKind, body?: LoginCompleteBody) => Promise<null>;
  sessionsStream: (id: string, opts?: StreamOptions) => Promise<Response>;
  putSessions: (id: string, body: SessionsBody) => Promise<null>;
  conversations: (virtualId: string) => Promise<ConversationsResponse>;
  getArtefact: (agentId: string) => Promise<Artefact>;
  putArtefact: (agentId: string, body: ArtefactBody) => Promise<ArtefactResponse>;
  putJiraExport: (agentId: string, body: JiraExportReport) => Promise<null>;
  /** One part of a file attached to a message in this agent's conversation. One part, never the whole file. */
  attachmentPart: (agentId: string, uploadId: string, index: number) => Promise<Uint8Array>;
  /** The whole file is on this pod's disk, which is what makes the hub delete its part rows. */
  attachmentFetched: (agentId: string, uploadId: string) => Promise<null>;
  stream: (id: string, opts?: StreamOptions) => Promise<Response>;
};

export type CreateApiOptions = {
  env?: Env;
  baseUrl?: string;
  launchToken?: string;
  devUser?: string;
  getToken?: (() => Promise<string>) | null;
  fetchImpl?: typeof fetch;
};

export function createApi({
  env = process.env,
  baseUrl = env.AGENT_HUB_URL || DEFAULT_URL,
  // A virtual agent's pod has no Azure identity of its own; the hub accepts its launch token instead. The
  // token alone does not make a pod — `virtualAgent` is the one predicate, and it wants the agent id too.
  launchToken = virtualAgent(env)?.launchToken ?? "",
  devUser = launchToken ? "" : env.AGENT_HUB_DEV_USER || "",
  getToken = launchToken ? async () => launchToken : devUser ? null : createTokenProvider({ scope: env.AGENT_HUB_SCOPE || DEFAULT_SCOPE }),
  fetchImpl = globalThis.fetch
}: CreateApiOptions = {}): Api {
  const base = baseUrl.replace(/\/+$/, "");

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...extra };
    if (devUser) {
      h["X-Dev-User"] = devUser;
    } else if (getToken) {
      h.Authorization = `Bearer ${await getToken()}`;
    } else {
      throw new Error("no agent-hub credential: sign in to Azure, or set AGENT_HUB_DEV_USER against a development hub");
    }
    return h;
  }

  async function request<T>(method: string, path: string, body?: unknown, { timeoutMs = REQUEST_TIMEOUT_MS }: RequestOptions = {}): Promise<T> {
    const init: RequestInit = {
      method,
      headers: await headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(timeoutMs)
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      throw new ApiError(res.status, json as ApiErrorBody | null, method, path);
    }
    // The one unchecked boundary in this module. The hub answers `docs/agent-api.md`, and a response that
    // does not is a service bug the client cannot repair, so it is asserted here and nowhere else.
    return json as T;
  }

  const a = (agentId: string) => `/api/agent/${encodeURIComponent(agentId)}`;
  const v = (virtualId: string, rest: string) => `/api/virtual/${encodeURIComponent(virtualId)}/${rest}`;
  const k = (kind: CredentialKind) => encodeURIComponent(kind);
  const nullOn404 = <T>(promise: Promise<T>): Promise<T | null> =>
    promise.catch((e) => {
      if (e instanceof ApiError && e.status === 404) {
        return null;
      }
      throw e;
    });
  /**
   * A response read as bytes rather than JSON, for one part of an attachment. `arrayBuffer` here is one part — at
   * most `part_bytes` from the frame — and never the file, which is the whole point of fetching it in parts; the
   * caller appends each part to the file on disk and lets it go.
   *
   * Its own timeout, because 4 MiB over a slow connection takes longer than the 15 seconds a JSON call is given.
   */
  async function requestBytes(path: string, timeoutMs = PART_TIMEOUT_MS): Promise<Uint8Array> {
    const res = await fetchImpl(`${base}${path}`, { headers: await headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      let json: ApiErrorBody | null = null;
      try {
        json = { error: (await res.text()).slice(0, 200) };
      } catch {}
      throw new ApiError(res.status, json, "GET", path);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  // Both streams are framed alike, so the agent stream and a pod's sessions stream open the same way.
  async function openStream(path: string, { signal, lastEventId }: StreamOptions = {}): Promise<Response> {
    const h = await headers({ Accept: "text/event-stream" });
    if (lastEventId) {
      h["Last-Event-ID"] = lastEventId;
    }
    const res = await fetchImpl(`${base}${path}`, { headers: h, signal });
    if (!res.ok) {
      let json: ApiErrorBody | null = null;
      try {
        json = (await res.json()) as ApiErrorBody;
      } catch {}
      throw new ApiError(res.status, json, "GET", path);
    }
    return res;
  }
  const qs = (params: Record<string, string | number | undefined | null>) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        q.set(key, String(value));
      }
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  return {
    baseUrl: base,
    headers,
    register: (body) => request<RegisterResponse>("POST", "/api/agent/register", body),
    heartbeat: (id, body) => request<null>("POST", `${a(id)}/heartbeat`, body),
    offline: (id, opts) => request<null>("POST", `${a(id)}/offline`, undefined, opts),
    ack: (id, messageId) => request<null>("POST", `${a(id)}/deliveries/${encodeURIComponent(messageId)}/ack`),
    feed: (id, { since, limit } = {}) => request<FeedResponse>("GET", `${a(id)}/feed${qs({ since, limit })}`),
    setCursor: (id, cursor) => request<null>("POST", `${a(id)}/cursor`, { cursor: String(cursor) }),
    post: (id, body) => request<MessageResponse>("POST", `${a(id)}/posts`, body),
    direct: (id, body) => request<MessageResponse>("POST", `${a(id)}/direct`, body),
    transcript: (id, body, opts) => request<TranscriptResponse>("POST", `${a(id)}/transcript`, body, opts),
    subscriptions: (id) => request<TopicListResponse>("GET", `${a(id)}/subscriptions`),
    subscribe: (id, topics) => request<TopicListResponse>("PUT", `${a(id)}/subscriptions`, { topics }),
    unsubscribe: (id, topics) => request<TopicListResponse>("DELETE", `${a(id)}/subscriptions`, { topics }),
    topics: ({ prefix, limit } = {}) => request<TopicsResponse>("GET", `/api/agent/topics${qs({ prefix, limit })}`),
    topicMessages: (slug, { since, before, limit } = {}) =>
      request<MessagesResponse>("GET", `/api/agent/topics/${encodeURIComponent(slug)}/messages${qs({ since, before, limit })}`),
    agents: () => request<AgentsResponse>("GET", "/api/agent/agents"),
    message: (messageId) => request<MessageResponse>("GET", `/api/agent/messages/${encodeURIComponent(messageId)}`),
    virtualStatus: (id, phase, detail) => request<null>("POST", v(id, "status"), detail ? { phase, detail } : { phase }),
    getCredential: async (id, kind) => (await nullOn404(request<CredentialResponse>("GET", v(id, `credentials/${k(kind)}`))))?.value ?? null,
    putCredential: (id, kind, value) => request<null>("PUT", v(id, `credentials/${k(kind)}`), { value }),
    putPorts: (id, body) => request<null>("PUT", v(id, "ports"), body),
    myCredential: async (kind) => (await nullOn404(request<CredentialResponse>("GET", `/api/agent/credentials/${k(kind)}`)))?.value ?? null,
    putMyCredential: (kind, value) => request<null>("PUT", `/api/agent/credentials/${k(kind)}`, { value }),
    deleteMyCredential: (kind) => request<null>("DELETE", `/api/agent/credentials/${k(kind)}`),
    loginPrompt: (id, kind, body) => request<null>("POST", v(id, `login/${k(kind)}`), body),
    loginCode: async (id, kind) => (await request<LoginCodeResponse | null>("GET", v(id, `login/${k(kind)}/code`)))?.code ?? null,
    loginComplete: (id, kind, body = {}) => request<null>("POST", v(id, `login/${k(kind)}/complete`), body),
    // A virtual agent's HMCTS Assistant conversations: wakes and closes on the sessions stream, and what its
    // supervisor runs.
    sessionsStream: (id, opts) => openStream(v(id, "sessions"), opts),
    putSessions: (id, body) => request<null>("PUT", v(id, "sessions"), body),
    conversations: (virtualId) => request<ConversationsResponse>("GET", v(virtualId, "conversations")),
    getArtefact: (agentId) => request<Artefact>("GET", `${a(agentId)}/artefact`),
    putArtefact: (agentId, body) => request<ArtefactResponse>("PUT", `${a(agentId)}/artefact`, body),
    putJiraExport: (agentId, body) => request<null>("PUT", `${a(agentId)}/jira`, body),
    attachmentPart: (agentId, uploadId, index) => requestBytes(`${a(agentId)}/attachments/${encodeURIComponent(uploadId)}/parts/${index}`),
    attachmentFetched: (agentId, uploadId) => request<null>("POST", `${a(agentId)}/attachments/${encodeURIComponent(uploadId)}/fetched`),
    stream: (id, opts) => openStream(`${a(id)}/stream`, opts)
  };
}
