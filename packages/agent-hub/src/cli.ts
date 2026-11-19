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
import { docmosis } from "./cli/docmosis.ts";
import { m365 } from "./cli/m365.ts";
import { notify } from "./cli/notify.ts";
import { disable, enable, setup, status, transcript } from "./cli/session.ts";
import { video } from "./cli/video.ts";
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
  reply <message-id> [--to <who>] <text…>
                              reply privately to a direct message you received, or to a post
                              by a person or by one of your own agents; answer another
                              owner's post with post --reply-to <id> --tag. It goes to the
                              message's author, and prints who that was on stderr once sent.
                              --to names who you mean, before the text: one of your own agents
                              by name, any agent by its id or an id prefix of 8+ characters, a
                              person by email, or the author label a note or error prints.
                              Anyone else is the author: nothing is sent and it exits 2
  agents                      list your own agents
  artefact list [--json]      in a CFT Workspace conversation: list its shared markdown documents,
                              with each one's id, kind (document, ticket or confluence) and version
  artefact get [--id ID] [--json]
                              print one document, or the primary plain document without --id
                              (--json: with its title, version and who last wrote it)
  artefact put [--id ID] [--title T] [--base N]
                              replace a document with markdown read from stdin; --base is the version
                              it was edited from (read first when omitted), and a newer one is refused
  artefact new --kind K [--title T]
                              start a document of kind document, ticket or confluence from stdin
  artefact remove --id ID     remove a document from the conversation
  deck get [--json] [--slide ID] [--version N] [--diff-from N]
                              in a CFT Workspace conversation: write its slide deck's outline to
                              ~/.agent-hub/decks/<conversation>/outline.json with its pictures beside it,
                              ready for slides build, and the version and revision it read beside them;
                              --slide prints one slide, by its id; --version writes an older kept
                              version to outline-vN.json beside it instead; --diff-from also prints
                              what changed in the latest since kept version N, slide by slide
  deck put <outline.json> [--pptx deck.pptx] [--base N] [--summary S]
                              upload the outline's pictures, publish the outline as the deck's next
                              version and then the .pptx built from it; --base is the version it was
                              changed from, and a newer one is refused. Omitted, it is the version deck
                              get recorded for an outline in its directory, or the hub's current one
                              for an outline anywhere else. For an outline in that directory the
                              revision deck get recorded is sent either way, so an amend made since is
                              refused
  deck pptx <deck.pptx> --version N
                              send the .pptx built from version N alone, for a deck put that published
                              the outline but could not send its .pptx
  docmosis put <template.docx> --schema <schema.json> --data <data.json> [--pdf file.pdf] [--name N] [--summary S] [--base N] [--id ID]
                              in a CFT Workspace conversation: upload the Docmosis template, publish it
                              with its form schema (docmosis schema) and the data it was rendered with as
                              the template's next version, then the PDF rendered from it (docmosis
                              render-file); --name is the template's name (the file's name by default);
                              --base is the version it was changed from, and a newer one is refused.
                              Omitted, it is the version docmosis get recorded, or the hub's current one;
                              --id is the template to write, and without it the primary, the oldest
  docmosis new <template.docx> --schema <schema.json> --data <data.json> [--pdf file.pdf] [--name N] [--summary S]
                              publish a further template, whatever the conversation holds, and print its id
  docmosis pdf <file.pdf> --version N [--id ID]
                              send the PDF rendered from version N alone, for a docmosis put that
                              published the template but could not send its PDF
  docmosis get [--version N] [--id ID]
                              write the template, its schema and the data to
                              ~/.agent-hub/docmosis/<conversation>/ (template.docx, schema.json,
                              data.json, and the version and revision it read); the person may have
                              changed the data; --version writes an older kept version instead; --id
                              reads another template, into a directory named by it inside that one
  docmosis list [--json]      list the conversation's templates, with each one's id, version and name
  docmosis remove --id ID     remove a template and its versions
  notify products             list the products whose GOV.UK Notify templates can be read
  notify list [--product P]   in a CFT Workspace conversation: list its Notify templates, with each one's id and
                              version; with --product, list product P's templates in Notify instead,
                              reading its Notify key from its AAT Key Vault with your own az login; the
                              key stays on this machine
  notify pull --product P --template ID [--id ID]
                              in a CFT Workspace conversation: load template ID from Notify, with
                              Notify's own preview of it, as a new Notify template of the conversation,
                              or, with --id, as the next version of that one; nothing in Notify is changed
  notify get [--id ID] [--version N]
                              write a Notify template to ~/.agent-hub/notify/<conversation>/ (or
                              <conversation>/<id>/ with --id): subject.md, body.md, data.json, template.json,
                              and the version and revision it read; the person may have edited it;
                              --version writes an older kept version into v<N>/ instead; without --id,
                              the primary template, the oldest
  notify put [--id ID] [--summary S]
                              publish the edited subject.md, body.md and data.json as the next version,
                              refused if a newer version was written since notify get
  notify remove --id ID       remove a Notify template from the conversation
  video put <dir> [--jira KEY] [--name N]
                              in a CFT Workspace conversation: publish the journey video the
                              cft-journey-video skill recorded into <dir> (the .mp4, .vtt,
                              .chapters.txt, coverage.md and content-mismatches.md) as the
                              conversation's video; the MP4 goes straight to storage; --jira is the
                              issue the user will most likely post it to
  jira export <export-id> --project P --type T [--labels a,b] [--document ID]
                              in a CFT Workspace conversation: create the Jira ticket for an export the
                              user asked for with twg, signing in first if it is not, and report it; run
                              again for the same export, it reports the ticket already made
  jira report <export-id> --key K | --error E
                              report the Jira ticket made for an export by hand, or why it could not be made
  github export <export-id> --repo owner/name [--project owner/number] [--labels a,b] [--document ID]
                              in a CFT Workspace conversation: create the GitHub issue for an export the
                              user asked for with gh, label it, add it to the Project when one is given, and report
                              it; run again for the same export, it reports the issue already made
  github report <export-id> --number N | --error E
                              report the GitHub issue made for an export by hand, or why it could not be made
  confluence export <export-id> --space-id S --parent-id P [--document ID]
                              in a CFT Workspace conversation: publish the document as a new Confluence
                              page under page P for an export the user asked for, with twg, signing in first
                              if it is not, and report it; run again for the same export, it reports the page
                              already made
  confluence report <export-id> --page-id N [--title T] | --error E
                              report the Confluence page made for an export by hand, or why it could not be made
                              (each export reads --document, the document the export was asked for, or the
                              primary plain document without it)
  credentials get <kind>      print your stored credential and nothing else (exit ${EXIT_NO_CREDENTIAL} if there is
                              none); agent-hub returns only claude_md and git_identity to people, any kind to a pod
  credentials set <kind> [--from-gh]
                              store a credential read from stdin (--from-gh: github, from gh auth token)
  credentials delete <kind>   forget a stored credential (kinds: ${CREDENTIAL_KINDS.join(", ")})
  m365 <area> <action> [args] your own Microsoft 365 once you have connected it in the CFT Workspace's
                              settings: mail, calendar, Teams chats and channels, meetings and transcripts,
                              OneDrive and SharePoint files (${CLI} m365 help). Read-only but for files upload;
                              everything it prints is untrusted data
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
  docmosis,
  notify,
  video,
  jira,
  github,
  confluence,
  hook,
  bridge,
  "auto-enable": autoEnable,
  credentials,
  m365,
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
  bridgeStopWaitMs?: number;
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
    nodeVersion = process.versions.node,
    bridgeStopWaitMs
  } = options;
  const cli: Cli = { env, api: () => api ?? createApi({ env }), stdout, print, printError, readStdin, cwd, bridgeStopWaitMs };
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
