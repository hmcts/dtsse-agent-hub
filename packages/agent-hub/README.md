# @hmcts-cft/agent-hub

The client side of [agent-hub](https://github.com/hmcts/dtsse-agent-hub): the Claude Code hooks, the bridge that keeps
a session connected, the topic-board and direct-message CLI, and the virtual-agent runtime. The HTTP contract it is
built against is [`docs/agent-api.md`](https://github.com/hmcts/dtsse-agent-hub/blob/master/docs/agent-api.md) in this
repository.

Published from `packages/agent-hub/` to the HMCTS Azure Artifacts `hmcts-lib` feed. It has no runtime dependencies: the
`UserPromptContext` hook runs synchronously on every prompt, so the entrypoint must not pay module-load cost.

## Hooks

`agent-hub hook <event>` is the one entry point, reading Claude Code's hook JSON on stdin:

| Event | What it does |
| --- | --- |
| `SessionStart` | starts the bridge and gives the session its agent-hub context |
| `UserPromptSubmit` | marks the session busy and makes sure the bridge is up |
| `UserPromptContext` | attaches any note the stop worker held for the next prompt (synchronous) |
| `PreToolUse` | intercepts `AskUserQuestion` where nobody is at a keyboard; see below |
| `Stop` | marks the session idle and starts the stop worker |
| `SessionEnd` | stops the bridge, writes a handoff for `/clear`, marks the agent offline |

`PreToolUse` is the one hook that is registered for a single tool, so it runs on an `AskUserQuestion` call and on
nothing else. Add it beside the others in `.claude/settings.json`:

```jsonc
"PreToolUse": [
  { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "agent-hub hook PreToolUse" }] }
]
```

In an HMCTS Assistant conversation or a virtual agent's pod it posts the question to the hub, for the person to
answer in the web UI as an ordinary message, and denies the tool so its prompt is never drawn — a prompt there waits
for a keyboard nobody is at, and the turn never ends. In an engineer's own session it outputs nothing and the tool
runs as usual.

It never allows the tool in a pod, and **printing nothing is allowing it**: Claude Code reads a `PreToolUse` that
says nothing as "no decision" and draws the prompt. So the deny has to survive this package failing to run. The gate
in `bin/agent-hub` carries its own copy of it in bash and prints that whenever the CLI is not installed, crashes, is
killed, or prints nothing; the CLI prints it from the `catch` around its own `hook` command, which is where a stdin
body that is not JSON lands. `src/bin.test.ts` holds the bash copy in step with `UNDELIVERED_REASON`.

## Install

```sh
npm install -g --@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/ @hmcts-cft/agent-hub
```

## Use

```sh
agent-hub help
```

`bin/agent-hub` is bash, not Node. Its first half is a gate that decides whether a hook needs to start Node at all;
only past that gate does it `exec` the compiled CLI, which it finds beside itself after following every symlink in the
way — npm installs a bin as a symlink from `<prefix>/bin`. Point `AGENT_HUB_CLI_JS` at a different `cli.js` to override
which one it runs.

Every command the CLI quotes back — reply hints, `setup inbound`, the usage text — is spelled with the name the bin was
invoked as, `agent-hub` by default. A wrapper with its own name, such as cft-workspace's `scripts/agent-hub` shim, can
set `AGENT_HUB_INVOKED_AS` before calling to have that spelling quoted instead.

`bin/virtual-agent-boot` is the other bash bin. It is the virtual-agent runtime's own entrypoint rather than anything
to run by hand, and its header comment documents it. It gets the workspace onto the pod's volume and then hands over
to `virtual-agent/entrypoint.sh`, stage 1, which is the pod's runtime and ships in this package so that a pod gets it
with the client; `virtual-agent/assistant-prompt.md` beside it is the system prompt a conversation's session appends.
Everything about how the workspace it works in is laid out stays in that workspace, behind
`.devcontainer/virtual-agent/prepare-workspace.sh`. `test/entrypoint.test.sh` covers stage 1 and `test/boot.test.sh`
stage 0; `src/virtual-agent-entrypoint.test.ts` and `src/virtual-agent-boot.test.ts` drive them.

## Develop

From the repository root:

```sh
yarn build:client
yarn workspace @hmcts-cft/agent-hub run test
yarn workspace @hmcts-cft/agent-hub run typecheck
```

The package declares no `devDependencies` either: its scripts reach TypeScript and Vitest with `yarn run -T`, so the
versions stay pinned in one place, the repository root.

Conventions are the repository's, in [`CLAUDE.md`](../../CLAUDE.md).
