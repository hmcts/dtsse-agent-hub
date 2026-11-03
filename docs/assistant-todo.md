# CFT Workspace: to-do

What is still open for the CFT Workspace (`/assistant`). Delete this file once everything below is done or has moved
to Jira.

## Testing

- [ ] **A Playwright spec for a chat.** `test/e2e/tests/assistant.spec.ts` checks only the message box's height on a
  phone. It should stand in for the orchestrator (`X-Dev-Orchestrator`) and the pod (launch-token calls) and cover the
  getting-ready screen, then a starter, the typing indicator and the reply; an assistant-written document opening the
  panel; an edit conflict; and a product change, with the axe pass.
- [ ] **Try it in a real pod in preview**, with `AGENT_HUB_SESSION_IDLE_MINUTES=1` to see sessions stop. Check that
  two chats run two `c-*` sessions, a reopened chat resumes the same session id, a chat past the cap stops the least
  recently active idle session (or queues when every session is busy), and `agent-hub artefact put` updates the panel
  live.

## Capacity

The measurements and the reasoning are in [`virtual-agent-memory.md`](virtual-agent-memory.md).

- [ ] **Measure `medium` and `large`.** Their caps rest on `small` evidence: no pod has been measured above two
  concurrent sessions. Drive a pod with its full complement busy at once.
- [ ] **Exercise the memory warning on a real workload.** Every test that shows it firing sets `anon` at the limit.
  Nobody has seen the rule between a full pod's `0.95Gi + cap × 0.65Gi` and the `limit − 0.65Gi` it fires at; that
  needs a pod driven to a few gigabytes of non-reclaimable memory by a build or a leak.
- [ ] **The per-conversation cost is the `small` figure applied to every size.**

## Product

- [ ] **Decide who gets the Assistant.** Anyone signed in can open it. Should it be the default home for some people,
  chosen by role?
- [ ] **Model access for non-technical users.** People on their own licence still paste a Claude code; people on the
  gateway paste nothing. Look at provisioning the model without a paste at all.
- [ ] **GitHub is required**, because the pod clones the workspace with it. Consider an anonymous clone so that GitHub
  becomes optional.
- [ ] **Team templates.** A person can save their own prompts; the starters (`src/assistant/starters.ts`) are static.
  Should teams have their own?

## Polish

- [ ] **Markdown.** `src/messages/markup.ts` has no blockquotes or horizontal rules, so they show as raw text in
  answers and documents.
- [ ] **Fonts.** IBM Plex is used only where it is installed; nothing loads it. Bundle the font files if the design
  needs them everywhere.
- [ ] **Product chip.** The header's chip draws its own label and arrow over a native `<select>`
  (`ProductSelect.tsx`), so the open list is still the browser's. A custom listbox would style that too.
- [ ] **`/clear` in a session.** A `/clear` moves the conversation to the new session id, but the supervisor still
  tracks idleness by the id it started. A person cannot send `/clear` from the Assistant, so this only matters if that
  changes.
