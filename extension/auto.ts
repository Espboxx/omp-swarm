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
import { reconcilePool } from "./scaling";
import { findStarvation } from "./starvation";
import type { RoleConfig, SwarmConfig, SwarmGoal, SwarmTask, TaskCounts } from "./types";

export type AutoPhase = "off" | "idle" | "planning" | "nudging" | "running" | "done" | "stalled";

export interface AutoDeps {
	store: SwarmStore;
	config: SwarmConfig;
	isDriverRunning(): boolean;
	/** Live workers in the pool (sessions that came up), regardless of what they are doing. */
	workerCount(): number;
	/** Live workers holding NO claim, review lease or reservation: the only stoppable ones. */
	poolIdle(): number;
	/**
	 * Bring up `count` workers with this role shape. Callers pass the roster for the *new* workers
	 * only; the host decides whether that means starting a pool or adding to a running one.
	 */
	startSwarm(roles: RoleConfig[], count: number): Promise<string[]>;
	/** Stop up to `count` workers that hold nothing; returns the names it actually stopped. */
	shrinkSwarm(count: number): Promise<string[]>;
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
	/** Minimum gap between two pool resizes (the thrash guard). */
	scaleCooldownMs?: number;
	/** An agent's scale request older than this is stale and is dropped, never applied later. */
	scaleWindowMs?: number;
}

export const AUTO_TICK_MS = 2000;
const PLAN_NUDGE_MS = 90_000;
const PLAN_GIVEUP_MS = 180_000;
const STALL_MS = 90_000;
const PENDING_TURN_WINDOW_MS = 10_000;
/**
 * The pool resizes at most once per cooldown window, and an agent's ask expires after the request
 * window: several agents sensing the same shortage collapse into ONE resize (the largest ask), and a
 * stale ask can never resize a pool minutes after the shape that motivated it has gone.
 */
const SCALE_COOLDOWN_MS = 30_000;
const SCALE_WINDOW_MS = 60_000;
/**
 * A coordinator publishes its tasks one tool call at a time, and `isIdle()` is briefly true
 * between those calls. Starting on the first task would size the whole pool to a partial plan,
 * so the pool waits for a quiet period instead.
 */
const START_SETTLE_MS = 20_000;

/**
 * Roles the swarm needs for this work: one agent per required capability, sized to the plan.
 *
 * `goalAgents` is the budget a live planning round asked for (`swarm_goal`). A goal is work the pool
 * owes even before any task exists — that is the point of swarm-side planning — so it sizes the
 * roster on its own, and it raises the size when the round's one planning task would otherwise
 * shrink the pool to a single worker.
 */
export function planRoster(tasks: SwarmTask[], config: SwarmConfig, goalAgents = 0): RoleConfig[] {
	const active = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
	if (active.length === 0 && goalAgents <= 0) return [];
	const needed = new Set<string>();
	for (const task of active) for (const cap of task.requiredCapabilities) needed.add(cap);
	if (needed.size === 0) needed.add("general");
	if (config.review && active.some((t) => t.review.required)) needed.add("reviewer");
	const ordered = [...needed].sort((a, b) => (a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b)));
	// Sized to the whole plan, capped by the worker budget: work that is `blocked` behind a dependency
	// is still this plan's work, and a pool sized only to what is ready right now serializes the run.
	const wanted = Math.max(active.length, goalAgents);
	const budget = Math.max(1, Math.min(config.workers, wanted));
	// One agent per needed capability, capped by the worker budget; the slack goes to the
	// general-capable role so a wide pool stays cooperative rather than single-threaded.
	const roster = ordered.slice(0, Math.max(1, budget)).map((cap) => {
		const named = config.roles.find((role) => role.name === cap);
		const capabilities = named?.capabilities ?? (cap === "general" ? ["general"] : [cap, "general"]);
		return { name: cap, count: 1, capabilities };
	});
	// A REVIEW-capable row cannot always be taken by the review agent the pool already has: an auditor
	// must not audit its own work ("do not claim this task if you authored its dependency" — the rule the
	// pool honours), so a queue of review-capability rows with a single review agent is unroutable BY
	// CONSTRUCTION. That is the deadlock that left task-95/task-99 `ready` with an EMPTY eligible set while
	// three general agents idled. So this ONE capability is sized by demand — the active rows that require
	// it — bounded by the same budget; a second reviewer is a non-author of every dependency the first one
	// wrote, which is what routability needs. Every other capability stays at one agent with the slack
	// going to the general role, exactly as before. DEMAND here is rows that REQUIRE the `reviewer`
	// capability — the claim-side deadlock. A row that merely needs its RESULT reviewed is served by the
	// review flow, where one reviewer normally suffices, so review-required rows do not inflate the role.
	const reviewer = roster.find(
		(role) => role.name === "reviewer" || ((role.capabilities ?? []).includes("reviewer") && role.name !== "general"),
	);
	if (reviewer !== undefined) {
		const demand = active.filter((task) => task.requiredCapabilities.includes("reviewer")).length;
		reviewer.count += Math.min(Math.max(0, budget - roster.length), Math.max(0, demand - 1));
	}
	const general = roster.find((role) => (role.capabilities ?? []).includes("general")) ?? roster[0];
	if (general) general.count += budget - roster.reduce((n, role) => n + role.count, 0);
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

/**
 * The coordinator policy of the LEGACY path (`planning: "coordinator"`): the coordinator writes the
 * whole task list itself. Kept verbatim behind the flag so the old behaviour stays reachable and
 * provably unchanged.
 */
export const COORDINATOR_POLICY = [
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

/**
 * The coordinator policy of the DEFAULT path (`planning: "swarm"`): the coordinator sizes the pool
 * and nothing else. The workers evaluate the split themselves, negotiate it, create the tasks and
 * claim them; the coordinator must NOT pre-write the task list.
 */
export const SWARM_POLICY = [
	"[MULTI-AGENT MODE] You are the coordinator of a peer swarm; the workers evaluate and execute the work.",
	"The user's message is a task for the swarm. Do this, in this order:",
	"1. Decide HOW MANY agents it needs (1 to your worker budget). Do NOT write the task list yourself:",
	"   the workers read the goal, each propose their own split, merge it and claim the result.",
	"2. Call swarm_goal({ goal, agents }) ONCE with the user's request (carry every constraint they gave)",
	"   and that agent count. It opens the planning round and starts the pool.",
	"3. Tell the user the goal and the agent count, then STOP working on the task yourself: do not edit the files the workers own.",
	"4. Stay available: answer progress questions with swarm_status / swarm_tasks / /swarm board.",
	"If the user's message is a question, chat, or work that cannot be split, ignore this block and answer normally - do not call swarm_goal.",
].join("\n");

export const COORDINATOR_NOTICE =
	"MULTI-AGENT MODE: this request is executed by a peer swarm. Publish the plan with swarm_task_create and do not edit the files yourself - the workers start automatically.";

export const SWARM_NOTICE =
	"MULTI-AGENT MODE: this request is executed by a peer swarm. Post it with swarm_goal (you only choose how many agents) and do not edit the files yourself - the workers split it, claim it and start automatically.";

export const COORDINATOR_NUDGE =
	"[swarm] no tasks exist yet for the user's request. Create them now with swarm_task_create (2-6 tasks, required_capabilities general/reviewer/integrator) so the swarm can start; if the request cannot be split, say so instead.";

export const SWARM_NUDGE =
	"[swarm] no goal exists yet for the user's request. Call swarm_goal({ goal, agents }) now - decide only how many agents; the workers evaluate the split and claim it themselves. If the request cannot be split, say so instead.";

const drainNotice = (counts: TaskCounts): string =>
	`[swarm] the swarm finished: ${counts.done} task(s) done, ${counts.failed} failed. Run /swarm board for details, then report the outcome to the user.`;

const stallNotice = (counts: TaskCounts): string =>
	`[swarm] the swarm stalled: ${counts.blocked} task(s) blocked with no claimable work. Workers were stopped; fix the dependencies or run /swarm start manually.`;

const goalBoundNotice = (goal: SwarmGoal): string =>
	`[swarm] the planning round for ${goal.id} hit its bound with no plan, so the goal is closed as failed - nothing is spinning. Post a new goal, or create the tasks directly with swarm_task_create.`;

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
	/** When the pool last changed size, for the resize cooldown. */
	#lastResizeAt = 0;
	/**
	 * Identity of the last reported starvation condition (ready rows nobody online can claim). Held so
	 * a tick repeating the same condition stays silent, and cleared the moment it stops so the next
	 * occurrence — or a different row set — is reported again.
	 */
	#unclaimableKey: string | undefined;
	/**
	 * Identity of the last reported under-budget shape (`floor:ceiling`), so the operator is told once
	 * that the work wants more workers than `config.workers` allows, and told again only if it changes.
	 */
	#underBudgetedKey: string | undefined;
	readonly #scaleCooldownMs: number;
	readonly #scaleWindowMs: number;

	constructor(deps: AutoDeps, options: AutoOptions = {}) {
		this.#deps = deps;
		this.#nudgeMs = options.nudgeMs ?? PLAN_NUDGE_MS;
		this.#giveUpMs = options.giveUpMs ?? PLAN_GIVEUP_MS;
		this.#stallMs = options.stallMs ?? STALL_MS;
		this.#pendingWindowMs = options.pendingWindowMs ?? PENDING_TURN_WINDOW_MS;
		this.#settleMs = options.settleMs ?? START_SETTLE_MS;
		this.#scaleCooldownMs = options.scaleCooldownMs ?? SCALE_COOLDOWN_MS;
		this.#scaleWindowMs = options.scaleWindowMs ?? SCALE_WINDOW_MS;
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
		this.#lastResizeAt = 0;
		this.#unclaimableKey = undefined;
		this.#underBudgetedKey = undefined;
		this.#setPhase("idle");
	}

	async disable(): Promise<void> {
		if (this.#deps.isDriverRunning()) await this.#deps.stopSwarm("multi-agent mode disabled");
		this.#plannedWorkers = 0;
		this.#lastGrowthReady = 0;
		this.#lastResizeAt = 0;
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
		return this.#deps.config.planning === "coordinator" ? COORDINATOR_POLICY : SWARM_POLICY;
	}

	notice(): string {
		return this.#deps.config.planning === "coordinator" ? COORDINATOR_NOTICE : SWARM_NOTICE;
	}

	/** The nudge that goes to a coordinator which never opened a planning round. */
	#nudgeText(): string {
		return this.#deps.config.planning === "coordinator" ? COORDINATOR_NUDGE : SWARM_NUDGE;
	}

	async tick(): Promise<void> {
		if (this.#ticking || this.#phase === "off") return;
		this.#ticking = true;
		try {
			const { store, config } = this.#deps;
			const tasks = store.listTasks({ limit: 500 });
			const counts = store.counts();
			const actionable = counts.ready + counts.claimed + counts.review;
			// A live goal is work the pool owes before any task exists: it sizes the roster on its own
			// and it must not be read as a stall. The bound is enforced here, on the tick that already
			// exists, so a round that cannot converge is CLOSED with a FAIL instead of spinning.
			for (const goal of store.closeExpiredGoals(this.#deps.now())) {
				const notice = goalBoundNotice(goal);
				this.#deps.notify(notice, "warning");
				this.#deps.notifyMain(notice);
				this.#deps.onEvent?.("swarm.goal.failed", { goal: goal.id });
			}
			const liveGoals = store.liveGoals();
			const goalAgents = liveGoals.reduce((n, goal) => Math.max(n, goal.agents), 0);
			// Auto-start: the coordinator publishes tasks - or opens a goal, which mints exactly one
			// planning task - and the pool assembles once they stop arriving, so the roster is sized to
			// the whole plan. A task created mid-turn must not fix the pool size for the entire run.
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
				const roster = planRoster(tasks, config, goalAgents);
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
						this.#deps.nudgeToMain(this.#nudgeText());
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
				this.#lastResizeAt = 0;
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

			// Pool sizing: the AutoController is the SINGLE writer of the pool size. Agents may only ask
			// (`swarm_scale`), the asks are collapsed to the largest one in the window, and this recompute
			// is idempotent — so N agents sensing the same shortage still produce ONE resize, and a resize
			// that just happened defers the next one for the cooldown. Growing toward the PLAN stays the
			// block above; this one answers the agents and prunes a pool the plan does not need.
			if (this.#phase === "running" && !this.#drained && this.#deps.isDriverRunning()) {
				const live = this.#deps.workerCount();
				const desired = planRoster(tasks, config, goalAgents);
				const pending = store.pendingScaleRequests();
				const decision = reconcilePool({
					ceiling: config.workers,
					planned: this.#plannedWorkers,
					live,
					idle: this.#deps.poolIdle(),
					ready: counts.ready,
					claimed: counts.claimed,
					review: counts.review,
					plan: desired.reduce((n, role) => n + role.count, 0),
					pending,
					now: this.#deps.now(),
					lastResizeAt: this.#lastResizeAt,
					cooldownMs: this.#scaleCooldownMs,
					windowMs: this.#scaleWindowMs,
				});
				const pool = Math.max(live, this.#plannedWorkers);
				if (decision.action === "grow" && decision.delta > 0) {
					const deltaRoles = takeWorkers(desired, decision.delta);
					const short = decision.delta - deltaRoles.reduce((n, role) => n + role.count, 0);
					// An ask for more peers is honoured past the capability shape the plan implies; the
					// operator's ceiling is still the bound, and the request was already clamped to it.
					if (short > 0) deltaRoles.push({ name: "general", count: short, capabilities: ["general"] });
					this.#lastResizeAt = this.#deps.now();
					try {
						const started = await this.#deps.startSwarm(deltaRoles, decision.delta);
						// The host clamps at the operator's ceiling and can bring up fewer than we asked for, so
						// the recorded size is what actually started — never a number only the request knew.
						const grew = started.length;
						this.#plannedWorkers = Math.min(pool + grew, config.workers);
						this.#deps.notify(`swarm grew by ${grew} worker(s): ${decision.reason}`);
						this.#deps.onEvent?.("roster.grow", {
							workers: this.#plannedWorkers,
							ready: counts.ready,
							requested: decision.requested,
							roles: deltaRoles.map((role) => role.name),
						});
					} catch (error) {
						this.#deps.notify(`swarm growth failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					this.#deps.onChange();
				} else if (decision.action === "shrink" && decision.delta < 0) {
					this.#lastResizeAt = this.#deps.now();
					try {
						const stopped = await this.#deps.shrinkSwarm(-decision.delta);
						this.#plannedWorkers = Math.max(1, pool - stopped.length);
						// The plan's own growth must not undo the shrink on the next tick: it only fires when
						// READY work rises above what the pool was sized for, so rebind that watermark.
						this.#lastGrowthReady = counts.ready;
						this.#deps.notify(`swarm stopped ${stopped.length} idle worker(s): ${decision.reason}`);
						this.#deps.onEvent?.("roster.shrink", {
							workers: this.#plannedWorkers,
							stopped,
							ready: counts.ready,
							requested: decision.requested,
						});
					} catch (error) {
						this.#deps.notify(`swarm shrink failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					this.#deps.onChange();
				}
				if (decision.settled && pending.length > 0) {
					store.decideScaleRequests(
						pending.map((request) => request.id),
						decision.action,
						decision.action === "hold" ? pool : decision.target,
					);
				}
				// An under-budgeted pool is never silent: the work shape wants more workers than the operator
				// allowed, and the rule holds at the ceiling instead of planning past it. One notice per
				// distinct (floor, ceiling) pair, cleared when the budget catches up, so it cannot spam a tick.
				const budget = decision.underBudgeted;
				if (budget === undefined) {
					this.#underBudgetedKey = undefined;
				} else {
					const budgetKey = `${budget.floor}:${budget.ceiling}`;
					if (budgetKey !== this.#underBudgetedKey) {
						this.#underBudgetedKey = budgetKey;
						const text = `[swarm] the live work shape wants ${budget.floor} worker(s) but the operator's ceiling is ${budget.ceiling}: the pool holds at ${decision.target} and will not plan past the budget. Raise config.workers for more.`;
						this.#deps.notify(text, "warning");
						this.#deps.notifyMain(text);
						this.#deps.onEvent?.("pool.underBudgeted", { floor: budget.floor, ceiling: budget.ceiling, pool: decision.target });
					}
				}
			}

			// Stall: a running swarm with blocked work and nothing claimable. An OPEN GOAL is excluded:
			// the planning round is work in flight, not a stall, and the bound above is what closes it.
			if (this.#phase === "running" && this.#deps.isDriverRunning()) {
				if (actionable === 0 && counts.blocked > 0 && liveGoals.length === 0) {
					this.#blockedSince ??= this.#deps.now();
					if (this.#deps.now() - this.#blockedSince >= this.#stallMs) {
						const notice = stallNotice(counts);
						this.#deps.notify(notice, "warning");
						this.#deps.notifyMain(notice);
						await this.#deps.stopSwarm("swarm stalled: tasks blocked with no claimable work");
						this.#plannedWorkers = 0;
						this.#lastGrowthReady = 0;
						this.#lastResizeAt = 0;
						this.#setPhase("stalled");
					}
				} else {
					this.#blockedSince = undefined;
				}
			}

			// Starvation: the pool is running and ready work exists that NO online agent can claim —
			// every ready row declares a capability nobody online holds. Deliberately NOT a stall-stop
			// (the rows are legitimate, only unroutable) and deliberately NOT a growth: the roster is
			// minted from the plan's own role order, never from an individual row's capability string, so
			// more workers cannot mint the missing capability — only a re-file or a different pool can.
			// One notice per distinct condition, cleared as soon as somebody capable appears, so a later
			// recurrence (or a different row set) reports again instead of inheriting the old silence.
			if (this.#phase === "running" && this.#deps.isDriverRunning()) {
				const report =
					counts.ready > 0
						? findStarvation({
								ready: store.listTasks({ status: "ready", limit: 500 }),
								agents: store.listAgents(),
								now: this.#deps.now(),
								offlineAfterMs: config.offlineAfterSeconds * 1000,
							})
						: undefined;
				if (report === undefined) {
					this.#unclaimableKey = undefined;
				} else if (report.key !== this.#unclaimableKey) {
					this.#unclaimableKey = report.key;
					const rows = report.rows.map((row) => `${row.id} (${row.why})`).join(", ");
					const notice =
						report.online === 0
							? `[swarm] ${report.rows.length} ready task(s) that no ONLINE agent can claim: ${rows}. Nothing is blocked, so nothing reports itself: start a pool (/swarm start) or re-file the work.`
							: `[swarm] ready work nobody online can claim: ${rows}. This is not a stall, and growth cannot fix it (it only mints roles the plan asks for): re-file those task(s) with a capability the pool has, or add an agent that has it.`;
					this.#deps.notify(notice, "warning");
					this.#deps.notifyMain(notice);
					this.#deps.onEvent?.("pool.unclaimable", {
						rows: report.rows.map((row) => ({ id: row.id, missing: row.missing, why: row.why })),
						missing: report.missing,
						online: report.online,
					});
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
		if (this.#phase === "off") return [];
		// A live planning round is named on the header: it is the one thing the operator must see
		// while no task exists yet.
		const goals = this.#deps.store.liveGoals();
		const round = goals.map((goal) => `${goal.id} (${goal.agents}a)`).join(" ");
		return [`MULTI-AGENT MODE · ${this.#phase}${round === "" ? "" : ` · ${round}`}`];
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
		this.#lastResizeAt = 0;
		this.#unclaimableKey = undefined;
		this.#underBudgetedKey = undefined;
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
