// The request and response bodies of the hub's agent API. Every shape below is `docs/agent-api.md` in the service's
// own repository, written out again here rather than imported from `src/agent-api/schemas.ts`: this package is
// published on its own, so nothing in it may reach into the Next app's module graph, and it carries no dependencies —
// the hook path must not pay for loading a validation library.
import type { NameSource } from "./session.ts";

/** The credential kinds `docs/agent-api.md` defines; any other gives 404. */
export const CREDENTIAL_KINDS = ["github", "azure", "claude", "jenkins", "atlassian", "claude_md", "git_identity", "microsoft"] as const;

/**
 * The kinds a pod reads and stores through its own routes: all but a Microsoft 365 connection, which the hub keeps to
 * itself and hands a pod only access tokens from.
 */
export const POD_CREDENTIAL_KINDS = CREDENTIAL_KINDS.filter((kind) => kind !== "microsoft");

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
  current?: Artefact | Deck | DocmosisResponse | NotifyResponse;
  /** A `400` from `putDocmosis`: the .docx digests the hub does not hold. */
  missing_assets?: string[];
  /** A `409` from `putDocmosis` with a `pick` already loaded: the version that load wrote. */
  loaded?: DocmosisWritten;
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
  /**
   * This build's claim, sent until the hub has taken it, which only a `HeartbeatResponse` naming the same features
   * says: a hub from before the field drops it and still answers `204`. It replaces the stored claim and nothing else.
   */
  client_features?: string[];
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
  /** The page's opening words, as Confluence's search gives them, which tell it from another page of the same title. */
  excerpt?: string;
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

/** One template in the library's index: its path, its blob's git SHA-1 and its size in bytes. */
export type DocmosisIndexEntry = [path: string, blobSha: string, size: number];

/** The answer to one check of the template library: a new index, the one the hub holds is current, or why neither. */
export type DocmosisIndexAnswer =
  | { commit: string; etag: string | null; entries: DocmosisIndexEntry[]; dropped?: number }
  | { unchanged: true; etag?: string }
  | { error: "signed_out" | "sso" | "not_found" | "rate_limited" | "failed"; detail?: string; sso_url?: string; reset_at?: string };

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

/** A pod-job kind's name, as the hub's `src/assistant/pod-jobs.ts` accepts it: dotted lowercase words, 40 at most. */
export const POD_JOB_KIND_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
export const MAX_POD_JOB_KIND = 40;

/**
 * The most client features the hub takes in one claim, as its `src/agents/client-features.ts` has it: a claim over it
 * refuses the whole status report or registration with 400, so this build's claim must stay within it.
 */
export const MAX_CLIENT_FEATURES = 50;

/** A pod job the sessions stream sent: one of the kinds in `src/assistant/pod-job-handlers.ts`. See "Pod jobs". */
export type PodJobFrame = { job_id: string; kind: string; conversation_id: string; agent_id?: string; args: unknown };

/** The supervisor's answer to a pod job: the handler's result, or an error code and words for the person. */
export type PodJobAnswer = { status: "done"; result: unknown } | { status: "failed"; error: string; detail?: string };

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

/** One field of a Docmosis template's form schema, as `docmosis schema` infers it. */
export type DocmosisField =
  | { kind: "string" | "boolean" | "date"; controls: string[]; notes: string[]; inputFormat?: string }
  | { kind: "object"; controls: string[]; notes: string[]; properties: Record<string, DocmosisField> }
  | { kind: "array"; controls: string[]; notes: string[]; item: Extract<DocmosisField, { kind: "object" }> };

export type DocmosisSchema = { root: Extract<DocmosisField, { kind: "object" }>; warnings: string[] };

/** A conversation's Docmosis template at one version, as `GET …/docmosis` returns it. */
export type DocmosisResponse = {
  version: number;
  revision: number;
  name: string;
  /** `sha256:<hex>`, the digest `GET …/docmosis/assets/{sha256}` takes. */
  docx: string;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  by: "agent" | "user";
  summary: string | null;
  updated_at: string;
  has_pdf: boolean;
  render_error: { short: string; long: string } | null;
  /** The library path a version loaded from the template library came from; null for every other version, absent from an older hub. */
  source_path?: string | null;
  /** Only when a version other than the latest was asked for: the version the template is at now. */
  current_version?: number;
};

export type DocmosisBody = {
  name: string;
  docx: string;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  base_version: number;
  /** The revision read with the version, so a person's amend since is refused rather than overwritten. */
  base_revision?: number;
  summary?: string;
  /** The `docmosis.load` pod job this write loads a template for; see "Docmosis template library" in docs/agent-api.md. */
  pick?: string;
};

export type DocmosisWritten = { version: number; revision: number };

export type DocmosisAssetResponse = { asset: string };

export type NotifyTemplateType = "email" | "sms" | "letter";

/** Where a Notify draft came from: the template as Notify held it when the pod read it. */
export type NotifySource = {
  product: string;
  template_id: string;
  service_id: string;
  type: NotifyTemplateType;
  name: string;
  notify_version: number;
  notify_subject: string | null;
  notify_body: string;
  /** Notify's own preview with no personalisation: HTML for an email, text otherwise; null when too big to keep. */
  notify_preview: string | null;
};

/** A conversation's GOV.UK Notify template at one version, as `GET …/notify` returns it. */
export type NotifyResponse = NotifySource & {
  version: number;
  revision: number;
  /** The draft: null for a text message. */
  subject: string | null;
  body: string;
  data: Record<string, unknown>;
  by: "agent" | "user";
  summary: string | null;
  updated_at: string;
  /** Only when a version other than the latest was asked for: the version the template is at now. */
  current_version?: number;
};

export type NotifyBody = {
  subject: string | null;
  body: string;
  data: Record<string, unknown>;
  base_version: number;
  /** The revision read with the version, so a person's amend since is refused rather than overwritten. */
  base_revision?: number;
  summary?: string;
  /** Needed for the first version; left out, the version keeps the source of the one it is based on. */
  source?: NotifySource;
  /** Sent only for the panel's picker, whose load the owner asked for. */
  by?: "user";
};

export type NotifyWritten = { version: number; revision: number };

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
/** A heartbeat that sent `client_features` is answered with the claim as stored; one that did not, with no body. */
export type HeartbeatResponse = { client_features: string[] | null };
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

export type VideoChapter = { at: number; title: string };

/** The body of `POST …/video`: what the panel shows beside the player. The MP4 itself goes to the URL the answer names. */
export type VideoBeginBody = {
  name: string;
  bytes: number;
  captions?: string;
  chapters: VideoChapter[];
  coverage: string;
  coverage_summary?: string;
  content_mismatches: string;
  jira_key?: string;
};

export type VideoBegun = { video_id: string; upload_url: string; expires_in: number };

/** The conversation's ready video as `GET …/video` answers it. */
export type VideoResponse = {
  video_id: string;
  name: string;
  bytes: number;
  has_captions: boolean;
  chapters: VideoChapter[];
  coverage: string;
  coverage_summary: string | null;
  content_mismatches: string;
  jira_key: string | null;
  posted: { key: string; url: string; at: string } | null;
  finished_at: string;
  /** Where the MP4 can be downloaded from, for a limited time. */
  download_url: string;
};
