/**
 * Swarm-side planning at the store: the goal's lifecycle, the exactly-once scribe, the merge and
 * the round's bound. Real SQLite (a temp file, so the cross-process race is genuine), never a mock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { watchRounds } from "../../extension/driver";
import { MAX_SCRIBE_ATTEMPTS, SCRIBE_STALL_MS, deliverableKey } from "../../extension/planning";
import { SwarmStore } from "../../extension/store";
import type { SwarmTask } from "../../extension/types";

const CHILD = join(import.meta.dir, "helpers", "goal-child.ts");
const roots: string[] = [];

interface ChildResult {
	agent: string;
	claimed: boolean;
	planned: boolean;
	created: number;
	reason?: string;
}

function makeRoot(): { store: SwarmStore; paths: SwarmPaths } {
	const root = mkdtempSync(join(tmpdir(), "swarm-goal-"));
	roots.push(root);
	const paths = swarmPaths(root);
	const store = new SwarmStore(openDatabase(paths), paths);
	return { store, paths };
}

function runChild(args: string[]): Promise<ChildResult> {
	const proc = Bun.spawn(["bun", "run", CHILD, ...args], { stdout: "pipe", stderr: "pipe" });
	return (async () => {
		const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
		const line = stdout.trim().split("\n").at(-1) ?? "";
		return JSON.parse(line) as ChildResult;
	})();
}

/** Open a goal, propose one split, and hand the planning task to `scribe`. */
function round(store: SwarmStore, proposals: { agent: string; tasks: unknown }[] = [{ agent: "A", tasks: [{ title: "The deliverable" }] }]) {
	const opened = store.createGoal({ goal: "split the work", agents: 3, createdBy: "main" });
	for (const proposal of proposals) store.postProposal(opened.goal, proposal.agent, proposal.tasks);
	return opened;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows may still hold the WAL handle for a moment; the OS temp dir is disposable.
		}
	}
});

describe("opening a goal", () => {
	test("mints the goal and exactly ONE planning task, claimable by a general worker", () => {
		const { store } = makeRoot();
		const opened = store.createGoal({ goal: "ship swarm-side planning", agents: 3, createdBy: "main" });
		expect(opened.goal.id).toBe("goal-1");
		expect(opened.goal.status).toBe("open");
		expect(opened.goal.agents).toBe(3);
		expect(opened.goal.planningTask).toBe(opened.planningTask.id);
		expect(opened.planningTask.requiredCapabilities).toEqual(["general"]);
		expect(opened.planningTask.description).toContain("ship swarm-side planning");
		expect(store.liveGoals().map((goal) => goal.id)).toEqual(["goal-1"]);
		expect(store.listTasks({ limit: 10 }).length).toBe(1);
		expect(store.claim(opened.planningTask.id, "A", 300, ["general"]).ok).toBe(true);
		store.close();
	});

	test("goal ids are monotonic and every goal owns its own planning task and round", () => {
		const { store } = makeRoot();
		const first = store.createGoal({ goal: "one", agents: 1, createdBy: "main" });
		const second = store.createGoal({ goal: "two", agents: 2, createdBy: "main" });
		expect([first.goal.id, second.goal.id]).toEqual(["goal-1", "goal-2"]);
		expect(first.planningTask.id).not.toBe(second.planningTask.id);
		store.postProposal(second.goal, "A", [{ title: "only of goal-2" }]);
		expect(store.listProposals(first.goal)).toEqual([]);
		expect(store.listProposals(second.goal).length).toBe(1);
		expect(store.goalForPlanningTask(second.planningTask.id)?.id).toBe("goal-2");
		expect(store.goalForPlanningTask(first.planningTask.id)?.id).toBe("goal-1");
		store.close();
	});
});

describe("the scribe merges exactly once", () => {
	test("a caller that does not hold the planning task cannot merge", () => {
		const { store } = makeRoot();
		const opened = round(store);
		const refused = store.planGoal(opened.goal.id, "B");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("not claimed by B");
		expect(store.getGoal(opened.goal.id)?.status).toBe("open");
		expect(store.listTasks({ limit: 10 }).length).toBe(1);
		store.close();
	});

	test("an empty round is refused and named, and the goal stays open", () => {
		const { store } = makeRoot();
		const opened = store.createGoal({ goal: "nobody proposed", agents: 2, createdBy: "main" });
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const refused = store.planGoal(opened.goal.id, "A");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("no split proposal");
		expect(refused.reason).toContain("swarm_propose");
		expect(store.getGoal(opened.goal.id)?.status).toBe("open");
		store.close();
	});

	test("merging builds the real graph, posts the DECISION and plans the goal", () => {
		const { store } = makeRoot();
		const opened = round(store, [
			{
				agent: "A",
				tasks: [
					{ title: "Build the parser", deliverable: "parser + its tests", capabilities: ["general"], files: ["src/parser.ts"] },
					{ title: "Wire the CLI", depends_on: ["Build the parser"], review_required: true, files: ["src/cli.ts"] },
				],
			},
			{ agent: "B", tasks: [{ title: "build   the PARSER.", files: ["tests/parser.test.ts"] }] },
		]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const result = store.planGoal(opened.goal.id, "A");
		expect(result.ok).toBe(true);
		expect(result.proposals).toBe(2);
		expect(result.created.length).toBe(2);
		expect(result.folded).toEqual([deliverableKey("Build the parser")]);

		const parser = store.getTask(result.created[0] as string) as SwarmTask;
		expect(parser.title).toBe("Build the parser");
		expect(parser.files.sort()).toEqual(["src/parser.ts", "tests/parser.test.ts"]); // unioned across proposals
		expect(parser.requiredCapabilities).toEqual(["general"]);
		expect(parser.status).toBe("ready");
		expect(parser.description).toContain("parser + its tests");
		expect(parser.description).toContain("Split by A, B");
		expect(parser.description).toContain("goal-1");

		const cli = store.getTask(result.created[1] as string) as SwarmTask;
		expect(cli.dependencies).toEqual([parser.id]);
		expect(cli.status).toBe("blocked"); // it waits for the parser, and sweep() will promote it
		expect(cli.review.required).toBe(true);

		const decisions = store.searchBoard({ type: "DECISION" });
		expect(decisions.length).toBe(1);
		expect(decisions[0]?.taskId).toBe(opened.planningTask.id);
		expect(decisions[0]?.content).toContain("Build the parser");
		expect(decisions[0]?.content).toContain("Wire the CLI");
		expect(decisions[0]?.content).toContain("SIZE: peak parallelism 1 of 2 task(s) can run at once");
		expect(result.peak).toBe(1); // the round is a chain: Build the parser, then Wire the CLI

		const goal = store.getGoal(opened.goal.id);
		expect(goal?.status).toBe("planned");
		expect(goal?.planner).toBe("A");
		expect(goal?.result).toBe("2 task(s) from 2 proposal(s)");
		expect(store.liveGoals()).toEqual([]);

		// The round is over: replaying it changes nothing (the status flip is the second lock).
		const replay = store.planGoal(opened.goal.id, "A");
		expect(replay.ok).toBe(false);
		expect(replay.reason).toContain("is planned");
		expect(store.listTasks({ limit: 20 }).length).toBe(3); // 2 deliverables + the planning task
		store.close();
	});

	test("a deliverable the pool already holds is skipped, never duplicated", () => {
		const { store } = makeRoot();
		const existing = store.createTask({ title: "The deliverable", createdBy: "main", files: ["src/a.ts"] });
		const opened = round(store, [{ agent: "B", tasks: [{ title: "the DELIVERABLE.", files: ["src/b.ts"] }] }]);
		store.claim(opened.planningTask.id, "B", 300, ["general"]);
		const result = store.planGoal(opened.goal.id, "B");
		expect(result.ok).toBe(true);
		expect(result.created).toEqual([]);
		expect(result.skipped).toEqual([{ title: "the DELIVERABLE.", id: existing.id }]);
		expect(store.listTasks({ limit: 20 }).filter((task) => deliverableKey(task.title) === deliverableKey("The deliverable")).length).toBe(1);
		store.close();
	});

	test("a review-required deliverable keeps the review flow intact", () => {
		const { store } = makeRoot();
		const opened = round(store, [{ agent: "A", tasks: [{ title: "Audit it", review_required: true, capabilities: ["general"] }] }]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const created = store.planGoal(opened.goal.id, "A").created[0] as string;
		store.claim(created, "W", 300, ["general"]);
		store.complete(created, "W", { summary: "verified", reviewEnabled: true });
		expect(store.getTask(created)?.status).toBe("review");
		expect(store.decide(created, "R", true, "looks right").ok).toBe(true);
		expect(store.getTask(created)?.status).toBe("done");
		store.close();
	});

	test("a lease expiry hands the round to the next claimer, and the dead scribe cannot merge", () => {
		const { store, paths } = makeRoot();
		const opened = round(store);
		expect(store.claim(opened.planningTask.id, "A", 300, ["general"]).ok).toBe(true);
		// Simulate A dying: its lease is never renewed, so it expires.
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET lease_until=? WHERE id=?", Date.now() - 1000, opened.planningTask.id);
		raw.close();
		expect(store.claim(opened.planningTask.id, "B", 300, ["general"]).ok).toBe(true);
		const late = store.planGoal(opened.goal.id, "A");
		expect(late.ok).toBe(false);
		expect(late.reason).toContain("not claimed by A");
		const taken = store.planGoal(opened.goal.id, "B");
		expect(taken.ok).toBe(true);
		expect(store.getGoal(opened.goal.id)?.planner).toBe("B");
		expect(store.listTasks({ limit: 20 }).filter((task) => task.title === "The deliverable").length).toBe(1);
		store.close();
	});
});

describe("the scribe race, across processes", () => {
	test("three workers race one round: exactly one plans, and the deliverable is created once", async () => {
		const { store, paths } = makeRoot();
		const opened = round(store, [
			{ agent: "P1", tasks: [{ title: "The deliverable", files: ["src/a.ts"] }] },
			{ agent: "P2", tasks: [{ title: "the DELIVERABLE.", capabilities: ["general"] }] },
		]);
		const start = Date.now() + 400;
		const results = await Promise.all(
			["A", "B", "C"].map((agent) =>
				runChild(["--root", paths.root, "--goal", opened.goal.id, "--agent", agent, "--start", String(start)]),
			),
		);
		const planners = results.filter((result) => result.planned);
		expect(planners.length).toBe(1);
		expect(results.filter((result) => !result.claimed).length).toBe(2); // the claim is the election
		expect(store.getGoal(opened.goal.id)?.status).toBe("planned");
		expect(store.getGoal(opened.goal.id)?.planner).toBe(planners[0]?.agent);
		const deliverables = store.listTasks({ limit: 20 }).filter((task) => task.title !== `Plan ${opened.goal.id}: merge the split proposals into the task graph`);
		expect(deliverables.length).toBe(1);
		expect(deliverables[0]?.files).toEqual(["src/a.ts"]);
		expect(store.searchBoard({ type: "DECISION" }).length).toBe(1);
		store.close();
	});
});

describe("the plan's own size and the agents' asks", () => {
	test("the plan states its peak parallelism and a recommended agent count, capped by the ceiling", () => {
		const { store } = makeRoot();
		const opened = round(store, [{ agent: "A", tasks: [{ title: "one" }, { title: "two" }, { title: "three", depends_on: ["one"] }] }]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const result = store.planGoal(opened.goal.id, "A", { ceiling: 2 });
		expect(result.ok).toBe(true);
		expect(result.peak).toBe(2); // one and two run together, three follows one
		expect(result.recommended).toBe(2); // the ceiling the caller passed binds, not the peak
		const decision = store.searchBoard({ type: "DECISION" })[0]?.content ?? "";
		expect(decision).toContain("peak parallelism 2 of 3 task(s) can run at once");
		expect(decision).toContain("recommended agents 2 (ceiling 2)");
		expect(decision).toContain("swarm_scale");
		store.close();
	});

	test("an unknown ceiling recommends the peak as measured", () => {
		const { store } = makeRoot();
		const opened = round(store, [{ agent: "A", tasks: [{ title: "one" }, { title: "two" }] }]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const result = store.planGoal(opened.goal.id, "A");
		expect(result.peak).toBe(2);
		expect(result.recommended).toBe(2);
		expect(store.searchBoard({ type: "DECISION" })[0]?.content).toContain("recommended agents 2.");
		store.close();
	});

	test("an agent's ask is recorded with its author and reason, listed while pending, and closed once decided", () => {
		const { store } = makeRoot();
		const first = store.recordScaleRequest({ agentId: "w1", requested: 6, reason: "the queue is deeper than the pool", current: 2 });
		const second = store.recordScaleRequest({ agentId: "w2", requested: 5, reason: "same shortage", current: 2 });
		expect([first.id, second.id]).toEqual([1, 2]);
		expect(first.agentId).toBe("w1");
		expect(first.reason).toBe("the queue is deeper than the pool");
		expect(first.current).toBe(2);
		expect(store.pendingScaleRequests().map((request) => request.requested)).toEqual([6, 5]);
		expect(store.decideScaleRequests([first.id], "grow", 6)).toBe(1);
		expect(store.decideScaleRequests([first.id], "grow", 6)).toBe(0); // already decided: never re-applied
		const pending = store.pendingScaleRequests();
		expect(pending.map((request) => request.id)).toEqual([second.id]);
		expect(store.recentEvents(20).some((event) => event.type === "scale.request")).toBe(true);
		store.close();
	});
});

describe("the round's bound", () => {
	test("an expired goal is closed as failed with its unclaimed planning task and a FAIL entry", () => {
		const { store } = makeRoot();
		const expired = store.createGoal({ goal: "never planned", agents: 2, createdBy: "main", deadlineMs: 1000 });
		const claimed = store.createGoal({ goal: "claimed and slow", agents: 2, createdBy: "main", deadlineMs: 1000 });
		const later = store.createGoal({ goal: "plenty of time", agents: 2, createdBy: "main", deadlineMs: 600_000 });
		store.claim(claimed.planningTask.id, "A", 300, ["general"]);
		const closed = store.closeExpiredGoals(Date.now() + 2000);
		expect(closed.map((goal) => goal.id)).toEqual([expired.goal.id, claimed.goal.id]);
		expect(store.getGoal(expired.goal.id)?.status).toBe("failed");
		expect(store.getGoal(expired.goal.id)?.result).toContain("hit its bound");
		expect(store.getTask(expired.planningTask.id)?.status).toBe("failed");
		// A claimed planning task belongs to its holder: the failed goal already refuses its merge.
		expect(store.getTask(claimed.planningTask.id)?.status).toBe("claimed");
		expect(store.getGoal(later.goal.id)?.status).toBe("open");
		expect(store.liveGoals().map((goal) => goal.id)).toEqual([later.goal.id]);
		const fails = store.searchBoard({ type: "FAIL" });
		expect(fails.length).toBe(2);
		expect(fails[0]?.tags).toContain("goal:goal-2");
		// Idempotent: nothing left to close, and no second FAIL.
		expect(store.closeExpiredGoals(Date.now() + 3000)).toEqual([]);
		expect(store.searchBoard({ type: "FAIL" }).length).toBe(2);
		store.close();
	});

	test("a planned goal is never re-closed by the bound", () => {
		const { store } = makeRoot();
		const opened = store.createGoal({ goal: "planned in time", agents: 2, createdBy: "main", deadlineMs: 1000 });
		store.postProposal(opened.goal, "A", [{ title: "Done deliverable" }]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		expect(store.planGoal(opened.goal.id, "A").ok).toBe(true);
		expect(store.closeExpiredGoals(Date.now() + 60_000)).toEqual([]);
		expect(store.getGoal(opened.goal.id)?.status).toBe("planned");
		expect(store.searchBoard({ type: "FAIL" })).toEqual([]);
		store.close();
	});
});

/**
 * The round watchdog: the defect FACT #728 re-derived from goal-6 — the planning hold was EXCLUSIVE,
 * UN-SUPERSEDABLE and silently renewed by the driver's own beat, so a scribe that stopped producing
 * blocked every peer until the bound closed the round with `planner=null`. These tests drive the real
 * rule over a real store (isolated root, fresh processes for the takeover), never a fixture of it.
 */
describe("the round watchdog: a stalled scribe is superseded, not waited out", () => {
	/** Hold the round, propose a split, then move the round's OWN clock one silent window into the past. */
	function stalled(): { store: SwarmStore; paths: SwarmPaths; goalId: string; planning: string } {
		const { store, paths } = makeRoot();
		const opened = round(store);
		expect(store.claim(opened.planningTask.id, "A", 300, ["general"]).ok).toBe(true);
		silence(paths, opened.planningTask.id);
		return { store, paths, goalId: opened.goal.id, planning: opened.planningTask.id };
	}

	/** A claim, a renew and a proposal are the round moving; the clock the watchdog reads is those stamps. */
	function silence(paths: SwarmPaths, planning: string): void {
		const raw = openDatabase(paths);
		const since = Date.now() - SCRIBE_STALL_MS - 1000;
		raw.run("UPDATE tasks SET claimed_at=?, updated_at=? WHERE id=?", since, since, planning);
		raw.run("UPDATE board SET created_at=? WHERE task_id=?", since, planning);
		raw.close();
	}

	test("a silent hold returns the row to ready, logs task.takeover and says why on the board", () => {
		const { store, planning } = stalled();
		const live = watchRounds(store, store.liveGoals(), Date.now());
		expect(live.map((goal) => goal.id)).toEqual(["goal-1"]); // the round is still open, now claimable
		const row = store.getTask(planning);
		expect(row?.status).toBe("ready");
		expect(row?.claimedBy).toBeUndefined();
		expect(row?.leaseUntil).toBeUndefined();
		expect(store.recentEvents(20).some((event) => event.type === "task.takeover" && event.taskId === planning)).toBe(true);
		const notice = store.searchBoard({ tags: ["planning"] })[0]?.content ?? "";
		expect(notice).toContain("A held");
		expect(notice).toContain("without progress for");
		expect(store.getAgent("A")?.currentTask).toBeUndefined(); // the holder's row is settled, not left working
		store.close();
	});

	test("the driver's own heartbeat is liveness, not progress: the silent hold is still superseded", () => {
		const { store, planning } = stalled();
		store.heartbeat("A", undefined, undefined, 300); // exactly what #beat does every 20s for a roster worker
		expect(store.getTask(planning)?.status).toBe("claimed");
		expect(store.getTask(planning)?.leaseUntil).toBeGreaterThan(Date.now());
		watchRounds(store, store.liveGoals(), Date.now());
		// The lease is healthy, which is precisely why goal-6's hold never lapsed while the round starved.
		expect(store.getTask(planning)?.status).toBe("ready");
		store.close();
	});

	test("an explicitly renewed round is left alone: swarm_renew IS progress, the heartbeat is not", () => {
		const { store, planning } = stalled();
		expect(store.renew(planning, "A", 300)).toBe(true);
		const live = watchRounds(store, store.liveGoals(), Date.now());
		expect(live.map((goal) => goal.id)).toEqual(["goal-1"]);
		expect(store.getTask(planning)?.status).toBe("claimed");
		expect(store.searchBoard({ tags: ["planning"] })).toEqual([]);
		store.close();
	});

	test("the round survives exactly MAX_SCRIBE_ATTEMPTS scribes, then is closed with its reason", () => {
		const { store, paths, goalId, planning } = stalled();
		expect(watchRounds(store, store.liveGoals(), Date.now()).length).toBe(1); // takeover 1 offered
		expect(store.claim(planning, "B", 300, ["general"]).ok).toBe(true);
		silence(paths, planning);
		expect(watchRounds(store, store.liveGoals(), Date.now()).length).toBe(1); // takeover 2 offered
		expect(store.claim(planning, "C", 300, ["general"]).ok).toBe(true);
		silence(paths, planning);
		expect(watchRounds(store, store.liveGoals(), Date.now())).toEqual([]); // the ladder is exhausted

		const goal = store.getGoal(goalId);
		expect(goal?.status).toBe("failed");
		expect(goal?.result).toContain(`taken ${MAX_SCRIBE_ATTEMPTS} time(s)`);
		expect(goal?.result).toContain("closed explicitly instead of waiting for the bound");
		expect(store.getTask(planning)?.status).toBe("failed"); // the row cannot be left claimable under a failed goal
		const fails = store.searchBoard({ type: "FAIL" });
		expect(fails.length).toBe(1);
		expect(fails[0]?.tags).toContain("goal:goal-1");
		expect(fails[0]?.content).toContain("closed explicitly");
		expect(store.liveGoals()).toEqual([]);
		store.close();
	});

	test("a round re-offered and left sitting is closed with a reason instead of spinning to the bound", () => {
		const { store, paths, goalId, planning } = stalled();
		watchRounds(store, store.liveGoals(), Date.now()); // re-offered: the row is ready
		expect(store.getTask(planning)?.status).toBe("ready");
		silence(paths, planning); // nobody picks it up, and the window passes again
		expect(watchRounds(store, store.liveGoals(), Date.now())).toEqual([]);
		expect(store.getGoal(goalId)?.result).toContain("has been claimable for");
		expect(store.getTask(planning)?.status).toBe("failed");
		store.close();
	});

	test("a fresh round nobody has claimed is left to the bound: the watchdog is not a starter pistol", () => {
		const { store, paths } = makeRoot();
		const opened = round(store);
		silence(paths, opened.planningTask.id);
		expect(store.getTask(opened.planningTask.id)?.attempts).toBe(0);
		expect(watchRounds(store, store.liveGoals(), Date.now()).length).toBe(1);
		expect(store.getTask(opened.planningTask.id)?.status).toBe("ready");
		expect(store.getGoal(opened.goal.id)?.status).toBe("open");
		store.close();
	});

	test("a lost scribe is taken over by a FRESH PROCESS, which really produces the plan", async () => {
		const { store, paths, goalId, planning } = stalled();
		expect(store.listTasks({ status: "ready", limit: 10 })).toEqual([]); // nothing for a peer to take yet

		const offeredAt = Date.now();
		watchRounds(store, store.liveGoals(), offeredAt);

		// A different agent in a different OS process claims the free round and merges it.
		const taken = await runChild(["--root", paths.root, "--goal", goalId, "--agent", "w2"]);
		const recoveredMs = Date.now() - offeredAt;
		expect(taken.claimed).toBe(true);
		expect(taken.planned).toBe(true);
		expect(taken.created).toBe(1);
		expect(store.getGoal(goalId)?.status).toBe("planned");
		expect(store.getGoal(goalId)?.planner).toBe("w2");
		// The child drives the store directly (the swarm_plan TOOL is what completes the row), so the
		// round is closed by the goal's own state: planned, with exactly one plan on the board.
		expect(store.getTask(planning)?.claimedBy).toBe("w2");
		expect(store.listTasks({ limit: 20 }).filter((task) => task.title === "The deliverable").length).toBe(1);
		expect(store.searchBoard({ type: "DECISION" }).length).toBe(1);
		// The recovery costs process startup, never another stall window: the offer is what unblocked it.
		expect(recoveredMs).toBeLessThan(10_000);
		store.close();
	});
});
