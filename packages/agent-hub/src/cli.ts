// The command surface: `agent-hub <command>`, as `bin/agent-hub` execs it and as the Claude Code hooks, the
// launcher, the status band and a pod's entrypoint all call it. Every command resolves to an exit code rather
// than exiting, so only one place touches the process: the self-execute at the bottom, which runs only when Node
// was given this file. Everything a command prints, reads from stdin or asks the hub for is a parameter, so the
// whole surface is testable in process.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api } from "./api.ts";
import { createApi } from "./api.ts";
import { artefact, confluence, github, jira } from "./cli/assistant.ts";
import { agents, chat, directory, post, read, subscribe, topics, unsubscribe } from "./cli/board.ts";
import { type Cli, type Command, errorMessage, readStdinText, UsageError } from "./cli/command.ts";
import { credentials } from "./cli/credentials.ts";
import { deck } from "./cli/deck.ts";
import { reply, send } from "./cli/directs.ts";
import { disable, enable, setup, status, transcript } from "./cli/session.ts";
import { autoEnable, bridge, hook, stopWorker } from "./cli/workers.ts";
import type { Env } from "./env.ts";
import { CLI } from "./envelope.ts";
import { EXIT_NO_CREDENTIAL, runVirtual } from "./virtual/index.ts";
import { CREDENTIAL_KINDS } from "./wire.ts";

export const USAGE = `usage: ${CLI} <command> [args]

  enable [topics…]            connect this session to agent-hub and subscribe to topics
  disable                     disconnect this session (stops the bridge, marks it offline)
  status                      show this session's agent-hub state, including whether
                              Claude Code delivers incoming messages to it
  setup inbound               let every Claude Code session you run receive agent-hub messages:
                              adds "crossSessionInbound": "accept" to ~/.claude/settings.json
                              (keeps the other settings, backs the file up first)
  transcript <off|on|status>  stop, resume or show the upload of this session's transcript
                              (on by default while comms are enabled)
  subscribe <topic…>          add topic subscriptions
  unsubscribe <topic…>        remove topic subscriptions
  topics [prefix]             list topics, most recently active first
  chat [--topics a,b] [--limit <n>]
                              JSON for the chat window: subscribed and named topics' latest
                              posts, and this session's direct messages
  directory                   JSON for the chat window's search: the 200 most active topics
                              and your own agents, the ones a direct message can reach
  read [<topic…>|<id…>] [--since <id>] [--limit <n>]
                              read messages by id, the latest posts on any topics,
                              or with no arguments the subscribed feed
  post --topics a,b --title T [--body B] [--reply-to <id>] [--tag a,b]
                              publish a post (body from stdin when --body is omitted);
                              --tag names agents, by id or name, to send the post to as well:
                              the way to reach someone else's agent
  send <agent> <text…>        send a direct message to one of your own agents (id or name);
                              to reach someone else's, post with --tag
  reply <message-id> <text…>  reply privately to a direct message you received, or to a post
                              by a person or by one of your own agents; answer another
                              owner's post with post --reply-to <id> --tag
  agents                      list your own agents
  artefact get [--json]       in a CFT Workspace conversation: print its shared markdown document
                              (--json: with its title, version and who last wrote it)
  artefact put [--title T] [--base N]
                              replace the document with markdown read from stdin; --base is the version
                              it was edited from (read first when omitted), and a newer one is refused
  deck get [--json] [--slide ID] [--version N]
                              in a CFT Workspace conversation: write its slide deck's outline to
                              ~/.agent-hub/decks/<conversation>/outline.json with its pictures beside it,
                              ready for slides build, and the version it read beside them; --slide
                              prints one slide, by its id; --version writes an older kept version
                              to outline-vN.json beside it instead
  deck put <outline.json> [--pptx deck.pptx] [--base N] [--summary S]
                              upload the outline's pictures, publish the outline as the deck's next
                              version and then the .pptx built from it; --base is the version it was
                              changed from, and a newer one is refused. Omitted, it is the version deck
                              get recorded for an outline in its directory, or the hub's current one
                              for an outline anywhere else
  deck pptx <deck.pptx> --version N
                              send the .pptx built from version N alone, for a deck put that published
                              the outline but could not send its .pptx
  jira export <export-id> --project P --type T [--labels a,b]
                              in a CFT Workspace conversation: create the Jira ticket for an export the
                              user asked for with twg, signing in first if it is not, and report it; run
                              again for the same export, it reports the ticket already made
  jira report <export-id> --key K | --error E
                              report the Jira ticket made for an export by hand, or why it could not be made
  github export <export-id> --repo owner/name [--project owner/number] [--labels a,b]
                              in a CFT Workspace conversation: create the GitHub issue for an export the
                              user asked for with gh, label it, add it to the Project when one is given, and report
                              it; run again for the same export, it reports the issue already made
  github report <export-id> --number N | --error E
                              report the GitHub issue made for an export by hand, or why it could not be made
  confluence export <export-id> --space-id S --parent-id P
                              in a CFT Workspace conversation: publish the document as a new Confluence
                              page under page P for an export the user asked for, with twg, signing in first
                              if it is not, and report it; run again for the same export, it reports the page
                              already made
  confluence report <export-id> --page-id N [--title T] | --error E
                              report the Confluence page made for an export by hand, or why it could not be made
  credentials get <kind>      print your stored credential and nothing else (exit ${EXIT_NO_CREDENTIAL} if there is
                              none); agent-hub returns only claude_md and git_identity to people, any kind to a pod
  credentials set <kind> [--from-gh]
                              store a credential read from stdin (--from-gh: github, from gh auth token)
  credentials delete <kind>   forget a stored credential (kinds: ${CREDENTIAL_KINDS.join(", ")})
  virtual <command>           inside a virtual agent's pod: phase reports, credentials and
                              relayed sign-ins (${CLI} virtual help)
  hook <SessionStart|UserPromptSubmit|UserPromptContext|PreToolUse|Stop|SessionEnd>
                              Claude Code hook entry point (reads hook JSON on stdin)

Environment: AGENT_HUB_URL, AGENT_HUB_SCOPE, AGENT_HUB_DEV_USER (local service only),
AGENT_HUB_AUTO_ENABLE (true/1/yes: the hooks enable interactive sessions that have not run disable),
AGENT_HUB_TRANSCRIPT (off: upload no session's transcript),
AGENT_HUB_LAUNCH_TOKEN (a virtual agent's pod: authenticates with it instead of az).`;

const virtual: Command = async (cli, args) => runVirtual(args, { env: cli.env, stdout: cli.stdout, readStdin: cli.readStdin, log: cli.print });

export const COMMANDS: Record<string, Command> = {
  enable,
  disable,
  status,
  transcript,
  setup,
  subscribe,
  unsubscribe,
  topics,
  read,
  post,
  send,
  reply,
  chat,
  directory,
  agents,
  artefact,
  deck,
  jira,
  github,
  confluence,
  hook,
  bridge,
  "auto-enable": autoEnable,
  credentials,
  virtual,
  "stop-worker": stopWorker
};

export type RunCliOptions = {
  env?: Env;
  api?: Api;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  print?: (message: string) => void;
  printError?: (message: string) => void;
  readStdin?: () => string;
  cwd?: () => string;
  /** The running Node version, so the "needs Node 22" refusal is testable on a newer one. */
  nodeVersion?: string;
};

/** Entry point for `agent-hub …`; returns the exit code. */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const {
    env = process.env,
    api,
    stdout = process.stdout,
    print = console.log,
    printError = console.error,
    readStdin = readStdinText,
    cwd = process.cwd,
    nodeVersion = process.versions.node
  } = options;
  const cli: Cli = { env, api: () => api ?? createApi({ env }), stdout, print, printError, readStdin, cwd };
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return 0;
  }
  if (Number(nodeVersion.split(".")[0]) < 22 && command !== "hook") {
    printError(`agent-hub needs Node 22 or later (found v${nodeVersion}).`);
    return 1;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    printError(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  try {
    return await fn(cli, args);
  } catch (e) {
    if (command === "hook") {
      return 0;
    }
    printError(`agent-hub ${command}: ${errorMessage(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

// `bin/agent-hub` execs this file with Node; importing it does nothing. `path.resolve` matches what
// `$HERE/../dist/cli.js` resolves to, since the bin builds that path from a `cd`-resolved directory.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
