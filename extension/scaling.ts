/**
 * Pool sizing: the pure rule the AutoController runs on every tick.
 *
 * The operator's `config.workers` is the ABSOLUTE ceiling — no agent request can spend past it. The
 * controller stays the single writer of the pool size: agents may only ASK (`swarm_scale`), the asks
 * are collapsed by taking the MAX (N agents asking for one more is ONE more, not N more), and every
 * change is recomputed from scratch so a repeated tick with the same shape decides the same thing.
 */
import type { ScaleRequest } from "./types";

export interface PoolShape {
	/** `config.workers`: the operator's hard ceiling. Nothing may exceed it. */
	ceiling: number;
	/** Workers the controller has planned for (its own accounting of the pool size). */
	planned: number;
	/** Workers registered in the pool right now. */
	live: number;
	/** Live workers holding NO claim, review lease or reservation: the only stoppable ones. */
	idle: number;
	/** Tasks the pool could act on right now. */
	ready: number;
	/** Tasks a worker is holding. */
	claimed: number;
	/** Tasks in review (a reviewer holds a review lease). */
	review: number;
	/** What the task graph wants: the roster the plan derives, already capped by the ceiling. */
	plan: number;
}

export interface ReconcileInput extends PoolShape {
	/** Undecided asks, oldest first. */
	pending: ScaleRequest[];
	now: number;
	/** When the pool last changed size (grow or shrink), for the cooldown. */
	lastResizeAt: number;
	/** Minimum gap between two resizes. */
	cooldownMs: number;
	/** An ask older than this is stale and is dropped, never applied minutes later. */
	windowMs: number;
}

export interface ReconcileResult {
	action: "hold" | "grow" | "shrink";
	/** The size the decision steers to (== the current size when holding). */
	target: number;
	/** Workers to add (> 0) or stop (< 0); 0 when holding. */
	delta: number;
	/** The MAX of the usable asks, when any are pending. */
	requested?: number;
	/** Ids of asks that were above the ceiling (applied clamped, and reported). */
	clamped: number[];
	/** Ids of asks dropped as stale. */
	stale: number[];
	/**
	 * Whether the pending asks were CONSUMED by this decision. A deferral (cooldown, no idle worker to
	 * stop, a drained pool) leaves them pending on purpose, so the next tick can still apply them.
	 */
	settled: boolean;
	/**
	 * Set when the operator's ceiling is BELOW the live work shape this tick: the work wants more workers
	 * than the budget allows. The rule holds at the ceiling either way; this is the fact the caller reports,
	 * so an under-budgeted pool is never silent about it.
	 */
	underBudgeted?: { floor: number; ceiling: number };
	reason: string;
}

/** What a worker is holding, as the shrink rule sees it. */
export interface WorkerHoldings {
	streaming: boolean;
	holdsClaim: boolean;
	holdsReview: boolean;
	holdsReservation: boolean;
}

/**
 * Whether a shrink may stop this worker: it must hold NOTHING at all. A worker mid-turn, holding a
 * task, holding a review lease, or holding a file reservation is never stopped — the shrink defers
 * instead, which is why the caller's `idle` count is the only thing that bounds a shrink.
 */
export function canStop(holdings: WorkerHoldings): boolean {
	return !holdings.streaming && !holdings.holdsClaim && !holdings.holdsReview && !holdings.holdsReservation;
}

/**
 * The stoppable-worker floor: the live work shape. Every held task needs its own worker, one worker
 * is kept free for the next claim, and a pool with ready work keeps one more. A pool with nothing
 * actionable is never shrunk by this rule — stopping it is the drain path's job.
 */
export function poolFloor(shape: Pick<PoolShape, "ready" | "claimed" | "review">): number {
	const holding = shape.claimed + shape.review;
	if (holding + shape.ready === 0) return 1;
	return Math.max(1, holding + 1 + (shape.ready > 0 ? 1 : 0));
}

/** The pool size the work itself wants right now: what the plan needs, never below the floor. */
export function shapeTarget(shape: PoolShape): number {
	const floor = poolFloor(shape);
	return Math.min(Math.max(shape.plan, floor, 1), Math.max(1, shape.ceiling));
}

/**
 * Reconcile the pool size. Idempotent: called twice with the same shape (and no new ask) it decides
 * the same thing, because `planned` is the caller's record of what the last decision produced.
 */
export function reconcilePool(input: ReconcileInput): ReconcileResult {
	const current = Math.max(input.planned, input.live);
	// Nothing actionable: the drain/stall paths own that state, and a shrink here would race them. The
	// pending asks stay pending — their window expires them if the pool never picks the work up.
	if (input.ready + input.claimed + input.review === 0) {
		return {
			action: "hold",
			target: current,
			delta: 0,
			clamped: [],
			stale: [],
			settled: false,
			reason: "nothing is actionable; the drain path stops the pool, not the scaler",
		};
	}

	const clamped: number[] = [];
	const stale: number[] = [];
	const usable: ScaleRequest[] = [];
	for (const request of input.pending) {
		if (input.now - request.createdAt > input.windowMs) {
			stale.push(request.id);
			continue;
		}
		if (request.requested > input.ceiling) clamped.push(request.id);
		usable.push({ ...request, requested: Math.min(request.requested, input.ceiling) });
	}
	const requested = usable.length === 0 ? undefined : Math.max(...usable.map((request) => Math.max(1, request.requested)));
	const floor = poolFloor(input);
	const shape = shapeTarget(input);
	// The operator's ceiling is ABSOLUTE: it wins over the work-shape floor. When the live work needs more
	// workers than the budget allows, the honest outcome is to hold AT the ceiling and say so — never to
	// plan a pool the operator did not pay for. (Without this bound the floor lifted a target above the
	// ceiling in every under-budgeted shape, e.g. 4 claimed + 1 ready under `workers: 4` -> floor 6.)
	const ceiling = Math.max(1, input.ceiling);
	/** The operator budgeted less than the live work shape wants: worth saying out loud, never worth overspending. */
	const underBudgeted = floor > ceiling;
	// An ASK is the only thing that can grow the pool: without one the plan's own growth path stays the
	// single grower (and this rule only prunes what is too big). The floor and the ceiling always bind.
	const wanted =
		requested === undefined
			? Math.min(current, shape)
			: Math.min(Math.max(Math.min(requested, ceiling), floor), ceiling);
	const base: Pick<ReconcileResult, "requested" | "clamped" | "stale" | "underBudgeted"> = {
		requested,
		clamped,
		stale,
		underBudgeted: underBudgeted ? { floor, ceiling } : undefined,
	};
	if (wanted === current) {
		return {
			action: "hold",
			target: current,
			delta: 0,
			...base,
			settled: true,
			reason: `the pool already matches the shape (${current})${
				underBudgeted ? `; the live work shape wants ${floor}, but the operator's ceiling is ${ceiling}` : ""
			}`,
		};
	}

	const cooling = input.now - input.lastResizeAt < input.cooldownMs;
	if (cooling) {
		return {
			action: "hold",
			target: current,
			delta: 0,
			...base,
			settled: false,
			reason: `resize deferred: ${Math.max(0, input.cooldownMs - (input.now - input.lastResizeAt))}ms of cooldown left`,
		};
	}
	if (wanted > current) {
		return {
			action: "grow",
			target: wanted,
			delta: wanted - current,
			...base,
			settled: true,
			reason: `an agent asked for ${requested} worker(s)${clamped.length > 0 ? ` (clamped from above by the ceiling ${ceiling})` : ""}`,
		};
	}
	// Shrink: only a worker that holds NO claim/lease/reservation may be stopped; anything else defers.
	const stoppable = Math.min(current - wanted, input.idle);
	if (stoppable <= 0) {
		return {
			action: "hold",
			target: current,
			delta: 0,
			...base,
			settled: false,
			reason: `shrink to ${wanted} deferred: no idle worker to stop (${current - wanted} of ${current} are holding work)`,
		};
	}
	return {
		action: "shrink",
		target: current - stoppable,
		delta: -stoppable,
		...base,
		settled: true,
		reason:
			requested === undefined
				? `the plan needs ${wanted} worker(s), not ${current}`
				: `an agent asked for ${requested} worker(s), not ${current}`,
	};
}
