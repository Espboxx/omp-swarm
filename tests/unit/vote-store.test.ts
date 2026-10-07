/**
 * The vote ROUND at the store/tool layer (goal-8): a decision is auditable, denied by default at its
 * bound, never silently executed, and the gate is real. The pure arithmetic lives in voting.test.ts;
 * this file proves the wiring around it — the row, the ballots, the sweep that denies on time, the
 * board/event trail, and the decision points that ask for a passed round before they act.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { buildSwarmTools, type SwarmIdentity } from "../../extension/tools";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

let roots = 0;

function makeStore(): SwarmStore {
	// One root per store: the DB is in memory, but the event jsonl the store appends to is a real file, and
	// two tests sharing it would read each other's audit trail.
	roots += 1;
	return new SwarmStore(openInMemoryDatabase(), swarmPaths(join(tmpdir(), `swarm-vote-store-${roots}`)));
}

/** A tool surface for one identity, exactly as `driver.ts` builds it (a test seam over the host shape). */
function toolkit(store: SwarmStore, id: string, config: Partial<SwarmConfig> = {}, isMain = false) {
	const identity: SwarmIdentity = { id, role: "general", capabilities: ["general"], isMain };
	const tools = buildSwarmTools({ store, config: { ...DEFAULT_CONFIG, ...config }, identity, z: zod });
	const call = async (name: string, params: object): Promise<string> => {
		const picked = tools.find((candidate) => candidate.name === name);
		if (picked === undefined) throw new Error(`the tool ${name} is not in the catalog`);
		type ToolRun = (id: string, params: object) => Promise<{ content: readonly { type: string; text?: string }[] }>;
		const result = await (picked.execute as unknown as ToolRun)("call-1", params);
		return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
	};
	return { call, names: tools.map((tool) => tool.name) };
}

function roster(store: SwarmStore, ids: string[]): void {
	for (const id of ids) store.registerAgent({ id, role: "general", capabilities: ["general"] });
}

describe("swarm_vote: a round that passes executes the decision exactly once", () => {
	test("a create-task round above 75% creates the task; one vote of two does not", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");
		const w2 = toolkit(store, "w2");
		expect(w1.names).toContain("swarm_vote");

		const opened = await w1.call("swarm_vote", {
			kind: "create-task",
			question: "add the parser test",
			payload_json: JSON.stringify({ title: "parser test" }),
		});
		expect(opened).toContain("opened vote-1");
		expect(opened).toContain("needs strictly more than 0.75");
		expect(store.listTasks({}).length).toBe(0);

		const half = await w1.call("swarm_vote", { decision_id: "vote-1", approve: true });
		expect(half).toContain("needs 2 of 2");
		expect(store.listTasks({}).length).toBe(0);
		expect(store.getVote("vote-1")?.status).toBe("open");

		const settled = await w2.call("swarm_vote", { decision_id: "vote-1", approve: true });
		expect(settled).toContain("round settled");
		expect(store.getVote("vote-1")?.status).toBe("passed");
		const tasks = store.listTasks({});
		expect(tasks.length).toBe(1);
		expect(tasks[0].title).toBe("parser test");
		expect(store.getVote("vote-1")?.result).toContain("created task-1");
		expect(store.searchBoard({ tags: ["vote_passed"] }).length).toBe(1);
		store.close();
	});

	test("the coordinator's own round is a seed and never votes", async () => {
		const store = makeStore();
		roster(store, ["main"]);
		const main = toolkit(store, "main", {}, true);
		const text = await main.call("swarm_vote", {
			kind: "create-task",
			question: "seed the first task",
			payload_json: JSON.stringify({ title: "seeded" }),
		});
		expect(text).toContain("seeded vote-1");
		expect(store.getVote("vote-1")?.status).toBe("seeded");
		expect(store.listTasks({}).length).toBe(1);
		store.close();
	});
});

describe("swarm_vote: the bound denies, loudly and without executing", () => {
	test("a sub-quorum round fails at the bound with vote_failed on the events AND the board", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 1 });
		await w1.call("swarm_vote", { kind: "create-task", question: "sneak a task in", payload_json: JSON.stringify({ title: "sneaky" }) });
		await w1.call("swarm_vote", { decision_id: "vote-1", approve: true });

		// The sweep is the beat's own housekeeping, and it settles on the clock it is given: driving that
		// clock past the bound is the same test without a real sleep (a fake wait would just hide the race).
		const bound = store.getVote("vote-1")?.deadlineAt ?? 0;
		expect(store.sweep(60).settledVotes).toEqual([]);
		const settled = store.settleVotes(60, bound);
		expect(settled.map((vote) => vote.id)).toEqual(["vote-1"]);
		expect(store.getVote("vote-1")?.status).toBe("failed");
		expect(store.getVote("vote-1")?.result).toContain("timeout");
		expect(store.listTasks({}).length).toBe(0);

		const events = store.eventsOfType("vote.failed");
		expect(events.length).toBe(1);
		expect(events[0].data.for).toEqual(["w1"]);
		expect(events[0].data.absent).toEqual(["w2"]);
		const failed = store.searchBoard({ tags: ["vote_failed"] });
		expect(failed.length).toBe(1);
		expect(failed[0].content).toContain("absent 1 [w2]");
		store.close();
	});

	test("a hopeless round settles at once instead of waiting out the clock", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 90 });
		await w1.call("swarm_vote", { kind: "create-task", question: "rejected", payload_json: JSON.stringify({ title: "nope" }) });
		const text = await w1.call("swarm_vote", { decision_id: "vote-1", approve: false });
		expect(text).toContain("round settled");
		expect(store.getVote("vote-1")?.status).toBe("failed");
		expect(store.getVote("vote-1")?.result).toContain("unreachable");
		store.close();
	});
});

describe("swarm_vote: who counts", () => {
	test("one agent, one ballot: a repeat is refused, and a non-voter never counts", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");
		await w1.call("swarm_vote", { kind: "create-task", question: "q", payload_json: JSON.stringify({ title: "t" }) });
		expect(await w1.call("swarm_vote", { decision_id: "vote-1", approve: true })).toContain("voted FOR");
		expect(await w1.call("swarm_vote", { decision_id: "vote-1", approve: true })).toContain("already voted");

		// "ghost" is not on the roster: its ballot is recorded, reported, and ignored — it cannot tip a round.
		const ghost = await toolkit(store, "ghost").call("swarm_vote", { decision_id: "vote-1", approve: true });
		expect(ghost).toContain("ignored ghost");
		expect(store.getVote("vote-1")?.status).toBe("open");

		// With an offline third agent the base is the two ONLINE voters, so an offline agent cannot stall it.
		roster(store, ["w3"]);
		store.setAgentStatus("w3", "offline");
		const settled = await toolkit(store, "w2").call("swarm_vote", { decision_id: "vote-1", approve: true });
		expect(settled).toContain("eligible 2");
		expect(store.getVote("vote-1")?.status).toBe("passed");
		store.close();
	});

	test("a threshold request can only tighten the operator's policy", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");
		await w1.call("swarm_vote", { kind: "create-task", question: "loosen me", payload_json: JSON.stringify({ title: "a" }), threshold: 0.1 });
		expect(store.getVote("vote-1")?.threshold).toBe(0.75);
		await w1.call("swarm_vote", { kind: "create-task", question: "tighten me", payload_json: JSON.stringify({ title: "b" }), threshold: 0.9 });
		expect(store.getVote("vote-2")?.threshold).toBe(0.9);
		store.close();
	});
});

describe("the gate: cluster-level decisions need a passed round", () => {
	test("a regular agent cannot create a task without one, and can with a passed round", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");
		const refused = await w1.call("swarm_task_create", { title: "bypass" });
		expect(refused).toContain("cluster-level decision (create-task)");
		expect(store.listTasks({}).length).toBe(0);

		await w1.call("swarm_vote", { kind: "create-task", question: "approved row", payload_json: JSON.stringify({ title: "approved" }) });
		await w1.call("swarm_vote", { decision_id: "vote-1", approve: true });
		await toolkit(store, "w2").call("swarm_vote", { decision_id: "vote-1", approve: true });

		const allowed = await w1.call("swarm_task_create", { title: "second", vote_id: "vote-1" });
		expect(allowed).toContain("created task-2");
		expect(store.listTasks({}).length).toBe(2);
		store.close();
	});

	test("the coordinator's own call is a seed and needs no round", async () => {
		const store = makeStore();
		roster(store, ["main"]);
		const main = toolkit(store, "main", {}, true);
		expect(await main.call("swarm_task_create", { title: "seeded row" })).toContain("created task-1");
		store.close();
	});

	test("closing a row you do not hold is gated; failing your own is not", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");
		store.createTask({ title: "shared", createdBy: "main" });
		const own = store.createTask({ title: "mine", createdBy: "w1" });
		store.claim(own.id, "w1", 300);

		expect(await w1.call("swarm_fail", { task_id: "task-1", reason: "residue" })).toContain("cluster-level decision (close-task)");
		expect(store.getTask("task-1")?.status).toBe("ready");
		expect(await w1.call("swarm_fail", { task_id: own.id, reason: "dead end" })).toContain("-> failed");
		store.close();
	});

	test("a scale request is gated, and a passed scale round unlocks it", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { workers: 4 });
		expect(await w1.call("swarm_scale", { agents: 2, reason: "cheaper" })).toContain("cluster-level decision (scale)");
		expect(store.pendingScaleRequests()).toEqual([]);

		await w1.call("swarm_vote", { kind: "scale", question: "shrink to 2" });
		await w1.call("swarm_vote", { decision_id: "vote-1", approve: true });
		await toolkit(store, "w2").call("swarm_vote", { decision_id: "vote-1", approve: true });

		expect(await w1.call("swarm_scale", { agents: 2, reason: "cheaper", vote_id: "vote-1" })).toContain("scale request #1");
		expect(store.pendingScaleRequests().length).toBe(1);
		store.close();
	});

	test("with the operator's constraint off the tools act directly", async () => {
		const store = makeStore();
		roster(store, ["w1"]);
		const w1 = toolkit(store, "w1", { voteEnabled: false });
		expect(await w1.call("swarm_task_create", { title: "direct" })).toContain("created task-1");
		store.close();
	});
});

describe("the bound is enforced by the MECHANISM, not by an external tick (task-197)", () => {
	// Regression for the defect SwiftTiger's non-author verification measured (RESULT ADDENDUM #755): a due
	// round used to stay `open` until the driver's beat ran the sweep, so with no beat the `vote_failed` it
	// promises never landed. The fix settles on READ; these tests never call the sweep.
	test("a due round is denied the moment it is READ — no ballot, no sweep, no beat", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 1 });
		await w1.call("swarm_vote", { kind: "create-task", question: "denied on read", payload_json: JSON.stringify({ title: "never" }) });
		const opened = store.getVote("vote-1");
		expect(opened?.status).toBe("open");

		// The tool's READ path calls this same tallyVote, and it is driven here on a clock past the bound.
		const read = store.tallyVote("vote-1", DEFAULT_CONFIG.offlineAfterSeconds, (opened?.deadlineAt ?? 0) + 1);
		expect(read?.vote.status).toBe("failed");
		expect(read?.outcome.reason).toContain("timeout");
		expect(store.listTasks({}).length).toBe(0);
		expect(store.eventsOfType("vote.failed").length).toBe(1);
		expect(store.searchBoard({ tags: ["vote_failed"] })[0]?.content).toContain("absent 2");
		expect(store.inbox("w1", 5).some((message) => message.body.includes("vote_failed"))).toBe(true);
		// ...and the gate cannot be fooled by the same round on a later pass.
		expect(store.passedVote("create-task", "vote-1", DEFAULT_CONFIG.offlineAfterSeconds, (opened?.deadlineAt ?? 0) + 1)).toBeUndefined();
		store.close();
	});

	test("a ballot cast after the bound is refused, and settles the round as denied", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 1 });
		await w1.call("swarm_vote", { kind: "create-task", question: "a late yes must not save it", payload_json: JSON.stringify({ title: "never" }) });
		const opened = store.getVote("vote-1");
		const late = store.castBallot("vote-1", "w2", true, DEFAULT_CONFIG.offlineAfterSeconds, (opened?.deadlineAt ?? 0) + 1);
		expect(late.ok).toBe(false);
		expect(late.reason).toContain("already failed");
		expect(store.getVote("vote-1")?.result).toContain("timeout");
		expect(store.listTasks({}).length).toBe(0);
		store.close();
	});

	test("a plain LOOK at a due round denies it: getVote alone, no ballot, no tally, no sweep", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 1 });
		await w1.call("swarm_vote", { kind: "create-task", question: "denied by a look", payload_json: JSON.stringify({ title: "never" }) });
		const bound = store.getVote("vote-1")?.deadlineAt ?? 0;

		// Nothing but the read: the round is terminal the moment anybody looks at it, tick or no tick.
		expect(store.getVote("vote-1", DEFAULT_CONFIG.offlineAfterSeconds, bound + 1)?.status).toBe("failed");
		expect(store.listTasks({}).length).toBe(0);
		expect(store.eventsOfType("vote.failed").length).toBe(1);
		expect(store.searchBoard({ tags: ["vote_failed"] })[0]?.content).toContain("timeout");
		expect(store.inbox("w1", 5).some((message) => message.body.includes("vote_failed"))).toBe(true);
		// ...and the gate cannot be talked into it by the same round on a later pass.
		expect(store.passedVote("create-task", "vote-1", DEFAULT_CONFIG.offlineAfterSeconds, bound + 1)).toBeUndefined();
		store.close();
	});

	test("the sweep still REPORTS every round it finishes, and a later read does not double-settle it", async () => {
		const store = makeStore();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1", { voteTimeoutSeconds: 1 });
		await w1.call("swarm_vote", { kind: "create-task", question: "mop-up", payload_json: JSON.stringify({ title: "never" }) });
		const bound = store.getVote("vote-1")?.deadlineAt ?? 0;

		// The mop-up must hand back the rounds IT finished: the lazy read inside `tallyVote` used to finish
		// the row first, so `sweep()`/`settleVotes()` reported nothing and the driver lost its settled list.
		const settled = store.settleVotes(DEFAULT_CONFIG.offlineAfterSeconds, bound);
		expect(settled.map((vote) => vote.id)).toEqual(["vote-1"]);
		expect(settled[0]?.status).toBe("failed");
		// Idempotent: the same clock again finishes nothing, and neither does a read on top of it.
		expect(store.settleVotes(DEFAULT_CONFIG.offlineAfterSeconds, bound + 1000)).toEqual([]);
		expect(store.getVote("vote-1", DEFAULT_CONFIG.offlineAfterSeconds, bound + 1000)?.status).toBe("failed");
		expect(store.eventsOfType("vote.failed").length).toBe(1);
		expect(store.searchBoard({ tags: ["vote_failed"] }).length).toBe(1);
		expect(store.inbox("w1", 5).some((message) => message.body.includes("vote_failed"))).toBe(true);
		store.close();
	});
});
