# docs/08 — the loop-run pattern: "work until the big pieces are done"

How to drive a long, multi-phase build (e.g. plans 021–025) that runs until a
set of large deliverables is finished, survives usage-limit and machine kills
with ≤1 unit of rework, and keeps a roughly constant context window no matter
how many phases it burns through. This is the meta-protocol; docs/06 is the
per-phase gate protocol it sits on top of, and HEARTBEAT.md is one concrete
instance of it.

## The reframe that makes everything else fall out

**Do not try to preserve session context across a credit-out. Make losing it a
non-event.** All correctness lives in durable files (the run-state file) + git;
in-session context is only a *warm cache* of what you'd otherwise re-read from
disk. If any part of the run depends on the model *remembering* something that
isn't on disk, that part is fragile — a usage limit, a summarizer pass, or a
`--resume` will break it. Design so that a cold process that has never seen the
conversation can reconstruct the entire run state from the state file + `git
log`, and the loop becomes indifferent to whether this iteration is the same
session or a fresh one.

Everything below is machinery in service of that one property.

## The four load-bearing rules

### 1. Externalize all state; the commit is the only durable artifact

- One **run-state file** is the single source of truth (checklist of phases,
  each flipped to `[x] <hash>` only after green+committed+pushed; a newest-first
  Log; open questions). HEARTBEAT.md is this file for the 021–025 arc.
- **Subagent output is vapor until the orchestrator verifies + commits + pushes.**
  Subagents never commit. A phase's work only becomes durable at the commit. So
  a kill mid-phase loses *exactly that phase* and nothing before it — this is
  what bounds rework to ≤1 unit, and it's why "commit + push before yielding" is
  load-bearing, not stylistic. Push every phase: the machine can die too.

### 2. One iteration = one phase = one atomic green-gated commit

Each loop iteration does **exactly one phase**, then yields. Never chain phases
in a single turn — chaining trades away the ≤1-phase rework bound for nothing.
The iteration shape is fixed:

```
cold-read state  →  pick next unchecked box  →  (subagent does the phase)
  →  orchestrator verifies (T1 gate)  →  commit + push  →  flip the box
  →  yield / reschedule    (or stop, if no boxes remain)
```

### 3. Unit-sizing rule — how "big pieces" become iterations

A **big piece** (a whole plan) is a group of phase-boxes. A **phase** is the
largest chunk of work that simultaneously:

- (a) produces a **green gate** (docs/06 T1),
- (b) **commits atomically** (one coherent diff), and
- (c) **fits inside one subagent context window without the subagent itself
  summarizing mid-work.**

(c) is the one people miss: if a phase is too big, the subagent's context fills
and it summarizes *while still working*, losing fidelity on its own earlier
decisions — silent quality loss, not a crash. Size phases against that ceiling.
The 021-A…025-E decomposition already obeys this; when you add a new "big
piece," decompose it the same way.

### 4. Lean orchestrator — bounded ingest per iteration

This is the real context-management lever (more than "use subagents" alone).
The orchestrator's own context must stay **roughly constant across the whole
run** so that a 20-phase run in one long session never bloats it. Per iteration
the orchestrator reads only bounded artifacts:

- the **run-state file** (small),
- `git status` + `git log --oneline -N` (small),
- **only the current phase's section** of the current plan — enough to write the
  subagent brief and to verify — *never* all plans or all source in its own
  window,
- the subagent's **compact final report** (bounded by instruction).

The heavy reading — the plan's §0 invariants, the source, the exploration — is
pushed **down into the phase subagent**, which gets a fresh full window per
phase that is discarded afterward. The orchestrator never accumulates the union
of every phase's working context. This is what keeps the window flat.

> This *replaces* the older "read the CURRENT plan file in full, once per
> session" habit, which was fine for a single-session run but works directly
> against a lean orchestrator on a long loop.

## Choosing the loop primitive (nearly orthogonal — don't overthink)

Restart-survival and context management come from the state design above, **not**
from which primitive drives the turns. The primitive only decides *when the next
turn fires*:

- **`/goal`** — "keep working turn after turn until a condition is met." This is
  almost verbatim the "work until the big pieces are done" charter, with no idle
  wait between phases. **Recommended for this kind of run.**
- **`/loop` (self-paced, no interval)** — polls: does one phase, then waits a
  model-chosen 1 min–1 h before the next. Works, but inserts idle time between
  phases and its recurring task **expires after 7 days** (recreate before then
  for a multi-day run). Can stop itself via `ScheduleWakeup(stop: true)` when the
  checklist is clear.

Either way the rest of the architecture is identical. Pick `/goal` unless you
specifically want the polling/interval behavior of `/loop`.

## Kill & resume semantics (why this survives a credit-out)

- **Kill mid-phase:** dirty tree, uncommitted work. Next iteration's cold read
  detects it (`git status`) and either finishes the phase to green or
  stashes+restarts it clean. Cost: ≤1 phase.
- **Kill while idle between phases:** nothing in flight; durable state is the
  file + git. Cost: 0.
- **Usage limit:** does not delete anything. If the session stays open, it
  resumes when the window reopens. If the session exits, restore with
  `claude --resume` (restores an unexpired `/loop` task) or re-issue `/goal`;
  the cold read rebuilds state from the checklist + `git log`. There is **no
  catch-up** for missed fires — you get one fire when able, not one per missed
  slot, which is exactly what you want.
- **Both `/loop` and `/goal` accumulate context within one conversation** —
  neither spawns a fresh session per iteration. The lean-orchestrator +
  subagent-per-phase pattern is what makes that survivable: the in-session
  summarizer can't corrupt the run because nothing correctness-critical lives
  only in context.

## The invariant to check the whole design against

At any instant, kill the process and hand a brand-new cold agent only the repo:
it should reconstruct exactly where the run is and continue with at most one
phase of rework. If that's true, the run is credit-out-proof and
context-loss-proof. If it isn't, some state is trapped in session memory — move
it to the state file.
