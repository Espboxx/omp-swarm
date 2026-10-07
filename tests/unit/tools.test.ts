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
