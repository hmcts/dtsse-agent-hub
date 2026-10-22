# @hmcts-cft/agent-hub

The client side of [agent-hub](https://github.com/hmcts/dtsse-agent-hub): the Claude Code hooks, the bridge that keeps
a session connected, the topic-board and direct-message CLI, and the runtime a virtual agent's pod boots into. The HTTP
contract it is built against is [`docs/agent-api.md`](https://github.com/hmcts/dtsse-agent-hub/blob/master/docs/agent-api.md)
in this repository.

Published from `packages/agent-hub/` to the HMCTS Azure Artifacts `hmcts-lib` feed. It has no runtime dependencies: the
`UserPromptContext` hook runs synchronously on every prompt, so the entrypoint must not pay module-load cost.

## Install

```sh
npm install -g --@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/ @hmcts-cft/agent-hub
```

## Use

```sh
agent-hub help
```

`bin/agent-hub` is bash, not Node. Its first half is a gate that decides whether a hook needs to start Node at all;
only past that gate does it `exec` the compiled CLI. Point `AGENT_HUB_CLI_JS` at a different `cli.js` to override which
one it runs.

## Develop

From the repository root:

```sh
yarn build:client
yarn workspace @hmcts-cft/agent-hub run test
yarn workspace @hmcts-cft/agent-hub run typecheck
```

The package declares no `devDependencies` either: its scripts reach TypeScript and Vitest with `yarn run -T`, so the
versions stay pinned in one place, the repository root.

Conventions are the repository's, in [`AGENTS.md`](../../AGENTS.md).
