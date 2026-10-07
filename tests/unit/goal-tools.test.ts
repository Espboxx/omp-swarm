/**
 * The goal round through the TOOL layer: swarm_goal opens it, a worker posts its own split with
 * swarm_propose, and the scribe merges it with swarm_plan. This is the wiring the live run exercises
 * end to end - here without a session, so a broken tool is caught before a PTY proof.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { buildSwarmTools, type SwarmIdentity } from "../../extension/tools";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

function makeStore(): SwarmStore {
	return new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), "swarm-goal-tools")));
}

/** A worker's tool surface, exactly as `driver.ts` builds it. */
function workerTools(store: SwarmStore, id: string, config: Partial<SwarmConfig> = {}) {
	const identity: SwarmIdentity = { id, role: "general", capabilities: ["general"], isMain: false };
	const tools = buildSwarmTools({ store, config: { ...DEFAULT_CONFIG, ...config }, identity, z: zod });
	const call = async (name: string, params: object): Promise<string> => {
		const picked = tools.find((candidate) => candidate.name === name);
		if (picked === undefined) throw new Error(`the tool ${name} is not in the catalog`);
		// A test seam over the host's tool signature: none of the goal tools reads `onUpdate`/`ctx`, so
		// the harness supplies none and drops the abort signal.
		type ToolRun = (id: string, params: object) => Promise<{ content: readonly { type: string; text?: string }[] }>;
		const result = await (picked.execute as unknown as ToolRun)("call-1", params);
		return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
	};
	return { call, names: tools.map((tool) => tool.name) };
}

describe("swarm_goal", () => {
	test("opens the round and hands back the one planning task", async () => {
		const store = makeStore();
		const { call, names } = workerTools(store, "main");
		expect(names).toContain("swarm_goal");
		expect(names).toContain("swarm_propose");
		expect(names).toContain("swarm_plan");
		const text = await call("swarm_goal", { goal: "make the parser fast", agents: 3 });
		expect(text).toContain("goal-1 open with 3 agent(s)");
		expect(text).toContain("planning task: task-1");
		const goal = store.getGoal("goal-1");
		expect(goal?.goal).toBe("make the parser fast");
		expect(goal?.agents).toBe(3);
		expect(goal?.status).toBe("open");
		store.close();
	});

	test("clamps the budget to config.workers and refuses an empty or unusable count", async () => {
		const store = makeStore();
		const { call } = workerTools(store, "main", { workers: 2 });
		expect(await call("swarm_goal", { goal: "big", agents: 9 })).toContain("capped by config.workers=2");
		expect(store.getGoal("goal-1")?.agents).toBe(2);
		expect(await call("swarm_goal", { goal: "   ", agents: 2 })).toContain("needs the user's request");
		expect(await call("swarm_goal", { goal: "x", agents: 0 })).toContain("at least 1");
		expect(store.liveGoals().length).toBe(1);
		store.close();
	});

	test("the legacy mode refuses to open a round and says what to do instead", async () => {
		const store = makeStore();
		const { call } = workerTools(store, "main", { planning: "coordinator" });
		expect(await call("swarm_goal", { goal: "x", agents: 2 })).toContain("swarm_task_create");
		expect(store.liveGoals()).toEqual([]);
		store.close();
	});
});

describe("swarm_propose", () => {
	test("posts the worker's own split onto the board and names the next step", async () => {
		const store = makeStore();
		const main = workerTools(store, "main");
		await main.call("swarm_goal", { goal: "split the work", agents: 2 });
		const text = await workerTools(store, "w1").call("swarm_propose", {
			tasks: [{ title: "Ship the parser", files: ["src/p.ts"], capabilities: ["general"] }],
		});
		expect(text).toContain("proposal #1 for goal-1");
		expect(text).toContain("1 proposal(s) on the board so far");
		const goal = store.getGoal("goal-1");
		if (goal === undefined) throw new Error("the goal vanished");
		expect(store.listProposals(goal).length).toBe(1);
		const entry = store.searchBoard({ tags: ["proposal"] })[0];
		expect(entry?.type).toBe("OBSERVATION");
		expect(entry?.taskId).toBe(goal.planningTask);
		expect(store.liveGoals().length).toBe(1);
		store.close();
	});

	test("without an open goal it says so instead of inventing one", async () => {
		const store = makeStore();
		const text = await workerTools(store, "w1").call("swarm_propose", { tasks: [{ title: "x" }] });
		expect(text).toContain("no open goal");
		expect(await workerTools(store, "w1").call("swarm_propose", { goal_id: "goal-9", tasks: [{ title: "x" }] })).toContain("unknown goal goal-9");
		store.close();
	});
});

describe("swarm_plan", () => {
	async function announced(): Promise<{ store: SwarmStore; call: (name: string, params: object) => Promise<string> }> {
		const store = makeStore();
		await workerTools(store, "main").call("swarm_goal", { goal: "split the work", agents: 2 });
		await workerTools(store, "w1").call("swarm_propose", {
			tasks: [
				{ title: "Ship the parser", deliverable: "parser + tests", files: ["src/p.ts"] },
				{ title: "Ship the CLI", depends_on: ["Ship the parser"], review_required: true },
			],
		});
		await workerTools(store, "w2").call("swarm_propose", { tasks: [{ title: "ship   the PARSER.", files: ["tests/p.test.ts"] }] });
		return { store, call: workerTools(store, "w1").call };
	}

	test("refuses before the planning task is claimed, then merges the round exactly once", async () => {
		const { store, call } = await announced();
		expect(await call("swarm_plan", { goal_id: "goal-1" })).toContain("claim the goal's planning task first");
		expect((await call("swarm_claim", { task_id: "task-1" })).length).toBeGreaterThan(0);
		const planned = await call("swarm_plan", { goal_id: "goal-1" });
		expect(planned).toContain("goal-1 planned: 2 task(s) created");
		expect(planned).toContain("1 duplicate deliverable(s) folded");
		expect(planned).toContain("planning task task-1 completed");
		const goal = store.getGoal("goal-1");
		expect(goal?.status).toBe("planned");
		expect(goal?.planner).toBe("w1");
		expect(store.liveGoals()).toEqual([]);
		expect(store.getTask("task-1")?.status).toBe("done");
		const parser = store.listTasks({ limit: 20 }).find((task) => task.title === "Ship the parser");
		expect(parser?.files.sort()).toEqual(["src/p.ts", "tests/p.test.ts"]);
		const cli = store.listTasks({ limit: 20 }).find((task) => task.title === "Ship the CLI");
		expect(cli?.dependencies.length).toBe(1);
		expect(cli?.dependencies[0]).toBe(parser?.id);
		expect(cli?.review.required).toBe(true);
		expect(store.searchBoard({ type: "DECISION" }).length).toBe(1);

		// The round is closed: the planning task is done, so nothing can merge again, and no
		// deliverable is created twice.
		expect(await call("swarm_plan", { goal_id: "goal-1" })).toContain("claim the goal's planning task first");
		expect(store.searchBoard({ type: "DECISION" }).length).toBe(1);
		expect(store.listTasks({ limit: 20 }).filter((task) => task.title === "Ship the parser").length).toBe(1);
		store.close();
	});

	test("a second claimer cannot merge after the first scribe took the round", async () => {
		const { store } = await announced();
		const w1 = workerTools(store, "w1");
		const w3 = workerTools(store, "w3");
		await w1.call("swarm_claim", { task_id: "task-1" });
		expect(await w3.call("swarm_plan", { goal_id: "goal-1" })).toContain("claim the goal's planning task first");
		expect(store.getGoal("goal-1")?.status).toBe("open");
		expect(await w1.call("swarm_plan", { goal_id: "goal-1" })).toContain("2 task(s) created");
		store.close();
	});
});
