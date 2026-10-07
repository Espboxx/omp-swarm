/**
 * The round watchdog, pinned INDEPENDENTLY of the fix's own tests (task-189, written by an agent who
 * wrote none of the fix). Same property, asserted from the outside and at different seams:
 *
 *   - the loss is a SLOW SCRIBE, not a lost lease: the driver's beat keeps every lease warm
 *     (store.heartbeat renews `lease_until` and does NOT touch `updated_at`), so the watchdog must
 *     judge the ROUND's progress, never the holder's liveness;
 *   - the round must be re-offered to the pool, and the pool woken, in the same tick;
 *   - a re-offered round nobody picks up is closed with a reason, not spun to the bound;
 *   - and the zero-idle-burn property (task-170/171) must survive all of it: an unchanged pool costs
 *     exactly zero model calls, measured as prompts, which is the unit the operator pays.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { SwarmDriver, type TimerApi } from "../../extension/driver";
import { MAX_SCRIBE_ATTEMPTS, SCRIBE_STALL_MS, goalTag, scribeVerdict } from "../../extension/planning";
import { SwarmStore } from "../../extension/store";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// the OS temp dir is disposable, and Windows keeps the WAL pair locked for a moment
		}
	}
});

/** The ladder's inputs, so each boundary case differs from the next in exactly one field. */
const watch = (overrides: Partial<Parameters<typeof scribeVerdict>[0]> = {}) => ({
	planningTask: "task-1",
	now: 1_000_000,
	lastProgressAt: 1_000_000,
	attempts: 1,
	...overrides,
});

describe("the scribe-lost ladder, from the outside", () => {
	test("silence under the stall limit is ok, and the limit itself is NOT (the comparison is strict)", () => {
		expect(scribeVerdict(watch({ now: 1_000_000 + SCRIBE_STALL_MS - 1, heldBy: "w1" })).action).toBe("ok");
		expect(scribeVerdict(watch({ now: 1_000_000 + SCRIBE_STALL_MS, heldBy: "w1" })).action).toBe("reclaim");
	});

	test("a producing scribe is never taken off the round: progress inside every window keeps it", () => {
		let progressAt = 1_000_000;
		for (let window = 0; window < 10; window++) {
			const now = progressAt + SCRIBE_STALL_MS - 1_000;
			expect(scribeVerdict(watch({ now, lastProgressAt: progressAt, heldBy: "w1" })).action).toBe("ok");
			progressAt = now; // the scribe moved: a claim, a swarm_renew, a new proposal
		}
	});

	test("the round survives exactly MAX_SCRIBE_ATTEMPTS scribes, then closes", () => {
		const silent = { now: 1_000_000 + SCRIBE_STALL_MS + 1, heldBy: "w1", lastProgressAt: 1_000_000 };
		for (let attempts = 1; attempts < MAX_SCRIBE_ATTEMPTS; attempts++) {
			expect(scribeVerdict(watch({ ...silent, attempts })).action).toBe("reclaim");
		}
		expect(scribeVerdict(watch({ ...silent, attempts: MAX_SCRIBE_ATTEMPTS })).action).toBe("fail");
		expect(scribeVerdict(watch({ ...silent, attempts: MAX_SCRIBE_ATTEMPTS + 1 })).action).toBe("fail");
	});

	test("a round nobody ever claimed belongs to the bound; a re-offered round that sits does not", () => {
		const silent = { now: 1_000_000 + SCRIBE_STALL_MS + 1, lastProgressAt: 1_000_000 };
		expect(scribeVerdict(watch({ ...silent, attempts: 0 })).action).toBe("ok");
		expect(scribeVerdict(watch({ ...silent, attempts: 1 })).action).toBe("fail");
	});
});

describe("the store transitions the watchdog applies", () => {
	function withGoal(id = "main") {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-watchdog")));
		store.registerAgent({ id, role: "general", capabilities: ["general"] });
		const { goal, planningTask } = store.createGoal({ goal: "pin the watchdog", agents: 2, createdBy: "main" });
		return { store, goal, planningTask: planningTask.id };
	}

	test("a silent hold returns the row, names the holder, and settles the holder's agent row", () => {
		const { store, planningTask } = withGoal();
		store.claim(planningTask, "main", 300, ["general"]);
		const reclaimed = store.reclaimStalled(planningTask, "main held task-1 without progress for 121s");
		expect(reclaimed).toEqual({ ok: true, previous: "main" });
		const row = store.getTask(planningTask);
		expect(row?.status).toBe("ready");
		expect(row?.claimedBy).toBeUndefined();
		expect(store.eventsOfType("task.takeover").length).toBe(1);
		expect(store.listAgents().find((agent) => agent.id === "main")?.currentTask).toBeUndefined();
		store.close();
	});

	test("the beat is LIVENESS, not progress: a warm lease does not stop the takeover", () => {
		const { store, planningTask } = withGoal();
		store.claim(planningTask, "main", 300, ["general"]);
		const claimed = store.getTask(planningTask);
		// The driver's beat, several times over: this is what kept goal-6's hold alive to the bound.
		for (let i = 0; i < 5; i++) store.heartbeat("main", undefined, undefined, 300);
		const refreshed = store.getTask(planningTask);
		expect(refreshed?.updatedAt).toBe(claimed?.updatedAt);
		expect(refreshed?.claimedAt).toBe(claimed?.claimedAt);
		// ...so the round's own clock still reads as stalled, and the row is still taken away.
		expect(store.reclaimStalled(planningTask, "no progress").ok).toBe(true);
		store.close();
	});

	test("another agent takes the re-offered round over and really produces the plan", () => {
		const { store, goal, planningTask } = withGoal();
		store.registerAgent({ id: "w2", role: "general", capabilities: ["general"] });
		store.claim(planningTask, "main", 300, ["general"]);
		store.reclaimStalled(planningTask, "main went silent");
		expect(store.claim(planningTask, "w2", 300, ["general"]).ok).toBe(true);
		store.postBoard({
			type: "OBSERVATION",
			agentId: "w2",
			taskId: planningTask,
			content: JSON.stringify({ goal: goal.id, tasks: [{ title: "the takeover's own row", deliverable: "proves a re-offered round can be carried to a plan" }] }),
			tags: ["proposal", goalTag(goal.id)],
		});
		const planned = store.planGoal(goal.id, "w2", { ceiling: 4 });
		expect(planned.ok).toBe(true);
		expect(planned.created.length).toBeGreaterThan(0);
		expect(store.getGoal(goal.id)?.planner).toBe("w2");
		expect(store.getGoal(goal.id)?.status).toBe("planned");
		store.close();
	});

	test("the cap closes the round with a reason BEFORE the bound: the goal's own deadline is still ahead", () => {
		const { store, goal, planningTask } = withGoal();
		for (let attempt = 0; attempt < MAX_SCRIBE_ATTEMPTS; attempt++) {
			store.claim(planningTask, "main", 300, ["general"]);
			if (attempt < MAX_SCRIBE_ATTEMPTS - 1) store.reclaimStalled(planningTask, `silent on attempt ${attempt + 1}`);
		}
		const closed = store.closeStalledGoal(goal.id, "taken 3 time(s) with no progress; closed explicitly");
		expect(closed?.status).toBe("failed");
		expect(store.getTask(planningTask)?.status).toBe("failed");
		expect(store.getGoal(goal.id)?.deadlineAt).toBeGreaterThan(Date.now());
		expect(store.searchBoard({ tags: ["failure"] }).length).toBeGreaterThan(0);
		store.close();
	});
});

describe("the tick: the burn and the wake are the same pass", () => {
	interface Harness {
		store: SwarmStore;
		/** Every prompt the driver issued: one prompt IS one model call, the unit the operator pays. */
		prompts: string[];
		start(): Promise<void>;
		tick(): Promise<void>;
		/** Move the injected clock without sleeping. */
		advance(ms: number): void;
	}

	/** The host package resolves only inside `omp`, so the driver's host seams are stubbed (as in driver.test.ts). */
	const zodStub: Record<string, unknown> & (() => unknown) = new Proxy(function zod() {} as unknown as Record<string, unknown> & (() => unknown), {
		get: (_target, key) => (key === "then" ? undefined : zodStub),
		apply: () => zodStub,
	});

	function harness(): Harness {
		const root = mkdtempSync(join(tmpdir(), "swarm-watchdog-tick-"));
		tempDirs.push(root);
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(root));
		let t = Date.now();
		const prompts: string[] = [];
		const intervals: Array<() => void> = [];
		const sessions = {
			MAIN_AGENT_ID: "main",
			SessionManager: { create: () => ({}) },
			async createAgentSession(options: { agentId: string }) {
				return {
					session: {
						sessionId: `session-${options.agentId}`,
						isStreaming: false,
						async prompt(text: string) {
							prompts.push(text);
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
		};
		const timers = {
			setInterval: (callback: () => void) => {
				intervals.push(callback);
				return 0;
			},
			clearTimer: () => {},
		};
		// Both stubs are structurally-compatible stand-ins for host types this process cannot import; the
		// casts are the boundary, named so the reason is visible at the use site.
		const driver = new SwarmDriver({
			sdk: sessions as unknown as ConstructorParameters<typeof SwarmDriver>[0]["sdk"],
			store,
			config: DEFAULT_CONFIG as SwarmConfig,
			root,
			z: zodStub as never,
			timers: timers as unknown as TimerApi,
			exec: async () => ({ code: 1, stdout: "", stderr: "not a git repository" }),
			notify: () => {},
			onPanel: () => {},
			now: () => t,
		});
		const drain = async () => {
			for (let i = 0; i < 256; i++) await Promise.resolve();
		};
		return {
			store,
			prompts,
			async start() {
				await driver.start(1);
				for (let i = 0; i < 512 && store.listAgents().length === 0; i++) await Promise.resolve();
				await drain();
			},
			async tick() {
				intervals[0]?.();
				await drain();
			},
			advance(ms: number) {
				t += ms;
			},
		};
	}

	test("eight idle ticks on a live, freshly-claimed round cost ZERO model calls; the reclaim costs exactly one", async () => {
		const h = harness();
		const { goal, planningTask } = h.store.createGoal({ goal: "watchdog tick", agents: 1, createdBy: "main" });
		await h.start();
		// The holder is the coordinator, so no WORKER holds anything: the round is live but idle for the pool.
		h.store.claim(planningTask.id, "main", 300, ["general"]);
		// A live goal at spawn is itself something to tell a fresh worker; one settling tick drains that edge,
		// so what the loop below measures is the property under test: an UNCHANGED pool costs zero.
		await h.tick();
		const baseline = h.prompts.length;

		// (burn side) a fresh round is a no-op for the pool, tick after tick: zero model calls.
		for (let i = 0; i < 8; i++) await h.tick();
		expect(h.prompts.length).toBe(baseline);

		// (wake side) one silent window later the watchdog re-offers the round, and the SAME pass wakes the pool.
		h.advance(SCRIBE_STALL_MS + 1_000);
		await h.tick();
		expect(h.prompts.length).toBe(baseline + 1);
		expect(h.store.getTask(planningTask.id)?.status).toBe("ready");

		// (anti-spin) the re-offered round is not left riding to the bound: the next pass closes it, loudly.
		await h.tick();
		expect(h.store.getGoal(goal.id)?.status).toBe("failed");
		expect(h.store.searchBoard({ tags: ["failure"] }).length).toBeGreaterThan(0);
		expect(h.prompts.length).toBe(baseline + 2);
		h.store.close();
	});
});
