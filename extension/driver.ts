import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as zod from "@oh-my-pi/omptype/zod";
import { renderAgentInfoRows, sortAgentInfo, type AgentInfo } from "./agentinfo";
import { MAIN_ID, moveSelection, navEntries, renderNavLines } from "./agentnav";
import { expandWorkers, type WorkerSpec } from "./config";
import { goalTag, scribeVerdict } from "./planning";
import { renderPanel, type DrainSummary } from "./render";
import { canStop } from "./scaling";
import type { SwarmStore } from "./store";
import { buildSwarmTools, SWARM_TOOL_NAMES, type SwarmIdentity } from "./tools";
import type { RoleConfig, SwarmConfig, SwarmGoal, SwarmMessage, SwarmTask, TaskCounts } from "./types";

type HostSdk = ExtensionAPI["pi"];
type CreateOptions = NonNullable<Parameters<HostSdk["createAgentSession"]>[0]>;
type HostThinkingLevel = CreateOptions["thinkingLevel"];

const THINKING_LEVELS: Record<NonNullable<HostThinkingLevel>, true> = {
	inherit: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};

export type TimerApi = Pick<ExtensionContext, "setInterval" | "clearTimer">;

/**
 * The agent-list selection the widget paints and `/swarm nav` edits. It lives on the per-root
 * extension runtime (`extension/index.ts`), never in the store: it is view state, not swarm state.
 * `index` is the cursor row (main first) and `targetId` is the entry `Enter` committed to - the two
 * are independent, so the operator can walk the cursor without changing the target.
 *
 * `panelLines` NORMALISES both against the roster it just read (a worker that left must not leave
 * the cursor on a row that no longer exists, nor the target on an agent that is gone), which is why
 * it takes the object itself rather than a copy.
 */
export interface NavState {
	index: number;
	targetId: string;
}

export interface SwarmDriverDeps {
	sdk: HostSdk;
	store: SwarmStore;
	config: SwarmConfig;
	/** Swarm root: repository the workers operate on and the directory holding `.swarm/`. */
	root: string;
	z: typeof zod;
	timers: TimerApi;
	exec(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	/** Called whenever the roster changes so the host can repaint its panel. */
	onPanel(): void;
	/**
	 * Called ONCE per batch when nothing is actionable any more and at least one task of that batch
	 * finished, with the data for the completion summary. Never called twice for the same batch.
	 */
	onDrained?(summary: DrainSummary): void;
	/** Deliver a message to the main session (native `pi.sendMessage` path). */
	deliverToMain?(text: string, urgent: boolean): void;
	/**
	 * The tick's clock. Injected for the same reason `timers` is: the unit tests run the tick by hand and
	 * must not spend `idleTickSeconds` of real time to observe a stepped nudge. Left out in production.
	 */
	now?(): number;
}

/** Usage facts folded out of a worker's live session (task-32's obtainable route). */
interface WorkerUsage {
	ctx: { used: number; total: number };
	tokens: { in: number; out: number; cacheRead: number };
	costUsd: number;
}

interface WorkerRuntime {
	spec: WorkerSpec;
	session: AgentSession;
	identity: SwarmIdentity;
	worktree: string;
	turns: number;
	lastTickAt: number;
	/** Idle-wake bookkeeping: what this worker was last woken for, and how far its backoff has gone. */
	idle: IdleWakeState;
	lastError?: string;
	/** Last usage fold and its age; `#usage` refreshes it at most once per `USAGE_TTL_MS`. */
	usage?: WorkerUsage;
	usageAt?: number;
}

/**
 * The idle branch's state (one per worker). `signature` is the agent-relevant world the worker was last
 * woken for — `undefined` until the first evaluation, which only records it (a freshly bootstrapped
 * worker was just handed the whole protocol, so there is nothing to tell it). `empty` counts the idle
 * windows (paced by `idleTickSeconds`, stepped) that have passed since the last wake-up; after
 * {@link IDLE_PARK_AFTER} of them the worker is `parked` — a state the operator can read — and the
 * heartbeat keeps it online regardless, because a parked worker is idle, not dead.
 */
export interface IdleWakeState {
	signature: string | undefined;
	empty: number;
	parked: boolean;
	/** Earliest time the next idle window may advance. */
	nextAt: number;
}

export interface IdleWakeDecision {
	wake: boolean;
	state: IdleWakeState;
}

/** Idle windows with nothing new before the worker is parked. */
export const IDLE_PARK_AFTER = 3;
/** Upper bound on the idle window's stepped growth. */
export const IDLE_BACKOFF_MAX_MS = 300_000;

/**
 * Everything a worker can be prompted FOR, as one signature over the ID SETS — a different row set is a
 * change even when the counts hold still. One signature for all four reasons is what makes the tick's
 * wake decision single: an unchanged row set costs zero model calls, whichever branch would have fired.
 */
export function promptSignature(goals: SwarmGoal[], messages: SwarmMessage[], mine: SwarmTask[], ready: SwarmTask[], reviews: SwarmTask[]): string {
	const ids = (rows: readonly { id: string | number }[]) => rows.map((row) => String(row.id)).sort().join(",");
	const round = goals.map((goal) => `${goal.id}:${goal.planningTask}:${goal.status}`).join(",");
	return [`g:${round}`, `u:${ids(messages)}`, `t:${ids(mine)}`, `r:${ids(ready)}`, `v:${ids(reviews)}`].join("|");
}

/**
 * The shared edge behind {@link idleWake} and {@link stalledWake}.
 *
 * `repeat` false — a pure change edge. Time is never a reason to run a model call: an unchanged
 * signature is answered with bookkeeping only (the empty streak, the stepped window, the park).
 * `repeat` true — the state is addressed TO this worker (a task it holds, an unread message) and nothing
 * else reclaims it, so an elapsed window nudges it again, bounded by the same stepping and still woken
 * the moment the signature moves. It never parks: `#beat` renews every held task's lease
 * (store.ts `heartbeat`), so a parked worker would strand its task with no timeout left to free it.
 */
function edgeWake(state: IdleWakeState, signature: string, now: number, idleTickSeconds: number, repeat: boolean): IdleWakeDecision {
	const gap = Math.max(1, idleTickSeconds) * 1000;
	if (state.signature === undefined) {
		// First evaluation: record the state the worker's own bootstrap already described, do not wake.
		return { wake: false, state: { signature, empty: 0, parked: false, nextAt: now + gap } };
	}
	if (state.signature !== signature) {
		// The world moved. Wake now — dropping a real change is the one thing this edge must never do —
		// and give the empty streak a clean slate.
		return { wake: true, state: { signature, empty: 0, parked: false, nextAt: now + gap } };
	}
	if (now < state.nextAt) return { wake: false, state };
	const empty = state.empty + 1;
	const backoff = Math.min(gap * 2 ** (empty - 1), IDLE_BACKOFF_MAX_MS);
	const parked = !repeat && empty >= IDLE_PARK_AFTER;
	return { wake: repeat, state: { ...state, empty, parked, nextAt: now + backoff } };
}

/**
 * The idle edge, as a pure function so the contract is testable without a session: an idle worker is
 * woken by a CHANGE in agent-relevant state, never by the clock.
 *
 * The branch this replaced woke every idle worker every `idleTickSeconds` (15s by default) with the same
 * "no claimable work" prompt — a full model call per worker per window, forever, with nothing to act on,
 * which is exactly the operator's "空闲代理在后台白烧 token". An unchanged pool must cost ZERO model
 * calls, so this edge never wakes on time alone; the clock's only job is the empty streak
 * ({@link idleTickSeconds} after the last wake-up it advances, then 2x, 4x, … capped at
 * {@link IDLE_BACKOFF_MAX_MS}, and parks the worker after {@link IDLE_PARK_AFTER} of them). A change
 * wakes it at once, parked or not: a real change is never dropped, only the no-op wake-up is gone.
 */
export function idleWake(state: IdleWakeState, signature: string, now: number, idleTickSeconds: number): IdleWakeDecision {
	return edgeWake(state, signature, now, idleTickSeconds, false);
}

/** The obligation variant of {@link idleWake}: bounded cadence, no park. See {@link edgeWake}. */
export function stalledWake(state: IdleWakeState, signature: string, now: number, idleTickSeconds: number): IdleWakeDecision {
	return edgeWake(state, signature, now, idleTickSeconds, true);
}

const TICK_INTERVAL_MS = 3000;
const PANEL_INTERVAL_MS = 2000;
/**
 * The pool must hold still this long with nothing actionable before it counts as drained: a worker
 * that finished its task two ticks ago may not have claimed the next one yet.
 */
const DRAIN_SETTLE_MS = 10_000;
/** One scan covers the whole pool; the store is local and this is the same query the board uses. */
const TASK_SCAN_LIMIT = 500;
const STOP_GRACE_MS = 90_000;
const SPAWN_TIMEOUT_MS = 120_000;
/** The session-stats fold walks the transcript, so refresh it at most this often per worker. */
const USAGE_TTL_MS = 1000;
/** A branch read spawns git; the answer only moves on checkout, so hold it this long. */
const BRANCH_TTL_MS = 5000;
/**
 * The extension's own checkout. A worker's worktree is the swarm root, which need not be a git
 * repository (it is not, in the deployment that runs this repo from a subdirectory), so the git
 * facts of the code being worked on come from here when the worktree itself answers nothing.
 */
const EXTENSION_CHECKOUT = resolve(import.meta.dir, "..");

/** One slot per spawned worker: a growth step extends the exact callsign sequence the pool started. */
function roleSlots(specs: WorkerSpec[]): RoleConfig[] {
	return specs.map((spec) => ({ name: spec.role, count: 1, capabilities: spec.capabilities }));
}

/** Flatten a role shape into one slot per requested worker. */
function slotsFor(roles: RoleConfig[]): RoleConfig[] {
	const slots: RoleConfig[] = [];
	for (const role of roles) {
		for (let i = 0; i < role.count; i++) slots.push({ name: role.name, count: 1, capabilities: role.capabilities });
	}
	return slots;
}

/** Bound an await so a hung worker spawn cannot stall the rest of the swarm. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const expiry = Symbol("timeout");
	const { promise: deadline, resolve } = Promise.withResolvers<typeof expiry>();
	const timer = setTimeout(() => resolve(expiry), ms);
	try {
		const outcome = await Promise.race([promise, deadline]);
		if (outcome === expiry) throw new Error(`${what} timed out after ${Math.round(ms / 1000)}s`);
		return outcome;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The worker constitution. Workers are peers, not a manager's hands:
 * every decision (which task, when to split, what to share) lives with the agent
 * that holds the tools, and the shared database arbitrates ownership.
 */
export function workerSystemPrompt(spec: WorkerSpec, config: SwarmConfig, root: string): string {
	return [
		`You are ${spec.name}, a peer worker in a decentralized agent swarm (role: ${spec.role}).`,
		`Swarm root: ${root}. Shared state lives in .swarm/swarm.db; the whole swarm is flat — there is no manager above you.`,
		"",
		"Loop for every turn:",
		"1. swarm_inbox — read and answer peer messages.",
		"2. board_search — check FACT/DECISION entries and, above all, FAIL entries, so you never repeat a dead end.",
		"3. If you hold a task: continue it, and call swarm_renew when the work is long.",
		"4. Otherwise swarm_tasks (status=ready) and pick the best task for your capabilities; swarm_claim it. Losing the claim race is normal — pick another.",
		"If the pool has a LIVE GOAL and no real tasks yet (swarm_status names it): read the goal, post YOUR OWN split with swarm_propose, then claim the goal's planning task — the first claimer is the scribe that merges every proposal with swarm_plan.",
		"5. Before editing files that another agent might touch, swarm_reserve them. Overlap is refused; that is the point.",
		"6. Verify your work (run the tests, run the command) before swarm_complete.",
		"7. Afterwards post what you learned: FACT for verified behaviour, FAIL for dead ends, RESULT for the outcome, QUESTION when you need a peer.",
		"",
		"Rules:",
		"- Keep working while there is work you can take or that you hold; when `swarm_wait` returns with nothing changed, END YOUR TURN — the driver wakes you on the next real change (claimable work, a review you may take, an unread message, a new goal), so waiting again only spends a model call. Never end your turn while you hold unfinished work, and never stall silently.",
		"- Never touch a task another agent has claimed. If it is stuck (lease expired), it returns to the pool by itself.",
		"- If a task is too large, split it with swarm_task_create (add dependencies instead of duplicating work).",
		"- If you cannot finish, swarm_release with a reason. Never stall silently.",
		"- If the pool is the wrong size for the work, ask with swarm_scale({ agents, reason }) — the controller applies it on its next tick; never try to spawn or stop peers yourself.",
		"- Post a FAIL entry every time an approach fails; that is the cheapest gift you can give the swarm.",
		"- Two agents must not edit the same file: reservations expire with your lease, so renew them while you work.",
		"- Review tasks in `review` status are not yours to approve if you wrote them; swarm_review refuses that.",
		"- You are a host subagent only for the terminal's agent list; there is no parent agent to hand work to and you have no `yield` tool. The host's subagent note that verification belongs to a main agent does NOT apply to you: finish the task in your own turn, and verifying your own change is YOUR job.",
		"",
		`Your capabilities: ${spec.capabilities.join(", ")}. Lease: ${config.leaseSeconds}s, renewed by any tool call and by heartbeat.`,
	].join("\n");
}

/**
 * The worker's first message. Exported beside {@link workerSystemPrompt} so the pair can be pinned by a
 * test: both used to order the worker to keep looping ("Do not stop between tasks"), which cost one
 * model call per idle wait window until the driver learned to wake a worker on a change.
 */
export function workerBootstrap(spec: WorkerSpec, config: SwarmConfig): string {
	return [
		`You are starting as swarm worker ${spec.name} (role ${spec.role}).`,
		"Begin now:",
		"1. swarm_status to see the shared state.",
		"2. swarm_inbox and board_search (types FAIL, DECISION) to pick up prior knowledge.",
		"3. swarm_tasks status=ready, then swarm_claim the best match for your capabilities.",
		"If there is no claimable task but swarm_status names an OPEN GOAL, that is your first job: read the goal, post your own split with swarm_propose, then claim the goal's planning task (the first claimer is the scribe that merges every proposal with swarm_plan).",
		"4. Work the task in your working directory. Verify it. swarm_complete with a summary.",
		"5. Keep going while work exists: when a task ends, look for the next one (board, then swarm_tasks status=ready). When the pool has nothing for you, swarm_wait once; if it returns with nothing changed, end your turn — the driver wakes you when agent-relevant state changes.",
		config.review
			? "If a task you own is in review status and you are not its author, you may swarm_review it."
			: "Review is disabled for this swarm; complete tasks directly.",
	].join("\n");
}

/** What the caller wants to hear about a round the watchdog acted on. */
export interface RoundWatchHooks {
	/** One line per decision, for the driver's trace. */
	trace?(line: string): void;
	/**
	 * The operator-facing half. A round closed by the watchdog must be announced the way the bound's
	 * closures are (auto.ts's `goalBoundNotice`): the FAIL is on the board, but a round that dies
	 * outside its bound is exactly the case nobody expects, so it cannot be silent.
	 */
	closed?(goal: SwarmGoal, reason: string): void;
}

/**
 * The round watchdog: a live goal whose scribe stopped producing must not be able to hold the round
 * until the bound.
 *
 * The rule is pure ({@link scribeVerdict}); this function only feeds it the round's own facts and
 * applies the verdict - exported, so the ladder can be driven against a real store (isolated root,
 * fresh processes) without standing up a pool.
 *
 * The facts are the ones the store already keeps, so nothing new has to be written to decide: the
 * hold (`claimedBy`), how many times the round has been taken (`attempts`) and the last moment it
 * moved - a claim, an explicit `swarm_renew` or a new proposal. The driver's own beat is deliberately
 * NOT progress: it renews the lease of a session that may be hung, which is exactly the state goal-6
 * died in (claimed at +64s, silent from +363s, the bound at +601s; FACT #728).
 *
 * A `reclaim` hands the row back as `ready` (event `task.takeover`, a reason on the board), and the
 * tick's worker loop reads the workers' state AFTER this call, so the pool is woken in the same pass;
 * a `fail` closes the round with a reason minutes before the bound would have closed it silently.
 * Returns the goals that are still live.
 */
export function watchRounds(store: SwarmStore, goals: SwarmGoal[], now: number, hooks: RoundWatchHooks = {}): SwarmGoal[] {
	const live: SwarmGoal[] = [];
	for (const goal of goals) {
		const task = store.getTask(goal.planningTask);
		if (task === undefined) {
			live.push(goal);
			continue;
		}
		const lastProgressAt = Math.max(task.claimedAt ?? 0, task.updatedAt, ...store.listProposals(goal).map((proposal) => proposal.createdAt));
		const verdict = scribeVerdict({
			planningTask: task.id,
			heldBy: task.status === "claimed" ? task.claimedBy : undefined,
			attempts: task.attempts,
			lastProgressAt,
			now,
		});
		if (verdict.action === "ok") {
			live.push(goal);
			continue;
		}
		hooks.trace?.(`round ${goal.id}: ${verdict.reason}`);
		if (verdict.action === "fail") {
			const closed = store.closeStalledGoal(goal.id, verdict.reason);
			if (closed !== undefined) hooks.closed?.(closed, verdict.reason);
			continue;
		}
		if (!store.reclaimStalled(task.id, verdict.reason).ok) {
			live.push(goal);
			continue;
		}
		store.postBoard({
			type: "OBSERVATION",
			agentId: goal.createdBy,
			taskId: task.id,
			content: verdict.reason,
			tags: ["planning", goalTag(goal.id)],
		});
		live.push(goal);
	}
	return live;
}

export class SwarmDriver {
	readonly #deps: SwarmDriverDeps;
	readonly #workers = new Map<string, WorkerRuntime>();
	#started: string[] = [];
	/** Role slot per spawned worker: a growth step extends the callsign sequence where the pool left off. */
	#slots: RoleConfig[] = [];
	#running = false;
	#tickHandle: Timer | undefined;
	#heartbeatHandle: Timer | undefined;
	#panelHandle: Timer | undefined;
	/** The batch-completion alert already fired for the batch currently on the board. */
	#drained = false;
	/** Task ids of the current batch (non-terminal at start, or created while it ran). */
	#batch = new Set<string>();
	/** Every id this run has seen, so a task that appears later reads as new. */
	#seen = new Set<string>();
	/** When the pool's counts last moved, and the key they moved to: the settle window's clock. */
	#countsAt = 0;
	#countsKey = "";
	/** Driver start, for the summary's elapsed time. */
	#startedAt = 0;
	/** Branch per git cwd, re-read at most every `BRANCH_TTL_MS`; the spawn is the expensive part. */
	readonly #branches = new Map<string, { at: number; value: string | undefined }>();
	/**
	 * Host-registry subscription ({@link #watchHostRoster}): the Agent Hub can release a worker through
	 * `AgentLifecycleManager.release`, which disposes its session without asking the driver first.
	 */
	#hostRefUnsubscribe: (() => void) | undefined;
	/** Names THIS driver is disposing: their registry events must not be read as a hub release. */
	readonly #selfTearing = new Set<string>();

	constructor(deps: SwarmDriverDeps) {
		this.#deps = deps;
	}

	get running(): boolean {
		return this.#running;
	}

	/** Diagnostic trace for headless runs (`SWARM_TRACE=1 omp …`). */
	#trace(message: string): void {
		if (process.env.SWARM_TRACE !== "1") return;
		try {
			appendFileSync(join(this.#deps.store.paths.dir, "driver.log"), `${new Date().toISOString()} ${message}\n`);
		} catch {
			// tracing must never affect the swarm
		}
	}

	get workers(): { name: string; role: string; status: string; task?: string; turns: number; worktree: string }[] {
		const agents = new Map(this.#deps.store.listAgents().map((a) => [a.id, a]));
		return [...this.#workers.values()].map((worker) => ({
			name: worker.spec.name,
			role: worker.spec.role,
			status: worker.session.isStreaming ? (agents.get(worker.spec.name)?.status ?? "working") : "idle",
			task: agents.get(worker.spec.name)?.currentTask,
			turns: worker.turns,
			worktree: worker.worktree,
		}));
	}

	async start(count = this.#deps.config.workers, roles?: RoleConfig[]): Promise<string[]> {
		if (this.#running) throw new Error("swarm is already running");
		const specs = expandWorkers(this.#deps.config, count, roles);
		this.#running = true;
		this.#watchHostRoster();
		this.#openBatch();
		this.#started = [];
		this.#slots = roleSlots(specs);
		// Workers come up in the background: the caller (an extension command frame)
		// must not be blocked on N session creations, and one hung spawn must not
		// delay the rest of the swarm.
		void this.#spawnAll(specs);
		this.#tickHandle = this.#deps.timers.setInterval(() => void this.#tick(), TICK_INTERVAL_MS);
		this.#heartbeatHandle = this.#deps.timers.setInterval(() => this.#beat(), this.#deps.config.heartbeatSeconds * 1000);
		this.#panelHandle = this.#deps.timers.setInterval(() => this.#deps.onPanel(), PANEL_INTERVAL_MS);
		this.#deps.onPanel();
		return specs.map((spec) => spec.name);
	}

	/**
	 * Bring up `count` additional workers into the running pool. The callsign sequence continues where
	 * the pool left off, so grown workers never collide with the ones already registered. Clamped to
	 * the configured worker budget; returns the names it will try to start.
	 */
	async addWorkers(count: number, roles?: RoleConfig[]): Promise<string[]> {
		if (!this.#running) throw new Error("swarm is not running");
		// The offset is the number of *planned* slots, not the workers registered so far: a spawn that is
		// still in flight has already consumed its callsign, and reusing it would register two sessions
		// under one name.
		const planned = this.#slots.length;
		const room = Math.max(0, this.#deps.config.workers - planned);
		const want = Math.min(count, room);
		if (want <= 0) return [];
		const slots = [...this.#slots, ...slotsFor(roles ?? [])];
		const specs = expandWorkers(this.#deps.config, planned + want, slots).slice(planned, planned + want);
		this.#slots = slots;
		this.#trace(`grow: +${specs.length} worker(s) -> ${specs.map((spec) => spec.name).join(",")}`);
		void this.#spawnAll(specs);
		this.#deps.onPanel();
		return specs.map((spec) => spec.name);
	}

	async #spawnAll(specs: WorkerSpec[]): Promise<void> {
		for (const spec of specs) {
			if (!this.#running) return;
			try {
				await withTimeout(this.#spawn(spec), SPAWN_TIMEOUT_MS, `worker ${spec.name}: session creation`);
				this.#started.push(spec.name);
				void this.#prompt(this.#workers.get(spec.name) as WorkerRuntime, workerBootstrap(spec, this.#deps.config));
			} catch (error) {
				this.#deps.notify(
					`worker ${spec.name} failed to start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				this.#trace(`spawn ${spec.name}: failed ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.#trace(`spawn: finished, started=${this.#started.join(",") || "(none)"}`);
		this.#deps.onPanel();
	}

	/** Names of the workers that actually came up. */
	get started(): readonly string[] {
		return this.#started;
	}

	/**
	 * The workers that hold NOTHING: not streaming, no claimed task, no review lease, no reservation.
	 * This is the only set a shrink may stop — a worker holding work is never touched, and the caller
	 * defers instead.
	 */
	#stoppable(): WorkerRuntime[] {
		const { store } = this.#deps;
		const reserved = new Set(store.listReservations().map((reservation) => reservation.owner));
		return [...this.#workers.values()].filter((worker) =>
			canStop({
				streaming: worker.session.isStreaming,
				holdsClaim: store.listTasks({ status: "claimed", agent: worker.spec.name, limit: 1 }).length > 0,
				holdsReview: store.listTasks({ status: "review", agent: worker.spec.name, limit: 1 }).length > 0,
				holdsReservation: reserved.has(worker.spec.name),
			}),
		);
	}

	/** How many live workers could be stopped right now (see {@link #stoppable}). */
	idleWorkerCount(): number {
		return this.#stoppable().length;
	}

	/**
	 * Stop up to `count` workers that hold nothing, the newest first, so the surviving pool is a prefix
	 * of the spawn order — which keeps the callsign sequence (and therefore the slot list a later growth
	 * extends) aligned. Nothing has to be released: a stoppable worker holds no claim, lease or
	 * reservation by construction, so it is unregistered and disposed without a shutdown prompt.
	 * Returns the names it actually stopped (fewer than asked when fewer are free).
	 */
	async stopIdleWorkers(count: number): Promise<string[]> {
		if (count <= 0 || !this.#running) return [];
		const victims = this.#stoppable().slice(-count);
		const stopped: string[] = [];
		for (const worker of victims) {
			const name = worker.spec.name;
			this.#selfTearing.add(name);
			try {
				await worker.session.dispose();
			} catch (error) {
				this.#deps.notify(`dispose of ${name} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				this.#selfTearing.delete(name);
			}
			this.#deps.store.unregisterAgent(name);
			this.#workers.delete(name);
			stopped.push(name);
			this.#trace(`shrink: stopped ${name}`);
		}
		// Hand the freed slots back: the pool budget is measured in slots, so a later growth step must be
		// able to re-occupy the callsigns this shrink released.
		this.#slots = this.#slots.slice(0, this.#workers.size);
		this.#deps.onPanel();
		return stopped;
	}

	/**
	 * Keep the pool in step with the host's agent registry.
	 *
	 * Workers are created as host subagents in `AgentRegistry.global()` (`#spawn`), which is what lets the
	 * Agent Hub list them - and act on them: `x` in the Hub calls
	 * `AgentLifecycleManager.release(id, ref, { tombstone: true })`, which detaches the ref and disposes the
	 * session without asking the driver. The registry event is the only notice the pool gets, so the worker
	 * is dropped here rather than being prompted later on a disposed session. A release by the driver
	 * itself (`simulateCrash`, `stop`) is announced through `#selfTearing` and ignored.
	 */
	#watchHostRoster(): void {
		const registry = this.#deps.sdk.AgentRegistry?.global?.();
		if (registry === undefined) return; // a host without the registry surface keeps the previous behaviour
		this.#hostRefUnsubscribe?.();
		this.#hostRefUnsubscribe = registry.onChange((event) => {
			if (event.type !== "status_changed" && event.type !== "removed") return;
			const name = event.ref.id;
			if (this.#workers.get(name) === undefined || this.#selfTearing.has(name)) return;
			if (event.type === "status_changed" && event.ref.status !== "aborted") return;
			this.#workers.delete(name);
			this.#deps.store.setAgentStatus(name, "offline");
			this.#deps.notify(
				`worker ${name} was released from the Agent Hub; its claim survives until the lease expires`,
				"warning",
			);
			this.#trace(`host release ${name}: session disposed outside the driver`);
			this.#deps.onPanel();
		});
	}

	async #spawn(spec: WorkerSpec): Promise<void> {
		const { sdk, store, config, root, z } = this.#deps;
		this.#trace(`spawn ${spec.name}: start (worktrees=${config.worktrees})`);
		const worktree = config.worktrees ? await this.#prepareWorktree(spec) : root;
		this.#trace(`spawn ${spec.name}: worktree=${worktree}`);
		const identity: SwarmIdentity = { id: spec.name, role: spec.role, capabilities: spec.capabilities, worktree, isMain: false };
		const sessionDir = join(store.paths.sessionsDir, spec.name);
		mkdirSync(sessionDir, { recursive: true });

		const tools = buildSwarmTools({
			store,
			config,
			identity,
			z,
			wake: (to, text, urgent) => this.wake(to, text, urgent),
			onChange: () => this.#deps.onPanel(),
		});

		const thinkingLevel: HostThinkingLevel | undefined =
			config.thinkingLevel !== undefined && config.thinkingLevel in THINKING_LEVELS
				? (config.thinkingLevel as NonNullable<HostThinkingLevel>)
				: undefined;

		const { session, modelFallbackMessage } = await sdk.createAgentSession({
			cwd: worktree,
			sessionManager: sdk.SessionManager.create(worktree, sessionDir),
			// Host-visible identity. A worker must be a `sub` of the main session in
			// `AgentRegistry.global()` so the host's Agent Hub (`Alt+A`) lists it and `Enter` there can
			// focus its live session. Three options carry that, and none is optional:
			// - `agentId` gives the worker its own registry id. Without it the SDK resolves the id to
			//   `MAIN_AGENT_ID` (`sdk.ts:2135`) and the second worker would collide with the operator's
			//   own session ref.
			// - `taskDepth: 1` is what makes the SDK treat the session as a subagent (`sdk.ts:2034`);
			//   a `main`-kind session tears down the PROCESS-GLOBAL agent lifecycle when it disposes
			//   (`sdk.ts:4902`), so a worker must never be one.
			// - omitting `agentRegistry` targets `AgentRegistry.global()` (`sdk.ts:2134`) - the very
			//   registry the Hub reads (`modes/agent-hub-runtime.ts:49`). The old private
			//   `new sdk.AgentRegistry()` here is exactly why the Hub showed nobody (task-81, FACT #292).
			agentId: spec.name,
			agentDisplayName: spec.name,
			taskDepth: 1,
			parentAgentId: sdk.MAIN_AGENT_ID,
			modelPattern: config.model,
			thinkingLevel,
			appendSystemPrompt: workerSystemPrompt(spec, config, root),
			toolNames: [...new Set([...config.tools, ...SWARM_TOOL_NAMES])],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			customTools: tools,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			hasUI: false,
			interactivePrompts: false,
			bindProcessState: false,
			cacheWarming: false,
		});
		if (modelFallbackMessage) this.#deps.notify(`worker ${spec.name}: ${modelFallbackMessage}`, "warning");
		this.#trace(`spawn ${spec.name}: session ready id=${session.sessionId}`);

		// Seed the edge with the state the bootstrap prompt is about to describe (it is issued right after
		// this returns), so the worker's FIRST tick is a real comparison: a row that appears between the
		// spawn and that tick still wakes it. Leaving the signature unset would swallow exactly that wake.
		const seed = this.#workerState(spec.name, spec.capabilities);
		const runtime: WorkerRuntime = {
			spec,
			session,
			identity,
			worktree,
			turns: 0,
			lastTickAt: 0,
			idle: {
				signature: promptSignature(store.liveGoals(), seed.messages, seed.mine, seed.ready, seed.reviews),
				empty: 0,
				parked: false,
				nextAt: Date.now() + Math.max(1, config.idleTickSeconds) * 1000,
			},
		};
		this.#workers.set(spec.name, runtime);
		session.subscribe((event) => {
			if (event.type === "agent_start") {
				runtime.turns++;
			} else if (event.type === "agent_end" && event.isTerminal !== false) {
				runtime.lastTickAt = Date.now();
			}
		});
		store.registerAgent({
			id: spec.name,
			role: spec.role,
			capabilities: spec.capabilities,
			sessionId: session.sessionId,
			worktree,
			pid: process.pid,
		});
	}

	async #prepareWorktree(spec: WorkerSpec): Promise<string> {
		const { root, exec, notify, store } = this.#deps;
		const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], root).catch(() => undefined);
		if (!inside || inside.code !== 0 || inside.stdout.trim() !== "true") {
			notify(`worker ${spec.name}: not a git repository, using the shared checkout with file reservations`, "warning");
			return root;
		}
		const path = join(store.paths.worktreesDir, spec.name);
		const branch = `swarm/${spec.name.toLowerCase()}`;
		const added = await exec("git", ["worktree", "add", "-B", branch, path, "HEAD"], root).catch((error: unknown) => ({
			code: 1,
			stdout: "",
			stderr: String(error),
		}));
		if (added.code !== 0) {
			notify(`worker ${spec.name}: worktree creation failed (${added.stderr.trim() || "unknown"}), using the shared checkout`, "warning");
			return root;
		}
		return path;
	}

	#beat(): void {
		const { store, config } = this.#deps;
		for (const worker of this.#workers.values()) {
			// No status is passed: the store re-derives what the row can PROVE from its holdings
			// (working / reviewing / idle) and leaves the two declared states alone, so a status whose
			// cause is gone cannot be re-asserted by the beat loop — the mirror of the offline marker
			// (task-173, then the stale `reviewing` of task-176).
			store.heartbeat(worker.spec.name, undefined, undefined, config.leaseSeconds);
		}
		store.sweep(config.offlineAfterSeconds);
	}

	/**
	 * The state one worker can be prompted FOR, read exactly the way the tick reads it. One helper so the
	 * spawn-time seed and the tick can never disagree about what "a change" means.
	 */
	#workerState(name: string, capabilities: string[]): { messages: SwarmMessage[]; mine: SwarmTask[]; ready: SwarmTask[]; reviews: SwarmTask[] } {
		const { store, config } = this.#deps;
		const messages = store.inbox(name, 5);
		const mine = store.listTasks({ status: "claimed", agent: name, limit: 5 });
		const ready = store
			.listTasks({ status: "ready", limit: 50 })
			.filter((t) => t.requiredCapabilities.length === 0 || t.requiredCapabilities.some((cap) => capabilities.includes(cap)));
		const reviews = config.review ? store.listTasks({ status: "review", limit: 20 }).filter((t) => t.claimedBy !== name) : [];
		return { messages, mine, ready, reviews };
	}

	async #tick(): Promise<void> {
		if (!this.#running) return;
		const { store, config } = this.#deps;
		// The round a worker can join right now: a live goal is what the pool converges on before it
		// has any real task to claim. The watchdog runs FIRST, so a round it re-offers this tick is
		// already `ready` when the loop below reads the workers' state: the same pass moves the idle
		// signature and prompts the pool, instead of the wake arriving one tick later.
		const goals = watchRounds(store, store.liveGoals(), this.#deps.now?.() ?? Date.now(), {
			trace: (line) => this.#trace(line),
			closed: (goal, reason) => {
				// The same shape auto.ts uses for the bound's closures: the FAIL is on the board, and the
				// operator is told why the round died BEFORE its bound - never silent.
				const notice = `[swarm] the planning round for ${goal.id} was closed without a plan: ${reason}. Post a new goal, or create the tasks directly with swarm_task_create.`;
				this.#deps.notify(notice, "warning");
				this.#deps.deliverToMain?.(notice, true);
			},
		});
		for (const worker of this.#workers.values()) {
			if (worker.session.isStreaming) continue;
			const now = this.#deps.now?.() ?? Date.now();
			const { messages, mine, ready, reviews } = this.#workerState(worker.spec.name, worker.identity.capabilities);
			const scribe = goals.find((goal) => mine.some((task) => task.id === goal.planningTask));
			// Everything this worker can be prompted FOR, as ONE signature over the ID SETS — a different row
			// set is a change even when the counts hold still. It replaces the two state-blind branches that
			// re-prompted on every turn: the idle clock (task-145) and this one, the ready/review branch.
			const signature = promptSignature(goals, messages, mine, ready, reviews);
			const previous = worker.idle;
			// Work ADDRESSED to this worker (a task it holds, an unread message) is something it can stall
			// on, and nothing else reclaims it — the heartbeat renews every held task's lease, so no timeout
			// ever frees one — so it keeps a bounded stepped repeat. Claimable/review rows are shared
			// opportunities, a race the worker is free to lose, so they wake on the edge alone.
			const decision =
				messages.length > 0 || mine.length > 0
					? stalledWake(previous, signature, now, config.idleTickSeconds)
					: idleWake(previous, signature, now, config.idleTickSeconds);
			worker.idle = decision.state;
			if (!previous.parked && decision.state.parked) this.#trace(`idle ${worker.spec.name}: parked until the pool state changes`);
			if (!decision.wake) continue;
			await this.#prompt(worker, this.#continuationPrompt(worker, messages.length, mine.length, ready.length, reviews.length, scribe ?? goals[0], scribe !== undefined));
			worker.lastTickAt = now;
		}
		this.#checkDrained();
	}

	/**
	 * Start the batch this run is responsible for: every task that is still non-terminal right now.
	 * Tasks created while the run is going join it in `#checkDrained`, so a batch is "what this run
	 * had to do", not "whatever the board happens to hold when the last worker goes idle".
	 */
	#openBatch(): void {
		const tasks = this.#deps.store.listTasks({ limit: TASK_SCAN_LIMIT });
		this.#seen = new Set(tasks.map((task) => task.id));
		this.#batch = new Set(tasks.filter((task) => task.status !== "done" && task.status !== "failed").map((task) => task.id));
		this.#drained = false;
		this.#countsKey = "";
		this.#countsAt = Date.now();
		this.#startedAt = Date.now();
	}

	/**
	 * The batch-completion edge, evaluated on the tick that already exists - no new timer.
	 *
	 * It fires when nothing is actionable (`ready`/`claimed`/`review` are all empty), at least one
	 * member of the batch finished, and the counts have held still for `DRAIN_SETTLE_MS`. Blocked
	 * work is deliberately outside the predicate: a task whose dependency was closed as superseded
	 * stays blocked forever, so including it would mean this edge never fires at all in a pool that
	 * carries such a residue (see the 23/24/25/27/28/29 chain). The latch keeps the alert one-shot
	 * per batch; a task that shows up later opens a new one.
	 */
	#checkDrained(): void {
		const now = Date.now();
		const { store } = this.#deps;
		const counts = store.counts();
		const key = `${counts.ready}/${counts.claimed}/${counts.blocked}/${counts.review}/${counts.done}/${counts.failed}`;
		if (key !== this.#countsKey) {
			this.#countsKey = key;
			this.#countsAt = now;
		}
		let arrived = false;
		for (const task of store.listTasks({ limit: TASK_SCAN_LIMIT })) {
			const known = this.#seen.has(task.id);
			this.#seen.add(task.id);
			if (known && (task.status === "done" || task.status === "failed")) continue;
			// New to this run, or still open: either way the batch owns it.
			if (!this.#batch.has(task.id)) arrived = true;
			this.#batch.add(task.id);
		}
		if (arrived) this.#drained = false;
		if (this.#drained || counts.ready + counts.claimed + counts.review > 0) return;
		if (now - this.#countsAt < DRAIN_SETTLE_MS) return;
		const finished = [...this.#batch]
			.map((id) => store.getTask(id))
			.filter((task): task is SwarmTask => task !== undefined && (task.status === "done" || task.status === "failed"));
		// Nothing finished means the run ended without doing anything: the stall notice owns that
		// case, and "the swarm finished" would be a lie.
		if (finished.length === 0) return;
		this.#drained = true;
		this.#trace(`tick: batch drained - ${finished.length} of ${this.#batch.size} task(s) finished`);
		this.#deps.onDrained?.(this.#drainSummary(counts, finished, now));
	}

	/**
	 * The data for the one-shot completion alert. Two facts the store cannot give directly, handled
	 * honestly rather than guessed: `complete()`/`fail()` null `claimedBy`/`claimedAt`, so the
	 * finisher is joined from the event log (the only place it survives) and the duration is
	 * creation-to-completion (the working window is not recoverable). Cost is per session, never per
	 * task: it is the fold over this batch's workers, and it is omitted when the host will not say.
	 */
	#drainSummary(counts: TaskCounts, finished: SwarmTask[], now: number): DrainSummary {
		const finisher = new Map<string, string>();
		for (const event of this.#deps.store.recentEvents(200)) {
			if (event.taskId === undefined || event.agentId === undefined || finisher.has(event.taskId)) continue;
			finisher.set(event.taskId, event.agentId);
		}
		let cost = 0;
		let priced = false;
		for (const worker of this.#workers.values()) {
			const usage = this.#usage(worker, now);
			if (usage === undefined) continue;
			cost += usage.costUsd;
			priced = true;
		}
		return {
			counts,
			elapsedMs: Math.max(0, now - this.#startedAt),
			agents: this.#workers.size,
			costUsd: priced ? cost : undefined,
			tasks: finished.map((task) => ({
				id: task.id,
				title: task.title,
				status: task.status === "failed" ? "failed" : "done",
				agent: finisher.get(task.id),
				durationMs: Math.max(0, task.updatedAt - task.createdAt),
				reason: task.status === "failed" ? task.result : undefined,
			})),
		};
	}

	#continuationPrompt(worker: WorkerRuntime, messages: number, mine: number, ready = 0, reviews = 0, goal?: SwarmGoal, scribe = false): string {
		if (messages > 0) return `You have ${messages} unread peer message(s). swarm_inbox, act on them, then continue the loop.`;
		if (scribe && goal !== undefined) {
			return `You hold the planning task ${goal.planningTask} of ${goal.id}: you are the SCRIBE. Read every split proposal (board_search type=OBSERVATION tags=proposal), then call swarm_plan({ goal_id: "${goal.id}" }) to dedupe and merge them into the real task graph - or swarm_release the task with a reason if you cannot.`;
		}
		if (mine > 0) return `You still hold ${mine} task(s). Continue or swarm_release with a reason.`;
		// A live goal outranks the planning task it minted: the round must converge before the pool
		// can claim real work, so this is what an idle-but-useful worker is told to do.
		if (goal !== undefined) {
			return `The pool has an OPEN GOAL ${goal.id} and no plan yet: read it (swarm_status, then the planning task ${goal.planningTask}), post YOUR OWN split with swarm_propose, then claim the planning task ${goal.planningTask} - the first claimer is the scribe that merges every proposal with swarm_plan.`;
		}
		if (ready > 0) return `There are ${ready} claimable task(s) matching your capabilities. swarm_tasks status=ready, then swarm_claim one.`;
		if (reviews > 0) return `There are ${reviews} task(s) waiting for review. swarm_tasks status=review and review one you did not write.`;
		return `No claimable work right now (${worker.spec.name}). swarm_wait, then look again; if nothing useful exists, report the idle pool as a QUESTION on the board and stop - an empty pool is a real answer, not a gap to fill with work nobody asked for.`;
	}

	async #prompt(worker: WorkerRuntime, text: string): Promise<void> {
		try {
			this.#trace(`prompt ${worker.spec.name}: begin (${text.slice(0, 60)}…)`);
			await worker.session.prompt(text);
			worker.lastError = undefined;
			this.#trace(`prompt ${worker.spec.name}: settled`);
		} catch (error) {
			worker.lastError = error instanceof Error ? error.message : String(error);
			this.#trace(`prompt ${worker.spec.name}: failed ${worker.lastError}`);
			this.#deps.notify(`worker ${worker.spec.name} turn failed: ${worker.lastError}`, "warning");
		}
	}

	/** Deliver a peer message into the target session through the native prompt path. */
	wake(to: string, text: string, urgent: boolean): void {
		if (to === "main") {
			this.#deps.deliverToMain?.(text, urgent);
			return;
		}
		const worker = this.#workers.get(to);
		if (!worker) return;
		void (async () => {
			try {
				if (worker.session.isStreaming) {
					await worker.session.sendUserMessage(text, { deliverAs: urgent ? "steer" : "followUp" });
				} else {
					await worker.session.prompt(text);
				}
			} catch (error) {
				this.#deps.notify(`wake of ${to} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		})();
	}

	/**
	 * One `AgentInfo` per live worker, joining the runtime facts with the store's task records and
	 * the usage/branch caches. A worker whose row cannot be assembled still contributes a bare row,
	 * so a single bad session can never blank the list.
	 */
	agentInfoRows(now: number): AgentInfo[] {
		const rows: AgentInfo[] = [];
		for (const worker of this.#workers.values()) {
			const id = worker.spec.name;
			try {
				const agent = this.#deps.store.getAgent(id);
				const task = agent?.currentTask === undefined ? undefined : this.#deps.store.getTask(agent.currentTask);
				const usage = this.#usage(worker, now);
				rows.push({
					id,
					name: id,
					state: worker.session.isStreaming ? (agent?.status ?? "working") : "idle",
					taskId: task?.id,
					taskTitle: task?.title,
					taskStatus: task?.status,
					branch: this.#branch(worker.worktree),
					turns: worker.turns,
					lastActivityAt: worker.lastTickAt === 0 ? undefined : worker.lastTickAt,
					worktree: worker.worktree,
					ctx: usage?.ctx,
					tokens: usage?.tokens,
					costUsd: usage?.costUsd,
				});
			} catch (error) {
				this.#trace(`agentinfo ${id}: ${error instanceof Error ? error.message : String(error)}`);
				rows.push({ id, name: id, state: "idle" });
			}
		}
		return rows;
	}

	/**
	 * Fold a worker's session usage at most once per `USAGE_TTL_MS`. `getSessionStats()` is the host
	 * accessor task-32 proved reachable (≈0.016 ms on a 131-message transcript) and needs no
	 * transcript parsing at all; the TTL only bounds it for very long sessions and event-driven
	 * repaints. A failure keeps the previous value rather than blanking the row.
	 */
	#usage(worker: WorkerRuntime, now: number): WorkerUsage | undefined {
		if (worker.usage !== undefined && now - (worker.usageAt ?? 0) < USAGE_TTL_MS) return worker.usage;
		try {
			const stats = worker.session.getSessionStats();
			worker.usage = {
				ctx: { used: stats.contextUsage?.tokens ?? 0, total: stats.contextUsage?.contextWindow ?? 0 },
				tokens: { in: stats.tokens.input, out: stats.tokens.output, cacheRead: stats.tokens.cacheRead },
				costUsd: stats.cost,
			};
			worker.usageAt = now;
		} catch (error) {
			this.#trace(`usage ${worker.spec.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return worker.usage;
	}

	/** The branch of `worktree`, or of the extension's own checkout when that is not a repository. */
	#branch(worktree: string): string | undefined {
		const cached = this.#branches.get(worktree);
		if (cached !== undefined && Date.now() - cached.at < BRANCH_TTL_MS) return cached.value;
		let value: string | undefined;
		for (const cwd of [worktree, EXTENSION_CHECKOUT]) {
			try {
				const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
				if (result.success) {
					value = result.stdout.toString().trim();
					break;
				}
			} catch {
				// no git on PATH, or an unusable cwd: try the next candidate
			}
		}
		this.#branches.set(worktree, { at: Date.now(), value });
		return value;
	}

	/**
	 * The always-visible widget body: the run header, one rich row per worker, then the fleet
	 * counters and the board tally. With no workers it stays the iteration-2 surface verbatim, so a
	 * swarm that is simply off reads as stopped instead of as an empty list. `opts.color` is the
	 * caller's single decision (see `extension/index.ts`); false is byte-identical to the plain body.
	 */
	panelLines(width = 0, opts: { color?: boolean; nav?: NavState } = {}): string[] {
		const snapshot = this.#deps.store.snapshot(this.#deps.config.offlineAfterSeconds, this.#running);
		const lines = renderPanel(snapshot, 10, opts);
		if (this.#workers.size === 0) return lines;
		const header = lines.at(0);
		const tail = lines.slice(-2);
		if (header === undefined || tail.length < 2) return lines;
		return [header, ...this.#agentRows(this.agentInfoRows(snapshot.now), width, snapshot.now, opts), ...tail];
	}

	/**
	 * The rows between the run header and the counters: the navigable list when the caller passes a
	 * selection, the plain roster otherwise (byte-identical to the surface without it). One roster
	 * read feeds both, so the marker can never describe a different frame than the rows it sits in.
	 *
	 * The caller's selection is normalised in place against THIS roster: `moveSelection(index, 0, n)`
	 * clamps a cursor that outlived its row, and a target whose agent is gone falls back to main - so
	 * the widget can never paint a cursor past the last row nor a `*` on an entry that left.
	 */
	#agentRows(rows: AgentInfo[], width: number, now: number, opts: { color?: boolean; nav?: NavState }): string[] {
		const nav = opts.nav;
		if (nav === undefined) return renderAgentInfoRows(rows, { width, now, color: opts.color });
		const entries = navEntries(sortAgentInfo(rows), { id: MAIN_ID });
		nav.index = moveSelection(nav.index, 0, entries.length);
		if (!entries.some((entry) => entry.id === nav.targetId)) nav.targetId = entries[0]?.id ?? MAIN_ID;
		return renderNavLines(entries, {
			selectedIndex: nav.index,
			currentTargetId: nav.targetId,
			width,
			now,
			color: opts.color,
		});
	}

	/**
	 * Make one worker behave like a crashed process: its session is torn down
	 * without releasing anything, so its claim survives only until the lease
	 * expires and the sweeper reclaims it. Used by the integration run and by an
	 * operator testing recovery.
	 */
	async simulateCrash(name: string): Promise<boolean> {
		const worker = this.#workers.get(name);
		if (!worker) return false;
		this.#workers.delete(name);
		this.#selfTearing.add(name);
		try {
			worker.session.abort();
		} catch {
			// the session may already be idle
		}
		try {
			await worker.session.dispose();
		} catch {
			// disposal failures must not stop the simulation
		} finally {
			this.#selfTearing.delete(name);
		}
		this.#deps.store.setAgentStatus(name, "offline");
		this.#trace(`crash ${name}: session disposed, held work left to expire`);
		this.#deps.onPanel();
		return true;
	}

	async stop(reason = "swarm stopped"): Promise<void> {
		if (!this.#running) return;
		this.#running = false;
		for (const handle of [this.#tickHandle, this.#heartbeatHandle, this.#panelHandle]) {
			if (handle !== undefined) this.#deps.timers.clearTimer(handle);
		}
		const shutdownPrompt = `${reason}. Finish the current step: if you hold a task, swarm_release it with a reason (or swarm_complete it if it is finished and verified), post a final RESULT/OBSERVATION to the board, then stop.`;
		for (const worker of this.#workers.values()) {
			try {
				if (worker.session.isStreaming) await worker.session.sendUserMessage(shutdownPrompt, { deliverAs: "followUp" });
				else await worker.session.prompt(shutdownPrompt);
			} catch {
				// a worker that cannot take the shutdown prompt is disposed below
			}
		}
		const deadline = Date.now() + STOP_GRACE_MS;
		while (Date.now() < deadline && [...this.#workers.values()].some((w) => w.session.isStreaming)) {
			await Bun.sleep(500);
		}
		for (const worker of this.#workers.values()) {
			this.#deps.store.unregisterAgent(worker.spec.name);
			this.#selfTearing.add(worker.spec.name);
			try {
				await worker.session.dispose();
			} catch (error) {
				this.#deps.notify(`dispose of ${worker.spec.name} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				this.#selfTearing.delete(worker.spec.name);
			}
		}
		this.#workers.clear();
		this.#slots = [];
		this.#hostRefUnsubscribe?.();
		this.#hostRefUnsubscribe = undefined;
		this.#deps.onPanel();
	}
}
