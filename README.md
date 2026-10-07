[**English**](README.md) · [简体中文](README.zh-CN.md)
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
| Tool API | `CustomTool` / `createAgentSession({ customTools })` | the 22 swarm tools are injected into worker sessions |
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
  auto.ts      multi-agent mode: roster derivation (incl. the goal budget), mid-run growth + the auto-assemble/self-stop state machine + the planning round's bound
  driver.ts    worker lifecycle: spawn sessions, add workers to a running pool, tick, heartbeat, wake, worktrees, shutdown
  tools.ts     the 23 agent tools (shared by workers and the main session)
  store.ts     the reliability core: atomic claim, lease, review, reservations, board, messages, goals and the scribe's merge
  planning.ts  the planning round's pure rules: proposal parsing, the dedupe key, the merge and the creation order
  scaling.ts   the pool-size rule: collapsing the agents' asks into one resize, the ceiling clamp, the shrink floor and who may be stopped
  db.ts        SQLite schema, WAL setup, typed facade over bun:sqlite
  config.ts    `.swarm/config.json` loading + role expansion
  render.ts    text rendering for the panel, task table, summary, task progress and the batch-completion summary
  agentinfo.ts pure agent-list rows: AgentInfo facts -> one fitted ASCII line per worker
  color.ts     the reminder palette: per-agent and per-status colours, host-parity visible width, control-byte sanitization
  agentnav.ts  the agent-list selection model: main-first entries, cursor movement with wrap, the marker column, row rendering
  types.ts     domain types
  web.ts       `/swarm web`: the dashboard's child process, its argument parsing and the free-port scan
web/
  server.ts    the dashboard's transport: read-only HTTP + SSE over `.swarm/swarm.db`, 127.0.0.1 only
  snapshot.ts  the pure reader: one `swarm.db` -> the frozen Snapshot JSON
  lib/         the read-only DB handle, asset path resolution and the row types
  assets/      the page itself: index.html, app.js, style.css, strings.js (zh/en) and its sample snapshot
tests/
  unit/store.test.ts           54 unit tests of atomic claim, leases and crash recovery, dependencies, review, the blackboard, reservations, messaging, the offline marker as a read-side judgement, a status that can never outlive the hold that justifies it, and the two ways an unclaimable row can be closed
  unit/auto.test.ts            59 unit tests of multi-agent mode: roster derivation, the goal budget, the planning round's bound, mid-run growth and the assemble/self-stop state machine
  unit/driver.test.ts          13 unit tests of the no-change wake edges: ten unchanged idle ticks cost ZERO model calls, ten unchanged ticks over an already-claimable row cost one rather than ten, a real change (claimable work, a peer message, a live goal, a different row set at the same count) wakes the worker on the very next tick, a HELD task keeps a bounded stepped nudge instead of one per tick, and the empty streak's stepped window parks it until a change
  unit/planning.test.ts        53 unit tests of the planning round's pure rules: the dedupe key (artifact normalization, the language-blind pairing, the false-merge guard, the union shape a merged row still recognises), proposal parsing, the merge and the fold record it leaves, the creation order and the task brief
  unit/planning-residue.test.ts  5 unit tests of the REAL goal-5 residue: every dependency the round folded must resolve to the survivor, and no row is ever minted for a reference that resolves to nothing
  unit/scaling.test.ts         18 unit tests of the pool-size rule: collapsing concurrent asks into one resize, the ceiling clamp, the floor, the shrink deferral and the cooldown
  unit/starvation.test.ts      12 unit tests of the unclaimable-ready-work rule: which ready rows no online agent can take, and the notice that must follow
  unit/coordinator-guard.test.ts 17 unit tests of the coordinator-edit guard: when a main session may be told it is doing the workers' job, when silence is the right answer, and which bash commands count as writes
  unit/goals.test.ts           14 unit tests of the goal lifecycle: the exactly-once scribe (incl. a 3-process race), the merge's idempotence, lease takeover and the bound
  unit/goal-tools.test.ts      10 unit tests of the round at the TOOL layer: swarm_goal -> swarm_propose -> swarm_claim -> swarm_plan, and a duplicate-ridden round creating one row per deliverable
  unit/tools.test.ts           13 unit tests of the worker's three contracts: swarm_wait's timeout must say END YOUR TURN (never invite invented work, and keep `wake: "timeout"`) while the constitution/bootstrap states the same rule and still refuses to stop with work in flight; a lifecycle call (renew/complete/release/fail) must drop only its OWN task's file holds instead of every reservation the caller holds; and swarm_wait must report only rows this agent could actually claim, so a row whose declared files another agent holds is NOT reported as work available
  unit/render.test.ts          49 unit tests of the panel, task table, summary, progress bar, drain summary and age formatting
  unit/agentinfo.test.ts       30 unit tests of the agent-row facts: token/cost/context compaction, sorting, line fitting and colour
  unit/color.test.ts           39 unit tests of the reminder palette, status colours, painted output, host-parity width and control-byte sanitization
  unit/agentnav.test.ts        23 unit tests of the selection model: main-first entries, cursor wrap and clamping, the marker column and row rendering
  unit/web-command-parsing.test.ts 17 unit tests of `/swarm web`'s pure surface: argument parsing, port validation, the free-port scan and the URL
  unit/web-server.test.ts      10 unit tests of the dashboard's HTTP surface: the frozen contract, the error surface, SSE change detection, read-only
  unit/web-snapshot.test.ts    11 unit tests of the snapshot reader: counts, blockedReason, the newest-first feeds and the task-size cap
  unit/web-dashboard.test.ts    1 browser test of the page's own DOM: the newest-first feeds and a group header that cannot contradict the counts chip
  unit/web-format.test.ts       6 unit tests of the page's pure presentation helper: where a long path may break, and that the transform loses nothing
  unit/index.test.ts            8 unit tests of the extension's optional host-module seams: the lazy key matcher and the completion alert, both branches
  unit/provider-config-settings-api.test.ts 11 unit tests of the provider-settings API the runtime crash depended on: no string-path `settings.get`/`set` exists, the scope handles and `flush()` the fix uses, runtime overrides that outrank globals, and the operator's installed extension source
  unit/host-free-load.test.ts   3 checks that the extension loads under `bun --no-install` in a node_modules-free tree, with a negative control
  helpers/swarm-child.ts       child-process worker used by the race tests
  unit/helpers/goal-child.ts   child-process scribe used by the cross-process planning-race test
  unit/helpers/goal5-round.ts  the real goal-5 and goal-3 proposals copied out of `.swarm/swarm.db` verbatim, the fixture the merge's hardest pairings are decided on
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

`planning` decides who splits the work. It is the one key that changes the coordinator's whole
behaviour, and it is the only one listed here that the shipped `config.example.json` predates —
copying that template verbatim is still correct, because the default applies when the key is absent:

- `"planning": "swarm"` — **the default**. The coordinator only decides HOW MANY agents the request
  needs and opens a goal (`swarm_goal`); the workers post their own split proposals (`swarm_propose`),
  the first of them to claim the goal's planning task (the *scribe*) merges and dedupes them into the
  real task graph with `swarm_plan`, and everyone claims from that graph. See
  [Multi-agent mode](#multi-agent-mode-swarm-on) for the round and what it costs.
- `"planning": "coordinator"` — the pre-2026-10-07 behaviour kept behind the flag: the coordinator
  writes the entire task list itself with `swarm_task_create` and the workers only claim from it.

Any other value falls back to `"swarm"`.

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
/swarm web            # dashboard on 127.0.0.1:8787: starts it, prints the URL; /swarm web stop ends it
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

**What `Enter` does, exactly:** it marks the target in the swarm's own list. It does **not** switch the
session pane by itself — that is the host's surface. `Alt+A` opens the host Agent Hub, which now lists
every live worker (each is created as a host subagent in `AgentRegistry.global()`,
`extension/driver.ts`), `Enter` on a worker row attaches that worker's live session to the main pane
(`Viewing agent <id>`), and `Esc` on an empty editor or a double-`←` returns to main (`Returned to main
session`). `x` in the Hub releases a worker: the driver sees it through the agent registry, drops it
from the pool and marks it `offline`, so its claim survives only until the lease expires. `/swarm
message <id> <text>` (or the `swarm_message` tool) still reaches the agent you marked without leaving
this pane.

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
   the coordinator receives standing instructions that depend on `planning`:
   - `"swarm"` (default): decide HOW MANY agents the request needs, then open the goal with
     `swarm_goal({ goal, agents })` — the coordinator does **not** write the task list. That call
     records the goal and mints its ONE planning task; the pool then starts sized to the goal's agent
     budget (at least `agents`, capped by `config.workers`), because the round's own plan is a single
     task and without that budget it would run single-threaded.
   - `"coordinator"`: decompose the request into 2–6 independent tasks with `swarm_task_create`, post a
     `DECISION`, and do not edit the workers' files itself.
   Either way the coordinator stops working on the task itself and stays available for progress
   questions.
3. Once the coordinator stops publishing tasks (a 20 s quiet period, so the roster is sized to the
   whole plan rather than to the first task of a still-running turn; in `"swarm"` mode the goal's
   agent budget sets the floor, because a live goal counts as work before any task exists), a roster
   is derived from what the tasks need (`required_capabilities`): one agent per capability, with the
   slack going to the general-capable role — except the **review-capable role**, which is added when
   `review: true` and review-required work exists and is then sized by DEMAND (the active rows that
   require `reviewer`), because one reviewer cannot audit its own work and a queue of review-capability
   rows with a single review agent would be unroutable by construction. The roster is sized to the plan
   and capped by `config.workers` — work queued behind a dependency counts, so a dependency chain does
   not serialize the run.
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

The planning round (mode `"swarm"`), in order:

1. `swarm_goal({ goal, agents })` writes the goal row and its ONE planning task in one transaction, and
   the pool starts sized to the goal's agent budget (at least `agents`, capped by `config.workers`). A
   live goal counts as work for roster sizing even before any task exists, and it is deliberately never
   reported as a stall.
2. Every worker reads the goal (`swarm_status` names it; the planning task carries the brief) and posts
   its own split with `swarm_propose` — a board `OBSERVATION` tagged `proposal` and scoped to the goal,
   so the whole swarm can read and answer it (`swarm_message` to refine another agent's proposal).
3. The first worker to `swarm_claim` the planning task is the **scribe**. `swarm_plan` then merges the
   round in ONE transaction: it refuses unless the caller still holds that claim, the goal is still
   open, and at least one proposal exists. It dedupes a deliverable by WHAT IS PRODUCED, not by the
   wording: the key is the TARGET ARTIFACT (the `files` a proposal declares, else the file names in its
   title — where a title token counts as one only if it is path-shaped or ends in a known file
   extension, so a version tag like `1.2.3` or `v1.0.beta` is not a file name and cannot make two
   deliverables one) plus the KIND of work (write/verify/fix/document/remove/refactor), read from the
   title in English or Chinese and never from the description. Two artifacts are compared only in one
   normal form — case, separators, a leading `./`, a trailing `/` or `/**` — and a directory and a file
   inside it name the same target when their names agree, so `scratch/advisory-burnrate/**`,
   `scratch/advisory-burn/rate-table.md` and `scratch/advisory-burn/` are ONE deliverable and not three.
   Identical titles always collapse, and a Chinese and an English title pair on the artifact they share.
   An unknown kind (`other`) contradicts nothing, but two KNOWN kinds that differ never fold: a fix and
   a verification of it stay two tasks even when their wording overlaps. On one artifact two WRITERS are
   always one task — an artifact has one owner — while two non-writing views of it collapse only when
   one is a section of the other, the wording is close enough, or one declares extra artifacts. Files,
   capabilities and dependencies are unioned into the survivor and the longest description is kept, and
   deliverables the pool already holds are skipped and reported. A dependency reference resolves against
   every spelling the round saw and lands on the SURVIVOR of any fold, so an agent may depend on a
   deliverable another agent phrased differently and no edge can point at a row that lost; a reference
   that resolves to nothing is REPORTED and dropped, never minted into a task of its own. The merged
   split is posted as a `DECISION` that prints every folded row beside the survivor it folded into and
   the reason, so a merge can be audited without reading the database — and the direction of every
   doubtful case is the same: a false merge loses work, a false split only costs a task. The goal is
   then marked planned.
4. The planning task completes and everyone claims the real tasks through the unchanged loop.

Exactly-once is the ATOMIC CLAIM, not timing: two agents cannot hold the planning task at once, and a
lease that expires (a scribe that died mid-round) hands it to the next claimer, who re-merges safely
because creation is idempotent against the pool.

What the round costs, and how it ends: every worker that proposes pays for its own read of the goal and
its own proposal — roughly N × a coordination round, instead of one coordination round in the
coordinator, which is the honest trade for the coordinator no longer writing the list. The round is
bounded: no plan within 10 minutes of the goal closes it as `failed`, closes its unclaimed planning task
with it, and posts a `FAIL` on the board plus a notice, so a round that cannot converge is reported
rather than spun. And the dedupe key is the deliverable — its target artifact plus the kind of work —
never the title's wording: two writers on one artifact always become ONE task, because an artifact has
one owner. What can still split is a proposal the key cannot see at all: with no declared `files` and no
file name in its title it has no artifact to match on and merges with nothing, so two far-apart
phrasings of it stay two tasks — which is what the scribe's own reading of the round is for.

The status line tracks the mode: `idle`, `planning`, `running` (`3a r0 c2 v0 d1` = online agents,
ready/claimed/review/done), `done n/m`, `stalled`, prefixed while a pool is up by the compact
progress (`SWARM 7/9 done`) and replaced once a batch drains by its headline
(`SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42`); the widget above the
editor carries a `MULTI-AGENT MODE · <phase>` header over the progress block and one rich row per
worker (state, task, branch, ctx%, tokens, cost, turns, age — see above), and keeps the drained
summary in place of the progress block; `/swarm agents` lists the roster from the store. `/swarm off`
stops running workers and persists
`"auto": false`; a swarm blocked with nothing claimable is stopped after 90 s and reported as
`stalled` instead of spinning. If the coordinator opens no goal — or, in `"coordinator"` mode, creates
no tasks — for a request that is still streaming, it is nudged once after 90 s and the mode returns to
`idle`.

Tasks that appear while no pool is running — a hand-made `/swarm task`, leftovers after `/swarm stop`
— start a pool for them on the same terms. Tasks published while a pool is running are picked up by
that pool, which grows toward them up to `config.workers`.

Reproduce the UI surface without a TUI (repeat `--command` to walk a sequence in one session):

```bash
bun run rpc:dump -- --ui --installed --command "/swarm on" --command "/swarm off" --gap 10 --seconds 40
# → setStatus statusText=MULTI-AGENT ON · idle after "on"; no MULTI-AGENT frame after "off"
```

### Pool size: the coordinator's `N` is only a starting budget

The agent count you give `swarm_goal` sizes the pool at the start; nothing is frozen there. The plan's
own growth path above raises it as `ready` work appears, so a goal that under-counted the work is
corrected while it runs instead of running the whole batch with too few peers.

Any agent can also ask for a size, and an ask is the only other way the pool grows:

```
swarm_scale({ agents: 6, reason: "5 ready tasks and 2 in flight" })
```

- **Advisory and auditable**, never a direct spawn. The request is recorded with who asked, why, the
  size before and what happened, and it is posted on the board as an `OBSERVATION` tagged `scale`. The
  answer says which of four things occurred: `accepted`, `clamped` (the ask was above the ceiling),
  `raised to N` (the live work shape keeps a floor), or `recorded, but the pool is already N`.
- The **controller is the single writer** of the pool size, and it reconciles on the tick that already
  runs (every 2 s). Several agents sensing the same shortage inside one 60 s window collapse into ONE
  resize: the decision is recomputed from scratch on every tick and the largest ask wins, so N agents
  asking for one more is one more — never N more. An ask older than 60 s is dropped as stale rather
  than applied minutes after the shape that motivated it is gone.
- `config.workers` is the **operator's ceiling**, enforced where the resize happens rather than by
  convention: a larger ask is applied clamped, and the answer says so. No agent can spend past the
  budget the operator set, whatever it asks for. The ceiling also **beats the work-shape floor**: when
  the live work wants more workers than the budget allows, the pool HOLDS at the ceiling instead of
  planning past it, and says so **once per episode** with a `pool.underBudgeted` notice. That notice is
  an edge, not a level: the work-shape floor it would report is pool-shape jitter (5/6/5/6/7 while
  nothing the operator can act on moves), so the latch ignores the floor entirely and the operator is
  told once rather than once per tick. A fresh notice needs a real edge — a ceiling the operator moved
  (`config.workers`), or the condition going away and staying away for 60 s before it comes back. A
  grow reports the workers the host **actually started**, never the requested delta.
- The pool now **shrinks** as well, which it never used to. A shrink stops only workers holding
  **nothing** — no claim, no review lease, no file reservation, and not mid-turn. Anything else defers
  the shrink, and the deferred ask stays pending so a later tick still applies it. Sizing is floored by
  the live work shape (every held task keeps a worker, one worker stays free for the next claim, one
  more while `ready` work exists) and never drops below 1 while anything is actionable — stopping the
  whole pool is `/swarm off` or the drain path, not the scaler.
- The plan states the size it believes the work needs: `swarm_plan` reports the **peak parallelism**
  (how many of the created tasks can run at once) and a **recommended agent count**, with the ceiling,
  so "was `N` right?" has an answer before anyone starts working.

What it costs: growing the pool spawns real sessions and spends real tokens, so the ceiling is a limit
rather than a target. A resize is rate-limited instead of instant — two resizes are at least 30 s
apart and an ask expires after 60 s — so a wrong `N` is corrected within a tick or two, and never
beyond `config.workers`.

### Web dashboard (`/swarm web`)

The TUI reads badly at speed, so the swarm also has a page — one command starts it and prints the URL
it actually bound:

```
/swarm web                  # start (127.0.0.1:8787 by default) and print the URL
/swarm web --port 9100      # start from a specific port instead
/swarm web status           # is it running, on which port, as which pid
/swarm web stop             # stop it and free the port
```

It runs as a **separate child process** (`bun web/server.ts`), never inside the TUI's own process, so
a slow or broken page cannot block the editor or the swarm. The page shows what the pool looks like
from the outside — the agents and what each holds, the task pool by status, the collaboration feed
(board entries, agent-to-agent messages, raw events) and the progress split — read out of the same
`.swarm/swarm.db` the swarm writes.

Local and read-only by construction: it binds `127.0.0.1` only (never a network interface), opens the
database with SQLite's read-only flag, and answers every non-GET request with 405. The command itself
changes nothing: it does not switch multi-agent mode on, does not write the database, and needs no
config key.

Honest limits, because a held port is easy to forget about:

- If the default port is taken, the next free one is used and the URL printed — never a silent
  failure. An explicit `--port` that is taken is **refused**, naming the free alternative, rather than
  quietly swapped for a port you did not ask for.
- One dashboard per swarm root: a second `/swarm web` in the same root reports the running one instead
  of starting another. Two roots can each have their own, on different ports.
- It is a reader: it renders a snapshot and cannot run, claim or change anything.
- Stop it when you are done. `/swarm web stop`, `/swarm stop` and quitting omp all kill the child —
  measured on Windows, even a hard kill of omp takes it down and leaves the port free. While it runs it
  holds one port and one read-only database handle.

## Tools (available to workers and to the main session)

| Tool | Purpose |
|---|---|
| `swarm_status` | agents online/working/idle, task counts, blocked work with its reason, board histogram |
| `swarm_tasks` | list the pool (`status`, `capability`, `mine`, `limit`) |
| `swarm_claim` | **atomic** claim; optional file reservation in the same call |
| `swarm_renew` | extend leases you hold |
| `swarm_release` | give work back with a reason (never stall silently) |
| `swarm_complete` | finish with summary/commit/files → `review` or `done` |
| `swarm_fail` | fail with a reason; a FAIL board entry is written automatically. Also closes a task nobody holds, on two grounds: its dependency can never reach `done` (permanent residue), or it has sat there for ten minutes with every dependency satisfied and NO online agent holding the capabilities it declares — a row nothing could ever claim |
| `swarm_task_create` | add work or a dependency you discovered; refuses an unknown, self- or cycle-closing dependency |
| `swarm_goal` | open a goal's planning round: you choose only HOW MANY agents it needs (`agents`), never the task list — the workers split it themselves |
| `swarm_propose` | post YOUR OWN split of an open goal onto the board (tagged `proposal`, scoped to the goal) for the scribe to merge |
| `swarm_plan` | the scribe's merge: claim the goal's planning task first, then this dedupes the round into the real task graph, posts the DECISION and marks the goal planned |
| `swarm_scale` | ask for a different pool size (`agents`, `reason`) — advisory and auditable; the controller clamps it to `config.workers`, applies it on its next tick and only ever stops idle peers |
| `swarm_task_retry` | revive a `failed`/`blocked` task (fresh attempt, cleared claim) so its dependents can be promoted; stays `blocked` while its own dependencies are unresolved |
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
fresh attempt, and the usual `sweep()` promotes its dependents once it completes. The mirror case is
residue: a task whose dependency can never reach `done` (`store.ts:deadDependencies` — a `failed`,
missing or cyclic dependency) can never be claimed either, so `fail()` closes it even for an agent
that does not hold it, as long as no agent does. A row can be impossible the other way too — every
dependency satisfied, and yet no ONLINE agent holds the capabilities it declares — so `fail()` closes
that as well once it has sat that way for `UNROUTABLE_GRACE_MS` (10 minutes), and still refuses while
any online agent could claim it. There is no delete and no archive, so those two are the only exits an
unclaimable row has.

**Lease + heartbeat.** Every claim writes `claimed_by`/`lease_until`. Any tool call and the driver's
heartbeat renew leases. A sweeper (`sweep()`) runs inside every claim and on each heartbeat: tasks
whose lease expired return to `ready` with a `task.reclaim` event, and lease-backed reservations
expire with them. A crashed agent therefore cannot wedge the pool, and a live lease is never
stolen.

**Worker loop.** After bootstrap, each idle worker is ticked only when there is something to do
(unread message, held task, claimable task matching its capabilities, or a review it may take). Idle
work is an edge too: a worker with nothing to do is woken by a **change** in the pool's live-goal
round, never by the clock, so an unchanged pool costs **zero** model calls — the operator's "idle
workers burning tokens in the background" is gone. `idleTickSeconds` now paces only the empty streak
(1x/2x/4x …, capped at 5 minutes), after which the worker is parked; parking cannot delay real work,
because the branches above fire on the first tick that it exists. The tick carries *facts*, never
decisions — task
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
bun run test                   # 476 unit tests in the 23 tracked files under tests/unit (incl. a 3-process claim race, a 3-process scribe race and a browser test)
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
seeded task-5 requires `requiredCapabilities: ["integrator"]` (`harness.ts:102`) — when the victim was
the only integrator holder (`harness.ts:55`) that task was unclaimable, the runner never reached its
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

**Both recorded runs predate swarm-side planning**: they were taken while the coordinator wrote the
task list itself, which is today's `planning: "coordinator"`. The row "the coordinator decomposed the
task — 4 tasks created by `main` before any worker existed" is a record of THAT path, kept as it was
taken. No end-to-end run of the `"swarm"` default is recorded in this file yet; what that default has
today is the unit suites (`unit/planning.test.ts` for the round's rules, `unit/goals.test.ts` including
the three-OS-process scribe race, `unit/goal-tools.test.ts` for the whole round at the tool layer) and
a real-host load check (the extension is loaded from disk against a fresh root and creates the `goals`
table). A recorded run of the new default will be added here when it exists.

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
- Multi-agent mode rides on the coordinator obeying the injected policy: a turn that ends without
  `swarm_goal` (mode `"swarm"`) or without `swarm_task_create` rows (mode `"coordinator"`) starts
  nothing — the mode nudges once after 90 s, then returns to `idle` — and only a question, a chat or
  an explanation is answered normally. Tasks you create by hand while the mode is on start a pool on
  the next tick, and a goal opened by hand does the same.
- A live goal counts as work: it keeps the pool out of the stall notice and sizes the roster on its
  own, so a goal nobody can plan is reported by the round's own bound (a `FAIL` after 10 minutes)
  rather than as `stalled`. The two are not the same latency: if the planning task was already closed
  as `failed` while the goal stayed open, the pool can look quiet for the rest of that bound before
  the `FAIL` lands — reported, but later than a stall would have been.
- Roster growth is keyed to ready work: at most one step per ready-count increase, never past
  `config.workers`, and only while the pool is running and undrained — a task published after the
  pool stopped or drained waits for the next `/swarm start` instead. Because the trigger is the ready
  count, a worker whose spawn failed is not replaced by a later growth: only new claimable work grows
  the pool. The trigger compares the ready count with the LIVE worker count (`auto.ts:429`), not with
  capability: ready work that no live worker is able to claim does not grow the pool by itself (seen
  in the pre-fix SDK run: 1 ready `integrator`-only task against 4 live workers → 0 `roster.grow`
  events; the harness now ends such a run with a `[stuck]` line instead of waiting for the timeout).
  The delta itself is measured against `max(live, planned)` (`auto.ts:433`).
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
- There is no delete or archive: residue is closed as `failed`, and `fail()` accepts a row no agent
  holds only while a dependency of it can never reach `done` (`store.ts:deadDependencies`). A task
  whose dependency is merely unfinished stays unclosable, so the exit cannot be used to skip work —
  and a pool loaded from a tree older than this one still refuses the close entirely.
- The suite covers this repo, not the extensions it runs against: the `/provider-config` crash this
  batch fixed lives in `~/.omp/agent/extensions/provider-config/index.ts`, outside the tree, so a
  green `tests/unit` run is a no-regression signal only — that the crash is gone is proven by a live
  probe against a real `Settings` instance (the legacy string-path `settings.get(...)` still throws
  `settings.get is not a function`, the shipped `lookup(...)` handle path reads `95` from
  `config.yml`, writes survive `scope.flush()` and the config file is restored), pinned in-repo by
  `tests/unit/provider-config-settings-api.test.ts`. The fix sits in the operator's install rather
  than in git: a reinstall or upgrade of OMP that rolls back `extensions/` needs it applied again.

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
