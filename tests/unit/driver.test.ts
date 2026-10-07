/**
 * The two no-change wake edges of the driver: an agent is woken by a CHANGE in the pool state, never by
 * the clock, and never twice for the same unchanged rows. The operator's report — "多代理已创建、后台代理
 * 没有任务时一直烧 token" — is one full model call per idle window per worker, and the ready/review branch
 * added a second one per turn, so "model calls" is what this file measures: the faked session records
 * every prompt the driver issues, and nothing is inferred.
 *
 * No host, no real sessions, no wall clock: the timers are captured instead of scheduled and the tick is
 * invoked by hand, so a tick is a function call and the counters are exact.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { IDLE_PARK_AFTER, SwarmDriver, idleWake, stalledWake, type IdleWakeState, type TimerApi } from "../../extension/driver";
import { SwarmStore } from "../../extension/store";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// the OS temp dir is disposable
		}
	}
});

/**
 * The host package resolves only inside the `omp` binary (tests/unit/index.test.ts explains), so the
 * driver's two host seams are stubbed. The zod stub only ever reaches `buildSwarmTools`, whose schemas
 * this test never executes: every property and every call returns the same callable node, and `then`
 * stays undefined so the stub is not mistaken for a thenable.
 */
const zodStub: Record<string, unknown> & (() => unknown) = new Proxy(function zod() {} as unknown as Record<string, unknown> & (() => unknown), {
	get: (_target, key) => (key === "then" ? undefined : zodStub),
	apply: () => zodStub,
});

/**
 * Drain the microtask queue. Deliberately not a sleep: the driver's tick and spawn chains contain no
 * macrotask of their own (the faked session resolves the moment it is awaited), so draining is
 * deterministic where a wall-clock wait would be slower and racier.
 */
async function drain(turns = 128): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** The pool comes up in the background (`start` does not await its own spawn), so wait for the agent row. */
async function until(predicate: () => boolean, turns = 512): Promise<void> {
	for (let i = 0; i < turns; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("the pool never came up");
}

interface Harness {
	store: SwarmStore;
	/** Every prompt the driver issued, in order: the model calls this fix is measured in. */
	prompts: { agent: string; text: string }[];
	start(count?: number): Promise<void>;
	/** One full driver tick (the captured interval callback), awaited to completion. */
	tick(): Promise<void>;
}

function harness(overrides: Partial<SwarmConfig> = {}, now?: () => number): Harness {
	const root = mkdtempSync(join(tmpdir(), "swarm-driver-unit-"));
	tempDirs.push(root);
	const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(root));
	const config: SwarmConfig = { ...DEFAULT_CONFIG, ...overrides };
	const prompts: { agent: string; text: string }[] = [];
	const intervals: Array<() => void> = [];

	const sdk = {
		MAIN_AGENT_ID: "main",
		SessionManager: { create: () => ({}) },
		async createAgentSession(options: { agentId: string }) {
			const agent = options.agentId;
			return {
				session: {
					sessionId: `session-${agent}`,
					isStreaming: false,
					// The model call this fix removes: a prompt is exactly one turn, so it is the unit of cost.
					async prompt(text: string) {
						prompts.push({ agent, text });
					},
					async sendUserMessage() {},
					subscribe() {
						return () => {};
					},
					async dispose() {},
				},
				modelFallbackMessage: undefined,
			};
		},
	} as unknown as ConstructorParameters<typeof SwarmDriver>[0]["sdk"];

	/** Captured, never scheduled: the tests run the tick by hand. `Timer` is the host's opaque token. */
	const timers = {
		setInterval: (callback: () => void) => {
			intervals.push(callback);
			return 0;
		},
		clearTimer: () => {},
	} as unknown as TimerApi;

	const driver = new SwarmDriver({
		sdk,
		store,
		config,
		root,
		z: zodStub as never,
		timers,
		exec: async () => ({ code: 1, stdout: "", stderr: "not a git repository" }),
		notify: () => {},
		onPanel: () => {},
		now,
	});

	return {
		store,
		prompts,
		async start(count = 1) {
			await driver.start(count);
			await until(() => store.listAgents().length >= count);
			// The bootstrap prompt is fire-and-forget after the spawn: drain so the counters are settled
			// before any test measures them.
			await drain();
		},
		async tick() {
			const callback = intervals[0];
			if (callback === undefined) throw new Error("the driver is not running");
			callback();
			await drain();
		},
	};
}

describe("idle edge: an idle worker costs nothing until the pool moves", () => {
	test("ten idle ticks with nothing claimable cost ZERO model calls", async () => {
		const h = harness();
		await h.start();
		// The worker's own bootstrap is the only prompt it will ever see with an empty pool.
		expect(h.prompts).toHaveLength(1);
		expect(h.prompts[0]?.text).toContain("You are starting as swarm worker");

		for (let i = 0; i < 10; i++) await h.tick();
		expect(h.prompts).toHaveLength(1);
	});

	test("a claimable task wakes the worker on the very next tick", async () => {
		const h = harness();
		await h.start();
		for (let i = 0; i < 5; i++) await h.tick();
		expect(h.prompts).toHaveLength(1);

		h.store.createTask({ title: "do the thing", createdBy: "main" });
		await h.tick();
		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]?.text).toContain("claimable task(s)");
	});

	test("a peer message still wakes it: the real-work branches are untouched", async () => {
		const h = harness();
		await h.start();
		await h.tick();
		expect(h.prompts).toHaveLength(1);

		h.store.sendMessage({ from: "main", to: h.store.listAgents()[0]?.id ?? "", body: "status?" });
		await h.tick();
		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]?.text).toContain("unread peer message(s)");
	});

	test("a live goal wakes it once, then the unchanged round stays silent", async () => {
		const h = harness();
		await h.start();
		await h.tick();
		expect(h.prompts).toHaveLength(1);

		// A goal whose planning task ANOTHER agent holds: nothing claimable is left for this worker, so the
		// goal round is the only agent-relevant state that can wake it — the case the clock used to cover,
		// now covered by the change itself. The holder is deliberately not a callsign the pool can mint,
		// so the worker cannot read itself as the scribe.
		const { planningTask } = h.store.createGoal({ goal: "ship it", agents: 2, createdBy: "main" });
		expect(h.store.claim(planningTask.id, "peer-auditor", 300, ["general"]).ok).toBe(true);
		await h.tick();
		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]?.text).toContain("OPEN GOAL");

		await h.tick();
		await h.tick();
		expect(h.prompts).toHaveLength(2);
	});
});

describe("idleWake: the edge itself", () => {
	test("the first evaluation records the state the worker already has and does not wake it", () => {
		const decision = idleWake({ signature: undefined, empty: 0, parked: false, nextAt: 0 }, "goal-1:task-1:open", 0, 15);
		expect(decision.wake).toBe(false);
		expect(decision.state.signature).toBe("goal-1:task-1:open");
	});

	test("a change wakes at once; the same state never does, however much time passes", () => {
		const moved = idleWake({ signature: "a", empty: 0, parked: false, nextAt: 0 }, "b", 0, 15);
		expect(moved.wake).toBe(true);
		expect(idleWake(moved.state, "b", 10 * 60_000, 15).wake).toBe(false);
	});

	test("the empty streak steps the window and parks the worker, and a change unparks it", () => {
		// Windows at idleTickSeconds, then 2x, then 4x: one streak step per elapsed window.
		let state: IdleWakeState = { signature: "a", empty: 0, parked: false, nextAt: 0 };
		let now = 0;
		for (const step of [15_000, 30_000, 60_000]) {
			now += step;
			const decision = idleWake(state, "a", now, 15);
			expect(decision.wake).toBe(false);
			state = decision.state;
		}
		expect(state.parked).toBe(true);
		expect(state.empty).toBe(IDLE_PARK_AFTER);

		// The clock cannot un-park it, and it cannot produce a call on its own: only a real change can.
		now += 10 * 60_000;
		expect(idleWake(state, "a", now, 15).wake).toBe(false);
		const woken = idleWake(state, "b", now, 15);
		expect(woken.wake).toBe(true);
		expect(woken.state.parked).toBe(false);
		expect(woken.state.empty).toBe(0);
	});
});

describe("ready/review edge: a row this worker does not take costs nothing", () => {
	test("ten unchanged ticks over a claimable row cost ONE model call, not ten", async () => {
		const h = harness();
		await h.start();
		h.store.createTask({ title: "the only row", createdBy: "main" });
		await h.tick();
		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]?.text).toContain("claimable task(s)");

		for (let i = 0; i < 10; i++) await h.tick();
		expect(h.prompts).toHaveLength(2);
	});

	test("a different row set wakes it on the very next tick, even at the same count", async () => {
		const h = harness();
		await h.start();
		const first = h.store.createTask({ title: "row one", createdBy: "main" });
		await h.tick();
		expect(h.prompts).toHaveLength(2);
		await h.tick();
		expect(h.prompts).toHaveLength(2);

		// Same count (one matching row), different ids: a peer takes row one and row two appears.
		expect(h.store.claim(first.id, "peer-auditor", 300, ["general"]).ok).toBe(true);
		h.store.createTask({ title: "row two", createdBy: "main" });
		await h.tick();
		expect(h.prompts).toHaveLength(3);
	});

	test("a review row wakes it once, then the unchanged queue stays silent", async () => {
		const h = harness();
		await h.start();
		const task = h.store.createTask({ title: "needs a look", createdBy: "main" });
		expect(h.store.claim(task.id, "peer-author", 300, ["general"]).ok).toBe(true);
		await h.tick();
		const before = h.prompts.length;

		h.store.complete(task.id, "peer-author", { summary: "done", reviewRequired: true });
		await h.tick();
		expect(h.prompts).toHaveLength(before + 1);
		expect(h.prompts[before]?.text).toContain("waiting for review");

		await h.tick();
		await h.tick();
		expect(h.prompts).toHaveLength(before + 1);
	});
});

describe("stalledWake: an obligation repeats on a bounded cadence and never parks", () => {
	test("the first evaluation records the state, and an unelapsed window is silent", () => {
		expect(stalledWake({ signature: undefined, empty: 0, parked: false, nextAt: 0 }, "u:1", 0, 15).wake).toBe(false);
		expect(stalledWake({ signature: "u:1", empty: 0, parked: false, nextAt: 60_000 }, "u:1", 30_000, 15).wake).toBe(false);
	});

	test("each elapsed window nudges once, the cadence steps, and the worker is never parked out of its own work", () => {
		let state: IdleWakeState = { signature: "t:task-1", empty: 0, parked: false, nextAt: 0 };
		let now = 0;
		let wakes = 0;
		for (const step of [15_000, 15_000, 30_000, 60_000, 240_000, 600_000]) {
			now += step;
			const decision = stalledWake(state, "t:task-1", now, 15);
			if (decision.wake) wakes++;
			state = decision.state;
			expect(state.parked).toBe(false);
		}
		// One nudge per elapsed window (never one per tick), with the window stepping to the 300s cap.
		expect(wakes).toBe(6);

		const moved = stalledWake(state, "t:task-1,t:task-2", now, 15);
		expect(moved.wake).toBe(true);
		expect(moved.state.empty).toBe(0);
	});
});

describe("a worker that HOLDS work is still driven", () => {
	/**
	 * The half the idle fix must NOT weaken: work ADDRESSED to a worker (a task it holds) is nudged on a
	 * bounded cadence, because nothing else reclaims it — `#beat` renews every held task's lease, so a
	 * silent holder would strand its task forever. The bound is the point: not one prompt per tick (the
	 * loop task-171 removes), and not zero (a stranded holder). The clock is injected so the stepping is
	 * observed without spending 15 real seconds per window.
	 */
	test("a held task keeps a bounded stepped nudge: not one per tick, and never zero", async () => {
		let clock = 0;
		const h = harness({}, () => clock);
		await h.start();
		const held = h.store.listAgents()[0]?.id ?? "";
		h.store.createTask({ title: "held work", createdBy: "main" });
		expect(h.store.claim("task-1", held, 300, ["general"]).ok).toBe(true);
		await h.tick();

		// The claim is a change: one nudge. Then the clock stands still, and a stalled holder costs NOTHING.
		const afterClaim = h.prompts.length;
		for (let i = 0; i < 5; i++) await h.tick();
		expect(h.prompts.length).toBe(afterClaim);

		// One nudge per ELAPSED window, on the stepped cadence: idleTickSeconds, then 2x, 4x … Half a
		// window is not a window.
		clock += 15_000;
		await h.tick();
		expect(h.prompts.length).toBe(afterClaim + 1);
		clock += 15_000;
		await h.tick();
		expect(h.prompts.length).toBe(afterClaim + 2);
		clock += 7_000;
		await h.tick();
		expect(h.prompts.length).toBe(afterClaim + 2);
		clock += 23_000; // the second window stepped to 2x: the next nudge is 30s after the last one
		await h.tick();
		expect(h.prompts.length).toBe(afterClaim + 3);
		expect(h.prompts.at(-1)?.text).toContain("hold");
	});
});
