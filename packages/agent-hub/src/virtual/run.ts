// `agent-hub virtual <command>`, the entry point a pod's entrypoint script calls. Every command resolves to an
// exit code rather than exiting, so the CLI stays the only place that touches the process.
import type { Api } from "../api.ts";
import { CREDENTIAL_KINDS, createApi } from "../api.ts";
import { runAssistantSupervisor } from "../assistant/index.ts";
import type { Env } from "../env.ts";
import { CLI } from "../envelope.ts";
import { setGitIdentity } from "../git-identity.ts";
import { watchPorts } from "../ports.ts";
import { withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { atlassianLogin } from "./atlassian.ts";
import { cacheSync } from "./cache-sync.ts";
import { readStdinText, runCredentialCommand } from "./credentials.ts";
import { EXIT_FATAL, EXIT_NO_CREDENTIAL, FatalError, isVirtualPhase, PHASES, say } from "./phases.ts";
import { azureLogin, claudeLogin, githubLogin, run } from "./sign-in.ts";

export const VIRTUAL_USAGE = `usage: ${CLI} virtual <command>

  status <phase> [detail…]    report a phase (${PHASES.join(", ")})
  azure-login                 restore the stored Azure sign-in, or relay a device-code sign-in
  github-login                relay GitHub device-code sign-ins and store the token; exit ${EXIT_NO_CREDENTIAL} when every
                              code was shown to the owner and none completed, which asking again will not fix
  claude-login                relay a Claude sign-in (own licence) and store the token
  atlassian-login             restore the stored twg (Jira, Confluence) sign-in, or relay a device-code
                              sign-in; exit ${EXIT_NO_CREDENTIAL} when the owner does not complete it
  cache-sync [--once]         store the Azure token cache and the twg sign-in on agent-hub when they
                              change, refreshing twg when due (every 10 min)
  git-identity                set the global git user.name and user.email (and push/init defaults)
  watch-ports                 report the ports listening in the pod to agent-hub when they change (every 5s)
  assistant-supervisor        beside the main session: run one Claude session per HMCTS Assistant conversation
                              the hub wakes, in tmux session c-<first 8 of its id>, and stop the idle ones
  credential get <kind>       print a stored credential (exit ${EXIT_NO_CREDENTIAL} if there is none)
  credential put <kind>       store a credential read from stdin

Kinds: ${CREDENTIAL_KINDS.join(", ")}. Exit ${EXIT_FATAL} means the hub failed the agent: do not retry.
Environment: AGENT_HUB_URL, AGENT_HUB_VIRTUAL_AGENT_ID, AGENT_HUB_LAUNCH_TOKEN, AZURE_TENANT_ID,
VIRTUAL_AGENT_IGNORE_PORTS (ports watch-ports never reports), AGENT_HUB_MAX_SESSIONS (conversation sessions at
once, 2 by default), AGENT_HUB_SESSION_IDLE_MINUTES (20 by default) and AGENT_HUB_GITHUB_SIGN_IN_GAP_MS (the
wait between relayed GitHub codes, 60000 by default).`;

export type RunVirtualOptions = {
  api?: Api;
  env?: Env;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  /** `credential put` reads its value here; a parameter so a test does not have to own the process's stdin. */
  readStdin?: () => string;
  log?: (message: string) => void;
};

/** Entry point for `agent-hub virtual …`; returns the exit code. */
export async function runVirtual(
  args: string[],
  { api, env = process.env, stdout = process.stdout, readStdin = readStdinText, log = console.log }: RunVirtualOptions = {}
): Promise<number> {
  const [command, ...rest] = args;
  try {
    const hub = () => api || createApi();
    switch (command) {
      case "status": {
        const [phase, ...detail] = rest;
        if (!isVirtualPhase(phase)) {
          throw new Error(`phase must be one of ${PHASES.join(", ")}`);
        }
        const { id } = requireVirtualAgent(env);
        await withRetry(() => hub().virtualStatus(id, phase, detail.join(" ") || undefined));
        return 0;
      }
      case "azure-login":
        await azureLogin({ api: hub(), env });
        return 0;
      case "github-login":
        return (await githubLogin({ api: hub(), env })) === "not-signed-in" ? EXIT_NO_CREDENTIAL : 0;
      case "claude-login":
        await claudeLogin({ api: hub(), env });
        return 0;
      case "atlassian-login":
        return (await atlassianLogin({ api: hub(), env })) === "not-signed-in" ? EXIT_NO_CREDENTIAL : 0;
      case "git-identity":
        await setGitIdentity({ api: hub(), id: requireVirtualAgent(env).id, exec: (cmd, a) => run(cmd, a, { env, timeoutMs: 30000 }), log: say });
        return 0;
      case "cache-sync":
        await cacheSync({ api: hub(), env, once: rest.includes("--once") });
        return 0;
      case "watch-ports":
        await watchPorts({ api: hub(), id: requireVirtualAgent(env).id, env, say });
        return 0;
      case "assistant-supervisor":
        await runAssistantSupervisor({ api: hub(), id: requireVirtualAgent(env).id, env, say });
        return 0;
      case "credential":
        return await runCredentialCommand({ api: hub(), id: requireVirtualAgent(env).id, argv: rest, stdout, readStdin });
      case undefined:
      case "help":
        log(VIRTUAL_USAGE);
        return 0;
      default:
        throw new Error(`unknown virtual command: ${command}\n\n${VIRTUAL_USAGE}`);
    }
  } catch (e) {
    say((e as Error).message);
    return e instanceof FatalError ? EXIT_FATAL : 1;
  }
}
