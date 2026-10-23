// The pod side of the HMCTS Assistant's conversations: one interactive Claude session per conversation, beside
// the virtual agent's own. Gathered for the CLI and the package's public surface.
export type { RunAssistantSupervisorOptions } from "./run.ts";
export { runAssistantSupervisor } from "./run.ts";
export type {
  AssistantSupervisor,
  ConversationSession,
  CreateAssistantSupervisorOptions,
  ReportOutcome,
  SavedSession,
  SessionPhase,
  SupervisorFs,
  Wake
} from "./supervisor.ts";
export {
  createAssistantSupervisor,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MAX_SESSIONS,
  EXIT_GRACE_MS,
  idleMinutes,
  MAX_SESSIONS_LIMIT,
  maxSessions,
  parseSavedSession,
  parseWake,
  REPORT_EVERY_MS
} from "./supervisor.ts";
export type { CreateTmuxOptions, ProgramCheck, StartSessionOptions, Tmux, TmuxExec, TmuxResult } from "./tmux.ts";
export { canRunProgram, claudeCommand, commandProgram, createTmux, PROMPT_FILE, tmuxName } from "./tmux.ts";
