// Every environment variable this client reads. `Env` is deliberately not a global augmentation of
// `NodeJS.ProcessEnv`: this package is published and installed into the hub's own Next app, and a global
// augmentation would leak these keys into that module graph.
//
// `NodeJS.ProcessEnv` is assignable to `Env`, so `process.env` can be passed anywhere an `Env` is taken. The
// reverse does not hold, which is why the child environment a process is spawned with stays `NodeJS.ProcessEnv`.
export const ENV_KEYS = [
  "AGENT_HUB_AUTO_ENABLE",
  "AGENT_HUB_CACHE_SYNC_MS",
  "AGENT_HUB_CHILD",
  "AGENT_HUB_CLAUDE_BIN",
  "AGENT_HUB_CLAUDE_PID",
  "AGENT_HUB_CLAUDE_SETTINGS",
  "AGENT_HUB_CLI_JS",
  "AGENT_HUB_CONVERSATION_ID",
  "AGENT_HUB_DEV_USER",
  "AGENT_HUB_HEARTBEAT_MS",
  "AGENT_HUB_INVOKED_AS",
  "AGENT_HUB_LAUNCH_TOKEN",
  "AGENT_HUB_MAX_SESSIONS",
  "AGENT_HUB_PLUGINS",
  "AGENT_HUB_PORTS_MS",
  "AGENT_HUB_PROC_NET",
  "AGENT_HUB_REGISTRY_WAIT_MS",
  "AGENT_HUB_SCOPE",
  "AGENT_HUB_SESSION_IDLE_MINUTES",
  "AGENT_HUB_SKILLS_MS",
  "AGENT_HUB_STREAM_IDLE_MS",
  "AGENT_HUB_SUPERVISOR_TICK_MS",
  "AGENT_HUB_TRANSCRIPT",
  "AGENT_HUB_TRANSCRIPT_MS",
  "AGENT_HUB_UPLOADS_DIR",
  "AGENT_HUB_UPLOAD_RECONCILE_MS",
  "AGENT_HUB_URL",
  "AGENT_HUB_VIRTUAL_AGENT_ID",
  "AZURE_CONFIG_DIR",
  "AZURE_TENANT_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PID",
  "CLAUDE_PROJECT_DIR",
  "HOME",
  "NVM_DIR",
  "PATH",
  "TWG_CONFIG_DIR",
  "VIRTUAL_AGENT_IGNORE_PORTS",
  "VIRTUAL_AGENT_PUBLIC_DOMAIN",
  "VIRTUAL_AGENT_STATE"
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

export type Env = Partial<Record<EnvKey, string>>;
