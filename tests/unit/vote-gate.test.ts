/**
 * The gate at the TICKET level (goal-9). A passed round is a ONE-SHOT ticket bound to the payload it
 * froze: it may authorise exactly one action, and only that action. This is the half of the adversarial
 * finding VERDICT §3 the tools own — the "one 2/2 pass created THREE tasks" replay itself is pinned in
 * vote-store.test.ts, next to the round; here the attacks come from the side the hole was actually
 * reached through: swarm_fail / swarm_goal, a payload swap, a thrown action, and two OS processes
 * spending one ticket at the same instant.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { buildSwarmTools, type SwarmIdentity } from "../../extension/tools";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

const CHILD = join(import.meta.dir, "helpers", "vote-race-child.ts");
const roots: string[] = [];

interface ChildResult {
	agent: string;
	ok: boolean;
	reason?: string;
	goal?: string;
	ms: number;
}

function makeRoot(): { store: SwarmStore; paths: SwarmPaths } {
	const root = mkdtempSync(join(tmpdir(), "swarm-vote-gate-"));
	roots.push(root);
	const paths = swarmPaths(root);
	return { store: new SwarmStore(openDatabase(paths), paths), paths };
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

/** A tool surface for one identity, exactly as `driver.ts` builds it. */
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
	return { call };
}

function roster(store: SwarmStore, ids: string[]): void {
	for (const id of ids) store.registerAgent({ id, role: "general", capabilities: ["general"] });
}

/** A row nobody holds whose only dependency is already failed: the residue a close-task round exists for. */
function deadRow(store: SwarmStore, title: string): string {
	const spent = store.createTask({ title: `${title} (spent)`, createdBy: "main" });
	store.claim(spent.id, "main", 300, ["general"]);
	store.fail(spent.id, "main", "spent");
	return store.createTask({ title, createdBy: "main", dependencies: [spent.id] }).id;
}

/** Two ballots on one open round of `kind`, so it PASSES: the pool's consent, on the record. */
async function pass(store: SwarmStore, kind: string, payload: Record<string, unknown>): Promise<string> {
	const w1 = toolkit(store, "w1");
	const w2 = toolkit(store, "w2");
	await w1.call("swarm_vote", { kind, question: `decide ${kind}`, payload_json: JSON.stringify(payload) });
	await w1.call("swarm_vote", { decision_id: "vote-1", approve: true });
	await w2.call("swarm_vote", { decision_id: "vote-1", approve: true });
	if (store.getVote("vote-1")?.status !== "passed") throw new Error("the round did not pass");
	return "vote-1";
}

function runChild(args: string[]): Promise<ChildResult> {
	const proc = Bun.spawn(["bun", "run", CHILD, ...args], { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" });
	return (async () => {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as ChildResult;
	})();
}

describe("a passed round is a one-shot ticket for the payload it froze", () => {
	test("a close-task round names the row it may close: the same pass cannot close a second row", async () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const first = deadRow(store, "residue one");
		const second = deadRow(store, "residue two");
		const vote = await pass(store, "close-task", { task_id: first });

		const w1 = toolkit(store, "w1");
		// The ticket names `first`: acting on `second` is the payload swap the attack used, and it is refused.
		expect(await w1.call("swarm_fail", { task_id: second, reason: "swap", vote_id: vote })).toContain("consent binds to the decision");
		expect(store.getTask(second)?.status).toBe("blocked");
		// Acting on the row it DOES name works, exactly once...
		expect(await w1.call("swarm_fail", { task_id: first, reason: "dead dependency", vote_id: vote })).toContain("-> failed");
		expect(store.getTask(first)?.status).toBe("failed");
		// ...and then the ticket is spent: the row it named cannot be re-closed under it...
		expect(await w1.call("swarm_fail", { task_id: first, reason: "replay", vote_id: vote })).toContain("already consumed");
		// ...nor can any other row (the payload check fires first: that is simply not this decision).
		expect(await w1.call("swarm_fail", { task_id: second, reason: "swap again", vote_id: vote })).toContain("consent binds to the decision");
		expect(store.getTask(second)?.status).toBe("blocked");
		store.close();
	});

	test("a REFUSED close does not spend the ticket: the consent authorises a close, not an attempt", async () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		// A row another agent holds: the gate applies, and the close itself is refused by the store.
		const held = store.createTask({ title: "someone else's", createdBy: "w2" });
		store.claim(held.id, "w2", 300, ["general"]);
		const vote = await pass(store, "close-task", { task_id: held.id });
		const w1 = toolkit(store, "w1");

		expect(await w1.call("swarm_fail", { task_id: held.id, reason: "not mine", vote_id: vote })).toContain("fail rejected");
		expect(store.getTask(held.id)?.status).toBe("claimed");
		// The refusal is the store's, not the pool's: `fail()` declined to close a row its holder
		// still holds. This assertion used to require the opposite ("the ATTEMPT is the action"),
		// which is what let vote-15 and vote-17 spend their tickets on closes that never happened
		// and left task-286 exactly where it was. A round authorises the close it was passed for, so
		// an action that reports failure does not burn the consent: the reason comes back, and the
		// ticket stays unspent for the next attempt.
		const retried = await w1.call("swarm_fail", { task_id: held.id, reason: "again", vote_id: vote });
		expect(retried).toContain("not consumed");
		expect(store.getTask(held.id)?.status).toBe("claimed");
		store.close();
	});

	test("swarm_integrate is the same create-task decision, so it is gated too (board FAIL #797)", async () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		store.createTask({ title: "done one", createdBy: "main" });
		store.createTask({ title: "done two", createdBy: "main" });
		const w1 = toolkit(store, "w1");
		// The exact fields the tool would pass, which is what a create-task round must have frozen to be usable.
		const fields = {
			title: "Integrate task-1 + task-2",
			description: "Merge and verify the combined result of the dependent tasks.",
			priority: 5,
			dependencies: ["task-1", "task-2"],
			requiredCapabilities: ["integrator"],
		};

		expect(await w1.call("swarm_integrate", { task_ids: ["task-1", "task-2"] })).toContain("cluster-level decision (create-task)");
		expect(store.listTasks({}).length).toBe(2);

		// A passed create-task round executes ITSELF, so the integration row exists before any tool call and
		// the ticket is already spent: the round is what creates it, and this call cannot create a second.
		const vote = await pass(store, "create-task", fields);
		expect(store.listTasks({}).filter((task) => task.title === fields.title).length).toBe(1);
		expect(await w1.call("swarm_integrate", { task_ids: ["task-1", "task-2"], vote_id: vote })).toContain("already consumed");
		expect(store.listTasks({}).filter((task) => task.title === fields.title).length).toBe(1);
		store.close();
	});

	test("an action that THROWS rolls the ticket back: a failed attempt does not burn the consent", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const spent = store.openVote({
			kind: "spawn",
			question: "two agents",
			payload: { agents: 2 },
			openedBy: "w1",
			policy: { threshold: 0.75, minBase: 2, timeoutMs: 90_000 },
		});
		store.castBallot(spent.id, "w1", true);
		store.castBallot(spent.id, "w2", true);
		expect(store.settleVote(spent.id, DEFAULT_CONFIG.offlineAfterSeconds)?.vote.status).toBe("passed");

		const attempt = {
			kind: "spawn" as const,
			voteId: spent.id,
			payload: { agents: 2 },
			consumedBy: "w1",
			offlineAfterSeconds: DEFAULT_CONFIG.offlineAfterSeconds,
		};
		expect(() => store.consumeVote({ ...attempt, action: () => { throw new Error("boom"); } })).toThrow("boom");
		// The transaction rolled back with the consumption: the pool's consent is still there to be used.
		const used = store.consumeVote({ ...attempt, action: () => store.createGoal({ goal: "after the failure", agents: 2, createdBy: "w1" }) });
		expect(used.ok).toBe(true);
		expect(store.liveGoals().map((goal) => goal.goal)).toEqual(["after the failure"]);
		store.close();
	});
});

describe("the pool's SIZE is voted on, whoever asks (goal-9 high 2)", () => {
	test("no agent raises a goal's budget without a ballot; the coordinator's own goal is a seed", async () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const w1 = toolkit(store, "w1");

		// The hole: `swarm_goal` checked no identity, so any agent raised N and planRoster grew the pool.
		expect(await w1.call("swarm_goal", { goal: "grow the pool", agents: 3 })).toContain("cluster-level decision (spawn)");
		expect(store.liveGoals()).toEqual([]);

		const vote = await pass(store, "spawn", { agents: 3 });
		expect(await w1.call("swarm_goal", { goal: "grow the pool", agents: 3, vote_id: vote })).toContain("goal-1 open with 3 agent(s)");
		expect(store.liveGoals().map((goal) => goal.agents)).toEqual([3]);
		// A round voted for 3 agents does not authorise 6, and it is spent after opening one goal.
		expect(await w1.call("swarm_goal", { goal: "bigger", agents: 6, vote_id: vote })).toContain("consent binds to the decision");
		expect(await w1.call("swarm_goal", { goal: "again", agents: 3, vote_id: vote })).toContain("already consumed");
		expect(store.liveGoals().length).toBe(1);

		// Seed authority (rule 2): the coordinator opens its own goal with no round and no pool to ask.
		expect(await toolkit(store, "main", {}, true).call("swarm_goal", { goal: "seeded goal", agents: 2 })).toContain("goal-2 open with 2 agent(s)");
		expect(store.liveGoals().length).toBe(2);
		store.close();
	});

	test("two OS processes race for ONE ticket: exactly one spends it and acts", async () => {
		const { store, paths } = makeRoot();
		roster(store, ["w1", "w2"]);
		const vote = await pass(store, "spawn", { agents: 2 });
		store.close();

		// A 400ms barrier puts both processes at the gate together, and `--hold` keeps the winner inside its
		// transaction long enough that the loser arrives while the ticket is being spent rather than after it.
		const start = Date.now() + 400;
		const racers = await Promise.all([
			runChild(["--root", paths.root, "--vote", vote, "--agent", "A", "--start", String(start), "--hold", "500"]),
			runChild(["--root", paths.root, "--vote", vote, "--agent", "B", "--start", String(start), "--hold", "500"]),
		]);

		const winners = racers.filter((racer) => racer.ok);
		expect(winners.length).toBe(1);
		// The winner spent ~the whole hold, which is the evidence that the ticket was consumed while its
		// transaction was still open — the property the loser's refusal depends on.
		expect(winners[0].ms).toBeGreaterThanOrEqual(450);
		for (const loser of racers.filter((racer) => !racer.ok)) {
			// ONE decision, one action: the loser waited on the winner's write lock and then found the round
			// spent. Both orderings are refused by design (the check; then the primary key as the backstop),
			// so a slow machine can make the overlap less likely but can never let a second action through.
			expect(loser.reason).toContain("consumed");
			expect(loser.reason).toContain(winners[0].agent);
		}

		const check = new SwarmStore(openDatabase(paths), paths);
		expect(check.liveGoals().map((goal) => goal.goal)).toEqual([`race ${winners[0].agent}`]);
		check.close();
	});
});

describe("a ruling that closed a row must be one the pool actually passed", () => {
	/** A passed `close-task` round frozen on `rowId`, carrying the ruling's own text in its payload. */
	function ruledRound(store: SwarmStore, rowId: string): string {
		const vote = store.openVote({
			kind: "close-task",
			question: "close the residue",
			payload: { task_id: rowId, decision: "DECISION #1753 + vote-15 + vote-17" },
			openedBy: "w1",
			policy: { threshold: 0.75, minBase: 2, timeoutMs: 90_000 },
		});
		store.castBallot(vote.id, "w1", true);
		store.castBallot(vote.id, "w2", true);
		const settled = store.settleVote(vote.id, DEFAULT_CONFIG.offlineAfterSeconds);
		if (settled?.vote.status !== "passed") throw new Error("the ruling round did not pass");
		return vote.id;
	}

	test("a fabricated ruling closes nothing: the text alone is not authority", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		// An ordinary queued row: unheld, deps satisfied, a capable agent online. Everything about it is
		// claimable, so only a REAL ruling could ever close it — which is the point of the fourth exit.
		const row = store.createTask({ title: "queued", createdBy: "boot", requiredCapabilities: ["general"] });
		const closed = store.fail(row.id, "generalist", "let me close it", { decision: "DECISION #1", voteId: "vote-1" });
		expect(closed.ok).toBe(false);
		expect(store.getTask(row.id)?.status).toBe("ready");
		// Still waiting its turn, exactly as it was: the row is claimable, not damaged.
		expect(store.claim(row.id, "generalist", 300, ["general"]).ok).toBe(true);
		store.close();
	});

	test("a ruled exit closes the row and the event names the round that licensed it", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const row = store.createTask({ title: "residue", createdBy: "boot", requiredCapabilities: ["general"] });
		const vote = ruledRound(store, row.id);

		const closed = store.fail(row.id, "generalist", "CLOSED BY DECISION", {
			decision: "DECISION #1753 + vote-15 + vote-17",
			voteId: vote,
		});
		expect(closed.ok).toBe(true);
		expect(store.getTask(row.id)?.status).toBe("failed");
		store.close();
	});

	test("a ruling whose text does not match the round's own payload is refused", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const row = store.createTask({ title: "residue", createdBy: "boot", requiredCapabilities: ["general"] });
		const vote = ruledRound(store, row.id);

		// The round exists and passed, but it did not vote on THIS text: naming a ruling means naming
		// what the pool actually decided, so a mismatch is the same refusal as no ruling at all.
		const closed = store.fail(row.id, "generalist", "close it", { decision: "DECISION #1", voteId: vote });
		expect(closed.ok).toBe(false);
		expect(closed.reason).toContain("no ruling named");
		expect(store.getTask(row.id)?.status).toBe("ready");
		store.close();
	});

	test("a ruled exit is not a second close: an already-consumed round cannot close a second row", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const first = store.createTask({ title: "first", createdBy: "boot", requiredCapabilities: ["general"] });
		const second = store.createTask({ title: "second", createdBy: "boot", requiredCapabilities: ["general"] });
		// The round is frozen on `first`, so a ruling naming `second` is a payload the pool never voted
		// on — the same refusal the ticket gate already gives a payload swap.
		const vote = ruledRound(store, first.id);
		const closed = store.fail(second.id, "generalist", "swap", {
			decision: "DECISION #1753 + vote-15 + vote-17",
			voteId: vote,
		});
		expect(closed.ok).toBe(false);
		expect(store.getTask(second.id)?.status).toBe("ready");
		store.close();
	});

	test("a ruling whose round was ALREADY SPENT closes nothing, even at the row it ruled on", () => {
		const { store } = makeRoot();
		roster(store, ["w1", "w2"]);
		const row = store.createTask({ title: "already ruled", createdBy: "boot", requiredCapabilities: ["general"] });
		const ruling = { decision: "DECISION #1753 + vote-15 + vote-17", voteId: ruledRound(store, row.id) };

		// One close by this ruling — which spends the round it rode in on.
		expect(store.fail(row.id, "generalist", "CLOSED BY DECISION", ruling).ok).toBe(true);
		expect(store.getTask(row.id)?.status).toBe("failed");

		// Now the row is reopened for a fresh attempt and the SAME ruling is named again, for the SAME
		// row and the SAME text. The `task_id` and text guards both pass, so the only thing left that
		// can refuse is the spent check — which is exactly the guard under test. Without it, one passed
		// round is a standing permission to close that row forever, which is the replay hole goal-9
		// closed for every other kind (VERDICT §3).
		store.retryTask(row.id, "reopen", "generalist");
		expect(store.getTask(row.id)?.status).not.toBe("failed");
		const replay = store.fail(row.id, "generalist", "CLOSED BY DECISION", ruling);
		expect(replay.ok).toBe(false);
		expect(replay.reason).toContain("no ruling named");
		store.close();
	});
});
