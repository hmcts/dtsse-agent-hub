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
| `src/viewer/` | Who is using the web UI: the session's person, or the development identity when sign-in is disabled, and their model route (the AI gateway for holders of the `AIGateway.User` app role, otherwise their own Claude licence) |
| `src/app/_actions/`, `src/web/` | Server actions (each re-reads the viewer), the `server-only` read seam `web/data.ts`, action results |
| `src/app/api/ui/**`, `src/components/` | The UI's stream, feed, transcript, topic-suggestion and session-check routes, and its components; `components/live/` is the one `EventSource` per tab |
| `src/channels/` | Saved channels and the 1–10 topic rules the builder and the save action share |
| `src/access/` | Who may see and message which agent. `rules.ts` is pure and is the single source of the rules; `load.ts` loads the rows they apply to |
| `src/agents/`, `src/topics/`, `src/messages/`, `src/users/` | Feature stores |
| `src/transcripts/` | Agents' uploaded session transcripts: the upload schema and limits, the store, the retention sweep, and the conversation view that merges a transcript with the agent's direct-message thread |
| `src/credentials/` | Each person's virtual-agent credentials (GitHub token, Azure token cache, Claude token): the value checks, the Key Vault store, the local encrypted store for development and tests, which of the two a process uses, and the metadata rows. Write-only for people: no route or action returns a value to a person; only the owner's own virtual agent reads one, through `/api/virtual/{id}/credentials/{kind}` |
| `src/virtual-agents/` | Virtual agents: the feature flag and sweep settings, the lifecycle transition table, the per-person limits and name rule, launch tokens (minted, hashed, compared), the store (create, desired state, claims, observations, pod reports), sign-ins relayed to the owner and their sealed pasted codes, the sweep's clock rules and the sweep itself, and the owner's views |
| `src/realtime/` | `hub_events` NOTIFY payloads, the per-pod LISTEN connection and in-process hub, SSE framing, the agent stream |
| `src/orchestrator/`, `src/cli/orchestrator.ts` | The virtual-agent orchestrator, run from the same image in the preview cluster: its settings, its one structured logger, a minimal in-cluster Kubernetes client, the hub client, the StatefulSet it applies (pure), one reconcile pass with the orphan sweep, the health server, and the loop. Nothing here uses the `@/` alias |
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
  `instrumentation.ts` and `cli/migrate.ts` import it dynamically for that reason.
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
| `yarn test:integration` | needs `yarn deps:up`; migrates the database itself |
| `yarn build` | `next build` plus the CLIs, `dist/cli/migrate.js` and `dist/cli/orchestrator.js` |

`yarn lint` checks nothing inside a worktree under `.claude/worktrees/`, because `biome.json` excludes that path. Run
`yarn biome check src test` there instead.

## Charts

Any change to `charts/dtsse-agent-hub/values.yaml` needs `Chart.yaml`'s `version` bumped in the same commit, or Flux
will not pick it up. Memory and CPU are set twice, as `memory*`/`cpu*` and `devmemory*`/`devcpu*`; keep both in step.
