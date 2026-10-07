/**
 * Pool sizing, the pure rule: request collapsing, the operator's ceiling, the live-work floor, the
 * never-stop-a-worker-holding-work rule, the cooldown and what "settled" means for a pending ask.
 * No store, no timers — the rule is a function of the shape it is handed.
 */
import { describe, expect, test } from "bun:test";
import { canStop, poolFloor, reconcilePool, shapeTarget, type PoolShape, type ReconcileInput } from "../../extension/scaling";
import type { ScaleRequest } from "../../extension/types";

function shape(overrides: Partial<PoolShape> = {}): PoolShape {
	return { ceiling: 8, planned: 4, live: 4, idle: 2, ready: 2, claimed: 0, review: 0, plan: 4, ...overrides };
}

function ask(id: number, requested: number, createdAt = 1_000_000): ScaleRequest {
	return { id, agentId: `w${id}`, requested, reason: `ask ${id}`, current: 4, createdAt };
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
	return { ...shape(), pending: [], now: 1_000_000, lastResizeAt: 0, cooldownMs: 30_000, windowMs: 60_000, ...overrides };
}

describe("canStop", () => {
	test("only a worker holding nothing at all may be stopped", () => {
		expect(canStop({ streaming: false, holdsClaim: false, holdsReview: false, holdsReservation: false })).toBe(true);
		expect(canStop({ streaming: true, holdsClaim: false, holdsReview: false, holdsReservation: false })).toBe(false);
		expect(canStop({ streaming: false, holdsClaim: true, holdsReview: false, holdsReservation: false })).toBe(false);
		expect(canStop({ streaming: false, holdsClaim: false, holdsReview: true, holdsReservation: false })).toBe(false);
		expect(canStop({ streaming: false, holdsClaim: false, holdsReview: false, holdsReservation: true })).toBe(false);
	});
});

describe("poolFloor", () => {
	test("every held task keeps a worker, one stays free, and ready work keeps one more", () => {
		expect(poolFloor({ ready: 0, claimed: 0, review: 0 })).toBe(1); // nothing actionable: the drain path owns it
		expect(poolFloor({ ready: 0, claimed: 1, review: 0 })).toBe(2);
		expect(poolFloor({ ready: 0, claimed: 0, review: 1 })).toBe(2); // a reviewer holds a lease too
		expect(poolFloor({ ready: 3, claimed: 2, review: 1 })).toBe(5); // 3 held + 1 free + 1 for the queue
	});

	test("the shape target never drops below the floor and never passes the ceiling", () => {
		expect(shapeTarget(shape({ plan: 0, ready: 2, planned: 6, live: 6 }))).toBe(2); // floor 2 beats a tiny plan
		expect(shapeTarget(shape({ plan: 99, ceiling: 4 }))).toBe(4);
	});
});

describe("reconcilePool", () => {
	test("no ask and a pool that matches the plan: hold, and the ask window is not consumed", () => {
		const result = reconcilePool(input());
		expect(result).toMatchObject({ action: "hold", target: 4, delta: 0, settled: true });
		expect(result.requested).toBeUndefined();
	});

	test("nothing actionable defers to the drain path instead of shrinking the pool away", () => {
		const result = reconcilePool(input({ ready: 0, claimed: 0, review: 0 }));
		expect(result.action).toBe("hold");
		expect(result.settled).toBe(false);
		expect(result.reason).toContain("drain path");
	});

	test("N agents asking for the same shortage collapse into ONE resize, the largest", () => {
		const result = reconcilePool(input({ pending: [ask(1, 6), ask(2, 5), ask(3, 6)], planned: 4, live: 4 }));
		expect(result.action).toBe("grow");
		expect(result.delta).toBe(2); // 6 - 4, NOT 6+5+6 askers each adding a worker
		expect(result.target).toBe(6);
		expect(result.requested).toBe(6);
		expect(result.settled).toBe(true);
	});

	test("an ask above the operator's ceiling is clamped, not refused silently, and says so", () => {
		const result = reconcilePool(input({ ceiling: 4, pending: [ask(1, 12)], planned: 4, live: 4 }));
		expect(result.clamped).toEqual([1]);
		expect(result.requested).toBe(4);
		expect(result.action).toBe("hold"); // clamped to exactly the current size
	});

	test("a shrink ask never goes below the live work shape", () => {
		const result = reconcilePool(input({ pending: [ask(1, 1)], planned: 4, live: 4, idle: 3, ready: 4, claimed: 1 }));
		// floor = 1 held + 1 free + 1 for the ready queue = 3
		expect(result.action).toBe("shrink");
		expect(result.target).toBe(3);
		expect(result.delta).toBe(-1);
	});

	test("a shrink stops the idle peers only, and never more than are idle", () => {
		const busy = reconcilePool(input({ planned: 4, live: 4, idle: 0, ready: 1, claimed: 0, plan: 2 }));
		expect(busy.action).toBe("hold");
		expect(busy.settled).toBe(false);
		expect(busy.reason).toContain("deferred");
		expect(busy.reason).toContain("no idle worker");
		// Never more stops than there are idle workers, whatever the shape says it wants.
		for (const busyCount of [0, 1, 2, 5]) {
			for (const claimed of [0, 1, 3]) {
				const candidate = reconcilePool(input({ planned: 8, live: 8, idle: busyCount, ready: 4, claimed }));
				expect(-candidate.delta).toBeLessThanOrEqual(busyCount);
			}
		}
		const partly = reconcilePool(input({ planned: 6, live: 6, idle: 2, ready: 1, claimed: 3, plan: 4 }));
		expect(partly.action).toBe("shrink");
		expect(partly.target).toBe(5); // floor = 3 held + 1 free + 1 for the ready queue = 5
		expect(partly.delta).toBe(-1);
	});

	test("an over-provisioned pool shrinks toward the plan even with no ask at all", () => {
		const result = reconcilePool(input({ planned: 6, live: 6, idle: 3, ready: 3, plan: 3, claimed: 0 }));
		expect(result.action).toBe("shrink");
		expect(result.target).toBe(3);
		expect(result.requested).toBeUndefined();
	});

	test("without an ask this rule never grows: growth toward the plan stays the other path's job", () => {
		const result = reconcilePool(input({ planned: 2, live: 2, idle: 0, ready: 5, claimed: 0, plan: 5 }));
		expect(result.action).toBe("hold");
		expect(result.delta).toBe(0);
	});

	test("a resize inside the cooldown is deferred with the remaining time, and stays unsettled", () => {
		const result = reconcilePool(input({ pending: [ask(1, 6, 1_010_000)], now: 1_010_000, lastResizeAt: 1_000_000, cooldownMs: 30_000 }));
		expect(result.action).toBe("hold");
		expect(result.settled).toBe(false);
		expect(result.reason).toContain("20000ms of cooldown left");
		const after = reconcilePool(input({ pending: [ask(1, 6, 1_010_000)], now: 1_030_000, lastResizeAt: 1_000_000, cooldownMs: 30_000 }));
		expect(after.action).toBe("grow");
	});

	test("an ask older than the window is stale: it is dropped, never applied minutes later", () => {
		const result = reconcilePool(input({ pending: [ask(1, 6, 1_000_000)], now: 1_100_000, windowMs: 60_000 }));
		expect(result.stale).toEqual([1]);
		expect(result.requested).toBeUndefined();
		expect(result.action).toBe("hold"); // the shape matches, so the stale ask changed nothing
	});

	test("applying a decision and recomputing from the new shape decides the same thing (idempotent)", () => {
		const first = reconcilePool(input({ planned: 6, live: 6, idle: 3, ready: 3, plan: 3 }));
		expect(first).toMatchObject({ action: "shrink", target: 3, delta: -3 });
		const second = reconcilePool(input({ planned: first.target, live: first.target, idle: 0, ready: 3, plan: 3 }));
		expect(second).toMatchObject({ action: "hold", target: 3, delta: 0, settled: true });
	});
});
