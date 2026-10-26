# HMCTS Assistant: to-do

The HMCTS Assistant (`/assistant`) is built across two repositories, each on a branch named `feat/hmcts-assistant`:

- **`hmcts/dtsse-agent-hub`** (this repo): the UI, the stores, the routes and the contract (`docs/agent-api.md`, Conversations).
- **`hmcts/cft-workspace`**: the pod side. That's the supervisor (`scripts/lib/agent-hub/assistant.mjs`), which every virtual agent's pod runs beside its own session (`.devcontainer/virtual-agent/entrypoint.sh`), the `artefact` CLI, the conversation envelope and `assistant-prompt.md`.

There is no separate kind of "assistant" agent: the Assistant is an interface to the person's first virtual agent. The plan is for it to replace the hub's virtual-agent pages, leaving the hub as the background comms layer.

Delete this file once everything below is done or has moved to Jira.

## Before release

- [ ] Raise a Jira ticket and prefix both commits and PRs with it, as the repo's other commits are (`VIBE-…`).
- [ ] Open both PRs and link each to the other. Review them together: they implement one contract.
- [ ] Write the Playwright spec `test/e2e/tests/assistant.spec.ts` (`@regression`, plus the axe pass), modelled on `virtual-agents.spec.ts`. It should stand in for the orchestrator (`X-Dev-Orchestrator`) and the pod (launch-token calls) and cover:
  - the getting-ready screen, then a starter, the typing indicator and the reply;
  - an assistant-written document opening the panel;
  - an edit conflict;
  - a product change.
- [ ] Try it in a real pod in preview, with `AGENT_HUB_SESSION_IDLE_MINUTES=1` to see sessions stop. Check that:
  - two chats run two `c-*` sessions;
  - a fourth queues on `small`;
  - a reopened chat resumes the same session id;
  - `scripts/agent-hub artefact put` updates the panel live.
- [x] Check memory and CPU with several sessions running at once. Measured on a running `small` pod: three sessions, the pod's own included, hold 4.1Gi of its 8Gi cgroup limit at 314m of CPU, so a session with its MCP servers, hai wrapper and bridge costs about 1.2Gi and about 100m idle. `small`'s cap is 3 on that basis (`CONVERSATION_SESSIONS` in `src/orchestrator/manifests.ts`), which leaves a third of the limit free. Still to do on `medium` and `large`, and with the sessions busy rather than idle, which is what raising either of their caps wants.
- [x] **`small` does not get more memory.** It stays on 1 CPU / 4Gi requested: someone who needs more conversations at once moves up a size, rather than every `small` pod costing more. That is why the cap is 3 and not higher — three plus the pod's own fits the 8Gi limit with headroom, where five would have crowded it at about 7.5Gi.
- [ ] Tell Linus's `move-agent-hub-client` session what changed: `assistant.mjs` and the `artefact` commands still need absorbing into `packages/agent-hub`, there is no `AGENT_HUB_VIRTUAL_MODE` now, and `entrypoint.sh` always starts the supervisor.

## Rollout

- [ ] **Merge the cft-workspace PR first.** Pods clone workspace `master` when they boot, so from then on every pod runs the supervisor. Until the hub has the sessions route, the supervisor gets 404s and keeps retrying, which is harmless.
- [ ] **Then merge the hub PR.** The Assistant has no flag of its own. It appears wherever `VIRTUAL_AGENTS_ENABLED` is on, including AAT, as soon as the hub deploys, so the pod side must already be live.
- [ ] Decide who gets the Assistant. Today anyone signed in can open it. Should it be the default home for some people, chosen by role?
- [ ] Move what the hub's virtual-agent pages do into the Assistant (start and stop, size, plugins, ports, sign-ins, CLAUDE.md, git identity), then remove those pages from the hub.

## Gaps in v1

- [ ] **Model access for non-technical users.** People on Bedrock still paste an API key, and people on their own licence still paste a Claude code. Look at provisioning the model without either.
- [ ] **GitHub is required**, because `boot.sh` clones the workspace with it. Consider an anonymous clone so that GitHub becomes optional.
- [ ] **Markdown.** `src/messages/markup.ts` has no tables, blockquotes or horizontal rules, so they show as raw text in answers and documents.
- [ ] **File upload** (the prototype's "Upload file") was out of scope. It needs storage the pod can read.
- [ ] **Fonts.** IBM Plex is used only where it's installed; nothing loads it. Bundle the font files under `public/` if the design needs them everywhere.
- [ ] **Product chip.** The header's chip draws its own label and arrow over a native `<select>`, because a native one takes the width of its widest option. What is still the browser's is the open list; a custom listbox would style that too, and is the only part of this left.
- [ ] **`/clear` in a session.** A `/clear` moves the conversation to the new session id, but the supervisor still tracks idleness by the id it started. A person can't send `/clear` from the Assistant, so this only matters if that changes.
- [ ] **Templates and starters** are static (`src/assistant/starters.ts`). Should teams have their own?
- [ ] **Agent status leak.** `agent_status` events for a conversation's agent reach the owner's grantees' streams (id and status only, nothing else). Filter them out if that matters.
