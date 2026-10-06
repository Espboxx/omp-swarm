/**
 * Multi-agent mode: `/swarm on` turns the session into a coordinator.
 *
 * The user types a task in the normal prompt; the `input` hook marks a planning
 * window, the `before_agent_start` hook injects the coordinator policy into that
 * same turn, and this controller watches the shared database. As soon as the
 * coordinator publishes tasks, the roster is derived from what they need, the
 * workers are started, and once everything is terminal the swarm stops itself
 * and reports back into the main session.
 *
 * The controller owns no timers: the host calls `tick()` every `AUTO_TICK_MS`,
 * and tests call it directly.
 */
import type { SwarmStore } from "./store";
import type { RoleConfig, SwarmConfig, SwarmTask, TaskCounts } from "./types";

export type AutoPhase = "off" | "idle" | "planning" | "nudging" | "running" | "done" | "stalled";

export interface AutoDeps {
	store: SwarmStore;
	config: SwarmConfig;
	isDriverRunning(): boolean;
	/** Live workers in the pool (sessions that came up), regardless of what they are doing. */
	workerCount(): number;
	/**
	 * Bring up `count` workers with this role shape. Callers pass the roster for the *new* workers
	 * only; the host decides whether that means starting a pool or adding to a running one.
	 */
	startSwarm(roles: RoleConfig[], count: number): Promise<string[]>;
	stopSwarm(reason: string): Promise<void>;
	/** `ctx.isIdle() === false`: the main session is streaming a turn right now. */
	isMainBusy(): boolean;
	/** Inject text into the running main turn (`deliverAs: "steer"`). */
	nudgeToMain(text: string): void;
	/** Deliver a notice to the main session (`deliverAs: "followUp"`). */
	notifyMain(text: string): void;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	onChange(): void;
	now(): number;
	onEvent?(type: string, data?: Record<string, unknown>): void;
}

export interface AutoOptions {
	nudgeMs?: number;
	giveUpMs?: number;
	stallMs?: number;
	pendingWindowMs?: number;
	/** Quiet period after the last new task before the pool is assembled. */
	settleMs?: number;
}

export const AUTO_TICK_MS = 2000;
const PLAN_NUDGE_MS = 90_000;
const PLAN_GIVEUP_MS = 180_000;
const STALL_MS = 90_000;
const PENDING_TURN_WINDOW_MS = 10_000;
/**
 * A coordinator publishes its tasks one tool call at a time, and `isIdle()` is briefly true
 * between those calls. Starting on the first task would size the whole pool to a partial plan,
 * so the pool waits for a quiet period instead.
 */
const START_SETTLE_MS = 20_000;

/** Roles the swarm needs for these tasks: one agent per required capability, sized to the plan. */
export function planRoster(tasks: SwarmTask[], config: SwarmConfig): RoleConfig[] {
	const active = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
	if (active.length === 0) return [];
	const needed = new Set<string>();
	for (const task of active) for (const cap of task.requiredCapabilities) needed.add(cap);
	if (needed.size === 0) needed.add("general");
	if (config.review && active.some((t) => t.review.required)) needed.add("reviewer");
	const ordered = [...needed].sort((a, b) => (a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b)));
	// Sized to the whole plan, capped by the worker budget: work that is `blocked` behind a dependency
	// is still this plan's work, and a pool sized only to what is ready right now serializes the run.
	const budget = Math.max(1, Math.min(config.workers, active.length));
	// One agent per needed capability, capped by the worker budget; the slack goes to the
	// general-capable role so a wide pool stays cooperative rather than single-threaded.
	const roster = ordered.slice(0, Math.max(1, budget)).map((cap) => {
		const named = config.roles.find((role) => role.name === cap);
		const capabilities = named?.capabilities ?? (cap === "general" ? ["general"] : [cap, "general"]);
		return { name: cap, count: 1, capabilities };
	});
	const general = roster.find((role) => (role.capabilities ?? []).includes("general")) ?? roster[0];
	if (general) general.count += budget - roster.length;
	return roster;
}

/** Trim a desired roster down to `delta` workers, keeping the plan's role order. */
function takeWorkers(desired: RoleConfig[], delta: number): RoleConfig[] {
	const out: RoleConfig[] = [];
	let remaining = delta;
	for (const role of desired) {
		if (remaining <= 0) break;
		const take = Math.min(role.count, remaining);
		if (take > 0) out.push({ ...role, count: take });
		remaining -= take;
	}
	return out;
}

export const MODE_POLICY = [
	"[MULTI-AGENT MODE] You are the coordinator of a peer swarm; the workers execute.",
	"The user's message is a task for the swarm. Do this, in this order:",
	"1. Decompose it into 2-6 independent tasks and create each with swarm_task_create:",
	"   - title: imperative one-liner;",
	"   - description: the deliverable, the exact command that proves it works (test/build/run), and the files it touches;",
	'   - required_capabilities: ["general"] for implementation, ["reviewer"] for audit work, ["integrator"] for a task that merges results;',
	"   - dependencies: ids of tasks that must finish first; review_required: true for risky work.",
	"2. Post one board_post type=DECISION summarizing the split (one line per task).",
	"3. Then STOP working on the task yourself: do not edit the files the workers own. The swarm starts automatically as soon as tasks exist.",
	"4. Stay available: tell the user the plan, and answer progress questions with swarm_status / swarm_tasks / /swarm board.",
	"If the user's message is a question, chat, or work that cannot be split, ignore this block and answer normally - do not create tasks.",
].join("\n");

export const MODE_NOTICE =
	"MULTI-AGENT MODE: this request is executed by a peer swarm. Publish the plan with swarm_task_create and do not edit the files yourself - the workers start automatically.";

export const NUDGE_TEXT =
	"[swarm] no tasks exist yet for the user's request. Create them now with swarm_task_create (2-6 tasks, required_capabilities general/reviewer/integrator) so the swarm can start; if the request cannot be split, say so instead.";

const drainNotice = (counts: TaskCounts): string =>
	`[swarm] the swarm finished: ${counts.done} task(s) done, ${counts.failed} failed. Run /swarm board for details, then report the outcome to the user.`;

const stallNotice = (counts: TaskCounts): string =>
	`[swarm] the swarm stalled: ${counts.blocked} task(s) blocked with no claimable work. Workers were stopped; fix the dependencies or run /swarm start manually.`;

export class AutoController {
	readonly #deps: AutoDeps;
	readonly #nudgeMs: number;
	readonly #giveUpMs: number;
	readonly #stallMs: number;
	readonly #pendingWindowMs: number;
	readonly #settleMs: number;
	#phase: AutoPhase = "off";
	#knownIds = new Set<string>();
	/** A task appeared while no pool was running: a pool is owed for it. */
	#pendingStart = false;
	#lastTaskAt = 0;
	#blockedSince: number | undefined;
	#drained = false;
	#plannedAt = 0;
	#pendingUntil = 0;
	#ticking = false;
	/**
	 * Ready count the current pool was sized for, and the workers it was sized to. Growth is throttled
	 * to one step per ready-count increase, and its delta is measured against the planned pool rather
	 * than the registered one: a spawn that is still coming up must neither trigger growth on its own
	 * nor be double-counted by the next step.
	 */
	#lastGrowthReady = 0;
	#plannedWorkers = 0;

	constructor(deps: AutoDeps, options: AutoOptions = {}) {
		this.#deps = deps;
		this.#nudgeMs = options.nudgeMs ?? PLAN_NUDGE_MS;
		this.#giveUpMs = options.giveUpMs ?? PLAN_GIVEUP_MS;
		this.#stallMs = options.stallMs ?? STALL_MS;
		this.#pendingWindowMs = options.pendingWindowMs ?? PENDING_TURN_WINDOW_MS;
		this.#settleMs = options.settleMs ?? START_SETTLE_MS;
	}

	get phase(): AutoPhase {
		return this.#phase;
	}

	get enabled(): boolean {
		return this.#phase !== "off";
	}

	/** Turn the mode on in memory. Persistence is the caller's job. */
	enable(): void {
		this.#knownIds = new Set(this.#deps.store.listTasks({ limit: 500 }).map((t) => t.id));
		this.#pendingStart = false;
		this.#lastTaskAt = 0;
		this.#blockedSince = undefined;
		this.#drained = false;
		this.#lastGrowthReady = 0;
		this.#plannedWorkers = 0;
		this.#setPhase("idle");
	}

	async disable(): Promise<void> {
		if (this.#deps.isDriverRunning()) await this.#deps.stopSwarm("multi-agent mode disabled");
		this.#plannedWorkers = 0;
		this.#lastGrowthReady = 0;
		this.#setPhase("off");
		this.#deps.onChange();
	}

	/** A real user submission arrived: this is the task the swarm should pick up. */
	noteTask(text: string): void {
		if (!this.enabled || this.#deps.isDriverRunning()) return;
		if (text.trimStart().startsWith("/")) return; // a slash command is not a task
		this.#plannedAt = this.#deps.now();
		this.#pendingUntil = this.#deps.now() + this.#pendingWindowMs;
		this.#setPhase("planning");
	}

	/** Whether the turn that is about to start is the one carrying the task. */
	claimsTurn(prompt: string): boolean {
		void prompt; // `event.prompt` may be expanded differently; the 10s window is the trigger identity
		if (!this.enabled) return false;
		if (this.#phase !== "planning" && this.#phase !== "nudging") return false;
		if (this.#phase === "planning" && this.#deps.now() > this.#pendingUntil) {
			this.#setPhase("idle");
			return false;
		}
		return true;
	}

	policy(): string {
		return MODE_POLICY;
	}

	notice(): string {
		return MODE_NOTICE;
	}

	async tick(): Promise<void> {
		if (this.#ticking || this.#phase === "off") return;
		this.#ticking = true;
		try {
			const { store, config } = this.#deps;
			const tasks = store.listTasks({ limit: 500 });
			const counts = store.counts();
			const actionable = counts.ready + counts.claimed + counts.review;

			// Auto-start: the coordinator publishes tasks (or the operator seeds them) and the pool
			// assembles once they stop arriving, so the roster is sized to the whole plan. A task
			// created mid-turn must not fix the pool size for the entire run.
			if (!this.#deps.isDriverRunning()) {
				const newIds = tasks.filter((t) => !this.#knownIds.has(t.id));
				if (newIds.length > 0) {
					this.#knownIds = new Set(tasks.map((t) => t.id));
					this.#lastTaskAt = this.#deps.now();
					if (newIds.some((t) => t.status !== "done" && t.status !== "failed")) this.#pendingStart = true;
				}
			}
			if (
				this.#pendingStart &&
				!this.#deps.isDriverRunning() &&
				!this.#deps.isMainBusy() &&
				this.#deps.now() - this.#lastTaskAt >= this.#settleMs
			) {
				const roster = planRoster(tasks, config);
				if (roster.length > 0) {
					const size = roster.reduce((n, role) => n + role.count, 0);
					this.#blockedSince = undefined;
					this.#setPhase("running", { roles: roster.map((role) => role.name) });
					try {
						await this.#deps.startSwarm(roster, size);
						this.#pendingStart = false;
						// This pool is sized for the work that is ready now; only MORE ready work grows it.
						this.#plannedWorkers = size;
						this.#lastGrowthReady = counts.ready;
					} catch (error) {
						// A pool that refuses to start must not wedge the mode in `running`, and the
						// work it owed is still owed.
						this.#lastTaskAt = this.#deps.now();
						this.#setPhase("idle");
						this.#deps.notify(`swarm failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					this.#deps.onChange();
					return;
				}
			}

			// Planning window: the coordinator was handed the task; nudge it if it stalls.
			if (this.#phase === "planning") {
				if (this.#deps.now() - this.#plannedAt >= this.#nudgeMs) {
					if (this.#deps.isMainBusy()) {
						this.#setPhase("nudging");
						this.#deps.nudgeToMain(NUDGE_TEXT);
					} else {
						this.#setPhase("idle");
					}
				}
			} else if (this.#phase === "nudging" && this.#deps.now() - this.#plannedAt >= this.#giveUpMs) {
				this.#setPhase("idle");
			}

			// Drain: the driver says every task is terminal.
			if (this.#drained && this.#phase === "running") {
				this.#drained = false;
				this.#setPhase("done");
				this.#deps.notifyMain(drainNotice(counts));
				await this.#deps.stopSwarm("all tasks finished");
				this.#plannedWorkers = 0;
				this.#lastGrowthReady = 0;
				this.#setPhase("idle");
				this.#deps.onChange();
			}

			// Roster growth: work published after the pool was sized (the coordinator adding tasks, a
			// worker splitting an oversized one) must not queue behind a pool too small for it. Grow
			// only while running, only toward the plan, only up to the worker budget, and only after the
			// ready count rises above what the pool was already sized for, so a spawn still coming up
			// cannot trigger a growth of its own.
			if (this.#phase === "running" && !this.#drained && this.#deps.isDriverRunning()) {
				const live = this.#deps.workerCount();
				if (counts.ready > live && counts.ready > this.#lastGrowthReady && this.#plannedWorkers < config.workers) {
					const desired = planRoster(tasks, config);
					const target = Math.min(config.workers, desired.reduce((n, role) => n + role.count, 0));
					const pool = Math.max(live, this.#plannedWorkers);
					const deltaRoles = takeWorkers(desired, target - pool);
					const delta = deltaRoles.reduce((n, role) => n + role.count, 0);
					if (delta > 0) {
						// Throttle first: a growth that throws must not retry on every tick, only when
						// more ready work appears.
						this.#lastGrowthReady = counts.ready;
						try {
							await this.#deps.startSwarm(deltaRoles, delta);
							this.#plannedWorkers = pool + delta;
							this.#deps.notify(`swarm grew by ${delta} worker(s) toward ${counts.ready} ready task(s)`);
							this.#deps.onEvent?.("roster.grow", {
								workers: pool + delta,
								ready: counts.ready,
								roles: deltaRoles.map((role) => role.name),
							});
						} catch (error) {
							// A growth that throws must never wedge the phase; a later ready increase retries it.
							this.#deps.notify(`swarm growth failed: ${error instanceof Error ? error.message : String(error)}`, "error");
						}
						this.#deps.onChange();
					}
				}
			}

			// Stall: a running swarm with blocked work and nothing claimable.
			if (this.#phase === "running" && this.#deps.isDriverRunning()) {
				if (actionable === 0 && counts.blocked > 0) {
					this.#blockedSince ??= this.#deps.now();
					if (this.#deps.now() - this.#blockedSince >= this.#stallMs) {
						const notice = stallNotice(counts);
						this.#deps.notify(notice, "warning");
						this.#deps.notifyMain(notice);
						await this.#deps.stopSwarm("swarm stalled: tasks blocked with no claimable work");
						this.#plannedWorkers = 0;
						this.#lastGrowthReady = 0;
						this.#setPhase("stalled");
					}
				} else {
					this.#blockedSince = undefined;
				}
			}

			this.#deps.onChange();
		} finally {
			this.#ticking = false;
		}
	}

	/** Called by the driver once the whole pool is terminal. */
	noteDrained(): void {
		this.#drained = true;
	}

	statusText(): string | undefined {
		const counts = this.#deps.store.counts();
		switch (this.#phase) {
			case "off":
				return undefined;
			case "idle":
				// A manual `/swarm start` under an enabled mode still needs its live counts.
				return this.#deps.isDriverRunning() ? this.#runningText() : "MULTI-AGENT ON · idle";
			case "planning":
			case "nudging":
				return "MULTI-AGENT ON · planning";
			case "running":
				return this.#runningText();
			case "done":
				return `MULTI-AGENT ON · done ${counts.done}/${counts.done + counts.failed}`;
			case "stalled":
				return "MULTI-AGENT ON · stalled";
		}
	}

	header(): string[] {
		return this.#phase === "off" ? [] : [`MULTI-AGENT MODE · ${this.#phase}`];
	}

	dispose(): void {
		this.#phase = "off";
		this.#knownIds = new Set();
		this.#pendingStart = false;
		this.#lastTaskAt = 0;
		this.#blockedSince = undefined;
		this.#drained = false;
		this.#lastGrowthReady = 0;
		this.#plannedWorkers = 0;
	}

	#setPhase(phase: AutoPhase, data?: Record<string, unknown>): void {
		this.#phase = phase;
		this.#deps.onEvent?.(`swarm.auto.${phase}`, data);
	}

	#runningText(): string {
		const counts = this.#deps.store.counts();
		const snapshot = this.#deps.store.snapshot(this.#deps.config.offlineAfterSeconds, this.#deps.isDriverRunning());
		const online = snapshot.agents.filter((agent) => agent.status !== "offline").length;
		return `MULTI-AGENT ON · ${online}a r${counts.ready} c${counts.claimed} v${counts.review} d${counts.done}`;
	}
}
