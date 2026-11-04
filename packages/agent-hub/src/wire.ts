// The request and response bodies of the hub's agent API. Every shape below is `docs/agent-api.md` in the service's
// own repository, written out again here rather than imported from `src/agent-api/schemas.ts`: this package is
// published on its own, so nothing in it may reach into the Next app's module graph, and it carries no dependencies —
// the hook path must not pay for loading a validation library.
import type { NameSource } from "./session.ts";

/** The credential kinds `docs/agent-api.md` defines; any other gives 404. */
export const CREDENTIAL_KINDS = ["github", "azure", "claude", "jenkins", "atlassian", "claude_md", "git_identity", "microsoft"] as const;

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
  /** The agents a post tagged. Absent from a hub that predates tagging, so every reader must tolerate that. */
  tagged_agents?: { id: string; name: string }[];
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
  /**
   * A `409` from `putArtefact`: the document as `getArtefact` returns it, to merge the refused change into; from
   * `putDeck`, the deck as `getDeck` returns it.
   */
  current?: Artefact | Deck;
  /** A `400` from `putDeck`: the pictures the outline names that the hub does not hold. */
  missing?: string[];
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
  /**
   * Where `name` came from: `user` for a /rename, `derived` for a name this client worked out. Optional on the wire,
   * where leaving it out reads as `derived`, but required here for the same reason as `client_features`: the service
   * replaces what it has stored with whatever a register reports, so a call site that omitted it would tell the hub
   * the person had not named this session when they had.
   */
  name_source: NameSource;
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
  /** Where `name` came from; read as `derived` when left out, and ignored by a heartbeat that sends no `name`. */
  name_source?: NameSource;
  skills?: Skill[];
};

export type PostBody = {
  topics: string[];
  title?: string | null;
  body: string;
  in_reply_to?: string | null;
  /**
   * The agents the post tags, as ids or names: they are sent it on their streams whether or not they subscribe to
   * its topics. Optional on the wire, and a hub that predates tagging ignores it, so no client feature is claimed
   * for it — nothing the hub sends depends on this client understanding a new field.
   */
  tag_agents?: string[];
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

/** A sign-in the pod relayed and gave up on: `expired` when its code ran out unused, `failed` for anything else. */
export type LoginFailedBody = {
  state: "expired" | "failed";
  detail?: string;
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

/** A conversation's GitHub export result, as its session reports it: the issue number it created, or why it could not. */
export type GithubExportReport = { export_id: string; number: number; project_error?: string } | { export_id: string; error: string };

/** A conversation's Confluence export result: the page it created and the title it was created with, or why it could not. */
export type ConfluenceExportReport = { export_id: string; page_id: string; title?: string } | { export_id: string; error: string };

/** One Jira project a lookup found: only what the person picks it by. */
export type JiraProjectFound = { key: string; name: string };

/** One Confluence page a lookup found: the ids an export needs, and the titles that say where it is. */
export type ConfluencePageFound = {
  id: string;
  title: string;
  space_id: string;
  space_key: string;
  space_name: string;
  ancestors: string[];
};

/** The answer to one Welsh translation job: what scripts/welsh printed, or why it did not run. */
export type WelshAnswer = { result: Record<string, unknown> } | { error: "signed_out" | "failed"; detail?: string };

/** One GitHub repository a lookup found, as `owner/name`, with its description when it has one. */
export type GithubRepoFound = { full_name: string; description: string | null };

/** One GitHub Project a lookup found: the owner and number an issue is added to it by, and its title. */
export type GithubProjectFound = { owner: string; number: number; title: string };

/** The answer to one lookup: what twg or gh found, or why it found nothing. */
export type LookupAnswer =
  | { results: JiraProjectFound[] | ConfluencePageFound[] | GithubRepoFound[] | GithubProjectFound[] }
  | { error: "signed_out" | "failed" | "superseded"; detail?: string };

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

/**
 * A conversation's slide deck, as `GET …/deck` returns it: an outline in the slides plugin's shape whose pictures are
 * `{asset: "sha256:<hex>"}` rather than paths. Kept as `unknown` here, because the hub checks it and the plugin
 * builds it; this client only moves it and rewrites its pictures.
 */
export type Deck = {
  title: string | null;
  outline: DeckOutline | null;
  version: number;
  /** Moved on by every write of the outline, a person's amend of their latest version included; absent from an older hub. */
  revision?: number;
  updated_by: "user" | "agent" | null;
  updated_at: string | null;
  pptx: boolean;
  /** Only when one kept version was asked for: the version the deck is at now. */
  latest_version?: number;
};

/** A deck build as the supervisor reads it: the version to build, with its outline as `GET …/deck` returns one. */
export type DeckBuild = { job_id: string; conversation_id: string; version: number; outline: DeckOutline };

export type DeckImage = { asset?: string; path?: string; alt?: string; decorative?: boolean };
export type DeckSlide = { id?: string; layout?: string; title?: string; image?: DeckImage; [field: string]: unknown };
export type DeckOutline = { title?: string; slides?: DeckSlide[]; [field: string]: unknown };

export type DeckBody = {
  outline: DeckOutline;
  base_version: number;
  /** The revision the outline was read at, so a person's amend since is refused rather than overwritten. */
  base_revision?: number;
  summary?: string;
};

export type DeckResponse = { version: number; revision?: number; outline: DeckOutline };

export type DeckAssetResponse = { asset: string };

/** One conversation of a virtual agent, as `conversations` lists them for the uploads reconciliation. */
export type ConversationSummary = { id: string };

export type ConversationsResponse = { conversations: ConversationSummary[] };

/**
 * What this pod holds on its own volume, and which deletions it has carried out: the uploads' share, the whole
 * volume, how many files there are, the largest of them by id, and the ids whose copies are now gone.
 *
 * `deleted` is the only thing that ends a deletion request. Absence from `files` means nothing, since that list is
 * capped at the largest `MAX_REPORTED_FILES`.
 */
export type UploadsReportBody = {
  uploads_bytes: number;
  volume_used_bytes: number;
  volume_total_bytes: number;
  files_total: number;
  files: { upload_id: string; bytes: number }[];
  deleted: string[];
};

/**
 * What this container's memory cgroup says: `memory.max`, `memory.current`, `memory.peak` and `memory.stat`'s `anon`.
 *
 * All four or none. Every sentence the hub writes about memory is relative to the limit, and `anon_bytes` is what it
 * warns on, so a partial report would be a figure it had to guess rather than a weaker one — the hub refuses one.
 */
export type MemoryReportBody = {
  limit_bytes: number;
  current_bytes: number;
  peak_bytes: number;
  /** `memory.stat`'s `anon`: the part the kernel cannot reclaim, and the only one the warning can be true of. */
  anon_bytes: number;
};

export type RegisterResponse = { agent_id: string; name: string };
export type MessageResponse = { message: Message };
export type MessagesResponse = { messages: Message[] };
export type FeedResponse = { messages: Message[]; cursor: string };
export type TopicListResponse = { topics: string[] };
export type TopicsResponse = { topics: TopicSummary[] };
export type AgentsResponse = { agents: AgentSummary[] };
export type TranscriptResponse = { accepted: number };
export type CredentialResponse = { value: string };
/** A Microsoft Graph access token minted from the owner's Microsoft 365 connection; see "Microsoft 365" in docs/agent-api.md. */
export type MicrosoftTokenResponse = { access_token: string; expires_at: string; permissions: string[] };
export type LoginCodeResponse = { code: string };
/** Whether the owner has asked for a sign-in of this kind; see `GET /api/virtual/{id}/login/{kind}`. */
export type SignInRequestResponse = { requested: boolean };
