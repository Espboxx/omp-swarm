/**
 * The idle worker's own instruction pair, apart from the goal round (`tests/unit/goal-tools.test.ts`):
 * `swarm_wait`'s timeout return and the constitution the worker obeys. Both used to demand a loop —
 * "check the board for something useful to add, then wait again or stop" together with "Do not stop
 * between tasks" — which is one full model call per wait window per idle worker, forever. That loop was
 * a workaround for a driver that woke idle workers on a TIMER; the driver now wakes a worker when
 * agent-relevant state CHANGES, so ending the turn loses no wake-up and the instructions must say so
 * (board QUESTION #611, task-171).
 *
 * No wall clock: `swarm_wait` blocks by looping, so its clock is injected (the same kind of seam
 * `driver.ts` gets from `timers`) and the fake clock advances the window instead of a real sleep.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { workerBootstrap, workerSystemPrompt } from "../../extension/driver";
import { SwarmStore } from "../../extension/store";
import { buildSwarmTools, type SwarmIdentity, type WaitClock } from "../../extension/tools";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

interface CallResult {
	text: string;
	details: Record<string, unknown>;
}

/** A clock that never sleeps: the wait loop advances it by asking for a window it never waits out. */
function fakeClock(start = 1_000): WaitClock {
	let current = start;
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += ms;
		},
	};
}

/**
 * A worker's tool surface exactly as `driver.ts` builds it, returning the catalog itself (so a test can
 * read the description the model sees before it calls anything) and a caller that keeps `details` —
 * where `wake` lives, and which the goal-round harness drops.
 */
function workerTools(store: SwarmStore, id: string, clock: WaitClock, config: Partial<SwarmConfig> = {}) {
	const identity: SwarmIdentity = { id, role: "general", capabilities: ["general"], isMain: false };
	const tools = buildSwarmTools({ store, config: { ...DEFAULT_CONFIG, ...config }, identity, z: zod, clock });
	const call = async (name: string, params: object): Promise<CallResult> => {
		const picked = tools.find((candidate) => candidate.name === name);
		if (picked === undefined) throw new Error(`the tool ${name} is not in the catalog`);
		// A test seam over the host's tool signature: none of the tools under test reads `onUpdate`/`ctx`.
		type ToolRun = (id: string, params: object) => Promise<{
			content: readonly { type: string; text?: string }[];
			details?: Record<string, unknown>;
		}>;
		const result = await (picked.execute as unknown as ToolRun)("call-1", params);
		return {
			text: result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n"),
			details: result.details ?? {},
		};
	};
	return { tools, call };
}

describe("swarm_wait: an idle pool ends the turn", () => {
	test("the timeout path says END YOUR TURN and never invites invented work", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-timeout")));
		const { tools, call } = workerTools(store, "RapidTiger", fakeClock());
		const wait = tools.find((candidate) => candidate.name === "swarm_wait");
		const { text, details } = await call("swarm_wait", { seconds: 25 });
		expect(text).toContain("END YOUR TURN");
		expect(text).toContain("nothing changed");
		expect(details.wake).toBe("timeout"); // the return shape callers and tests key on
		expect(text).not.toContain("something useful to add");
		expect(text).not.toContain("wait again");
		expect(text).not.toContain("create the next task");
		// The description is read before the tool is ever called, so it must not demand a loop either.
		expect(wait?.description ?? "").toContain("END YOUR TURN");
		expect(wait?.description ?? "").not.toContain("Run this instead of ending your turn");
	});

	test("a peer message still returns immediately, with the inbox prompt", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-message")));
		const { call } = workerTools(store, "RapidTiger", fakeClock());
		store.sendMessage({ to: "RapidTiger", from: "SwiftTiger", body: "ping" });
		const { text, details } = await call("swarm_wait", { seconds: 25 });
		expect(text).toContain("message waiting");
		expect(text).not.toContain("END YOUR TURN");
		expect(details.wake).toBe("message");
	});

	test("claimable work is returned without waiting out the window", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-task")));
		const { call } = workerTools(store, "RapidTiger", fakeClock());
		store.createTask({ title: "a real task", createdBy: "main" });
		const { text, details } = await call("swarm_wait", { seconds: 25 });
		expect(text).toContain("work available");
		expect(text).toContain("task-1");
		expect(text).not.toContain("END YOUR TURN");
		expect(details.wake).toBe("task");
	});
});

describe("a lifecycle call releases only its own task's file holds", () => {
	/**
	 * The lock that used to evaporate: `swarm_renew` called `releaseReservations(identity.id)` with no
	 * patterns, so the one call the docs tell a busy agent to make deleted every reservation it held —
	 * and closing one task also dropped another task's files (FAIL #602). A reservation is the only
	 * thing stopping two agents from writing one file, so this is the difference between a lock and a
	 * line in the docs.
	 */
	const patternsOf = (store: SwarmStore, id: string) =>
		store
			.listReservations()
			.filter((row) => row.owner === id)
			.map((row) => row.pattern)
			.sort();

	/** Two tasks with disjoint declared files, both claimed by the same worker. */
	const twoClaimedTasks = async (store: SwarmStore, call: (name: string, params: object) => Promise<CallResult>) => {
		store.createTask({ title: "a", createdBy: "main", files: ["omp-swarm/extension/a.ts"] });
		store.createTask({ title: "b", createdBy: "main", files: ["omp-swarm/extension/b.ts"] });
		await call("swarm_claim", { task_id: "task-1" });
		await call("swarm_claim", { task_id: "task-2" });
	};

	test("renewing keeps every reservation the caller holds", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-renew")));
		const { call } = workerTools(store, "SwiftTiger", fakeClock());
		await twoClaimedTasks(store, call);
		// A hold the agent made by hand carries no task, so nothing it does to a task may drop it.
		await call("swarm_reserve", { paths: ["scratch/notes.md"] });
		const before = patternsOf(store, "SwiftTiger");
		expect(before).toContain("omp-swarm/extension/a.ts");

		const { text } = await call("swarm_renew", {});
		expect(text).toContain("renewed: task-1, task-2");
		expect(patternsOf(store, "SwiftTiger")).toEqual(before);
	});

	test("completing one task keeps the other task's reservation", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-complete")));
		const { call } = workerTools(store, "SwiftTiger", fakeClock());
		await twoClaimedTasks(store, call);

		await call("swarm_complete", { task_id: "task-1", summary: "done" });
		expect(patternsOf(store, "SwiftTiger")).toEqual(["omp-swarm/extension/b.ts"]);
	});

	test("releasing one task keeps the other task's reservation", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-release")));
		const { call } = workerTools(store, "SwiftTiger", fakeClock());
		await twoClaimedTasks(store, call);

		await call("swarm_release", { task_id: "task-1", reason: "blocked" });
		expect(patternsOf(store, "SwiftTiger")).toEqual(["omp-swarm/extension/b.ts"]);
	});

	test("failing one task keeps the other task's reservation", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-fail")));
		const { call } = workerTools(store, "SwiftTiger", fakeClock());
		await twoClaimedTasks(store, call);

		await call("swarm_fail", { task_id: "task-1", reason: "dead end" });
		expect(patternsOf(store, "SwiftTiger")).toEqual(["omp-swarm/extension/b.ts"]);
	});

	test("the unreserve tool still releases exactly the paths it is given", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-unreserve")));
		const { call } = workerTools(store, "SwiftTiger", fakeClock());
		await call("swarm_reserve", { paths: ["scratch/a.md", "scratch/b.md"] });

		await call("swarm_unreserve", { paths: ["scratch/a.md"] });
		expect(patternsOf(store, "SwiftTiger")).toEqual(["scratch/b.md"]);
	});
});

describe("the worker's instruction pair states the rule the driver can honour", () => {
	const spec = { name: "RapidTiger", role: "general", capabilities: ["general"], index: 0 };

	test("an empty pool ends the turn, and unfinished work still never stops", () => {
		const prompt = workerSystemPrompt(spec, DEFAULT_CONFIG, "/tmp/root");
		expect(prompt).toContain("END YOUR TURN");
		expect(prompt).not.toContain("Do not stop between tasks");
		expect(prompt).not.toContain("Never end your turn while the swarm is running and work is claimable");
		// The half that must NOT be weakened: work in hand keeps the worker looping, and it still never
		// stalls silently.
		expect(prompt).toContain("Never end your turn while you hold unfinished work, and never stall silently.");
	});

	test("the bootstrap no longer orders the worker to keep looping while the pool is empty", () => {
		const bootstrap = workerBootstrap(spec, DEFAULT_CONFIG);
		expect(bootstrap).toContain("Keep going while work exists");
		expect(bootstrap).toContain("end your turn");
		expect(bootstrap).not.toContain("Do not stop between tasks");
		expect(bootstrap).not.toContain("then claim again");
	});
});

describe("swarm_wait reports only rows this agent can actually take", () => {
	/**
	 * The read-side half of the same family: `swarm_wait` consulted capabilities but not the file
	 * reservations that gate the claim path, so it reported `work available: task-N` for a row
	 * `swarm_claim` is certain to refuse — one full model turn per idle agent per attempt, for work
	 * that was never theirs (FAIL #648).
	 */
	test("a row whose declared files another agent holds is NOT work available", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-wait-blocked")));
		const { call } = workerTools(store, "RapidTiger", fakeClock());
		store.createTask({ title: "someone else's file", createdBy: "main", files: ["omp-swarm/extension/driver.ts"] });
		expect(store.acquireReservations("SwiftTiger", ["omp-swarm/extension/driver.ts"], 600, "task-97").ok).toBe(true);

		const { text, details } = await call("swarm_wait", { seconds: 25 });
		expect(details.wake).toBe("timeout");
		expect(text).toContain("END YOUR TURN");
		expect(text).not.toContain("work available");
	});

	test("the same row is work with no reservation, or when the caller is the holder", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-wait-owner")));
		const { call } = workerTools(store, "RapidTiger", fakeClock());
		store.createTask({ title: "the only row", createdBy: "main", files: ["omp-swarm/extension/driver.ts"] });

		const free = await call("swarm_wait", { seconds: 25 });
		expect(free.details.wake).toBe("task");
		expect(free.text).toContain("work available");

		// The caller's own hold is not a conflict: `acquireReservations` exempts the owner, so the claim
		// path is open and the row must stay reported as work.
		expect(store.acquireReservations("RapidTiger", ["omp-swarm/extension/driver.ts"], 600, "task-98").ok).toBe(true);
		const own = await call("swarm_wait", { seconds: 25 });
		expect(own.details.wake).toBe("task");
		expect(own.text).toContain("work available");
	});

	test("a row with no declared files stays claimable, and an unblocked row wins over a blocked one", async () => {
		const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-tools-wait-second")));
		const { call } = workerTools(store, "RapidTiger", fakeClock());
		store.createTask({ title: "blocked", createdBy: "main", files: ["omp-swarm/extension/driver.ts"] });
		expect(store.acquireReservations("SwiftTiger", ["omp-swarm/extension/driver.ts"], 600, "task-97").ok).toBe(true);
		store.createTask({ title: "free", createdBy: "main" });

		const { text, details } = await call("swarm_wait", { seconds: 25 });
		expect(details.wake).toBe("task");
		expect(text).toContain("task-2");
		expect(text).not.toContain("task-1");
	});
});
