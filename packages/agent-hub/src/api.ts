// The HTTP client for the hub, over the shapes in `wire.ts`. Like them it carries no dependencies, because the hook
// path must not pay for loading a validation library.
import { createTokenProvider, DEFAULT_SCOPE } from "./az-token.ts";
import type { Env } from "./env.ts";
import { CLIENT_FEATURES } from "./features.ts";
import type { PortsReport } from "./ports.ts";
import type { QuestionBody } from "./questions.ts";
import { virtualAgent } from "./virtual-agent.ts";
import type {
  AgentsResponse,
  ApiErrorBody,
  Artefact,
  ArtefactBody,
  ArtefactResponse,
  ConfluenceExportReport,
  ConversationsResponse,
  CredentialKind,
  CredentialResponse,
  Deck,
  DeckAssetResponse,
  DeckBody,
  DeckBuild,
  DeckResponse,
  DirectBody,
  FeedResponse,
  GithubExportReport,
  HeartbeatBody,
  HeartbeatResponse,
  JiraExportReport,
  LoginCodeResponse,
  LoginCompleteBody,
  LoginFailedBody,
  LoginPromptBody,
  LookupAnswer,
  MemoryReportBody,
  MessageResponse,
  MessagesResponse,
  MicrosoftTokenResponse,
  PostBody,
  RegisterBody,
  RegisterResponse,
  SessionsBody,
  SignInRequestResponse,
  TopicListResponse,
  TopicsResponse,
  TranscriptBody,
  TranscriptResponse,
  UploadsReportBody,
  VirtualPhase,
  WelshAnswer
} from "./wire.ts";

export const DEFAULT_URL = "https://agent-hub.aat.platform.hmcts.net";
const REQUEST_TIMEOUT_MS = 15000;
/** One attachment part is up to 4 MiB, which a slow pod connection will not pull inside the JSON timeout. */
const PART_TIMEOUT_MS = 60000;
/** How much of a body that is not the contract's `{ error }` object is worth keeping, and saying. */
const BODY_TEXT_MAX = 200;

/**
 * How every call in this module reads a response body: the service's JSON when it sent a JSON object, and
 * otherwise the first `BODY_TEXT_MAX` characters of whatever it did send, under `error`. A number, a string or an
 * array is text as far as this is concerned — only an object can be the `{ error }` the contract promises, and
 * typing a bare `404` as one would be a lie the callers below would carry.
 *
 * Streams read theirs this way too, rather than discarding a body they cannot parse, because a client talking to
 * a service older than itself meets an unmatched path on a stream as readily as anywhere else and
 * `isMissingRoute` has to be able to tell.
 *
 * `request` also reads its successful responses through this, so the rule above is what a 2xx payload gets as
 * well: every route answering one sends a JSON object, and the ones that send nothing answer `204`, whose empty
 * body gives `null`. A route that started answering 2xx with a top-level array, number or string would arrive at
 * its caller as `{ error: "<the text>" }` cast to the expected type, so give it its own read rather than this one.
 */
const readBody = (text: string): ApiErrorBody | null => {
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ApiErrorBody;
    }
  } catch {}
  return { error: text.slice(0, BODY_TEXT_MAX) };
};

// A body that came back as a page rather than this service's JSON: whatever a route of its own answers with, it
// is never markup. Kept off the message, because a Next.js error document says nothing the status does not and
// any slice of one is markup in a log; the body is still on the error for a caller that wants it.
const isErrorPage = (body: ApiErrorBody | null): boolean => typeof body?.error === "string" && body.error.trimStart().startsWith("<");

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, method: string, path: string) {
    // Bounded like the text bodies `readBody` keeps, because a service's own `error` is not length-checked either
    // and this message is what reaches a log.
    const said = body?.error && !isErrorPage(body) ? ` ${String(body.error).slice(0, BODY_TEXT_MAX)}` : "";
    super(`${method} ${path} failed: ${status}${said}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Whether the service has no such route at all, rather than a route of its own that refused: an unmatched path
 * answers with the app's own not-found page, where a route sends `{ error }` (`docs/agent-api.md`). A client
 * published ahead of the deploy that carries its route sees this from every hub still on the older image, which
 * is a deploy catching up rather than a fault.
 */
export const isMissingRoute = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && isErrorPage(error.body);

/**
 * A URL without the slashes it ends with. Walked back by hand rather than with `/\/+$/`, which retries from every
 * slash in a run that does not reach the end and so takes quadratic time over a long one.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end--;
  }
  return url.slice(0, end);
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
  heartbeat: (id: string, body: HeartbeatBody) => Promise<HeartbeatResponse | null>;
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
  /**
   * A Graph access token for the owner (a pod, given its agent id) or for the person calling (`null`), minted by the hub
   * from their Microsoft 365 connection. The connection itself never leaves the hub.
   */
  microsoftToken: (id: string | null) => Promise<MicrosoftTokenResponse>;
  loginPrompt: (id: string, kind: CredentialKind, body: LoginPromptBody) => Promise<null>;
  loginCode: (id: string, kind: CredentialKind) => Promise<string | null>;
  /**
   * Whether the owner has asked for a sign-in of this kind, which a pod checks before relaying one it makes only on
   * request. A hub with no such route answers `false`: nobody can have asked it.
   */
  signInRequested: (id: string, kind: CredentialKind) => Promise<boolean>;
  loginComplete: (id: string, kind: CredentialKind, body?: LoginCompleteBody) => Promise<null>;
  /** The other half of `loginComplete`: the pod owes the hub one of the two for every sign-in it relays. */
  loginFailed: (id: string, kind: CredentialKind, body: LoginFailedBody) => Promise<null>;
  sessionsStream: (id: string, opts?: StreamOptions) => Promise<Response>;
  putSessions: (id: string, body: SessionsBody) => Promise<null>;
  conversations: (virtualId: string) => Promise<ConversationsResponse>;
  /** What the uploads directory and the volume under it come to, which the hub has no way to see for itself. */
  putUploads: (virtualId: string, body: UploadsReportBody) => Promise<null>;
  /** What this container's memory cgroup says, which the hub has no way to see for itself either. */
  putMemory: (virtualId: string, body: MemoryReportBody) => Promise<null>;
  getArtefact: (agentId: string) => Promise<Artefact>;
  putArtefact: (agentId: string, body: ArtefactBody) => Promise<ArtefactResponse>;
  /** The latest version of the deck, or one kept version of it, which then says the version the deck is at now. */
  getDeck: (agentId: string, version?: number) => Promise<Deck>;
  putDeck: (agentId: string, body: DeckBody) => Promise<DeckResponse>;
  /** One picture for the deck, under the SHA-256 of its bytes. At most 5 MiB. */
  putDeckAsset: (agentId: string, sha256: string, bytes: Uint8Array) => Promise<DeckAssetResponse>;
  deckAsset: (agentId: string, sha256: string) => Promise<Uint8Array>;
  /** The .pptx built from one version of the deck. At most 5 MiB. */
  putDeckPptx: (agentId: string, version: number, bytes: Uint8Array) => Promise<null>;
  /**
   * A question this session's model asked with `AskUserQuestion`, for the person to answer in the web UI. Idempotent
   * on `tool_use_id`, so a retry after a lost response does not put the question on screen twice.
   */
  postQuestion: (agentId: string, body: QuestionBody, opts?: RequestOptions) => Promise<null>;
  putJiraExport: (agentId: string, body: JiraExportReport) => Promise<null>;
  putGithubExport: (agentId: string, body: GithubExportReport) => Promise<null>;
  putConfluenceExport: (agentId: string, body: ConfluenceExportReport) => Promise<null>;
  /** The supervisor's answer to one of its owner's Jira or Confluence lookups. */
  putLookup: (virtualId: string, lookupId: string, body: LookupAnswer) => Promise<null>;
  /** The supervisor's answer to one of its owner's Welsh translation jobs. */
  putWelsh: (virtualId: string, jobId: string, body: WelshAnswer) => Promise<null>;
  /** A spreadsheet a Welsh job made, for its owner to download; sent before the job's answer. At most 5 MiB. */
  putWelshFile: (virtualId: string, jobId: string, name: string, bytes: Uint8Array) => Promise<{ file_id: string }>;
  /** A spreadsheet the owner uploaded for a Welsh job to read. At most 5 MiB, so read whole. */
  welshFile: (virtualId: string, fileId: string) => Promise<Uint8Array>;
  /** The version one of its owner's pending deck builds is of, outline and all. */
  deckBuild: (virtualId: string, jobId: string) => Promise<DeckBuild>;
  /** One picture a pending deck build's outline names. At most 5 MiB, so read whole. */
  deckBuildAsset: (virtualId: string, jobId: string, sha256: string) => Promise<Uint8Array>;
  /** The supervisor's answer to a deck build: the .pptx it built, at most 5 MiB, or why there is none. */
  putDeckBuild: (virtualId: string, jobId: string, answer: { pptx: Uint8Array } | { error: string }) => Promise<null>;
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
  const base = trimTrailingSlashes(baseUrl);

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
    const json: unknown = readBody(await res.text());
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
      let text = "";
      try {
        text = await res.text();
      } catch {}
      throw new ApiError(res.status, readBody(text), "GET", path);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  /**
   * Raw bytes up to the hub, on the part timeout since they can be 5 MiB: a Welsh spreadsheet with its name in a
   * header, or a deck's picture or .pptx with none.
   */
  async function putBytes<T>(path: string, name: string | null, bytes: Uint8Array, timeoutMs = PART_TIMEOUT_MS): Promise<T> {
    const named: Record<string, string> = name === null ? {} : { "X-File-Name": encodeURIComponent(name) };
    const res = await fetchImpl(`${base}${path}`, {
      method: "PUT",
      headers: await headers({ "Content-Type": "application/octet-stream", ...named }),
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json: unknown = readBody(await res.text());
    if (!res.ok) {
      throw new ApiError(res.status, json as ApiErrorBody | null, "PUT", path);
    }
    return json as T;
  }
  // Both streams are framed alike, so the agent stream and a pod's sessions stream open the same way.
  async function openStream(path: string, { signal, lastEventId }: StreamOptions = {}): Promise<Response> {
    const h = await headers({ Accept: "text/event-stream" });
    if (lastEventId) {
      h["Last-Event-ID"] = lastEventId;
    }
    const res = await fetchImpl(`${base}${path}`, { headers: h, signal });
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}
      throw new ApiError(res.status, readBody(text), "GET", path);
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
    heartbeat: (id, body) => request<HeartbeatResponse | null>("POST", `${a(id)}/heartbeat`, body),
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
    // Every report carries the claim, so the hub's copy is always the running build's; a hub that predates the field
    // ignores it.
    virtualStatus: (id, phase, detail) =>
      request<null>("POST", v(id, "status"), { phase, ...(detail ? { detail } : {}), client_features: [...CLIENT_FEATURES] }),
    getCredential: async (id, kind) => (await nullOn404(request<CredentialResponse>("GET", v(id, `credentials/${k(kind)}`))))?.value ?? null,
    putCredential: (id, kind, value) => request<null>("PUT", v(id, `credentials/${k(kind)}`), { value }),
    putPorts: (id, body) => request<null>("PUT", v(id, "ports"), body),
    myCredential: async (kind) => (await nullOn404(request<CredentialResponse>("GET", `/api/agent/credentials/${k(kind)}`)))?.value ?? null,
    putMyCredential: (kind, value) => request<null>("PUT", `/api/agent/credentials/${k(kind)}`, { value }),
    deleteMyCredential: (kind) => request<null>("DELETE", `/api/agent/credentials/${k(kind)}`),
    microsoftToken: (id) => request<MicrosoftTokenResponse>("GET", id === null ? "/api/agent/microsoft/token" : v(id, "microsoft/token")),
    loginPrompt: (id, kind, body) => request<null>("POST", v(id, `login/${k(kind)}`), body),
    loginCode: async (id, kind) => (await request<LoginCodeResponse | null>("GET", v(id, `login/${k(kind)}/code`)))?.code ?? null,
    signInRequested: async (id, kind) => {
      try {
        return (await request<SignInRequestResponse | null>("GET", v(id, `login/${k(kind)}`)))?.requested === true;
      } catch (e) {
        // 404 and 405 are a hub older than the route, which has no way to have been asked.
        if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
          return false;
        }
        throw e;
      }
    },
    loginComplete: (id, kind, body = {}) => request<null>("POST", v(id, `login/${k(kind)}/complete`), body),
    loginFailed: (id, kind, body) => request<null>("POST", v(id, `login/${k(kind)}/failed`), body),
    // A virtual agent's CFT Workspace conversations: wakes and closes on the sessions stream, and what its
    // supervisor runs.
    sessionsStream: (id, opts) => openStream(v(id, "sessions"), opts),
    putSessions: (id, body) => request<null>("PUT", v(id, "sessions"), body),
    conversations: (virtualId) => request<ConversationsResponse>("GET", v(virtualId, "conversations")),
    putUploads: (virtualId, body) => request<null>("PUT", v(virtualId, "uploads"), body),
    putMemory: (virtualId, body) => request<null>("PUT", v(virtualId, "memory"), body),
    getArtefact: (agentId) => request<Artefact>("GET", `${a(agentId)}/artefact`),
    putArtefact: (agentId, body) => request<ArtefactResponse>("PUT", `${a(agentId)}/artefact`, body),
    getDeck: (agentId, version) => request<Deck>("GET", `${a(agentId)}/deck${qs({ version })}`),
    putDeck: (agentId, body) => request<DeckResponse>("PUT", `${a(agentId)}/deck`, body),
    putDeckAsset: (agentId, sha256, bytes) => putBytes<DeckAssetResponse>(`${a(agentId)}/deck/assets/${encodeURIComponent(sha256)}`, null, bytes),
    deckAsset: (agentId, sha256) => requestBytes(`${a(agentId)}/deck/assets/${encodeURIComponent(sha256)}`),
    putDeckPptx: (agentId, version, bytes) => putBytes<null>(`${a(agentId)}/deck/versions/${version}/pptx`, null, bytes),
    postQuestion: (agentId, body, opts) => request<null>("POST", `${a(agentId)}/question`, body, opts),
    putJiraExport: (agentId, body) => request<null>("PUT", `${a(agentId)}/jira`, body),
    putGithubExport: (agentId, body) => request<null>("PUT", `${a(agentId)}/github`, body),
    putConfluenceExport: (agentId, body) => request<null>("PUT", `${a(agentId)}/confluence`, body),
    putLookup: (virtualId, lookupId, body) => request<null>("PUT", v(virtualId, `lookups/${encodeURIComponent(lookupId)}`), body),
    putWelsh: (virtualId, jobId, body) => request<null>("PUT", v(virtualId, `welsh/${encodeURIComponent(jobId)}`), body),
    putWelshFile: (virtualId, jobId, name, bytes) => putBytes<{ file_id: string }>(v(virtualId, `welsh/${encodeURIComponent(jobId)}/files`), name, bytes),
    welshFile: (virtualId, fileId) => requestBytes(v(virtualId, `welsh/files/${encodeURIComponent(fileId)}`)),
    deckBuild: (virtualId, jobId) => request<DeckBuild>("GET", v(virtualId, `deck-builds/${encodeURIComponent(jobId)}`)),
    deckBuildAsset: (virtualId, jobId, sha256) => requestBytes(v(virtualId, `deck-builds/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(sha256)}`)),
    putDeckBuild: (virtualId, jobId, answer) =>
      "pptx" in answer
        ? putBytes<null>(v(virtualId, `deck-builds/${encodeURIComponent(jobId)}`), null, answer.pptx)
        : request<null>("PUT", v(virtualId, `deck-builds/${encodeURIComponent(jobId)}`), { error: answer.error }),
    attachmentPart: (agentId, uploadId, index) => requestBytes(`${a(agentId)}/attachments/${encodeURIComponent(uploadId)}/parts/${index}`),
    attachmentFetched: (agentId, uploadId) => request<null>("POST", `${a(agentId)}/attachments/${encodeURIComponent(uploadId)}/fetched`),
    stream: (id, opts) => openStream(`${a(id)}/stream`, opts)
  };
}
