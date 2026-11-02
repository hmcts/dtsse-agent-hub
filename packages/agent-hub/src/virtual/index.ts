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
  twgPromptsForBrowser,
  twgRefreshRejected
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
export type { AzureLoginMode, AzureLoginOptions, AzureLoginResult } from "./azure-login.ts";
export { azureLogin, parseAzDeviceCode } from "./azure-login.ts";
export type { CacheSyncOptions, CacheSyncResult } from "./cache-sync.ts";
export { CACHE_SYNC_MS, cacheSync } from "./cache-sync.ts";
export type { ClaudeLoginOptions, ClaudeLoginResult } from "./claude-login.ts";
export { claudeLogin, findClaudeToken, PASTE_CODE_EXPIRES_S, parseClaudeAuthorizeUrl } from "./claude-login.ts";
export type { CredentialCommandOptions, CredentialStore } from "./credentials.ts";
export { isCredentialKind, OWNER_READABLE, requireCredentialKind, runCredentialCommand } from "./credentials.ts";
export type { DeviceCodePrompt, LoginOptions, RelayDeviceLoginOptions, RelayDeviceLoginResult, Respond } from "./device-relay.ts";
export { DEVICE_CODE_EXPIRES_S, DeviceLoginError, EXPIRY_TOLERANCE_S, relayDeviceLogin } from "./device-relay.ts";
export type { GithubLoginOptions, GithubLoginResult } from "./github-login.ts";
export { GITHUB_SIGN_IN_CODES, GITHUB_SIGN_IN_GAP_MS, githubLogin, githubSignInGapMs } from "./github-login.ts";
export { EXIT_FATAL, EXIT_NO_CREDENTIAL, FatalError, isVirtualPhase, PHASES, say, virtualStateDir } from "./phases.ts";
export type { RunOptions, RunResult } from "./process.ts";
export { childEnv, OUTPUT_TAIL_CHARS, outputTail, REDACTED, redactTokens, run, SIGKILL_AFTER_MS, stripAnsi } from "./process.ts";
export type { RunVirtualOptions } from "./run.ts";
export { runVirtual, VIRTUAL_USAGE } from "./run.ts";
