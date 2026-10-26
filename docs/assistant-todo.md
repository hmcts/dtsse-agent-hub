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
  - a fifth queues on `small`;
  - a reopened chat resumes the same session id;
  - `scripts/agent-hub artefact put` updates the panel live.
- [x] Check memory and CPU with several sessions running at once. **A conversation costs about 0.65Gi, and what caps a pod is its resource requests rather than its limits.**

  Measured in the preview cluster on 2026-10-26 by **proportional set size (PSS)**, read per process from `/proc/<pid>/smaps_rollup`, with the cgroup's own `/sys/fs/cgroup/memory.{current,peak,stat}` and `cpu.stat` as the totals. **PSS, not RSS**: a session is twenty-odd node processes sharing one node binary and their `node_modules` pages, and ΣRSS counts those pages once per process — it is where the old 1.2Gi came from, and it is nearly double the truth. Do not redo this with RSS. Per-process `Anonymous:` summed to within 0.3% of the cgroup's `memory.stat` `anon`, which is what makes the subtraction below trustworthy.

  Of 28 pods, 10 ran `hmctsprod.azurecr.io/dtsse/virtual-agent` and 18 the pre-switch `cft-workspace/devcontainer`; 26 of the 28 were idle at the boot script alone (6–10 MiB) and gave only the stopped baseline. **Every one of the 28 was `small`** — `memory.max` 8Gi, `cpu.max` 4 — so no figure here is measured on `medium` or `large`. The marginal comes from `va-d5bcb7af-0`, a `small` pod on the devcontainer image, sampled four minutes apart as it went from two sessions to one — the same pod, owner and MCP set, so nothing but the session differs:

  | route | marginal per conversation |
  | --- | --- |
  | cgroup `memory.stat` `anon` subtraction | **0.64Gi** |
  | Σ PSS subtraction | 0.68Gi |
  | `memory.current` subtraction | 0.69Gi |
  | Σ RSS subtraction | 1.25Gi ← where 1.2Gi came from |

  `CONVERSATION_MEMORY_BYTES` is **0.65Gi** on the `anon` figure, because `anon` is the part the kernel cannot reclaim and it is the only one of the four that is purely additive. Page cache was 2.1–2.4Gi on both awake pods — the 6.8GiB workspace clone, not the sessions — and moved only 0.03Gi per conversation, so the margin is the same whichever currency the comparison is in even though the level is not.

  An awake pod with no conversations holds **0.95Gi** of `anon`: its own session 0.71–0.79Gi, the three agent-hub daemons 0.18–0.20Gi, entrypoint and tmux 0.012Gi. That is the mean of 15 samples of the two awake pods taken four minutes apart over 35 minutes, range 0.91–0.99Gi — so the baseline is firm even though the marginal rests on the one transition. A session splits 52% MCP servers and their wrappers, 30% `claude`, 19% bridge and `hai`.

  **MCP servers share far less between sessions than it looks.** When the second session exited, the survivor's PSS *rose* 113 MiB while its `anon` did not move: that 113 MiB is what the two had been splitting, so about 14% of a session is genuinely shared and 86% is not. 80% of the MCP footprint is private heap — each session spawns its own playwright-mcp, azmcp and mcp-jenkins with heaps of their own, and only binary and library pages are common.
- [x] **CPU was measured and the quota taken off.** Measured CPU: 25–30m per idle session, 139–186m mean over a working 150s window, and **a single session on its own was throttled against `small`'s then four-CPU limit** (26 periods of a 30s window at 568m mean; 0% on all 26 idle pods). A CFS quota is CPU-seconds per 100ms period and every one of those figures is a mean over seconds, so they cannot size a quota — a session averaging 568m was throttled against 4000m. Since throttling costs latency and has no OOM-kill equivalent, **no size has a CPU limit now**; the request carries the reasoning, because it is what a pod is guaranteed under contention and what its bursts borrow above. Admission permits it: 2237 of the 6640 containers running in `cft-preview-00-aks` have no CPU limit, Postgres StatefulSets in `civil`, `ccd`, `pcs` and `wa` among them.
- [x] **Caps raised against the requests: `small` 3 → 4, `medium` 4 → 6, `large` 7 → 8.** The hard constraint is memory, read at the size's **request** because a pod over it is an eviction candidate under node pressure: a cap of N costs 0.95 + 0.65N Gi, so `small` is bound at 4 — 3.55Gi of 4Gi, a fifth chat being 4.20Gi. CPU is a convention rather than a constraint now there is no quota, keeping (N + 1) × 186m inside the request as a check on a pod contending with its own guarantee while merely working; that it also lands on 4 for `small` is a coincidence of the two formulas. `medium` and `large` are bound by neither: memory would hold 10 and 23, the CPU convention 9 and 20.
- [x] **A raised cap does not reach a running pod, so nothing shown to a person comes from the constant.** `CONVERSATION_SESSIONS` is baked into the pod template as `AGENT_HUB_MAX_SESSIONS`, and the claim query selects on `generation > observed_generation`, so a deploy claims no already-observed running agent and every live pod keeps the cap it booted with. At its cap the supervisor stops the least recently active idle session rather than queueing, so a higher figure on screen would invite someone to end a chat they never closed. `reportSessions` now keeps the `max` the pod already sends with every report (new `virtual_agent.sessions_max`), and `chatCapacity` reads it. A pod that has not reported gets **no current figure at all** rather than the constant as a fallback: the hub cannot see a pod's supervisor, so the cap is what the pod will be given and not what it was given. `sizeSentence` is sayable without it, naming only what the pod holds from its next restart.
- [ ] **What binds `medium` and `large` is the evidence, not a resource.** Nothing above two concurrent sessions has been measured, and the burst figure is of one session alone, so 6 and 8 sit at 65% and 42% of their CPU requests at the working mean. Raising them needs a pod driven deliberately with its full complement busy at once rather than sampled.
- [x] **`small` does not get more memory.** It stays on 1 CPU / 4Gi requested: someone who needs more conversations at once moves up a size, rather than every `small` pod costing more. That 4Gi request is what fixes its cap at 4 — 4 conversations hold 3.55Gi of `anon` inside it and a fifth would be 4.20Gi outside it.
- [ ] **The warning cannot fire from a person's chats, at any size.** It is `memory.current + CONVERSATION_MEMORY_BYTES > limit`, so the thresholds are 7.35Gi of 8 on `small`, 15.35 of 16 on `medium` and 31.35 of 32 on `large`. A pod at its cap settles near 6.2Gi, 7.5Gi and 8.8Gi — short by 1.2Gi on `small` and by 22.6Gi on `large`. What actually trips it is page cache, which was 2.1–2.4Gi of the workspace clone on both awake pods, or the pod's own non-session work. `memoryAdvice` is worded for that: it says what was measured and what each remedy frees, and does **not** name chats as the cause. Making the warning mean what it says needs a figure for the part the kernel cannot reclaim, which the pod's three cgroup reads do not include — a fourth, `anon`, and a client feature to gate it, which is a contract and client change.
- [ ] Tell Linus's `move-agent-hub-client` session what changed: `assistant.mjs` and the `artefact` commands still need absorbing into `packages/agent-hub`, there is no `AGENT_HUB_VIRTUAL_MODE` now, and `entrypoint.sh` always starts the supervisor.

## Rollout

- [ ] **Merge the cft-workspace PR first.** Pods clone workspace `master` when they boot, so from then on every pod runs the supervisor. Until the hub has the sessions route, the supervisor gets 404s and keeps retrying, which is harmless.
- [ ] **Then merge the hub PR.** The Assistant has no flag of its own. It appears wherever `VIRTUAL_AGENTS_ENABLED` is on, including AAT, as soon as the hub deploys, so the pod side must already be live.
- [ ] Decide who gets the Assistant. Today anyone signed in can open it. Should it be the default home for some people, chosen by role?
- [ ] Move what the hub's virtual-agent pages do into the Assistant (start and stop, ports, git identity), then remove those pages from the hub. Size is done: the Assistant's settings has a Size section, which posts to the same `resizeVirtualAgent` the agent page does, and says what replacing the pod ends before the person commits. Plugins, sign-ins and CLAUDE.md were already there.
- [x] **Tell people when their assistant is low on memory.** The pod reports its own cgroup (`PUT /api/virtual/{id}/memory`, gated on the `memory` client feature) and the Size section warns once the live figure leaves less than one conversation's worth of headroom under the limit — the warning names the two things that answer it, move up a size or close a chat, and rides on the settings cog's existing mark rather than a second badge. It is computed from `memory.current` and not `memory.peak`, because nothing resets the peak while the pod lives: a warning on it could never be cleared by the chat-closing it asks for. Still to do is above — the cost is the `small` figure applied to every size, and the threshold is not reachable by opening chats.

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
