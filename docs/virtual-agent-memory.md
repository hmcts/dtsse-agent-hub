# Virtual agent memory and CPU

Why each size runs the number of CFT Workspace conversations it does, why no size has a CPU limit, and why the
memory warning is computed from `anon`. The rules themselves are in [`agent-api.md`](agent-api.md#conversations)
(Capacity) and [Memory in the pod](agent-api.md#memory-in-the-pod); this page is the evidence behind them.

## What was measured

Measured in the preview cluster on 2026-10-26 by **proportional set size (PSS)**, read per process from
`/proc/<pid>/smaps_rollup`, with the cgroup's own `/sys/fs/cgroup/memory.{current,peak,stat}` and `cpu.stat` as the
totals. Per-process `Anonymous:` summed to within 0.3% of the cgroup's `memory.stat` `anon`, which is what makes the
subtraction below trustworthy.

**PSS, never RSS.** A session is twenty-odd node processes sharing one node binary and their `node_modules` pages, and
ΣRSS counts those pages once per process. It puts the marginal at 1.25Gi, nearly double the truth. Do not redo this
with RSS.

Of 28 pods, 10 ran `hmctsprod.azurecr.io/dtsse/virtual-agent` and 18 the earlier `cft-workspace/devcontainer`; 26 of
the 28 were idle at the boot script alone (6–10 MiB) and gave only the stopped baseline. **Every one of the 28 was
`small`** (`memory.max` 8Gi, `cpu.max` 4), so no figure here is measured on `medium` or `large`.

### One conversation

The marginal comes from `va-d5bcb7af-0`, a `small` pod sampled four minutes apart as it went from two sessions to one:
the same pod, owner and MCP set, so nothing but the session differs. It is one transition read four ways, not four
measurements.

| Route | Marginal per conversation |
| --- | --- |
| cgroup `memory.stat` `anon` subtraction | **0.64Gi** |
| Σ PSS subtraction | 0.68Gi |
| `memory.current` subtraction | 0.69Gi |
| Σ RSS subtraction | 1.25Gi |

`CONVERSATION_MEMORY_BYTES` is **0.65Gi**, on the `anon` figure: `anon` is the part the kernel cannot reclaim, and it is
the only one of the four that is purely additive. Page cache was 2.1–2.4Gi on both awake pods, which is the 6.8GiB
workspace clone rather than the sessions, and it moved only 0.03Gi per conversation.

A session splits 52% MCP servers and their wrappers, 30% `claude`, and 19% bridge and `hai`. **MCP servers share far
less between sessions than it looks.** When the second session exited, the survivor's PSS rose 113 MiB while its
`anon` did not move: that 113 MiB is what the two had been splitting, so about 14% of a session is shared and 86% is
not. 80% of the MCP footprint is private heap, because each session spawns its own playwright-mcp, azmcp and
mcp-jenkins, and only binary and library pages are common.

### An awake pod with no conversations

**0.95Gi** of `anon` (`POD_BASELINE_MEMORY_BYTES`): its own session 0.71–0.79Gi, the three agent-hub daemons
0.18–0.20Gi, the entrypoint and tmux 0.012Gi. That is the mean of 15 samples of the two awake pods taken four minutes
apart over 35 minutes, ranging 0.91–0.99Gi, so the baseline is firm even though the marginal rests on one transition.
A cap of N conversations therefore costs `0.95 + 0.65N` Gi.

### CPU

25–30m per idle session, and 139–186m mean over a working 150-second window. A single session on its own averaged 568m
over its busiest 30 seconds and was throttled in 26 of that window's periods against `small`'s four-CPU quota at the
time, against none on all 26 idle pods.

## Why the caps are 4, 6 and 8

**Memory is the hard constraint, read at the size's request rather than its limit**, because a pod over its memory
request is an eviction candidate when the node comes under pressure, however much headroom its limit leaves. `small`
at 4 is 3.55Gi of the 4Gi it requests, and a fifth chat would be 4.20Gi, which is what fixes `small` at 4.

`small` keeps 1 CPU and 4Gi requested: someone who needs more conversations at once moves up a size, rather than every
`small` pod costing more.

CPU is a convention rather than a constraint: a cap of N draws `(N + 1) × 186m` sustained, with the pod's own session
counted, kept inside the request as a check that a pod would not contend with its own guarantee while merely working.
That it also lands on 4 for `small` is a coincidence of the two formulas.

`medium` and `large` are bound by neither (their memory requests would hold 10 and 23 chats, the CPU convention 9 and
20) but by the evidence. No pod has been measured above two concurrent sessions, and the burst figure is of one session
alone, so both sit well inside their requests. **Open:** raising them needs a pod driven deliberately with its full
complement busy at once, rather than sampled.

The figures are given as formulas rather than tables of worked percentages, because a worked figure is right only at
the cap it was taken at and goes stale on a line nothing conflicts with.

## Why no size has a CPU limit

What a pod is guaranteed under contention comes from `cpu.shares`, which the request sets. A quota adds nothing to that
floor and only clips the bursts above it, and throttling costs latency with no OOM-kill equivalent to protect against.
A quota is not wrong in principle, its job being to bound a runaway pod, but nothing measured here can size one: a CFS
quota is CPU-seconds per 100ms period and every figure above is a mean over seconds, which is how a session averaging
0.57 CPU was throttled against 4.0. Admission permits pods with no CPU limit: 2237 of the 6640 containers running in
`cft-preview-00-aks` at the time had none, Postgres StatefulSets in `civil`, `ccd`, `pcs` and `wa` among them.

## Why the warning reads `anon`

The warning is `anon_bytes + CONVERSATION_MEMORY_BYTES > limit_bytes`: less than one more conversation's worth of
headroom, in the part of the pod the kernel cannot reclaim.

**`memory.current` and `memory.peak` cannot answer a headroom question.** Both count page cache, and a pod that has
read the workspace clone holds 2.1–2.4Gi of it. Cache is reclaimed at the `memory.max` watermark rather than given back
early, so a container that has read the clone sits high and stays high: a threshold on either is crossed by file
reads, and the kernel would give that memory back before killing anything. A pod at its cap settles at `anon` plus
2.1–2.4Gi of cache plus about 0.15Gi of kernel, which stays under `limit − 0.65Gi` at every size and cap in use, so a
warning on either figure would be false exactly when it appeared. Choosing the constant differently does not help,
because the problem is what the figure tracks rather than its scale. `anon` is purely additive and is what the
constant was measured as.

**It is not about how many chats are open.** A pod's chats hold `0.95Gi + cap × 0.65Gi` of `anon`, and the threshold is
`limit − 0.65Gi`. The two meet only above a cap of `(limit − 0.95Gi − 0.65Gi) / 0.65Gi`, about ten chats on `small`
and several times any cap in use on every size, because the caps keep chats inside a size's memory *request* and the
threshold sits a conversation under its *limit*, which is double the request. That bound depends only on the limit and
the two constants, so raising a cap moves the figures closer and changes nothing. `src/assistant/memory-report.test.ts`
asserts it for every size at whatever cap it holds.

**What crosses it is the work inside a chat.** 0.65Gi is what a session *settles* at, not a ceiling: a build, a
dependency tree, a language server or a leak can put one session gigabytes above it, and the pod's own work can do the
same. `0.95 + 0.65N` predicts a pod whose sessions are doing what they were measured doing; the threshold is for when
one of them is not, which ends with the kernel killing the container where nobody outside the pod can see it coming.
Closing a chat frees about 0.65Gi against the 7.4Gi a `small` pod holds when the warning fires, so the warning gives
that as a figure, not as the remedy. The remedy it offers is a bigger size.

**Why it reports on every change in the session count.** A session starting or ending steps `anon` by about one
conversation, and between those steps it was flat for the work measured: 15 samples of a working pod over 35 minutes
held within 3%, while `memory.current` and `memory.peak` moved several times that. An unconditioned 10-minute sample
is a poor instrument for a figure that moves in steps. The flatness is not a claim that nothing else moves `anon`:
heavier work inside a session does, which is the case the warning exists for, and the 10-minute report is what catches
it.

## Open

- **The warning has never fired on a real chat workload.** Every test that shows it firing sets `anon` at or within a
  byte of the limit, which is a pod being OOM-killed. Nobody has seen the rule between what a full pod holds
  (`0.95Gi + cap × 0.65Gi`) and the `limit − 0.65Gi` it takes to fire. Closing this needs a pod driven to a few
  gigabytes of non-reclaimable memory on purpose, by a build or a leak, not by chats.
- **The cost per conversation is the `small` figure applied to every size.**
- **`medium` and `large` caps** rest on the `small` evidence, as above.
