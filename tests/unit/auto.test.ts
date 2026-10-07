/**
 * Multi-agent mode: roster derivation (pure) and the AutoController state machine.
 * No sessions, no network, no timers — the clock and the driver are faked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	AutoController,
	COORDINATOR_NUDGE,
	COORDINATOR_POLICY,
	SWARM_NUDGE,
	SWARM_POLICY,
	planRoster,
	type AutoDeps,
	type AutoOptions,
} from "../../extension/auto";
import { loadSwarmConfig, saveSwarmAuto } from "../../extension/config";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { DEFAULT_CONFIG, type RoleConfig, type SwarmConfig, type SwarmTask } from "../../extension/types";

const tempDirs: string[] = [];

function makeStore(): SwarmStore {
	return new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-auto-unit")));
}

function task(overrides: Partial<SwarmTask> = {}): SwarmTask {
	return {
		id: "task-1",
		title: "t",
		description: "",
		status: "ready",
		priority: 0,
		createdBy: "main",
		createdAt: 0,
		updatedAt: 0,
		dependencies: [],
		requiredCapabilities: [],
		files: [],
		review: { required: false },
		attempts: 0,
		...overrides,
	};
}

interface Calls {
	start: { roles: RoleConfig[]; count: number }[];
	stop: string[];
	shrink: number[];
	nudge: string[];
	main: string[];
	notify: string[];
}

function harness(options: { config?: Partial<SwarmConfig>; auto?: AutoOptions } = {}) {
	const store = makeStore();
	const config: SwarmConfig = { ...DEFAULT_CONFIG, ...options.config };
	const calls: Calls = { start: [], stop: [], shrink: [], nudge: [], main: [], notify: [] };
	let clock = 1_000_000;
	let busy = false;
	let running = false;
	let workers = 0;
	let idle = 0;
	let startFailure = false;
	const deps: AutoDeps = {
		store,
		config,
		isDriverRunning: () => running,
		workerCount: () => workers,
		poolIdle: () => idle,
		startSwarm: async (roles, count) => {
			calls.start.push({ roles, count });
			if (startFailure) {
				startFailure = false;
				throw new Error("swarm is already running");
			}
			workers += count;
			// One name per WORKER, as the real host returns: `driver.start`/`addWorkers` hand back the specs
			// they will bring up (already clamped by the operator's ceiling), not the role shape.
			return Array.from({ length: count }, (_, i) => `w${workers - count + i + 1}`);
		},
		shrinkSwarm: async (count) => {
			calls.shrink.push(count);
			const stopped = Math.min(count, idle);
			idle -= stopped;
			workers -= stopped;
			return Array.from({ length: stopped }, (_, i) => `w${workers + i + 1}`);
		},
		stopSwarm: async (reason) => {
			calls.stop.push(reason);
		},
		isMainBusy: () => busy,
		nudgeToMain: (text) => calls.nudge.push(text),
		notifyMain: (text) => calls.main.push(text),
		notify: (text) => calls.notify.push(text),
		onChange: () => {},
		now: () => clock,
	};
	const controller = new AutoController(deps, {
		nudgeMs: 1000,
		giveUpMs: 2000,
		stallMs: 1000,
		pendingWindowMs: 100,
		settleMs: 1000,
		...options.auto,
	});
	return {
		store,
		config,
		controller,
		calls,
		settleMs: options.auto?.settleMs ?? 1000,
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
		setBusy: (value: boolean) => {
			busy = value;
		},
		setDriverRunning: (value: boolean) => {
			running = value;
		},
		setWorkers: (value: number) => {
			workers = value;
		},
		setIdle: (value: number) => {
			idle = value;
		},
		failNextStart: () => {
			startFailure = true;
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// the OS temp dir is disposable
		}
	}
});

type Harness = ReturnType<typeof harness>;

/** Let the pool observe its tasks, then let the quiet period pass, then let it assemble. */
async function settle(h: Harness): Promise<void> {
	await h.controller.tick();
	h.advance(h.settleMs);
	await h.controller.tick();
}

describe("planRoster", () => {
	test("general-only work yields one general role sized to the ready tasks", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		const roster = planRoster([task(), task({ id: "task-2" }), task({ id: "task-3" })], config);
		expect(roster).toEqual([{ name: "general", count: 3, capabilities: ["general"] }]);
	});

	test("the pool never exceeds config.workers", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 2 };
		const roster = planRoster([task(), task({ id: "task-2" }), task({ id: "task-3" })], config);
		expect(roster.reduce((n, role) => n + role.count, 0)).toBe(2);
	});

	test("work queued behind dependencies still gets a full pool", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 3 };
		const roster = planRoster(
			[task(), task({ id: "task-2", status: "blocked", dependencies: ["task-1"] }), task({ id: "task-3", status: "blocked" })],
			config,
		);
		expect(roster.reduce((n, role) => n + role.count, 0)).toBe(3);
	});

	test("review-required work adds a reviewer that can also take general work", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4, review: true };
		const roster = planRoster([task({ review: { required: true } }), task({ id: "task-2" })], config);
		const reviewer = roster.find((role) => role.name === "reviewer");
		expect(reviewer?.capabilities).toContain("general");
		expect(roster.reduce((n, role) => n + role.count, 0)).toBeLessThanOrEqual(config.workers);
		expect(roster[0]?.name).toBe("general");
	});

	test("work that asks for an integrator gets an integrator role", () => {
		const roster = planRoster([task({ requiredCapabilities: ["integrator"] })], { ...DEFAULT_CONFIG, workers: 4 });
		expect(roster.map((role) => role.name)).toEqual(["integrator"]);
	});

	test("an integrator outside config.roles still lands inside the worker budget", () => {
		const roster = planRoster([task({ requiredCapabilities: ["integrator"] })], { ...DEFAULT_CONFIG, workers: 1 });
		expect(roster.reduce((n, role) => n + role.count, 0)).toBe(1);
	});

	test("a terminal pool needs no roster", () => {
		expect(planRoster([task({ status: "done" }), task({ id: "task-2", status: "failed" })], DEFAULT_CONFIG)).toEqual([]);
	});

	test("two review-capability rows mint TWO reviewers: one reviewer cannot audit its own work", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		const roster = planRoster(
			[task({ id: "task-95", requiredCapabilities: ["reviewer"] }), task({ id: "task-99", requiredCapabilities: ["reviewer"] })],
			config,
		);
		expect(roster.find((role) => role.name === "reviewer")?.count).toBe(2);
		expect(roster.reduce((n, role) => n + role.count, 0)).toBeLessThanOrEqual(config.workers);
	});

	test("a single review-capability row still mints exactly one reviewer, and the slack still goes to general", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		// The other two rows declare `general` explicitly, so the roster has a separate general role to take
		// the slack (with capability-less rows the review role itself carries it — pre-existing behaviour).
		const roster = planRoster(
			[
				task({ requiredCapabilities: ["reviewer"] }),
				task({ id: "task-2", requiredCapabilities: ["general"] }),
				task({ id: "task-3", requiredCapabilities: ["general"] }),
			],
			config,
		);
		expect(roster.find((role) => role.name === "reviewer")?.count).toBe(1);
		expect(roster.find((role) => role.name === "general")?.count).toBe(2);
	});

	test("a demand larger than the budget still respects the operator's ceiling", () => {
		const six = Array.from({ length: 6 }, (_, index) => task({ id: `task-${index + 1}`, requiredCapabilities: ["reviewer"] }));
		const roster = planRoster(six, { ...DEFAULT_CONFIG, workers: 3 });
		expect(roster.reduce((n, role) => n + role.count, 0)).toBe(3);
	});

	test("a plan with no review-capability row is unchanged by this rule", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		expect(planRoster([task(), task({ id: "task-2" }), task({ id: "task-3" })], config)).toEqual([
			{ name: "general", count: 3, capabilities: ["general"] },
		]);
		// Two rows needing an integrator still yield one integrator that carries the slack (and the
		// general capability with it) — the pre-existing rule, untouched.
		expect(
			planRoster([task({ requiredCapabilities: ["integrator"] }), task({ id: "task-2", requiredCapabilities: ["integrator"] })], config),
		).toEqual([{ name: "integrator", count: 2, capabilities: ["integrator", "general"] }]);
	});
});

describe("saveSwarmAuto", () => {
	test("round-trips through loadSwarmConfig and keeps unknown keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "swarm-auto-config-"));
		tempDirs.push(dir);
		const configFile = join(dir, ".swarm", "config.json");
		saveSwarmAuto(configFile, false);
		expect(existsSync(configFile)).toBe(true);
		expect(loadSwarmConfig(configFile).auto).toBe(false);

		writeFileSync(configFile, `${JSON.stringify({ auto: false, workers: 2, custom: "keep" }, null, 2)}\n`);
		saveSwarmAuto(configFile, true);
		const raw = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		expect(raw.custom).toBe("keep");
		expect(raw.workers).toBe(2);
		expect(loadSwarmConfig(configFile).auto).toBe(true);
	});
});

describe("multi-agent mode", () => {
	test("enabling does not boot a swarm for tasks that already exist", async () => {
		const h = harness();
		h.store.createTask({ title: "seeded", createdBy: "bootstrap" });
		h.controller.enable();
		await h.controller.tick();
		expect(h.calls.start.length).toBe(0);
		expect(h.controller.phase).toBe("idle");
		expect(h.controller.enabled).toBe(true);
	});

	test("a user task opens a planning window that claims exactly its own turn", () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("implement the parser");
		expect(h.controller.phase).toBe("planning");
		expect(h.controller.claimsTurn("implement the parser (expanded)")).toBe(true);
		h.advance(101);
		expect(h.controller.claimsTurn("an unrelated later turn")).toBe(false);
		expect(h.controller.phase).toBe("idle");
	});

	test("tasks published by the coordinator start the swarm once", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		h.store.createTask({ title: "b", createdBy: "main" });
		await settle(h);
		expect(h.controller.phase).toBe("running");
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.start[0]?.count).toBe(2);
		expect(h.calls.start[0]?.roles.map((role) => role.name)).toEqual(["general"]);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1);
	});

	test("a pool assembles only once the coordinator stops publishing tasks", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		await h.controller.tick();
		h.advance(h.settleMs / 2); // the coordinator is still thinking
		await h.controller.tick();
		expect(h.calls.start.length).toBe(0);
		h.store.createTask({ title: "b", createdBy: "main" });
		h.advance(h.settleMs / 2);
		await h.controller.tick(); // the second task restarts the quiet period
		expect(h.calls.start.length).toBe(0);
		h.advance(h.settleMs);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.start[0]?.count).toBe(2);
	});

	test("a task published mid-turn waits for the coordinator to finish before sizing the pool", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.setBusy(true);
		h.store.createTask({ title: "a", createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(0);
		h.advance(h.settleMs);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(0); // still mid-turn: the plan is not complete yet
		h.store.createTask({ title: "b", createdBy: "main" });
		h.store.createTask({ title: "c", createdBy: "main" });
		h.setBusy(false);
		await settle(h);
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.start[0]?.count).toBe(3);
	});

	test("a pool that refuses to start does not wedge the mode", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		h.failNextStart();
		await settle(h);
		expect(h.controller.phase).toBe("idle");
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.notify.length).toBe(1);
		h.advance(h.settleMs);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2); // the retry succeeded
		expect(h.controller.phase).toBe("running");
	});

	test("a drained pool stops the swarm and reports back to the main session", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		await settle(h);
		h.setDriverRunning(true);
		h.controller.noteDrained();
		await h.controller.tick();
		expect(h.calls.stop).toEqual(["all tasks finished"]);
		expect(h.calls.main.length).toBe(1);
		expect(h.controller.phase).toBe("idle");
		h.controller.noteDrained();
		await h.controller.tick();
		expect(h.calls.stop.length).toBe(1);
	});

	test("a swarm blocked with nothing claimable is stopped", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		// A permanent block built from a FAILED dependency: task-1's createTask now refuses unknown ids,
		// so the block has to come from work that really exists and can never reach `done`.
		const a = h.store.createTask({ title: "a", createdBy: "main" });
		h.store.claim(a.id, "main", 300);
		h.store.fail(a.id, "main", "cannot be done");
		h.store.createTask({ title: "b", createdBy: "main", dependencies: [a.id] });
		await settle(h);
		expect(h.controller.phase).toBe("running");
		h.setDriverRunning(true);
		await h.controller.tick();
		expect(h.calls.stop.length).toBe(0); // the stall clock only starts once the pool is stuck
		h.advance(1000);
		await h.controller.tick();
		expect(h.calls.stop).toEqual(["swarm stalled: tasks blocked with no claimable work"]);
		expect(h.controller.phase).toBe("stalled");
		expect(h.calls.notify.length).toBe(1);
		expect(h.calls.main.length).toBe(1);
	});

	test("a busy coordinator that publishes nothing is nudged once, then given up on", async () => {
		// The legacy path: this nudge asks for the task list, so it belongs to coordinator planning.
		const h = harness({ config: { planning: "coordinator" } });
		h.controller.enable();
		h.controller.noteTask("a task the coordinator forgot");
		h.setBusy(true);
		h.advance(1000);
		await h.controller.tick();
		expect(h.controller.phase).toBe("nudging");
		expect(h.calls.nudge).toEqual([COORDINATOR_NUDGE]);
		await h.controller.tick();
		expect(h.calls.nudge.length).toBe(1);
		h.advance(1000);
		await h.controller.tick();
		expect(h.controller.phase).toBe("idle");
		expect(h.calls.stop.length).toBe(0);
	});

	test("an idle coordinator that publishes nothing is simply dropped", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("a question");
		h.setBusy(false);
		h.advance(1000);
		await h.controller.tick();
		expect(h.calls.nudge.length).toBe(0);
		expect(h.controller.phase).toBe("idle");
	});

	test("disabling the mode stops a running swarm", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		await settle(h);
		h.setDriverRunning(true);
		await h.controller.disable();
		expect(h.calls.stop).toEqual(["multi-agent mode disabled"]);
		expect(h.controller.phase).toBe("off");
		expect(h.controller.enabled).toBe(false);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1);
	});
});

describe("roster growth", () => {
	/**
	 * Start a pool sized for `tasks` ready tasks, then let the harness control how many workers are
	 * actually registered (`live`), which lags the background spawn in the real driver.
	 */
	async function runningPool(h: Harness, tasks: number, live?: number): Promise<void> {
		h.controller.enable();
		h.controller.noteTask("do the thing");
		for (let i = 0; i < tasks; i++) h.store.createTask({ title: `t${i}`, createdBy: "main" });
		await settle(h);
		h.setDriverRunning(true);
		h.setWorkers(live ?? tasks);
	}

	test("ready work published after the pool was sized grows the roster by the delta toward the plan", async () => {
		const h = harness();
		await runningPool(h, 2);
		expect(h.calls.start.length).toBe(1);
		h.store.createTask({ title: "late-1", createdBy: "main" });
		h.store.createTask({ title: "late-2", createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		expect(h.calls.start[1]).toEqual({ roles: [{ name: "general", count: 2, capabilities: ["general"] }], count: 2 });
		expect(h.calls.notify.length).toBe(1);
		expect(h.controller.phase).toBe("running");
	});

	test("growth is throttled to one step per ready-count increase", async () => {
		const h = harness({ config: { workers: 6 } });
		await runningPool(h, 2);
		h.store.createTask({ title: "late-1", createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		expect(h.calls.start[1]?.count).toBe(1);
		await h.controller.tick(); // nothing new is ready: no second step
		expect(h.calls.start.length).toBe(2);
		h.store.createTask({ title: "late-2", createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(3);
		expect(h.calls.start[2]?.count).toBe(1);
	});

	test("never grows past the worker budget", async () => {
		const h = harness();
		await runningPool(h, 2);
		for (let i = 0; i < 4; i++) h.store.createTask({ title: `late-${i}`, createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		expect(h.calls.start[1]?.count).toBe(2);
		expect(h.calls.start.reduce((n, call) => n + call.count, 0)).toBe(h.config.workers);
		h.store.createTask({ title: "more", createdBy: "main" });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2); // the budget is spent
	});

	test("does not grow while the driver is not running", async () => {
		const h = harness();
		await runningPool(h, 2);
		h.store.createTask({ title: "late", createdBy: "main" });
		h.setDriverRunning(false);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1);
	});

	test("does not grow for a spawn that is still coming up", async () => {
		const h = harness();
		await runningPool(h, 2, 0); // both spawns are still in flight: zero workers registered yet
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1); // the pool was already sized for this ready count
	});

	test("a growth that throws is reported and does not wedge the phase", async () => {
		const h = harness();
		await runningPool(h, 2);
		h.store.createTask({ title: "late", createdBy: "main" });
		h.failNextStart();
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		expect(h.calls.notify.length).toBe(1);
		expect(h.controller.phase).toBe("running");
	});
});

describe("status text", () => {
	test("names the mode in every phase the operator can see", () => {
		const h = harness();
		expect(h.controller.statusText()).toBeUndefined();
		expect(h.controller.header()).toEqual([]);

		h.controller.enable();
		expect(h.controller.statusText()).toBe("MULTI-AGENT ON · idle");
		expect(h.controller.header()).toEqual(["MULTI-AGENT MODE · idle"]);

		h.controller.noteTask("do the thing");
		expect(h.controller.statusText()).toBe("MULTI-AGENT ON · planning");
	});

	test("a running swarm reports the live counts", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "a", createdBy: "main" });
		h.store.createTask({ title: "b", createdBy: "main" });
		await settle(h);
		h.store.claim(h.store.listTasks({ limit: 10 })[0]?.id ?? "", "w1", 300);
		h.store.claim(h.store.listTasks({ limit: 10 })[1]?.id ?? "", "w2", 300);
		h.setDriverRunning(true);
		expect(h.controller.statusText()).toMatch(/^MULTI-AGENT ON · \d+a r0 c2 v0 d0$/);
	});

	test("a manual /swarm start under an enabled mode still shows its counts", () => {
		const h = harness();
		h.controller.enable();
		h.store.createTask({ title: "seeded by hand", createdBy: "main" });
		h.setDriverRunning(true);
		expect(h.controller.phase).toBe("idle");
		expect(h.controller.statusText()).toMatch(/^MULTI-AGENT ON · \d+a r1 c0 v0 d0$/);
	});
});

describe("swarm-side planning", () => {
	test("a live goal sizes the roster by itself, and never past the worker budget", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		expect(planRoster([], config, 3)).toEqual([{ name: "general", count: 3, capabilities: ["general"] }]);
		expect(planRoster([], config, 9).reduce((n, role) => n + role.count, 0)).toBe(4);
		expect(planRoster([], config)).toEqual([]); // without a goal there is still nothing to size
	});

	test("the round's single planning task does not shrink the pool to one worker", () => {
		const config: SwarmConfig = { ...DEFAULT_CONFIG, workers: 4 };
		const planning = task({ requiredCapabilities: ["general"] });
		expect(planRoster([planning], config, 3)).toEqual([{ name: "general", count: 3, capabilities: ["general"] }]);
		expect(planRoster([planning], config).reduce((n, role) => n + role.count, 0)).toBe(1);
	});

	test("a goal with no tasks at all starts the pool with the requested agent count", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		const opened = h.store.createGoal({ goal: "split me", agents: 3, createdBy: "main", now: h.now() });
		expect(opened.planningTask.requiredCapabilities).toEqual(["general"]);
		await settle(h);
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.start[0]?.count).toBe(3);
		expect(h.controller.phase).toBe("running");
		expect(h.controller.header()).toEqual(["MULTI-AGENT MODE · running · goal-1 (3a)"]);
	});

	test("a live goal keeps the pool out of the stall branch even when nothing is claimable", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		const opened = h.store.createGoal({ goal: "split me", agents: 2, createdBy: "main", deadlineMs: 600_000, now: h.now() });
		// Residue of exactly the shape the stall notice fires on: blocked work, nothing claimable.
		const seed = h.store.createTask({ title: "a", createdBy: "main" });
		h.store.claim(seed.id, "main", 300);
		h.store.fail(seed.id, "main", "cannot be done");
		h.store.createTask({ title: "b", createdBy: "main", dependencies: [seed.id] });
		await settle(h);
		h.setDriverRunning(true);
		// The round's only convergence path is closed, so nothing is actionable while the goal is open.
		expect(h.store.claim(opened.planningTask.id, "w1", 300, ["general"]).ok).toBe(true);
		expect(h.store.fail(opened.planningTask.id, "w1", "cannot merge").ok).toBe(true);
		h.advance(h.settleMs + h.settleMs);
		await h.controller.tick();
		expect(h.calls.stop).toEqual([]); // the round is in flight, not a stall
		expect(h.controller.phase).toBe("running");
		expect(h.calls.notify).toEqual([]);
	});

	test("the round's bound closes the goal with a FAIL instead of spinning", async () => {
		const h = harness();
		h.controller.enable();
		const opened = h.store.createGoal({ goal: "split me", agents: 2, createdBy: "main", deadlineMs: 1000, now: h.now() });
		await h.controller.tick();
		expect(h.store.getGoal(opened.goal.id)?.status).toBe("open"); // the bound does not fire early
		expect(h.calls.notify).toEqual([]);
		h.advance(1001);
		await h.controller.tick();
		expect(h.store.getGoal(opened.goal.id)?.status).toBe("failed");
		expect(h.store.getTask(opened.planningTask.id)?.status).toBe("failed");
		expect(h.calls.notify.length).toBe(1);
		expect(h.calls.main.length).toBe(1);
		const fails = h.store.searchBoard({ type: "FAIL" });
		expect(fails.length).toBe(1);
		expect(fails[0]?.content).toContain("hit its bound");
		expect(fails[0]?.tags).toContain("goal:goal-1");
	});

	test("the bound never re-closes a goal the scribe already planned", async () => {
		const h = harness();
		h.controller.enable();
		const opened = h.store.createGoal({ goal: "split me", agents: 2, createdBy: "main", deadlineMs: 1000, now: h.now() });
		expect(h.store.claim(opened.planningTask.id, "w1", 300, ["general"]).ok).toBe(true);
		h.store.postProposal(opened.goal, "w1", [{ title: "t" }]);
		expect(h.store.planGoal(opened.goal.id, "w1").ok).toBe(true);
		h.advance(10_000);
		await h.controller.tick();
		expect(h.store.getGoal(opened.goal.id)?.status).toBe("planned");
		expect(h.calls.notify).toEqual([]);
		expect(h.store.searchBoard({ type: "FAIL" })).toEqual([]);
	});

	test("the default policy hands the split to the workers and never asks for a task list", () => {
		const h = harness();
		h.controller.enable();
		expect(h.config.planning).toBe("swarm");
		expect(h.controller.policy()).toBe(SWARM_POLICY);
		expect(h.controller.policy()).toContain("swarm_goal");
		expect(h.controller.policy()).toContain("Do NOT write the task list yourself");
		expect(h.controller.policy()).not.toContain("Decompose it into 2-6 independent tasks");
		expect(h.controller.notice()).toContain("swarm_goal");
	});

	test('planning: "coordinator" keeps the old text, notice and nudge', async () => {
		const h = harness({ config: { planning: "coordinator" } });
		h.controller.enable();
		expect(h.controller.policy()).toBe(COORDINATOR_POLICY);
		expect(h.controller.policy()).toContain("Decompose it into 2-6 independent tasks");
		expect(h.controller.notice()).toContain("swarm_task_create");
		h.controller.noteTask("a task the coordinator forgot");
		h.setBusy(true);
		h.advance(1000);
		await h.controller.tick();
		expect(h.calls.nudge).toEqual([COORDINATOR_NUDGE]);
	});

	test("a swarm-planning coordinator that opens no goal is nudged toward swarm_goal", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("a task the coordinator forgot");
		h.setBusy(true);
		h.advance(1000);
		await h.controller.tick();
		expect(h.calls.nudge).toEqual([SWARM_NUDGE]);
		expect(h.calls.nudge[0]).toContain("swarm_goal");
	});
});

describe("planning config", () => {
	test("defaults to swarm, honours coordinator, and ignores an unknown value", () => {
		const dir = mkdtempSync(join(tmpdir(), "swarm-planning-config-"));
		tempDirs.push(dir);
		const configFile = join(dir, ".swarm", "config.json");
		expect(loadSwarmConfig(join(dir, "absent.json")).planning).toBe("swarm");
		saveSwarmAuto(configFile, false); // creates `.swarm/`, exactly as the mode switch does

		writeFileSync(configFile, `${JSON.stringify({ planning: "swarm" }, null, 2)}\n`);
		expect(loadSwarmConfig(configFile).planning).toBe("swarm");
		writeFileSync(configFile, `${JSON.stringify({ planning: "coordinator", workers: 2 }, null, 2)}\n`);
		expect(loadSwarmConfig(configFile).planning).toBe("coordinator");
		expect(loadSwarmConfig(configFile).workers).toBe(2);

		writeFileSync(configFile, `${JSON.stringify({ planning: "nonsense" }, null, 2)}\n`);
		expect(loadSwarmConfig(configFile).planning).toBe("swarm");
	});
});

describe("pool sizing from agent requests", () => {
	/** A running pool sized for one ready task: the shape a scale request has to correct. */
	async function pool(h: Harness, tasks = 1): Promise<void> {
		h.controller.enable();
		h.controller.noteTask("do the thing");
		for (let i = 0; i < tasks; i++) h.store.createTask({ title: `t${i}`, createdBy: "main" });
		await settle(h);
		h.setDriverRunning(true);
	}

	test("several asks for the same size collapse into ONE resize, the largest, and the asks are marked decided", async () => {
		const h = harness({ config: { workers: 6 } });
		await pool(h);
		expect(h.calls.start.length).toBe(1);
		h.store.recordScaleRequest({ agentId: "w1", requested: 5, reason: "queue is deep", current: 1 });
		h.store.recordScaleRequest({ agentId: "w2", requested: 4, reason: "same shortage", current: 1 });
		h.store.recordScaleRequest({ agentId: "w3", requested: 5, reason: "same shortage", current: 1 });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		expect(h.calls.start[1]).toMatchObject({ count: 4 });
		expect(h.calls.notify.some((line) => line.includes("grew by 4"))).toBe(true);
		expect(h.store.pendingScaleRequests()).toEqual([]); // consumed: the ask produced the resize
	});

	test("an ask above config.workers is clamped by the operator's ceiling", async () => {
		const h = harness({ config: { workers: 3 } });
		await pool(h);
		h.store.recordScaleRequest({ agentId: "w1", requested: 99, reason: "as many as possible", current: 1 });
		await h.controller.tick();
		expect(h.calls.start[1]?.count).toBe(2); // 3 - 1, never 98
		expect(h.calls.start.reduce((n, call) => n + call.count, 0)).toBe(3);
	});

	test("an under-budgeted pool grows only TO the ceiling, never 2 past it", async () => {
		// Three workers, each holding a task, and a fourth task ready: the live-work floor is 5 while the
		// operator budgeted 4. Before the fix the floor lifted the target to 5 and the controller recorded a
		// pool of 5 it could never have (the host clamps) — and the plan's growth gate went dead with it.
		const h = harness({ config: { workers: 4 } });
		await pool(h, 3);
		for (const task of h.store.listTasks({ status: "ready", limit: 10 })) h.store.claim(task.id, "w1", 300, []);
		h.store.createTask({ title: "late", createdBy: "main" });
		h.store.recordScaleRequest({ agentId: "w1", requested: 6, reason: "the queue is deeper than the pool", current: 3 });

		const before = h.calls.start.length;
		await h.controller.tick();
		expect(h.calls.start.length).toBe(before + 1);
		expect(h.calls.start.at(-1)?.count).toBe(1); // 4 - 3: to the ceiling, not to the floor (5)
		expect(h.calls.start.reduce((n, call) => n + call.count, 0)).toBeLessThanOrEqual(4);
		expect(h.store.pendingScaleRequests()).toEqual([]); // the ask was answered, not silently dropped
	});

	test("a saturated pool holds at the ceiling, says so, and never claims a growth it did not get", async () => {
		const h = harness({ config: { workers: 2 } });
		await pool(h, 2);
		h.setWorkers(2);
		for (const task of h.store.listTasks({ status: "ready", limit: 10 })) h.store.claim(task.id, "w1", 300, []);
		h.store.createTask({ title: "late", createdBy: "main" });
		h.store.recordScaleRequest({ agentId: "w1", requested: 8, reason: "much deeper than the pool", current: 2 });

		const starts = h.calls.start.length;
		const notices = h.calls.notify.length;
		await h.controller.tick();
		const added = h.calls.notify.slice(notices);
		expect(h.calls.start.length).toBe(starts); // nothing spawned above the budget
		expect(added.some((line) => line.includes("grew by"))).toBe(false); // and no false growth claim
		expect(added.some((line) => line.includes("the operator's ceiling is 2"))).toBe(true); // the honest reason
		expect(h.store.pendingScaleRequests()).toEqual([]);
	});

	test("a shrink stops idle peers only and leaves the ask pending when nobody is idle", async () => {
		const h = harness({ config: { workers: 6 } });
		await pool(h, 4);
		h.setWorkers(4);
		h.setIdle(0);
		h.store.recordScaleRequest({ agentId: "w1", requested: 1, reason: "over-provisioned", current: 4 });
		await h.controller.tick();
		expect(h.calls.shrink).toEqual([]); // nothing idle: deferred, never a worker holding work
		expect(h.store.pendingScaleRequests().length).toBe(1);
		h.setIdle(2);
		h.advance(30_001);
		await h.controller.tick();
		expect(h.calls.shrink).toEqual([2]);
		expect(h.store.pendingScaleRequests()).toEqual([]);
	});

	test("an over-provisioned pool prunes itself toward the plan with no ask at all", async () => {
		const h = harness({ config: { workers: 4 } });
		await pool(h, 4);
		h.setWorkers(4);
		h.setIdle(3);
		// three of the four tasks finish, so the plan is one task and two workers (held + free + ready)
		for (const task of h.store.listTasks({ limit: 10 }).slice(1)) {
			h.store.claim(task.id, "w9", 300, ["general"]);
			h.store.complete(task.id, "w9", { summary: "done" });
		}
		await h.controller.tick();
		expect(h.calls.shrink).toEqual([2]);
		expect(h.calls.notify.some((line) => line.includes("stopped 2 idle worker"))).toBe(true);
	});

	test("a resize inside the cooldown is deferred, and applied once the window passes", async () => {
		const h = harness({ config: { workers: 6 }, auto: { scaleCooldownMs: 1000 } });
		await pool(h);
		h.store.recordScaleRequest({ agentId: "w1", requested: 3, reason: "more peers", current: 1 });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2);
		h.store.recordScaleRequest({ agentId: "w2", requested: 5, reason: "even more", current: 3 });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(2); // still cooling down
		expect(h.store.pendingScaleRequests().length).toBe(1);
		h.advance(1001);
		await h.controller.tick();
		expect(h.calls.start.length).toBe(3);
		expect(h.calls.start[2]?.count).toBe(2);
	});

	test("an ask the pool already satisfies is consumed, never retried forever", async () => {
		const h = harness({ config: { workers: 6 } });
		await pool(h, 2);
		h.store.recordScaleRequest({ agentId: "w1", requested: 2, reason: "we are fine as we are", current: 2 });
		await h.controller.tick();
		expect(h.calls.start.length).toBe(1);
		expect(h.calls.shrink).toEqual([]);
		expect(h.store.pendingScaleRequests()).toEqual([]); // decided as satisfied
	});
});

describe("pool starvation: ready work nobody online can claim", () => {
	/**
	 * A running pool whose claimable work has been taken by an online general agent, so the only thing
	 * left ready is whatever the test creates. Without the claim, a `ready` row that ANY online agent
	 * could take would (correctly) silence the detector.
	 */
	async function claimedPool(h: Harness): Promise<void> {
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "claimable", createdBy: "main" });
		await settle(h);
		h.setDriverRunning(true);
		h.setWorkers(1);
		h.store.registerAgent({ id: "SwiftTiger", role: "general", capabilities: ["general"] });
		h.store.claim("task-1", "SwiftTiger", 300, ["general"]);
	}

	const starvationNotices = (h: Harness) => h.calls.notify.filter((line) => line.includes("can claim"));

	test("a ready row demanding a capability nobody holds is notified once, named, and is not a stall", async () => {
		const h = harness();
		await claimedPool(h);
		h.store.createTask({ title: "audit the thing", createdBy: "main", requiredCapabilities: ["reviewer"] });
		const stops = h.calls.stop.length;

		await h.controller.tick();
		const notices = starvationNotices(h);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("task-2");
		expect(notices[0]).toContain("reviewer");
		// The main session is told too, so a human can re-file the row.
		expect(h.calls.main.filter((line) => line.includes("can claim"))).toHaveLength(1);
		// Not a stall-stop of its own: the row is legitimate, only unroutable.
		expect(h.calls.stop.length).toBe(stops);
		expect(h.controller.phase).toBe("running");

		// A tick repeating the same condition stays silent; growth never mints the capability.
		const starts = h.calls.start.length;
		await h.controller.tick();
		expect(starvationNotices(h)).toHaveLength(1);
		expect(h.calls.start.length).toBe(starts);
	});

	test("a capable but busy agent silences it: that is queueing, not starvation", async () => {
		const h = harness();
		await claimedPool(h);
		h.store.registerAgent({ id: "VividTiger", role: "reviewer", capabilities: ["reviewer"] });
		h.store.setAgentStatus("VividTiger", "working");
		h.store.createTask({ title: "audit the thing", createdBy: "main", requiredCapabilities: ["reviewer"] });
		await h.controller.tick();
		expect(starvationNotices(h)).toEqual([]);
	});

	test("an offline capable agent does not count, and the notice re-arms on the next occurrence", async () => {
		const h = harness();
		await claimedPool(h);
		h.store.registerAgent({ id: "VividTiger", role: "reviewer", capabilities: ["reviewer"] });
		h.store.createTask({ title: "audit the thing", createdBy: "main", requiredCapabilities: ["reviewer"] });
		await h.controller.tick();
		expect(starvationNotices(h)).toEqual([]); // capable and online: fine

		h.store.setAgentStatus("VividTiger", "offline");
		await h.controller.tick();
		expect(starvationNotices(h)).toHaveLength(1); // the condition, reported fresh

		await h.controller.tick();
		expect(starvationNotices(h)).toHaveLength(1); // and silent while it still holds
	});

	test("an ordinary ready pool with a capable idle agent is untouched (regression)", async () => {
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("do the thing");
		h.store.createTask({ title: "one", createdBy: "main", requiredCapabilities: ["general"] });
		await settle(h);
		h.setDriverRunning(true);
		h.setWorkers(1);
		h.store.registerAgent({ id: "SwiftTiger", role: "general", capabilities: ["general"] });
		await h.controller.tick();
		expect(starvationNotices(h)).toEqual([]);
	});
});

