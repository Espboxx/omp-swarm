# omp-swarm — decentralized peer-agent swarm for OMP

A flat multi-agent swarm: **N peer agents with no permanent manager**, coordinating through one
shared SQLite blackboard — shared task pool, atomic claims, leases, reservations, review, and
append-only shared knowledge.

```
                 ┌──────────────────────────────┐
                 │      .swarm/swarm.db         │
                 │  TASK · CLAIM · LEASE        │
                 │  FACT · FAIL · RESULT        │
                 │  MESSAGE · RESERVATION       │
                 └──────────────┬───────────────┘
        ┌────────────┬──────────┼──────────┬────────────┐
     Agent A      Agent B    Agent C    Agent D       (bootstrap)
        │            │          │          │              │
        └──────── shared working directory / git worktrees ┘
```

Everyone is a peer. The launcher only *starts* workers and *ticks* them; every decision — which
task, when to split, what to share, when to escalate — is made by whichever agent holds the tools,
and ownership conflicts are settled by the database, never by agent etiquette.

## What OMP already provides (reused, not reimplemented)

| Capability | OMP surface | How the swarm uses it |
|---|---|---|
| Agent runtime | `pi.pi.createAgentSession` (SDK) | each worker is a real OMP `AgentSession` in-process, own model, own session file, own `AgentRegistry` |
| Sessions | `SessionManager.create(cwd, dir)` | per-worker transcripts under `.swarm/sessions/<name>/` |
| Tool API | `CustomTool` / `createAgentSession({ customTools })` | the 19 swarm tools are injected into worker sessions |
| Restricted tool sets | `toolNames` + `restrictToolNames` + `allowRestrictedCustomTools` | workers get coding tools + swarm tools, nothing else |
| System prompt layering | `appendSystemPrompt` | the worker constitution is appended, not replacing OMP's prompt |
| Subagent observability | `session.subscribe()` (`agent_start` / `agent_end.isTerminal`) | idle detection for tick delivery |
| Message delivery | `session.prompt()` / `sendUserMessage({deliverAs: "steer" \| "followUp"})` | a peer message is delivered as a prompt, not over a private protocol |
| Managed timers | `ctx.setInterval` / `ctx.clearTimer` | heartbeat, sweeper, tick, panel — throws stay contained |
| TUI | `ctx.ui.setStatus` / `ctx.ui.setWidget` / `ctx.ui.notify` | live swarm status line, the `swarm-panel` text widget above the editor, and the alert line |
| Completion banner | `TERMINAL.sendNotification` (`@oh-my-pi/pi-tui`) | the batch-completion alert goes out on the host's own "Complete" channel |
| Slash commands | `pi.registerCommand("swarm", …)` | `/swarm start`, `/swarm status`, … |
| Isolated checkouts | `git worktree` (as OMP does for tasks) | `worktrees: true` gives each worker a branch + checkout |
| Process execution | `pi.exec` | worktree creation |

Nothing here forks OMP, patches core, or invents a second LLM abstraction. The swarm's own surface
is exactly the part OMP does not ship: **shared task pool, atomic claim, lease, blackboard,
reservations, autonomous worker loop, review, swarm panel**.

Deliberate deviation from "reuse native agent messaging": OMP's `agent://` / IRC channel addresses
agents **inside one session tree**. A swarm's peers are independent top-level sessions that must
also survive process restarts, so messaging is a durable table in the shared database and delivery
into a peer happens through OMP's own prompt path. One transport, not two.

## Files

`config.example.json` — copy to `.swarm/config.json` in your project.

```
extension/
  index.ts     extension entry: tool registration, /swarm commands, status panel, lazy runtimes
  auto.ts      multi-agent mode: roster derivation, mid-run growth + the auto-assemble/self-stop state machine
  driver.ts    worker lifecycle: spawn sessions, add workers to a running pool, tick, heartbeat, wake, worktrees, shutdown
  tools.ts     the 19 agent tools (shared by workers and the main session)
  store.ts     the reliability core: atomic claim, lease, review, reservations, board, messages
  db.ts        SQLite schema, WAL setup, typed facade over bun:sqlite
  config.ts    `.swarm/config.json` loading + role expansion
  render.ts    text rendering for the panel, task table, summary, task progress and the batch-completion summary
  agentinfo.ts pure agent-list rows: AgentInfo facts -> one fitted ASCII line per worker
  color.ts     the reminder palette: per-agent and per-status colours, host-parity visible width, control-byte sanitization
  agentnav.ts  the agent-list selection model: main-first entries, cursor movement with wrap, the marker column, row rendering
  types.ts     domain types
tests/
  unit/store.test.ts           32 unit tests of atomic claim, leases and crash recovery, dependencies, review, the blackboard, reservations and messaging
  unit/auto.test.ts            28 unit tests of multi-agent mode: roster derivation, mid-run growth and the assemble/self-stop state machine
  unit/render.test.ts          49 unit tests of the panel, task table, summary, progress bar, drain summary and age formatting
  unit/agentinfo.test.ts       30 unit tests of the agent-row facts: token/cost/context compaction, sorting, line fitting and colour
  unit/color.test.ts           39 unit tests of the reminder palette, status colours, painted output, host-parity width and control-byte sanitization
  unit/agentnav.test.ts        23 unit tests of the selection model: main-first entries, cursor wrap and clamping, the marker column and row rendering
  unit/index.test.ts            8 unit tests of the extension's optional host-module seams: the lazy key matcher and the completion alert, both branches
  unit/host-free-load.test.ts   3 checks that the extension loads under `bun --no-install` in a node_modules-free tree, with a negative control
  helpers/swarm-child.ts       child-process worker used by the race tests
  integration/harness.ts       scratch project, seeded tasks, shared assertions
  integration/sdk-run.ts       live swarm driven through the SDK (headless)
  integration/swarm-run.ts     live swarm driven through a real `omp --mode rpc` session
  integration/auto-run.ts       multi-agent mode end to end: one plain task, no /swarm command
  integration/rpc-client.ts    minimal OMP RPC client (NDJSON over stdio)
  integration/rpc-dump.ts      frame-level RPC diagnostics
```

## Install

### From the marketplace (self-hosted)

This repo is its own marketplace — `.omp-plugin/marketplace.json` (catalog `espboxx-plugins`)
points back at the repo root, so one URL is enough:

```
/marketplace add Espboxx/omp-swarm
/marketplace install omp-swarm@espboxx-plugins
```

The CLI pair is equivalent: `omp plugin marketplace add Espboxx/omp-swarm` then
`omp plugin install omp-swarm@espboxx-plugins` (`--dry-run` previews without fetching or writing).

Installs are **user-scoped by default** (every project); add `--scope project` to scope one to the
current project, and `--force` to reinstall. `/reload-plugins` refreshes skills, slash commands,
agents and MCP servers, but a **newly installed extension module needs a session restart** before
`/swarm` and its tools exist. The package name `omp-swarm` is global per scope, so a marketplace
install collides with an already-`omp plugin link`ed checkout (`Runtime package name "omp-swarm"
conflicts with installed plugin "omp-swarm@espboxx-plugins"`) — uninstall the link first.

### From a local checkout

Development (any directory, no install needed):

```bash
omp -e /abs/path/to/omp-swarm/extension/index.ts
```

As a plugin (loads in every session — verified: `omp plugin doctor` reports 5 ok, and both the
tools and `/swarm` work in a session started without `-e`):

```bash
omp plugin install /abs/path/to/omp-swarm      # links the package into ~/.omp/plugins
omp plugin list                                 # confirm omp-swarm is listed
omp plugin doctor                               # health check
```

Unlike `-e`, the installer links the package, so edits under `extension/` take effect on the next
session without reinstalling. Uninstall with `omp plugin uninstall omp-swarm`.

Or reference it from config:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /abs/path/to/omp-swarm/extension/index.ts
```

Requires OMP 18.6.1+ (uses `pi.pi.createAgentSession` and the extension `ui.setWidget` surface).

## Configure

`.swarm/config.json` in the swarm root (created on first use; `/swarm config` prints the effective
values). A ready-to-copy template lives at `config.example.json` in this repo:

```json
{
  "workers": 4,
  "leaseSeconds": 120,
  "heartbeatSeconds": 10,
  "offlineAfterSeconds": 45,
  "idleTickSeconds": 20,
  "review": true,
  "auto": false,
  "worktrees": true,
  "model": "provider/model-selector",
  "thinkingLevel": "medium",
  "roles": [
    { "name": "general", "count": 2, "capabilities": ["general"] },
    { "name": "reviewer", "count": 1, "capabilities": ["general", "reviewer"] },
    { "name": "integrator", "count": 1, "capabilities": ["integrator", "reviewer"] }
  ],
  "tools": ["read", "grep", "glob", "edit", "write", "bash", "ast_grep", "ast_edit", "todo"]
}
```

`model` is optional — omit it and workers inherit the session/provider default. Role `count`s are
expanded into callsigns (`SwiftTiger`, `CalmFalcon`, …); `capabilities` gate claim eligibility.

## Use

```
/swarm on             # multi-agent mode: the next task you type is executed by a swarm
/swarm off            # leave the mode (running workers are stopped)
/swarm start 4        # spawn 4 workers (reads .swarm/config.json for roles/lease/review)
/swarm status         # full snapshot: mode phase, agents, task counts, in-flight tasks with elapsed/attempts, throughput, board histogram
/swarm agents         # roster with role, state, task, heartbeat age, capabilities, worktree
/swarm nav            # the same list as an overlay: arrows move the cursor, Enter marks the target (see below)
/swarm tasks ready    # task pool by status
/swarm board FAIL     # blackboard by type
/swarm task <title>   # operator-created task (bootstrap)
/swarm message <agent|all> <text>   # operator → worker(s), delivered as a prompt
/swarm approve <id> [notes] | /swarm reject <id> <notes>
/swarm config | /swarm roles
/swarm stop           # workers release their work, post final notes, sessions disposed
```

`/swarm start` returns immediately: sessions are created in the background and agents join within
~30 s (watch `/swarm agents` or the panel). A worker that cannot start is reported and skipped
instead of blocking the swarm. Set `SWARM_TRACE=1` to write per-worker milestones to
`.swarm/driver.log`.

While the swarm runs, the widget above the editor and the `swarm` status line update live. Above
the worker rows the widget carries the task progress — a bar (`█████████░`) over a
`TASKS 7/8 · 1 running · 1 blocked · 88%` line — and the status line carries the compact form
(`SWARM 7/8 done`). The denominator is the ACTIONABLE work (`ready + claimed + review + done +
failed`); `blocked` is deliberately excluded and reported as its own segment, because a task whose
dependency was closed as superseded stays blocked forever and a bar that counted it would never
reach 100 %. The widget then carries one row per worker — `state`, the task it holds, git branch,
`ctx <n>%`, tokens in/out, `$cost`, turns and last activity — fitted to the terminal width by
dropping whole fields from the right. For the store's view of the same swarm, `/swarm agents` lists
the roster (`role`, `state`, `task`, heartbeat age, capabilities, worktree) and `/swarm tasks` the
task table.

### Reminder colors

The widget's agent rows and the counters take reminder colors instead of reading as one white block:
each worker's name gets its own slot from a fixed 8-color palette, dealt over the agent ids in name
order rather than over the display order — the slots are distinct within one frame, and a worker that
changes state reorders the rows without recoloring anyone, so the color identifies the agent across
repaints (a worker joining the roster can still shift a later slot). Its state token gets that state's
color (`working` green, `reviewing` cyan, `waiting` amber, `blocked` red, `idle`/`offline` grey), and
the non-zero counters carry the same language — `BLOCKED` red, `FAILED` bright red, `DONE` green, with a
zero counter left plain so a clean pool stays calm. Color is decided in exactly one place,
`extension/index.ts` (`colorEnabled(process.env, process.stdout.isTTY)`), and is off whenever the
output is not an interactive terminal or `NO_COLOR` is set: `NO_COLOR=1 omp` and `omp | cat` emit the
byte-identical plain text, with zero escape bytes. The escapes are zero-width — every line is still
measured and clipped on VISIBLE columns with the host's own `Bun.stringWidth` rule (ANSI counted zero,
three cells per tab) — so a colored row fits the terminal exactly as the plain one does, a CJK or emoji
title included. Every row field that carries store text (name, state, task id and title, branch) is
sanitized before it is measured or painted: escape sequences and C0/C1 control characters are dropped,
so a task title can never smuggle a cursor move, a clear-screen or a clipboard write into the terminal.
The status line's `SWARM n/m done` is formed with the same colors, but the host sanitizes status text
before painting it (`pi-tui` `sanitizeStatusText`), so that one surface reads plain — measured, not
assumed.

### Agent list navigation

`/swarm nav` opens the agent list as a left-anchored overlay whose keys are yours:

| Key | Action |
|---|---|
| `↑` / `↓` (or `k` / `j`) | move the cursor; it wraps at both ends |
| `Enter` | make the highlighted row the **current target**, then close |
| `Esc` (or `q`) | close and change nothing |

Every row carries a three-column ASCII marker: `>` is the cursor, `*` is the current target, and the
two are independent — walking the list does not move `*`, only `Enter` does. Row 0 is the main
session (`main session · this terminal`), so main and the workers are one list the operator can move
between; the other rows are exactly what the widget paints (`state`, task, branch, `ctx`, tokens,
`$cost`, turns). The widget keeps painting both markers while the picker is closed, so the current
target is readable at all times and a repaint never loses the selection.

The overlay is what makes the keys possible, not a style choice: OMP silently drops `enter`/`escape`
from any extension `registerShortcut`, and the above-editor widget is never focused, so a focused
component is the only surface that can own the arrows **and** Enter. Nothing is claimed globally —
typing in the composer is unaffected (the picker only sees keys after `/swarm nav`), `Esc` closes it
without touching the selection, and a host with no TUI keeps the plain `/swarm agents` text. The
selection lives in the extension's per-root runtime, survives repaints, and is clamped against the
live roster: a cursor can never sit past the last row, and a target whose agent left falls back to
main.

The main row costs one of the host's ten widget lines, and it is charged to the block that was always
budget-dependent: the progress bar and its counts line both fit up to three workers, the counts line
alone at four, and at five or more neither is in the widget — the worker rows, the counters and the
board tally are untouched, and the `SWARM n/m done` status line plus `/swarm status` keep reporting
the progress itself. The persistent batch summary shrinks by the same line when the roster is large;
the status-line headline and the transcript copy are unaffected.

**What `Enter` does, exactly:** it marks the target. It does **not** switch the session pane, because
no extension-facing API can do that and the host's own Agent Hub (`Alt+A`) lists only host subagents
— swarm workers are created with a private agent registry and `hasUI: false`, so they never appear
there. `/swarm message <id> <text>` (or the `swarm_message` tool) stays the way to reach the agent you
marked.

### Batch completion alert

The operator gets **one** alert per batch, never repeated on a repaint. The edge is evaluated on the
tick that already runs (no new timer): nothing actionable, at least one task of the batch finished,
and the counts held still for `DRAIN_SETTLE_MS` (10 s — the driver samples every 3 s, so the alert
lands 10–13 s after the last task finishes, which is also what keeps a worker that is about to claim
the next task from ending the batch early). A task that appears later opens a new batch and the
alert can fire again for it.

The alert goes out on three surfaces:

- the host's own completion channel — `TERMINAL.sendNotification({ title: "SWARM DONE", body:
  <headline>, type: "completion" })`, the same one the host uses for its "Complete" banner
  (suppressed by `PI_NOTIFICATIONS=off`, a no-op in a headless terminal);
- a `ui.notify` line, plus the full multi-line summary in the transcript when multi-agent mode is
  off (with the mode on the controller posts its own finish notice, and one alert in the chat is
  enough);
- a **persistent marker**: the widget keeps the summary lines and the status line the headline —
  `SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42` — until new actionable
  work appears or the next `/swarm start`.

The batch is what that run was responsible for: the tasks that were non-terminal when the pool
started, plus any created while it ran. The summary stays honest about what it knows: the finisher
is joined from the event log (`complete()`/`fail()` clear `claimedBy`), the duration is
creation-to-completion (the working window is not recoverable), and the cost is this batch's worker
sessions folded together — there is no per-task price, so none is printed. A run that ends with
nothing finished is the stall notice's case, not this one, and never claims "the swarm finished".

One scope rule is worth stating, because both kinds of number share one line: the headline's counts
are the store's totals for the **whole board** at drain time (that is what `DrainSummary.counts`
is, and what `/swarm tasks` reports) — only the elapsed, the agents, the cost and the per-task lines
belong to this batch. On a pool that already carries finished work the headline therefore reads
larger than the batch did; the task lines are the batch's own record of what it did.

### Multi-agent mode (`/swarm on`)

Manual swarms need two operator acts (create tasks, then `/swarm start N`). In multi-agent mode the
session does both by itself:

1. `/swarm on` persists `"auto": true` in `.swarm/config.json` and the status line switches to
   `MULTI-AGENT ON · idle`. The mode is per project and survives restarts (a session whose config
   says `auto: true` starts in the mode).
2. Type a task in the normal prompt. The extension marks a planning window, and for that one turn
   the coordinator receives standing instructions: decompose the request into 2–6 independent tasks
   with `swarm_task_create`, post a `DECISION`, and do not edit the workers' files itself.
3. Once the coordinator stops publishing tasks (a 20 s quiet period, so the roster is sized to the
   whole plan rather than to the first task of a still-running turn), a roster is derived from what
   the tasks need (`required_capabilities`, one agent per capability, plus a `reviewer` when
   `review: true` and review-required work exists), sized to the plan and capped by `config.workers`
   — work queued behind a dependency counts, so a dependency chain does not serialize the run.
   Workers spawn, claim, and execute. The roster is not frozen at that first sizing: each tick while
   the driver is up and the pool is neither draining nor stalled, ready work above both the live
   worker count and the ready count the pool was sized for grows the pool
   (`auto.ts:AutoController.tick` → `driver.addWorkers`) by the delta the plan still needs, measured
   against the larger of live and planned workers, and only while fewer workers are planned than
   `config.workers`. Growth happens at most once per ready-count increase (the watermark is rebound at
   each step and reset when the mode is re-armed, disabled, disposed, drained or stalled), so a spawn
   still coming up neither triggers a growth of its own nor gets counted twice. A task published after
   the pool started (the coordinator adding work, a worker splitting an oversized one) therefore gets
   workers instead of queueing behind a pool too small for it.
4. When every task is `done`/`failed`, the swarm stops itself, the main session receives a finish
   notice with the counts, and the operator gets the batch-completion alert (see above) — answer,
   then send the next task if you have one.

The status line tracks the mode: `idle`, `planning`, `running` (`3a r0 c2 v0 d1` = online agents,
ready/claimed/review/done), `done n/m`, `stalled`, prefixed while a pool is up by the compact
progress (`SWARM 7/9 done`) and replaced once a batch drains by its headline
(`SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42`); the widget above the
editor carries a `MULTI-AGENT MODE · <phase>` header over the progress block and one rich row per
worker (state, task, branch, ctx%, tokens, cost, turns, age — see above), and keeps the drained
summary in place of the progress block; `/swarm agents` lists the roster from the store. `/swarm off`
stops running workers and persists
`"auto": false`; a swarm blocked with nothing claimable is stopped after 90 s and reported as
`stalled` instead of spinning. If the coordinator never publishes tasks for a request that is still
streaming, it is nudged once after 90 s and the mode returns to `idle`.

Tasks that appear while no pool is running — a hand-made `/swarm task`, leftovers after `/swarm stop`
— start a pool for them on the same terms. Tasks published while a pool is running are picked up by
that pool, which grows toward them up to `config.workers`.

Reproduce the UI surface without a TUI (repeat `--command` to walk a sequence in one session):

```bash
bun run rpc:dump -- --ui --installed --command "/swarm on" --command "/swarm off" --gap 10 --seconds 40
# → setStatus statusText=MULTI-AGENT ON · idle after "on"; no MULTI-AGENT frame after "off"
```

## Tools (available to workers and to the main session)

| Tool | Purpose |
|---|---|
| `swarm_status` | agents online/working/idle, task counts, blocked work with its reason, board histogram |
| `swarm_tasks` | list the pool (`status`, `capability`, `mine`, `limit`) |
| `swarm_claim` | **atomic** claim; optional file reservation in the same call |
| `swarm_renew` | extend leases you hold |
| `swarm_release` | give work back with a reason (never stall silently) |
| `swarm_complete` | finish with summary/commit/files → `review` or `done` |
| `swarm_fail` | fail with a reason; a FAIL board entry is written automatically |
| `swarm_task_create` | add work or a dependency you discovered; refuses an unknown, self- or cycle-closing dependency |
| `swarm_task_retry` | revive a `failed`/`blocked` task as `ready` (fresh attempt, cleared claim) so its dependents can be promoted |
| `swarm_integrate` | create an integration task requiring the `integrator` capability |
| `board_post` | FACT / FAIL / OBSERVATION / CLAIM / RESULT / QUESTION / REVIEW / DECISION |
| `board_search` | filter by type/task/agent/tag/keyword |
| `swarm_agents` | peer roster |
| `swarm_message` | direct message or `to: "all"` broadcast — delivered via the target's prompt path |
| `swarm_inbox` | read (and consume) your messages |
| `swarm_review` | approve → `done`, or reject with notes → `ready`; self-review is refused |
| `swarm_reserve` / `swarm_unreserve` | lease-backed file/directory reservations |
| `swarm_wait` | block until claimable work or a message appears (1–120 s) |

## How the hard parts work

**Atomic claim.** `claim()` runs `BEGIN IMMEDIATE` → expire stale leases → verify `status='ready'`,
dependencies complete, capabilities satisfied → `UPDATE … WHERE id=? AND status='ready'` → check
`changes === 1`. SQLite serializes the write transaction, so with N agents calling
`claim(task-17)` at the same instant exactly one wins and the losers get a reason string. Verified
with three real OS processes racing the same task (`tests/store.test.ts`).

**Task graph.** Dependencies are checked inside the create transaction (`store.ts:createTask` →
`#assertDependencies`), before any row is written: an unknown id is refused as
`unknown dependency: task-99`, a self-edge as `dependency_self: task-2 depends on itself`, and an
edge that would close a cycle as `dependency_cycle: task-2 -> task-1 -> task-2` — nothing is
inserted. `blockedReason()` explains any row that is still blocked — `missing: <ids>` for a
dependency id that no longer exists, `cycle: <path>` for a graph that can never reach `done`,
otherwise `waiting` — and `swarm_status` prints that reason next to the task. A `failed` task is no
longer a dead end: `swarm_task_retry` (`store.ts:retryTask`) returns it to the pool as `ready` with a
fresh attempt, and the usual `sweep()` promotes its dependents once it completes.

**Lease + heartbeat.** Every claim writes `claimed_by`/`lease_until`. Any tool call and the driver's
heartbeat renew leases. A sweeper (`sweep()`) runs inside every claim and on each heartbeat: tasks
whose lease expired return to `ready` with a `task.reclaim` event, and lease-backed reservations
expire with them. A crashed agent therefore cannot wedge the pool, and a live lease is never
stolen.

**Worker loop.** After bootstrap, each idle worker is ticked only when there is something to do
(unread message, held task, claimable task matching its capabilities, or a review it may take); with
no work it is nudged once per `idleTickSeconds`. The tick carries *facts*, never decisions — task
selection, splitting, sharing and escalation stay with the agent, which loops
`inbox → board → claim → work → verify → post → complete/ fail → wait` until the swarm stops.

**Reservations.** Patterns are path-shaped (`src/auth/**`, `src/parser.ts`); an overlapping request
is refused with the conflicting owner. Reservations expire with the lease, so a crash cannot lock a
file forever.

**Review.** `swarm_complete` on a review-required task moves it to `review`; the review slot is
lease-protected and the author is refused (`reviewer must not be the author of the change`);
approval promotes dependents, rejection returns the task to `ready` with the notes attached.

**Events.** Every mutation appends to the `events` table *and* `.swarm/events.jsonl`
(`task.claim`, `task.reclaim`, `review.approve`, `reservation.acquire`, `agent.join`, …).

## Tests and recorded runs

```bash
bun run test                   # 212 unit tests in the 8 files under tests/unit (incl. a 3-process claim race)
bun run typecheck              # tsc against the real OMP 18.6.1 host types
bun run swarm:sdk              # live swarm, SDK-driven (headless, no TUI)
bun run swarm:rpc              # live swarm through a real `omp --mode rpc` session + /swarm start
bun run auto:rpc               # multi-agent mode: config says auto, ONE plain task, no /swarm command
bun run rpc:dump -- --command "/swarm status"   # frame-level RPC diagnostics
```

Integration runners seed a scratch project with five real tasks (implement a parser + its tests,
write the README, audit the build setup and post a FAIL, ask a peer for its status, integrate the
result), start N workers, kill one worker mid-task to force lease recovery, and assert on the shared
database plus the event log. `tests/integration/last-run.json` is written by BOTH runners
(`swarm-run.ts:112` for RPC and `sdk-run.ts:138` for SDK), so a live SDK run overwrites the RPC
run's report; `last-run-sdk.json` on disk is a stale leftover from an earlier run. Multi-agent mode
reports land in `last-run-auto.json` / `last-run-auto-ui.json` (`auto-run.ts:260`). All of them are
generated locally by the runner and are **not tracked** in this repo (`.gitignore`:
`tests/integration/last-run*.json`), so the paths cited below are the local records of the runs on
the machine that produced them, not files a clone contains.
`auto-run.ts` boots the project with `"auto": true` and sends one plain task — a report on the mode
assembling itself, with no `/swarm` command in the transcript.

### Verified on this machine (OMP 18.6.1, 4 workers, review on)

`tests/integration/last-run-sdk.json` — **16/16 checks** (an earlier run: that path is the stale
artifact described above, not what `bun run swarm:sdk` writes today):

| Check | Evidence |
|---|---|
| 4 workers joined | `SwiftTiger, CalmTiger, BrightTiger, VividTiger` |
| ≥2 agents claimed work | all four claimed at least one task |
| no task held by two agents at once | 0 overlapping claim windows across 6 successful claims |
| real artifacts | `src/parser.ts` (16 lines), `src/parser.test.ts`, `README.md` written by workers |
| swarm-written tests pass | `bun test` in the scratch project → 3 pass, 0 fail |
| peer messaging | 4 direct messages + replies |
| FAIL published | the build-audit task reported the exact `bun run build` failure |
| RESULT / DECISION | 6 RESULT entries; the integrator posted a DECISION verifying parser ↔ README |
| review cycle | task-5 → `review` → peer `review.start` + `review.approve` → `done` |
| crash recovery | killed `VividTiger` holding task-1 → `task.reclaim` (lease expired) → `BrightTiger` claimed and finished it |
| shutdown hygiene | no task left claimed, all five tasks `done` |

The RPC run (its report is `last-run.json` until the next SDK run overwrites it) exercises the same
code path a user does — `omp --mode rpc` with the extension loaded, `/swarm start 4` dispatched
through the command handler — and produced the same outcomes (agents joining inside the host
process, claims, completions, FAIL/DECISION, lease reclaim).

**Pre-fix run, kept as the record:** `bun run swarm:sdk -- --workers 5 --timeout 600` → **14/16
checks passed** (`tests/integration/last-run.json`, 5 workers, 691 s; the verifier's literal output,
board FACT #25). Red: `review cycle ran — 0 started, 0
approved` and `seeded tasks reached a terminal or review state — task-1:done, task-2:done,
task-3:done, task-4:done, task-5:ready`. Cause, reproducible in both verifier runs and NOT a
regression from the iteration-2 changes: the harness crash test killed the first working agent, and
seeded task-5 requires `requiredCapabilities: ["integrator"]` (`harness.ts:101`) — when the victim was
the only integrator holder (`harness.ts:54`) that task was unclaimable, the runner never reached its
break condition and ended on its own `--timeout`, so the review cycle of the task that did reach
`review` never started.

**Latest literal run, honest:** after the harness fix, `bun run swarm:sdk -- --workers 5 --timeout 600`
→ **16/16 checks passed** (`tests/integration/last-run.json`, 5 workers, 273 s; the verifier's own run
while writing this). `review cycle ran — 1 started, 1 approved`; `seeded tasks reached a terminal or
review state — task-1:done, task-2:done, task-3:done, task-4:done, task-5:done`; `expired lease was
reclaimed and the task re-claimed by a peer — 1 lease-expiry reclaim(s) of 1 total`. The crash test now
kills a working agent that holds a task but is not the only live holder of a capability unfinished work
still requires (`harness.ts:pickCrashVictim`), so the reclaim check still runs on a real claim, and a
run that strands capability-gated ready work ends early with a `[stuck]` line (`sdk-run.ts:114`)
instead of waiting for the timeout.

### Verified multi-agent mode (private workflow)

`tests/integration/last-run-auto.json` (headless) — **15/15 checks**, and
`last-run-auto-ui.json` (`--ui`) — **16/16 checks**. Both runs boot a project whose config already
says `"auto": true`, dispatch one plain task, and send no `/swarm` command at all:

| Check | Evidence |
|---|---|
| the mode was live | headless: `swarm.auto.idle` + `swarm.auto.planning` in the event trail; `--ui`: `setStatus MULTI-AGENT ON` + widget frames |
| the coordinator decomposed the task | 4 tasks created by `main` before any worker existed |
| a swarm-sized pool assembled | `SwiftTiger, CalmTiger, BrightTiger` — all three joined within 1.4 s of the pool starting |
| work was executed by workers | all three claimed distinct tasks; 0 overlapping claim windows |
| real artifacts | `src/parser.ts`, `src/parser.test.ts`, `README.md`; `bun test` in the scratch project passes |
| the swarm stopped itself | pool drained 228–349 s in, then `agent.leave` for every worker with no operator command |
| nothing restarted | task rows and agent rows unchanged after the finish notice |

The UI run also asserts the status line tracked the run: `idle → planning → running → done 4/4`.

Manual TUI pass (Windows Terminal, `workers: 2`, one plain task asking for three independent
modules): `/swarm on` → `MULTI-AGENT ON · idle` and a `MULTI-AGENT MODE · idle` widget header; the
task moved the line to `· planning`, then to `· 2a r3 c0 v0 d0` with the panel reading
`SWARM running · 2 agents`; the two workers claimed different tasks; after the last task the session
received the finish notice, the panel read `SWARM stopped · 0 agents` and the line returned to
`· idle` (mode still on); `/swarm off` cleared the line and persisted `"auto": false`. `bun test` in
that project exits 0.

Live progress + completion alert (Windows Terminal, isolated sandbox root, `workers: 2`,
`review: false`, `/swarm start 2`):

| Frame | Evidence |
|---|---|
| mid-run | `██████████░░░░░░░░░░` over `TASKS 2/4 · 2 running · 50%`, both workers `working` on their own task, footer `READY 0 CLAIMED 2 REVIEW 0 BLOCKED 0 DONE 2 FAILED 0`, status line `swarm 2a r0 c2 v0 d2 · SWARM 2/4 done` |
| drain | one banner box `SWARM DONE · 4/4 tasks (4 done) · 2 agents · 3m39s · $0.01` with a line per task (`v task-3 Write out/three.txt (SwiftTiger · 1m)`), the same summary in the widget in place of the progress block, and the headline on the status line |
| ≥30 s later | identical — no second alert, same two batch boxes in the transcript, widget and status unchanged |
| composer | intact in every frame: the widget sits above the editor, the `╰─` composer line and the status line below it, nothing painted through |

A second batch (two tasks published while the pool ran) fired its own alert with the right per-task
lines once its own settle window passed, which is the one-batch-one-alert rule and the
"new task re-opens the edge" rule in the same run.

## Known limits

- Workers are in-process sessions: one OMP process hosts the swarm. Cross-machine swarms are out of
  scope (the store is a local SQLite file).
- One swarm per root: `.swarm/` is per working directory, and the driver is created per root.
- Review needs at least two live agents (self-review is refused). With a single worker, finish the
  review by hand: `/swarm approve <id>` or `/swarm reject <id> <notes>`.
- The tick/heartbeat loop depends on the host process staying alive; the store survives restarts,
  but `/swarm start` must be re-run. In multi-agent mode a session whose config says `auto: true`
  re-arms the mode and its tick loop on start.
- Multi-agent mode rides on the coordinator obeying the injected policy: if a turn ends with no
  `swarm_task_create` rows, nothing starts (it nudges once after 90 s, then returns to `idle`), and a
  request that cannot be split is answered normally. Tasks you create by hand while the mode is on
  start a pool on the next tick.
- Roster growth is keyed to ready work: at most one step per ready-count increase, never past
  `config.workers`, and only while the pool is running and undrained — a task published after the
  pool stopped or drained waits for the next `/swarm start` instead. Because the trigger is the ready
  count, a worker whose spawn failed is not replaced by a later growth: only new claimable work grows
  the pool. The trigger compares the ready count with the LIVE worker count (`auto.ts:301`), not with
  capability: ready work that no live worker is able to claim does not grow the pool by itself (seen
  in the pre-fix SDK run: 1 ready `integrator`-only task against 4 live workers → 0 `roster.grow`
  events; the harness now ends such a run with a `[stuck]` line instead of waiting for the timeout).
  The delta itself is measured against `max(live, planned)` (`auto.ts:304`).
- The status line and widget are extension UI frames — a headless session (`--no-ui`) emits none by
  host contract; use a UI-mode session to see them.
- The batch-completion alert is one per batch and lands `DRAIN_SETTLE_MS` (10 s) after the task
  counts stop moving, not the instant the last task finishes: the pool has to look idle for longer
  than a tick, or a worker about to claim the next task would end the batch early. A batch's tasks
  are the ones it started with plus any created while it ran, so a run restarted later does not
  re-report finished work.
- The loud surface is `TERMINAL.sendNotification`, which `PI_NOTIFICATIONS=off` suppresses and a
  headless terminal drops. The persistent marker (widget + status line) is UI-only too, so a
  `--no-ui` session gets the summary as a transcript message only when multi-agent mode is off.
- `swarm_wait` blocks a worker turn; it is not a scheduler replacement.
- Cycles cannot enter the graph any more (`store.ts:createTask` refuses unknown/self/cyclic
  dependencies), but rows created before that check existed can still be cyclic: they stay `blocked`
  and are reported as `cycle: <path>` by `swarm_status` (`store.ts:blockedReason`) — nothing repairs
  them in place.
- Reviving a `blocked` task with `swarm_task_retry` returns it to `ready` even while its dependencies
  are unfinished; `store.ts:claim` still refuses it until they are `done` (the tool prints that
  caveat). Retry is for a dead end, not for skipping a dependency.

## Scaling to 8 / 16 / 32 agents

Bottlenecks in the order they bite:

1. **Single SQLite writer.** WAL gives concurrent readers but one writer; `BEGIN IMMEDIATE` calls
   serialize. Fine to ~tens of agents; beyond that shard claim hot-spots (per-area task tables) or
   add a claim queue.
2. **One host process.** All worker sessions share the process: model streams, tool execution and
   the sweeper compete for the same event loop. Shard agents across processes/CLIs (each runs its
   own driver against the same DB) before going past ~16.
3. **Tick fan-out.** The tick loop is O(agents) per interval; at 32 agents a 3 s tick still leaves
   headroom, but `swarm_wait` per worker becomes the cheaper idle path.
4. **Git worktrees.** One worktree per agent is cheap per repo, expensive per index; at 32
   concurrent checkouts on one machine, prefer a few shard repos over 32 worktrees.
5. **Two agents editing one file** is solved by reservations, not by luck — but reservations are
   advisory to the LLM, so cap parallelism per file area in the role config instead of hoping.

## License

MIT — Copyright (c) 2026 Espboxx. See [LICENSE](LICENSE).
