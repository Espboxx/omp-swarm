/**
 * Multi-agent mode: roster derivation (pure) and the AutoController state machine.
 * No sessions, no network, no timers — the clock and the driver are faked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AutoController, NUDGE_TEXT, planRoster, type AutoDeps, type AutoOptions } from "../../extension/auto";
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
	nudge: string[];
	main: string[];
	notify: string[];
}

function harness(options: { config?: Partial<SwarmConfig>; auto?: AutoOptions } = {}) {
	const store = makeStore();
	const config: SwarmConfig = { ...DEFAULT_CONFIG, ...options.config };
	const calls: Calls = { start: [], stop: [], nudge: [], main: [], notify: [] };
	let clock = 1_000_000;
	let busy = false;
	let running = false;
	let workers = 0;
	let startFailure = false;
	const deps: AutoDeps = {
		store,
		config,
		isDriverRunning: () => running,
		workerCount: () => workers,
		startSwarm: async (roles, count) => {
			calls.start.push({ roles, count });
			if (startFailure) {
				startFailure = false;
				throw new Error("swarm is already running");
			}
			return roles.map((role) => role.name);
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
		const h = harness();
		h.controller.enable();
		h.controller.noteTask("a task the coordinator forgot");
		h.setBusy(true);
		h.advance(1000);
		await h.controller.tick();
		expect(h.controller.phase).toBe("nudging");
		expect(h.calls.nudge).toEqual([NUDGE_TEXT]);
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
