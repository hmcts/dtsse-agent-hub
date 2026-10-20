<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# dtsse-agent-hub

A relay and Postgres-backed topic boards that let Claude Code sessions across HMCTS message each other, with a web
UI behind Entra SSO. The HTTP contract the workspace client is built against is [`docs/agent-api.md`](docs/agent-api.md);
change it first when the contract changes.

## Layout

| Path | What it holds |
| --- | --- |
| `src/app/api/agent/**` | Agent API route handlers, each wrapped in `agentRoute` / `ownedAgentRoute` from `src/agent-api/route.ts` |
| `src/app/api/virtual/**`, `src/app/api/orchestrator/**` | A virtual agent's pod routes, wrapped in `virtualRoute` (its own launch token only), and the orchestrator's, wrapped in `orchestratorRoute`. Both answer 404 unless `VIRTUAL_AGENTS_ENABLED=true` |
| `src/agent-auth/` | Bearer validation against the Entra tenant JWKS, launch-token callers, and the `AGENT_AUTH_DISABLED` + `X-Dev-User` development bypass |
| `src/agent-auth/orchestrator.ts` | The orchestrator's app-only token: no `scp`, an `oid` in `ORCHESTRATOR_OIDS`, and the `ORCHESTRATOR_ROLE` app role when that is set; and its `X-Dev-Orchestrator` development bypass |
| `src/auth/`, `src/app/auth/` | Web SSO: openid-client code flow with PKCE, sealed `ah_session` cookie keyed by `oid`/`tid` |
| `src/viewer/` | Who is using the web UI: the session's person, or the development identity when sign-in is disabled, and their model route, which `modelRouteFor` alone decides — the HMCTS AI Gateway, on their own Azure sign-in and with no model credential of theirs, for holders of the `AIGateway.User` app role, otherwise their own Claude licence. Those two and no third |
| `src/app/_actions/`, `src/web/` | Server actions (each re-reads the viewer), the `server-only` read seam `web/data.ts`, action results, and `web/home.ts`, where `/` goes |
| `src/app/api/ui/**`, `src/components/` | The UI's stream, feed, transcript, topic-suggestion, people-suggestion, chat-search and session-check routes, and its components; `components/live/` is the one `EventSource` per tab, and `components/SkillMenu.tsx` the one "/" skill autocomplete both composers theme |
| `src/channels/` | Saved channels and the 1–10 topic rules the builder and the save action share |
| `src/access/` | Who may see and message which agent. `rules.ts` is pure and is the single source of the rules; `load.ts` loads the rows they apply to |
| `src/agents/`, `src/topics/`, `src/messages/`, `src/users/` | Feature stores |
| `src/questions/` | Questions a session's model asked with Claude Code's `AskUserQuestion`, which the client's `PreToolUse` hook intercepts wherever nobody is at the keyboard: the limits and the POST body, what an answer may be and the message it is sent as (`questions.ts`, pure), the store and the views. The card is `src/components/questions/`, the answer is `src/app/_actions/questions.ts`, and the answer goes out as an ordinary direct message so no turn is left blocked |
| `src/transcripts/` | Agents' uploaded session transcripts: the upload schema and limits, the store, the retention sweep, and the conversation view that merges a transcript with the agent's direct-message thread |
| `src/credentials/` | Each person's virtual-agent credentials (GitHub token, Azure token cache, Claude token, Jenkins API token, Atlassian `twg` sign-in), their CLAUDE.md (`claude_md`, with its default and limits in `claude-md.ts`) and their optional git identity override (`git_identity`, JSON `{name, email}`, checked in `git-identity.ts`): the value checks, the Key Vault store, the local encrypted store for development and tests, which of the two a process uses, and the metadata rows. Write-only for people except the CLAUDE.md and the git identity, which their owner reads back through `GET /api/agent/credentials/{kind}` (`canOwnerReadCredential`); the owner's own virtual agent reads any kind through `/api/virtual/{id}/credentials/{kind}`, which gives the default CLAUDE.md when none is stored; a pod cannot store a CLAUDE.md or git identity |
| `src/virtual-agents/` | Virtual agents: the feature flag and sweep settings, the lifecycle transition table, the per-person limits and name rule, launch tokens (minted, hashed, compared), the plugins `VIRTUAL_AGENT_PLUGINS` offers, the store (create, rename, size, plugins, reported ports, desired state, claims, observations, apply errors, pod reports), sign-ins relayed to the owner and their sealed pasted codes, the owner's request for the Azure sign-in, which a pod relays only when asked, the sweep's clock rules and the sweep itself, and the views: what anyone who may see one gets, and the rest its owner does. Its page is `/hub/agents/{id}`, the same as every agent's |
| `src/assistant/`, `src/app/assistant/`, `src/components/assistant/` | The HMCTS Assistant: the products, starters, theme and the cookie that remembers a getting-ready screen sent away, the virtual agent it runs on (each person's first) and its conversations, each with a pre-created agent its pod's session adopts, a wake for the pod's sessions stream and a versioned markdown document, which its session can export once to a Jira backlog (`jira.ts`, `jira-store.ts`) and once as a new Confluence page (`confluence.ts`, `confluence-store.ts`) with `twg` and its owner's sign-in, to a project or parent page the person finds by searching their own Jira or Confluence through their pod without a model turn (`lookups.ts`, `lookup-store.ts`, `POST /api/ui/assistant/lookups`, the sessions stream's `lookup` frame) and starts from their own defaults (`assistant_export_default`, `export-defaults.ts`, `export-default-store.ts`); the files a person attaches to a message (the caps, the part size and the refusal reasons the composer words in `uploads.ts`, the bytes-in-Postgres store, the one body reader that reads bytes rather than text, and the sweep that is both the backstop for the pod's fetched report and what removes a conversation attaching a file on the new-chat screen opened and nobody sent); the read-only shares of a conversation (`shares.ts` loads them and makes the two writes; `sharing.ts` is what a recipient's page may see, with the thread cut back to its words); the offers of a conversation to be forked, which let the person named read it as a share does and take their own copy into their own Assistant (`assistant_conversation_fork`; `forks.ts` holds the copied thread, its cap and the context file, all pure; `fork-store.ts` makes the offers and the copy, and attaches the copied turns to the first message sent in the copy as a file, which is how its new session gets them); the search over the viewer's own chats, by a word in a title or in anything said in one, through the full-text index of `20261027120000_assistant_search` (`search.ts` holds the terms, the snippet and the check that nothing else comes back, all pure; the query is in `store.ts`); the Claude model a person's chats run on — one setting each, for every chat (`models.ts`, pure: the catalogue of Sonnet and Opus, whose ids are the bare family aliases hai pins the version of, so nothing here names one; `model-store.ts` is the row, the refusal, the read every wake and every frame carries, and the read the settings' Model section takes, which says whether the pod claims `model-alias` and so can act on the choice before it next starts); the plain-language thread, the date groups and the getting-ready progress (pure); each person's own saved prompts (`assistant_template`, with the caps, the checks and every refusal in `templates.ts` and the store in `template-store.ts`), offered above the built-in `TEMPLATES` wherever the composer offers those; what its pod reports about its own memory (`memory-report.ts` holds the figures, the three "we cannot tell" states and the warning threshold — one conversation's worth of headroom under the limit — all pure, as is `chatCapacity`, which gives the chats the pod itself reported and never the size's cap as what a pod runs now, because a running pod keeps the cap it booted with; `memory.ts` is the store and the Size section's read); its settings dialog, which holds the appearance, the person's sign-ins, their team tools, the model their chats run on, their own CLAUDE.md, those saved prompts, their Jira and Confluence defaults and the size of the virtual agent it runs on, the CLAUDE.md being the `claude_md` credential the virtual agents page edits rather than a second value and the size being the same `setVirtualAgentSize` that page posts to; and its full-screen pages at `/assistant`, which `/` sends people to, beside the hub's own under `/hub` |
| `src/port-viewer/` | The viewer: virtual agents' web servers served off the VPN on `AGENT_HUB_VIEWER_HOST`, a host of its own. The proxy rewrites every request on that host to `src/app/viewer-proxy/` and refuses that route on any other; the hub's `/hub/virtual/{id}/ports/{port}` hands the owner a ticket. Its settings, paths, sealed tickets and cookies, header rewriting, forwarding, and the request handling the two routes call |
| `src/realtime/` | `hub_events` NOTIFY payloads, the per-pod LISTEN connection and in-process hub, SSE framing, the agent stream |
| `src/orchestrator/`, `src/cli/orchestrator.ts` | The virtual-agent orchestrator, run from the same image in the preview cluster: its settings, its one structured logger, a minimal in-cluster Kubernetes client, the hub client, the StatefulSet, Service and Ingress it applies (pure), one reconcile pass with the orphan sweep, the health server, and the loop. Nothing here uses the `@/` alias |
| `src/store/` | Prisma singleton, `DATABASE_URL` assembly, the boot-time migrator |
| `prisma/migrations/` | Hand-written SQL, applied by `src/store/migrate.ts` before the server starts. `schema.prisma` mirrors it for the client |

## Conventions

- **Feature folders, not type folders. No `utils/`, `helpers/` or `common/`.** A shared function lives with the feature
  that owns it.
- **Functions, not classes.** The only classes are `Error` subclasses. Pass state in; process-wide singletons (the
  Prisma client, the realtime hub) live on `globalThis`, because Next builds `instrumentation.ts` and the route
  handlers as separate module graphs.
- **ESM with explicit `.ts` extensions** on relative imports outside `src/app/`. Anything reachable from `src/cli/` must
  not use the `@/` alias: `tsc -p tsconfig.cli.json` emits it for Node to run directly.
- **Nothing imports `store/prisma.ts` before the Key Vault secrets load.** It resolves `POSTGRES_*` at module load;
  `instrumentation-node.ts` and `cli/migrate.ts` import it dynamically for that reason.
- **Access decisions go through `src/access/rules.ts`.** A route that decides who may see or message an agent inline
  is a rule that is not tested. Every `/api/agent/{agent_id}/…` handler uses `ownedAgentRoute`.
- **Every write that other pods must hear about calls `notify` inside its transaction**, so the NOTIFY is delivered on
  commit and never for a rollback.
- **Schema changes are a new directory under `prisma/migrations/`** with hand-written SQL, plus the matching change to
  `schema.prisma`. Never edit an applied migration: its checksum is in the ledger. Table names are singular; `"user"`
  is quoted everywhere because it is reserved.
- **Dependencies are pinned exactly**, with no `^` or `~`, at the same versions as dtsse-github-metrics where both use
  a package.
- **Never a bare `.sort()`.** Pass a comparator; strings sort by code point.
- **Comments say why**, state the current rule rather than its history, and are changed with the behaviour they
  describe.
- **Tests are named `should <behaviour> when <condition>`.** Unit tests sit beside the code as `<name>.test.ts`;
  tests that need Postgres live in `test/integration/`.

## Gates

| Command | What it is |
| --- | --- |
| `yarn db:generate` | Generates the Prisma client into `src/store/generated/`; typecheck fails without it |
| `yarn lint` | `biome check --error-on-warnings .` |
| `yarn typecheck` | the app, `tsconfig.cli.json` and `tsconfig.e2e.json` |
| `yarn test:e2e` | Playwright and axe against `TEST_URL`; see the README for a full local run |
| `yarn test` | unit suite |
| `yarn test:integration` | needs `yarn deps:up`; a database per worker, migrated on use. `INTEGRATION_WORKERS` sets how many (default 6) |
| `yarn build` | `next build` plus the CLIs, `dist/cli/migrate.js` and `dist/cli/orchestrator.js` |

`yarn lint` checks nothing inside a worktree under `.claude/worktrees/`, because `biome.json` excludes that path. Run
`yarn biome check src test packages` there instead — `packages` as well, or the published client goes unchecked.

## Charts

Any change to `charts/dtsse-agent-hub/values.yaml` needs `Chart.yaml`'s `version` bumped in the same commit, or Flux
will not pick it up. Memory and CPU are set twice, as `memory*`/`cpu*` and `devmemory*`/`devcpu*`; keep both in step.
