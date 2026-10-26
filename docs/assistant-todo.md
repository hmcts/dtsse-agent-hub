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
- [x] Check memory and CPU with several sessions running at once. **A conversation costs about 0.65Gi, and CPU rather than memory is what caps a pod.**

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
- [x] **CPU binds every size; memory binds none.** `small` at 3 is 2.90Gi of `anon` against the 4Gi it **requests** — so contrary to the earlier RSS figure, no size exceeds its request at its cap and no pod is an eviction candidate for holding its full complement of chats. Measured CPU: 25–30m per idle session, 139–186m mean over a working 150s window, and **a single session on its own was throttled against `small`'s four-CPU limit** (26 periods of a 30s window at 568m mean; 0% on all 26 idle pods). So a session's bursts already want more than four CPUs and extra sessions buy contention, not throughput. `small` and `medium` share that four-CPU limit and neither can be raised on it; `medium`'s larger request guarantees two CPUs rather than one, a better floor under node pressure and not a higher ceiling. `large`'s limit is eight, so its cap went 6 → **7** against the limits as they stand here — eight sessions on eight CPUs, the same CPU per session as the `small` 3 that production accepts. Raise a limit and that parity moves with it.
- [ ] **Raising capacity further needs higher CPU limits, not a bigger memory size.** Memory at a cap is `(0.95Gi + cap × 0.65Gi) / limit`, which is well under half at every size and cap in use. The missing measurement is several *busy* sessions in parallel on one pod, which needs a pod driven deliberately rather than sampled.
- [ ] **The warning has never been exercised at an `anon` a chat workload produces, because no such pod exists.** Every passing demonstration of it, in all three suites, sets `anon` at or within a byte of the limit — a pod being OOM-killed. That is the condition the rule detects and the wording now describes, so the tests are honest about what they pin; what nobody has seen is the rule's behaviour anywhere between what a full pod holds (`0.95Gi + cap × 0.65Gi`) and the `limit − 0.65Gi` it takes to fire, because the caps keep chats inside the request and the threshold sits a conversation under the limit whatever the caps are. Closing this needs a pod driven to a few gigabytes of non-reclaimable memory on purpose — a build or a leak, not chats — and until someone does, the only measured points are "a pod at its cap, silent" and "a pod at its ceiling, warning".
- [x] **The warning is computed from the part that cannot be reclaimed.** `memory.current` and `memory.peak` both count page cache, and a pod that has read the 6.8GiB clone holds 2.1–2.4Gi of it; cache is reclaimed at the `memory.max` watermark rather than given back, so either figure sits near the limit whatever the pod is holding. A threshold on either was crossed by file reads and not by chats: a pod at its cap settles at `anon` + 2.1–2.4Gi of cache + about 0.15Gi of kernel, which at every size and cap in use is gigabytes short of `limit − 0.65Gi` — so the sentence was false exactly when it appeared. The pod now sends `anon_bytes` from `memory.stat` as a fourth required figure, gated by a new `memory-anon` client feature so a client from before it is shown as an older version rather than a pod gone quiet, and the rule is `anon + CONVERSATION_MEMORY_BYTES > limit`. That is the figure the constant was measured as and the only one a headroom question can be asked of at all. What the rule detects is a pod heading for an OOM kill on memory the kernel cannot give back, and what gets it there is the **work inside** a chat rather than the number of them: 0.65Gi is what a session settles at, not a ceiling, and a build or a leak can put one gigabytes above it. A pod full of chats cannot reach the threshold at any size or cap — the caps keep chats inside the memory *request*, the threshold sits a conversation under the *limit*, and the chats it would take depends only on the limit and the two constants, so raising a cap moves the figures closer and changes nothing. If `0.95 + 0.65N` held without exception the warning could never fire; the exception is work. The wording follows that, and the item above records what is consequently untested.
- [x] **The report cadence follows the figure.** A session starting or ending steps `anon` by about one conversation, and between those steps it was flat for the work measured — 15 samples of a working pod held within 3%, where `current` and `peak` moved several times that — so the pod reports on every change in its session count as well as every 10-minute reconcile. An unconditioned 10-minute sample is a poor instrument for a figure that moves in steps, and would have left the warning describing a pod the person had already changed. That flatness is **not** a claim that nothing else moves `anon`: heavier work inside a session does, which is the case the warning exists for, and the 10-minute reconcile is what catches it.
- [x] **`small` does not get more memory.** It stays on 1 CPU / 4Gi requested: someone who needs more conversations at once moves up a size, rather than every `small` pod costing more. The cap is 3 because of the four-CPU limit, not memory — on the measured figures 3 conversations hold 2.90Gi of `anon`, inside that 4Gi request.
- [ ] Tell Linus's `move-agent-hub-client` session what changed: `assistant.mjs` and the `artefact` commands still need absorbing into `packages/agent-hub`, there is no `AGENT_HUB_VIRTUAL_MODE` now, and `entrypoint.sh` always starts the supervisor.

## Rollout

- [ ] **Merge the cft-workspace PR first.** Pods clone workspace `master` when they boot, so from then on every pod runs the supervisor. Until the hub has the sessions route, the supervisor gets 404s and keeps retrying, which is harmless.
- [ ] **Then merge the hub PR.** The Assistant has no flag of its own. It appears wherever `VIRTUAL_AGENTS_ENABLED` is on, including AAT, as soon as the hub deploys, so the pod side must already be live.
- [ ] Decide who gets the Assistant. Today anyone signed in can open it. Should it be the default home for some people, chosen by role?
- [ ] Move what the hub's virtual-agent pages do into the Assistant (start and stop, ports, git identity), then remove those pages from the hub. Size is done: the Assistant's settings has a Size section, which posts to the same `resizeVirtualAgent` the agent page does, and says what replacing the pod ends before the person commits. Plugins, sign-ins and CLAUDE.md were already there.
- [x] **Tell people when their assistant is low on memory.** The pod reports its own cgroup (`PUT /api/virtual/{id}/memory`, gated on the `memory-anon` client feature) and the Size section warns once the part that cannot be reclaimed leaves less than one conversation's worth of headroom under the limit, and rides on the settings cog's existing mark rather than a second badge. The remedy it offers is a bigger size; it gives what closing a chat would free as a figure rather than as a fix, because chats are not what gets a pod there, and leaves that out when no chat is open. On the largest size there is no bigger size to offer, so it says so. A stopped pod is not warned about at all, though its last report is still shown, and a replaced pod's report is dropped along with its launch token so the next pod cannot show it. Why `anon` rather than the live figure or the peak is above. Still open: the cost is the `small` figure applied to every size.

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
