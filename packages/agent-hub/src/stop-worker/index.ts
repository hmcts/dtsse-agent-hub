// The post-turn summariser: what the Stop hook spawns in the background to publish a notable outcome, hold a
// note about the feed for the next prompt, and follow the session to whichever repo it is now working in.
export type { CandidateTopics, CandidateTopicsOptions } from "./candidates.ts";
export { candidateTopics } from "./candidates.ts";
export type { HaikuCommand, RunHaikuOptions } from "./haiku.ts";
export { haikuCommand, runHaiku, summariserCwd, summariserSettings } from "./haiku.ts";
export type { Cursors, DecideOptions, Decision, FollowWorkState, Haiku, PassContext, RunStopWorkerOptions, StopWorkerApi } from "./run.ts";
export { decide, followWork, parseCursors, runPass, runStopWorker } from "./run.ts";
export type { BuildPromptOptions, HaikuOutput, HaikuPublish, HaikuValidation } from "./summarise.ts";
export { buildPrompt, formatFeed, parseHaikuResult, validateHaikuOutput, WORK_TYPES } from "./summarise.ts";
export type { ExtractTouchesOptions, ProductTouch, RepoTouch, ShellSeparator, ShellToken, ShellWord, Touches, TouchKind } from "./touches.ts";
export { bashPaths, extractTouches, NO_TOUCHES, shellWords, workedInRepos } from "./touches.ts";
export type { TranscriptSlice } from "./transcript.ts";
export { extractTranscriptText, readTranscriptSlice, SLICE_BYTES, tail } from "./transcript.ts";
