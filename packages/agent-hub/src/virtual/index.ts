// The pod side of an agent-hub virtual agent, gathered for the CLI and the package's public surface. The
// server side of virtual agents lives in the hub's own `src/virtual-agents/`; nothing here talks to it except
// through `api.ts`.
export type { AtlassianLoginOptions, AtlassianLoginResult, PackedAtlassianAuth, SyncAtlassianAuthOptions, SyncAtlassianAuthResult } from "./atlassian.ts";
export {
  ATLASSIAN_AUTH_MAX_CHARS,
  ATLASSIAN_SIGN_IN_CODES,
  atlassianLogin,
  jiraExportSignInBudget,
  packAtlassianAuth,
  parseTwgDeviceCode,
  readAtlassianAuth,
  restoreAtlassianAuth,
  syncAtlassianAuth,
  TWG_DEVICE_CODE_EXPIRES_S,
  twgDir,
  twgLoginExpired,
  twgPromptsForBrowser
} from "./atlassian.ts";
export type { AzureProfile, MsalCache, PackedAzureCache, SyncAzureCacheOptions, SyncAzureCacheResult } from "./azure-cache.ts";
export {
  AZURE_CACHE_MAX_CHARS,
  azureDir,
  minimalProfile,
  packAzureCache,
  pruneMsalCache,
  readAzureCache,
  restoreAzureCache,
  syncAzureCache,
  unpackAzureCache
} from "./azure-cache.ts";
export type { CacheSyncOptions, CacheSyncResult } from "./cache-sync.ts";
export { CACHE_SYNC_MS, cacheSync } from "./cache-sync.ts";
export type { CredentialCommandOptions, CredentialStore } from "./credentials.ts";
export { isCredentialKind, OWNER_READABLE, readStdinText, requireCredentialKind, runCredentialCommand } from "./credentials.ts";
export { EXIT_FATAL, EXIT_NO_CREDENTIAL, FatalError, isVirtualPhase, PHASES, say, virtualStateDir } from "./phases.ts";
export type { RunVirtualOptions } from "./run.ts";
export { runVirtual, VIRTUAL_USAGE } from "./run.ts";
export type {
  AzureLoginResult,
  ClaudeLoginOptions,
  ClaudeLoginResult,
  DeviceCodePrompt,
  GithubLoginOptions,
  GithubLoginResult,
  LoginOptions,
  RelayDeviceLoginOptions,
  RelayDeviceLoginResult,
  Respond,
  RunOptions,
  RunResult
} from "./sign-in.ts";
export {
  azureLogin,
  childEnv,
  claudeLogin,
  DEVICE_CODE_EXPIRES_S,
  DeviceLoginError,
  EXPIRY_TOLERANCE_S,
  findClaudeToken,
  GITHUB_SIGN_IN_CODES,
  GITHUB_SIGN_IN_GAP_MS,
  ghLoginExpired,
  githubLogin,
  githubSignInGapMs,
  OUTPUT_TAIL_CHARS,
  outputTail,
  PASTE_CODE_EXPIRES_S,
  parseAzDeviceCode,
  parseClaudeAuthorizeUrl,
  parseGhDeviceCode,
  REDACTED,
  redactTokens,
  relayDeviceLogin,
  run,
  SIGKILL_AFTER_MS,
  stripAnsi
} from "./sign-in.ts";
