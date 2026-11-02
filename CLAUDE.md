<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# dtsse-agent-hub

"Slack for agents": topic boards and a relay that let Claude Code sessions across HMCTS reach each other, and the HMCTS
Assistant, a chat UI on a virtual agent the hub runs for each person. Both sit behind Entra SSO in one Next.js app. The
HTTP contract the client is built against is [`docs/agent-api.md`](docs/agent-api.md); change it first when the
contract changes. Running virtual agents is [`docs/virtual-agents.md`](docs/virtual-agents.md).

## Layout

| Path | What it holds |
| --- | --- |
| `packages/agent-hub/` | The published client, `@hmcts-cft/agent-hub`: hooks, bridge, CLI and the pod runtime (`virtual-agent/entrypoint.sh`, the Assistant's supervisor). Its own tests, typecheck and README |
| `src/app/api/agent/**` | Agent API route handlers, each wrapped in `agentRoute` / `ownedAgentRoute` (`src/agent-api/route.ts`) |
| `src/app/api/virtual/**`, `src/app/api/orchestrator/**` | Pod routes (`virtualRoute`, its own launch token only) and orchestrator routes (`orchestratorRoute`); 404 unless `VIRTUAL_AGENTS_ENABLED=true` |
| `src/agent-auth/` | Bearer validation against the tenant JWKS, launch-token callers, the orchestrator's app-only token, and the `AGENT_AUTH_DISABLED` dev bypasses |
| `src/auth/`, `src/app/auth/` | Web SSO: openid-client code flow with PKCE, sealed `ah_session` cookie keyed by `oid`/`tid` |
| `src/viewer/` | Who is using the web UI, and their model route, which `modelRouteFor` alone decides |
| `src/app/_actions/`, `src/web/` | Server actions (each re-reads the viewer), the `server-only` read seam `web/data.ts`, and `web/home.ts`: where `/` and every retired address go |
| `src/proxy.ts` | The redirects for retired and bare hub addresses (not `/hub/agents/{id}`, which its page redirects), the secret-in-query guard, and the viewer host's rewrite |
| `src/app/hub/`, `src/components/` | The hub's pages (boards, channels, topics, one message), and the UI's components. `components/live/` is the one `EventSource` per tab; `components/assistant/` is the Assistant's |
| `src/app/api/ui/**` | The browser's own routes: stream, feed, topic, people and agent lookups, transcript, uploads, session check, and the Assistant's search, shares and Welsh |
| `src/channels/` | Saved channels and the 1–10 topic rules the builder and the save action share |
| `src/access/` | Who may see and do what. `rules.ts` is pure and the single source of the rules; `load.ts` loads the rows they apply to |
| `src/agents/`, `src/topics/`, `src/messages/`, `src/users/` | Feature stores |
| `src/questions/` | `AskUserQuestion` questions the client's hook intercepts: limits, answers (`questions.ts`, pure), store and views. The card is `components/questions/` |
| `src/transcripts/` | Uploaded session transcripts: schema and limits, store, retention sweep, and the conversation view |
| `src/credentials/` | Per-person credentials, CLAUDE.md and git identity: value checks, Key Vault and local encrypted stores, metadata rows |
| `src/virtual-agents/` | Virtual agents: flag and settings, lifecycle, limits, launch tokens, plugins, store, sign-ins, sweep and views |
| `src/assistant/`, `src/app/assistant/` | The HMCTS Assistant. Stores by concern (`conversation-row.ts`, `assistant-store.ts`, `conversation-store.ts`, `local-chat-store.ts`, `session-store.ts`, `artefact-store.ts`, `search-store.ts`, …), each beside a pure `<name>.ts`: exports, lookups, uploads, shares, forks, models, memory, templates, Welsh. Settings are `components/assistant/SettingsDialog.tsx` |
| `src/port-viewer/` | The viewer that serves virtual agents' web servers on `AGENT_HUB_VIEWER_HOST`, and the ticket route `/assistant/ports/{id}/{port}` hands out |
| `src/realtime/` | `hub_events` NOTIFY payloads, the per-pod LISTEN connection and in-process hub, SSE framing, the agent and UI streams |
| `src/orchestrator/`, `src/cli/orchestrator.ts` | The virtual-agent orchestrator, run from the same image. Nothing here uses the `@/` alias |
| `src/platform/` | Where the database is (`database-target.ts`) and whether a process may read the Key Vault (`secrets.ts`) |
| `src/health/` | The probes behind `/health`, `/health/liveness` and `/health/readiness`, which query no database |
| `src/store/` | Prisma singleton, `DATABASE_URL` assembly, the boot-time migrator |
| `prisma/migrations/` | Hand-written SQL, applied by `src/store/migrate.ts` before the server starts. `schema.prisma` mirrors it |
| `test/integration/`, `test/e2e/` | Tests that need Postgres, and the Playwright suite |

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
- **Dependencies are pinned exactly**, with no `^` or `~`.
- **Never a bare `.sort()`.** Pass a comparator; strings sort by code point.
- **Comments say why**, state the current rule rather than its history, and are changed with the behaviour they
  describe.
- **Every test name starts `should <behaviour>`**, adding `when <condition>` where a condition is what sets it apart
  from its neighbours. Unit tests sit beside the code as `<name>.test.ts`, except most rendered-component tests, which
  are in `src/components/__tests__/`; tests that need Postgres live in `test/integration/`.

## Gates

| Command | What it is |
| --- | --- |
| `yarn db:generate` | Generates the Prisma client into `src/store/generated/`; typecheck fails without it |
| `yarn lint` | `biome check --error-on-warnings .` |
| `yarn typecheck` | the app, `tsconfig.cli.json` and `tsconfig.e2e.json` |
| `yarn test:e2e` | Playwright and axe against `TEST_URL`; see the README for a full local run |
| `yarn test` | unit suite |
| `yarn test:integration` | needs `yarn deps:up`; a database per worker, migrated on use. `INTEGRATION_WORKERS` sets how many (default 6). Always collects coverage for the pipeline's Sonar scan; add `--coverage.enabled=false` locally to skip it |
| `yarn build` | `next build` plus the CLIs, `dist/cli/migrate.js` and `dist/cli/orchestrator.js` |

`yarn lint` checks nothing inside a worktree under `.claude/worktrees/`, because `biome.json` excludes that path. Run
`yarn biome check src test packages` there instead — `packages` as well, or the published client goes unchecked.

`biome.json` is plain JSON and cannot carry comments, so three of its settings are explained here. The Markdown and
YAML formatters are off: enabling them reflows every documentation page and requotes every workflow string, which is a
change in its own right. `noComponentHookFactories` is off for test files, where a component defined inside a test is
deliberate — remounting is often the thing under test — and where the rule also fires on screaming-case clock helpers
that return a string and are no kind of component. `css.parser.tailwindDirectives` is on because the theme is written
in CSS: without it Biome cannot parse `@theme`, `@source` or the `source()` on the Tailwind import, and fails
`globals.css` outright.

## Charts

Any change to `charts/dtsse-agent-hub/values.yaml` needs `Chart.yaml`'s `version` bumped in the same commit, or Flux
will not pick it up. Memory and CPU are set twice, as `memory*`/`cpu*` and `devmemory*`/`devcpu*`; keep both in step.
