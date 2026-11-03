// The package's public surface. `bin/agent-hub` runs `dist/cli.js` directly and does not come through here.
export type {
  AgentMetadata,
  EnsureBridgeResult,
  GatherMetadataOptions,
  NormalisedTopics,
  RegisterAgentOptions,
  RegisterAgentResult,
  RegisteredAgent,
  StoredAgent,
  TopicMetadata,
  TouchPlace,
  WorkspacePlace
} from "./agent.ts";
export {
  autoTopics,
  bridgePid,
  cloneDir,
  ensureBridge,
  gatherMetadata,
  gitBranch,
  jiraKey,
  loadAgent,
  normaliseTopic,
  normaliseTopics,
  parseAgent,
  registerAgent,
  repoName,
  slugify,
  stopBridge,
  TOPIC_RE,
  touchPlace,
  workspacePlace,
  workspaceRepoName,
  workspaceRoot
} from "./agent.ts";
export type { Api, CreateApiOptions, RequestOptions, StreamOptions } from "./api.ts";
export { ApiError, createApi, DEFAULT_URL, isMissingRoute } from "./api.ts";
export type {
  AssistantSupervisor,
  Attachment,
  AttachmentFs,
  ConversationSession,
  CreateAssistantSupervisorOptions,
  CreateTmuxOptions,
  FetchAttachmentsOptions,
  LookupFrame,
  ProgramCheck,
  ReadAttachments,
  ReconcileUploadsOptions,
  ReportOutcome,
  RunAssistantSupervisorOptions,
  SavedSession,
  SessionPhase,
  StartSessionOptions,
  SupervisorFs,
  Tmux,
  TmuxExec,
  TmuxResult,
  Wake
} from "./assistant/index.ts";
export {
  attachmentPath,
  canRunProgram,
  claudeCommand,
  commandProgram,
  conversationDir,
  createAssistantSupervisor,
  createLookupRunner,
  createTmux,
  createWelshRunner,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MAX_SESSIONS,
  EXIT_GRACE_MS,
  fetchAttachments,
  idleMinutes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_SESSIONS_LIMIT,
  maxSessions,
  PROMPT_FILE,
  parseAttachments,
  parseLookupFrame,
  parseSavedSession,
  parseWake,
  REFUSAL_EVERY_MS,
  REPORT_EVERY_MS,
  readAttachments,
  reconcileUploads,
  removeConversationUploads,
  runAssistantSupervisor,
  safeName,
  staleUploadDirs,
  tmuxName,
  unfetchedAttachments,
  uploadsRoot
} from "./assistant/index.ts";
export type { RunAz } from "./az-token.ts";
export { createTokenProvider, DEFAULT_SCOPE, parseAzToken, requireAzureLogin } from "./az-token.ts";
export type { Deliver, RunBridgeOptions } from "./bridge.ts";
export { readStatus, runBridge } from "./bridge.ts";
export { readStdinText } from "./cli/command.ts";
export type { ConfluenceExportDeps, ConfluenceExportOutcome, ConfluenceExportRequest } from "./confluence-export.ts";
export {
  CONFLUENCE_EXPORT_ID_RE,
  confluenceExportsDir,
  confluenceFailure,
  datedTitle,
  pageBody,
  pageTitle,
  parseCreatedPageId,
  runConfluenceExport
} from "./confluence-export.ts";
export type { DirectAuthor, DirectDirection, DirectEntry, DirectMessage, DirectPeer, RecordDirectOptions } from "./directs.ts";
export { parseDirectEntry, peerOf, peerOfReply, readDirects, recordDirect } from "./directs.ts";
export type {
  AutoEnableOutcome,
  EnableSessionOptions,
  EnableSessionResult,
  HookInput,
  MaybeAutoEnableOptions,
  RunAutoEnableOptions,
  SpawnWorker,
  WaitForSessionEntryOptions
} from "./enable.ts";
export {
  AUTO_ENABLE_RETRY_MS,
  autoEnableOn,
  clearOptOut,
  enableSession,
  isInteractive,
  isOptedOut,
  markOptedOut,
  maybeAutoEnable,
  runAutoEnable,
  waitForSessionEntry
} from "./enable.ts";
export type { Env, EnvKey } from "./env.ts";
export { ENV_KEYS } from "./env.ts";
export type {
  AssistantFrame,
  AssistantProduct,
  AttachmentOutcome,
  ChooseEnvelopeOptions,
  ConfluenceExportFrame,
  Delivery,
  DeliveryInput,
  EnvelopeAuthor,
  EnvelopeMessage,
  EnvelopeOptions,
  GithubExportFrame,
  JiraExportFrame,
  OwnerLaptopOptions,
  SessionKind
} from "./envelope.ts";
export {
  assistantEnvelope,
  attachmentLines,
  CLI,
  chooseEnvelope,
  cliName,
  confluenceExportLines,
  describeAuthor,
  directEnvelope,
  formatMessage,
  GITHUB_EXPORT_BASH_TIMEOUT_MS,
  githubExportLines,
  JIRA_EXPORT_BASH_TIMEOUT_MS,
  jiraExportLines,
  leadingSkill,
  ownerLaptopEnvelope,
  routeDelivery,
  taggedPostEnvelope
} from "./envelope.ts";
export type { ClientFeature } from "./features.ts";
export { CLIENT_FEATURES } from "./features.ts";
export type { DirectEventAuthor, DirectEventMessage } from "./frames.ts";
export {
  parseAssistantFrame,
  parseAssistantProduct,
  parseConfluenceExportFrame,
  parseDirectEventMessage,
  parseGithubExportFrame,
  parseJiraExportFrame
} from "./frames.ts";
export type {
  ChooseIdentityOptions,
  ChosenIdentity,
  Exec,
  ExecResult,
  GitHubEmail,
  GitHubUser,
  Identity,
  Override,
  SetGitIdentityOptions
} from "./git-identity.ts";
export { chooseIdentity, GIT_DEFAULTS, parseOverride, setGitIdentity } from "./git-identity.ts";
export type { HeldNote } from "./held-notes.ts";
export { HELD_NOTES, heldNotesContext, holdNote, MAX_HELD_BYTES, MAX_HELD_NOTES, messageIds, parseHeldNote, takeHeldNotes } from "./held-notes.ts";
export type { Handoff, HookContextOutput, HookPayload, RunHookOptions } from "./hooks.ts";
export { parseHandoff, reposNote, runHook, virtualAgentStateDir, webServersNote } from "./hooks.ts";
export type { InboundOptions, InboundResult, SetupInboundResult } from "./inbound.ts";
export {
  bypassFromArgv,
  bypassFromPsArgs,
  describeInbound,
  inboundAccepted,
  inboundFix,
  RESTART_HINT,
  SETUP_COMMAND,
  settingsFromArgv,
  settingsFromPsArgs,
  setupInbound,
  userSettingsPath
} from "./inbound.ts";
export { MAX_POST_TOPICS } from "./limits.ts";
export type { AddressKind, Listening, PortsReport, PortsReporter, PortTick, ProcNetSocket } from "./ports.ts";
export {
  APPEAR_READS,
  addressKind,
  createDebounce,
  createPortWatcher,
  DEFAULT_PUBLIC_DOMAIN,
  DISAPPEAR_READS,
  ignoredPorts,
  listeners,
  MAX_REPORTED,
  MIN_PORT,
  PORTS_POLL_MS,
  parseProcNet,
  procNetDir,
  publicUrlPattern,
  readTables,
  watchPorts
} from "./ports.ts";
export type { ReconnectDecision, RetryState, StreamEnd } from "./reconnect.ts";
export { nextBackoff, RAPID_CLOSE_MS, RAPID_CLOSES_BEFORE_BACKOFF, reconnectDelay } from "./reconnect.ts";
export type { RetryOptions } from "./retry.ts";
export { retryableByStatus, withRetry } from "./retry.ts";
export { containsSecret, findSecret, loadPatterns, PATTERNS_FILE, parsePatterns } from "./secret-scan.ts";
export type { Config, ConversationTitles, SessionEntry, SessionInfo } from "./session.ts";
export {
  acquirePidFile,
  agentName,
  claudeHome,
  cliCommand,
  conversationId,
  conversationTitles,
  DEFAULT_CONFIG,
  ensureStateDir,
  findSessionEntry,
  hubHome,
  isEnabled,
  log,
  logPath,
  nameSlug,
  parseSessionEntry,
  pidAlive,
  projectDir,
  projectTranscriptPath,
  readJson,
  readPidFile,
  readText,
  releasePidFile,
  removeFile,
  requireSessionId,
  rotateLog,
  sessionInfo,
  sha256,
  spawnDetached,
  stateDir,
  statePath,
  transcriptPath,
  validSessionId,
  writeJson
} from "./session.ts";
export type { CollectSkillsOptions, PluginInstall, PluginLookup, SkillListing } from "./skills.ts";
export {
  collectSkills,
  enabledPlugins,
  hubPlugins,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_NAME,
  MAX_SKILLS,
  parseFrontmatter,
  pluginInstalls,
  SKILL_NAME_RE,
  skillFrom,
  skillsHash
} from "./skills.ts";
export type { DeliverOptions } from "./socket.ts";
export { deliverToSocket, NO_MESSAGING_TOKEN } from "./socket.ts";
export type { SseEvent, SseParser, SseParserOptions } from "./sse.ts";
export { createSseParser } from "./sse.ts";
export type {
  BuildPromptOptions,
  CandidateTopics,
  CandidateTopicsOptions,
  Cursors,
  DecideOptions,
  Decision,
  ExtractTouchesOptions,
  FollowWorkState,
  Haiku,
  HaikuCommand,
  HaikuOutput,
  HaikuPublish,
  HaikuValidation,
  PassContext,
  ProductTouch,
  RepoTouch,
  RunHaikuOptions,
  RunStopWorkerOptions,
  ShellSeparator,
  ShellToken,
  ShellWord,
  StopWorkerApi,
  Touches,
  TouchKind,
  TranscriptSlice
} from "./stop-worker/index.ts";
export {
  bashPaths,
  buildPrompt,
  candidateTopics,
  decide,
  extractTouches,
  extractTranscriptText,
  followWork,
  formatFeed,
  haikuCommand,
  NO_TOUCHES,
  parseCursors,
  parseHaikuResult,
  readTranscriptSlice,
  runHaiku,
  runPass,
  runStopWorker,
  SLICE_BYTES,
  shellWords,
  summariserCwd,
  summariserSettings,
  tail,
  validateHaikuOutput,
  WORK_TYPES,
  workedInRepos
} from "./stop-worker/index.ts";
export type {
  BatchOptions,
  CreateTranscriptSyncOptions,
  FastForwardOptions,
  ParsedLines,
  ParseLinesOptions,
  SavedState,
  ScrubbedEntry,
  ScrubOptions,
  SyncState,
  TickOptions,
  TickResult,
  TickStatus,
  TranscriptItem,
  TranscriptSync
} from "./transcript-sync.ts";
export {
  BACKFILL_BYTES,
  backfillStart,
  batchItems,
  createTranscriptSync,
  fastForward,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_CONTENT_BYTES,
  parseEntries,
  parseLines,
  parseSavedState,
  scrub,
  setTranscriptOff,
  syncStatePath,
  toEntries,
  transcriptOff,
  transcriptOffByEnv,
  transcriptOffBySession,
  UNAVAILABLE_PAUSE_MS
} from "./transcript-sync.ts";
export type {
  AtlassianLoginOptions,
  AtlassianLoginResult,
  AzureLoginMode,
  AzureLoginOptions,
  AzureLoginResult,
  AzureProfile,
  CacheSyncOptions,
  CacheSyncResult,
  ClaudeLoginOptions,
  ClaudeLoginResult,
  CredentialCommandOptions,
  CredentialStore,
  DeviceCodePrompt,
  GithubLoginOptions,
  LoginOptions,
  MsalCache,
  PackedAtlassianAuth,
  PackedAzureCache,
  RelayDeviceLoginOptions,
  RelayDeviceLoginResult,
  Respond,
  RunOptions,
  RunResult,
  RunVirtualOptions,
  SyncAtlassianAuthOptions,
  SyncAtlassianAuthResult,
  SyncAzureCacheOptions,
  SyncAzureCacheResult
} from "./virtual/index.ts";
export {
  ATLASSIAN_AUTH_MAX_CHARS,
  ATLASSIAN_SIGN_IN_CODES,
  AZURE_CACHE_MAX_CHARS,
  atlassianLogin,
  azureDir,
  azureLogin,
  CACHE_SYNC_MS,
  cacheSync,
  childEnv,
  claudeLogin,
  DEVICE_CODE_EXPIRES_S,
  EXIT_FATAL,
  EXIT_NO_CREDENTIAL,
  EXPIRY_TOLERANCE_S,
  FatalError,
  findClaudeToken,
  githubLogin,
  isCredentialKind,
  isVirtualPhase,
  jiraExportSignInBudget,
  minimalProfile,
  OWNER_READABLE,
  PASTE_CODE_EXPIRES_S,
  PHASES,
  packAtlassianAuth,
  packAzureCache,
  parseAzDeviceCode,
  parseClaudeAuthorizeUrl,
  parseTwgDeviceCode,
  pruneMsalCache,
  readAtlassianAuth,
  readAzureCache,
  relayDeviceLogin,
  requireCredentialKind,
  restoreAtlassianAuth,
  restoreAzureCache,
  run,
  runCredentialCommand,
  runVirtual,
  say,
  stripAnsi,
  syncAtlassianAuth,
  syncAzureCache,
  TWG_DEVICE_CODE_EXPIRES_S,
  twgDir,
  twgLoginExpired,
  twgPromptsForBrowser,
  twgRefreshRejected,
  unpackAzureCache,
  VIRTUAL_USAGE,
  virtualStateDir
} from "./virtual/index.ts";
export type { VirtualAgent } from "./virtual-agent.ts";
export { MISSING_LAUNCH_TOKEN, MISSING_VIRTUAL_AGENT_ID, requireVirtualAgent, virtualAgent } from "./virtual-agent.ts";
export type {
  AgentSummary,
  AgentsResponse,
  ApiErrorBody,
  Artefact,
  ArtefactBody,
  ArtefactResponse,
  ConfluenceExportReport,
  ConfluencePageFound,
  CredentialKind,
  DirectBody,
  DirectCandidate,
  FeedResponse,
  HeartbeatBody,
  JiraProjectFound,
  LoginCompleteBody,
  LoginFailedBody,
  LoginPromptBody,
  LookupAnswer,
  MemoryReportBody,
  Message,
  MessageAuthor,
  MessageResponse,
  MessagesResponse,
  PostBody,
  RegisterBody,
  RegisterResponse,
  SessionReport,
  SessionsBody,
  Skill,
  TopicListResponse,
  TopicSummary,
  TopicsResponse,
  TranscriptBody,
  TranscriptEntry,
  TranscriptResponse,
  VirtualPhase
} from "./wire.ts";
export { CREDENTIAL_KINDS } from "./wire.ts";
