/**
 * The idle edge of the driver: an agent with nothing claimable is woken by a CHANGE in the pool state,
 * never by the clock. The operator's report — "多代理已创建、后台代理没有任务时一直烧 token" — is one
 * full model call per idle window per worker, so "model calls" is what this file measures: the faked
 * session records every prompt the driver issues, and nothing is inferred.
 *
 * No host, no real sessions, no wall clock: the timers are captured instead of scheduled and the tick is
 * invoked by hand, so a tick is a function call and the counters are exact.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { IDLE_PARK_AFTER, SwarmDriver, idleWake, type IdleWakeState, type TimerApi } from "../../extension/driver";
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

function harness(overrides: Partial<SwarmConfig> = {}): Harness {
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
