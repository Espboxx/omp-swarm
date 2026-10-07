import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore, UNROUTABLE_GRACE_MS, patternsConflict } from "../../extension/store";

const CHILD = join(import.meta.dir, "..", "helpers", "swarm-child.ts");
const roots: string[] = [];

interface ChildResult {
	op: string;
	agent: string;
	ok?: boolean;
	reason?: string;
	taskId?: string;
	count?: number;
}

function makeRoot(): { store: SwarmStore; paths: SwarmPaths } {
	const root = mkdtempSync(join(tmpdir(), "swarm-test-"));
	roots.push(root);
	const paths = swarmPaths(root);
	const store = new SwarmStore(openDatabase(paths), paths);
	return { store, paths };
}

function runChild(args: string[]): Promise<ChildResult> {
	const proc = Bun.spawn(["bun", "run", CHILD, ...args], { stdout: "pipe", stderr: "pipe" });
	return (async () => {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
		const line = stdout.trim().split("\n").at(-1) ?? "";
		return JSON.parse(line) as ChildResult;
	})();
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

describe("atomic claim", () => {
	test("two OS processes racing for one task: exactly one wins", async () => {
		const { store, paths } = makeRoot();
		const task = store.createTask({ title: "race", createdBy: "bootstrap" });
		const start = Date.now() + 400;
		const results = await Promise.all([
			runChild(["--root", paths.root, "--op", "claim", "--task", task.id, "--agent", "A", "--start", String(start)]),
			runChild(["--root", paths.root, "--op", "claim", "--task", task.id, "--agent", "B", "--start", String(start)]),
			runChild(["--root", paths.root, "--op", "claim", "--task", task.id, "--agent", "C", "--start", String(start)]),
		]);
		const winners = results.filter((r) => r.ok === true);
		expect(winners.length).toBe(1);
		const claimed = store.getTask(task.id);
		expect(claimed?.status).toBe("claimed");
		expect(claimed?.claimedBy).toBe(winners[0].agent);
		store.close();
	});

	test("second claim by another agent is refused while the lease is live", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "single", createdBy: "boot" });
		expect(store.claim(task.id, "A", 300).ok).toBe(true);
		const second = store.claim(task.id, "B", 300);
		expect(second.ok).toBe(false);
		expect(second.reason).toContain("claimed");
		store.close();
	});

	test("capability gate blocks agents without the required capability", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "review me", createdBy: "boot", requiredCapabilities: ["integrator"] });
		expect(store.claim(task.id, "A", 300, ["general"]).ok).toBe(false);
		expect(store.claim(task.id, "B", 300, ["integrator"]).ok).toBe(true);
		store.close();
	});
});

describe("lease and crash recovery", () => {
	test("expired lease returns the task to ready and another agent can claim it", () => {
		const { store, paths } = makeRoot();
		const task = store.createTask({ title: "leaky", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		// A crashes: no heartbeat, no release. Fast-forward the lease.
		const other = openDatabase(paths);
		other.run("UPDATE tasks SET lease_until=? WHERE id=?", Date.now() - 1000, task.id);
		other.close();

		const sweep = store.sweep(0);
		expect(sweep.reclaimed).toContain(task.id);
		expect(store.getTask(task.id)?.status).toBe("ready");
		expect(store.claim(task.id, "B", 300).ok).toBe(true);
		expect(store.getTask(task.id)?.claimedBy).toBe("B");
		store.close();
	});

	test("heartbeat renews the lease for tasks the agent holds", () => {
		const { store, paths } = makeRoot();
		const task = store.createTask({ title: "renew", createdBy: "boot" });
		store.claim(task.id, "A", 1);
		store.registerAgent({ id: "A", role: "general" });
		store.heartbeat("A", "working", task.id, 600);
		const other = openDatabase(paths);
		const row = other.get<{ lease_until: number }>("SELECT lease_until FROM tasks WHERE id=?", task.id);
		other.close();
		expect(row?.lease_until).toBeGreaterThan(Date.now() + 500_000);
		store.close();
	});

	test("unregistering an agent frees its claimed work", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "orphan", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		store.unregisterAgent("A");
		expect(store.getTask(task.id)?.status).toBe("ready");
		store.close();
	});
});

describe("dependencies", () => {
	test("a blocked task cannot be claimed until its dependency is done", () => {
		const { store } = makeRoot();
		const first = store.createTask({ title: "A", createdBy: "boot" });
		const second = store.createTask({ title: "B", createdBy: "boot", dependencies: [first.id] });
		expect(second.status).toBe("blocked");
		const blocked = store.claim(second.id, "A", 300);
		expect(blocked.ok).toBe(false);
		expect(blocked.reason).toContain("dependencies");

		store.claim(first.id, "A", 300);
		store.complete(first.id, "A", { summary: "first done" });
		expect(store.getTask(second.id)?.status).toBe("ready");
		expect(store.claim(second.id, "B", 300).ok).toBe(true);
		store.close();
	});

	test("a failed dependency keeps dependents blocked", () => {
		const { store } = makeRoot();
		const first = store.createTask({ title: "A", createdBy: "boot" });
		const second = store.createTask({ title: "B", createdBy: "boot", dependencies: [first.id] });
		store.claim(first.id, "A", 300);
		store.fail(first.id, "A", "unsupported by the parser");
		expect(store.getTask(second.id)?.status).toBe("blocked");
		expect(store.searchBoard({ type: "FAIL" }).length).toBe(1);
		store.close();
	});

	test("dependency cycles cannot be introduced through createTask", () => {
		const { store } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		const c = store.createTask({ title: "C", createdBy: "boot", dependencies: [b.id] });
		expect(store.unresolvedDependencies(c.id)).toEqual([b.id]);
		expect(store.getTask(c.id)?.status).toBe("blocked");
		store.close();
	});

	test("an unknown dependency id is refused and nothing is inserted", () => {
		const { store } = makeRoot();
		expect(() => store.createTask({ title: "typo", createdBy: "boot", dependencies: ["task-99"] })).toThrow("unknown dependency: task-99");
		expect(store.listTasks({ limit: 100 }).length).toBe(0);
		store.close();
	});

	test("a self-dependency is refused", () => {
		const { store } = makeRoot();
		store.createTask({ title: "A", createdBy: "boot" });
		// the next id would be task-2, so this edge would point at itself
		expect(() => store.createTask({ title: "loop", createdBy: "boot", dependencies: ["task-2"] })).toThrow(
			"dependency_self: task-2 depends on itself",
		);
		expect(store.listTasks({ limit: 100 }).length).toBe(1);
		store.close();
	});

	test("a dependency that already sits in a 2-node cycle is refused with the path", () => {
		const { store, paths } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		// createTask can no longer write this edge, so forge it to model a legacy row.
		const raw = openDatabase(paths);
		raw.run("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)", a.id, b.id);
		raw.close();

		expect(() => store.createTask({ title: "C", createdBy: "boot", dependencies: [b.id] })).toThrow(
			"dependency_cycle: task-2 -> task-1 -> task-2",
		);
		expect(store.listTasks({ limit: 100 }).length).toBe(2);
		store.close();
	});

	test("a transitive cycle is named along the whole walk", () => {
		const { store, paths } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		const c = store.createTask({ title: "C", createdBy: "boot", dependencies: [b.id] });
		const raw = openDatabase(paths);
		raw.run("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)", a.id, c.id);
		raw.close();

		expect(() => store.createTask({ title: "D", createdBy: "boot", dependencies: [c.id] })).toThrow(
			"dependency_cycle: task-3 -> task-2 -> task-1 -> task-3",
		);
		store.close();
	});

	test("blockedReason names waiting, missing and cyclic causes", () => {
		const { store, paths } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		const c = store.createTask({ title: "C", createdBy: "boot", dependencies: [b.id] });
		const d = store.createTask({ title: "D", createdBy: "boot", dependencies: [c.id] });
		expect(store.blockedReason(a.id)).toBeUndefined();
		expect(store.blockedReason(b.id)).toBe("waiting");

		const raw = openDatabase(paths);
		raw.run("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)", a.id, c.id);
		raw.run("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)", d.id, "task-99");
		raw.close();

		expect(store.blockedReason(c.id)).toBe(`cycle: ${b.id} -> ${a.id} -> ${c.id} -> ${b.id}`);
		expect(store.blockedReason(d.id)).toBe("missing: task-99");
		store.close();
	});

	test("retryTask revives a failed task and the sweep promotes its dependents", () => {
		const { store } = makeRoot();
		const first = store.createTask({ title: "A", createdBy: "boot" });
		const second = store.createTask({ title: "B", createdBy: "boot", dependencies: [first.id] });
		store.claim(first.id, "A", 300);
		store.fail(first.id, "A", "unsupported by the parser");
		expect(store.getTask(second.id)?.status).toBe("blocked");

		const retried = store.retryTask(first.id, "parser regression fixed", "B");
		expect(retried.ok).toBe(true);
		expect(retried.task?.status).toBe("ready");
		expect(retried.task?.claimedBy).toBeUndefined();
		expect(retried.task?.attempts).toBe(2); // one claim + the retry
		expect(store.getTask(second.id)?.status).toBe("blocked");

		expect(store.claim(first.id, "B", 300).ok).toBe(true);
		store.complete(first.id, "B", { summary: "done on the retry" });
		expect(store.getTask(second.id)?.status).toBe("ready");
		expect(store.recentEvents(5).map((e) => e.type)).toContain("task.retry");
		store.close();
	});

	test("retryTask revives a blocked task only when it becomes claimable, and refuses a task that is neither failed nor blocked", () => {
		const { store } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		// `a` is merely unfinished, so reviving `b` must not manufacture a `ready` row nobody can claim
		const revived = store.retryTask(b.id, "dependency was a mistake");
		expect(revived.ok).toBe(true);
		expect(revived.task?.status).toBe("blocked");
		expect(store.claim(b.id, "B", 300).ok).toBe(false);

		// the block is not a dead end: the sweep promotes `b` the moment `a` completes
		store.claim(a.id, "A", 300);
		store.complete(a.id, "A", { summary: "done" });
		expect(store.getTask(b.id)?.status).toBe("ready");

		const refused = store.retryTask(a.id, "not broken");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("not failed or blocked");
		expect(store.retryTask("task-99").reason).toContain("unknown task");
		store.close();
	});
});

describe("closing dead residue", () => {
	test("an unowned task whose dependency was closed as failed can be closed by a non-holder", () => {
		const { store } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		store.claim(a.id, "A", 300);
		store.fail(a.id, "A", "superseded by a rollback");
		// b can never be claimed, so nobody can ever hold it; B is not its owner either
		expect(store.claim(b.id, "B", 300).reason).toContain(`dependencies: ${a.id}`);

		const closed = store.fail(b.id, "B", "CLOSED AS SUPERSEDED - panel-era residue; no work executed");
		expect(closed.ok).toBe(true);
		expect(store.getTask(b.id)?.status).toBe("failed");
		expect(store.getTask(b.id)?.claimedBy).toBeUndefined();
		const entry = store.searchBoard({ type: "FAIL", taskId: b.id })[0];
		expect(entry?.agentId).toBe("B");
		expect(entry?.content).toContain("no work executed");
		store.close();
	});

	test("a legacy ready row nobody can claim can be closed", () => {
		const { store, paths } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		store.claim(a.id, "A", 300);
		store.fail(a.id, "A", "superseded by a rollback");
		// what the old retryTask left behind, and what task-23 carries in the live pool:
		// ready, unowned, and refused by claim() forever
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET status='ready' WHERE id=?", b.id);
		raw.close();
		expect(store.claim(b.id, "B", 300).reason).toContain(`dependencies: ${a.id}`);

		expect(store.fail(b.id, "B", "CLOSED AS SUPERSEDED").ok).toBe(true);
		expect(store.getTask(b.id)?.status).toBe("failed");
		store.close();
	});

	test("a dependency that is merely unfinished, or already done, never makes the dependent closable", () => {
		const { store } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		const stillOpen = store.fail(b.id, "B", "nope");
		expect(stillOpen.ok).toBe(false);
		expect(stillOpen.reason).toContain("is blocked");

		// in flight is no better: `a` may still finish, so `b` is not residue
		store.claim(a.id, "A", 300);
		expect(store.fail(b.id, "B", "nope").ok).toBe(false);

		store.complete(a.id, "A", { summary: "done" });
		expect(store.getTask(b.id)?.status).toBe("ready");
		expect(store.fail(b.id, "B", "nope").ok).toBe(false);
		expect(store.getTask(b.id)?.status).toBe("ready");
		store.close();
	});

	test("a resumable block is not residue: an unfinished dependency keeps it out of reach of fail", () => {
		const { store } = makeRoot();
		const blocked = store.createTask({ title: "resumable", createdBy: "boot" });
		const dependent = store.createTask({ title: "later", createdBy: "boot", dependencies: [blocked.id] });
		expect(store.blockedReason(dependent.id)).toBe("waiting");
		expect(store.deadDependencies(dependent.id)).toEqual([]);

		store.claim(blocked.id, "A", 300);
		expect(store.deadDependencies(dependent.id)).toEqual([]);
		store.close();
	});

	test("closing a residue row leaves the caller's own held work alone", () => {
		const { store } = makeRoot();
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		store.claim(a.id, "A", 300);
		store.fail(a.id, "A", "superseded by a rollback");

		const mine = store.createTask({ title: "mine", createdBy: "boot" });
		store.claim(mine.id, "B", 300);
		expect(store.fail(b.id, "B", "CLOSED AS SUPERSEDED").ok).toBe(true);
		expect(store.getTask(mine.id)?.status).toBe("claimed");
		expect(store.getTask(mine.id)?.claimedBy).toBe("B");
		store.close();
	});
});

describe("closing a row nothing online can claim", () => {
	/** A ready row requiring `reviewer`, undisturbed for longer than the grace window. */
	const strandedRow = (store: SwarmStore, paths: SwarmPaths) => {
		const task = store.createTask({ title: "audit", createdBy: "boot", requiredCapabilities: ["reviewer"] });
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - UNROUTABLE_GRACE_MS - 1_000, task.id);
		raw.close();
		return task;
	};

	test("an unheld ready row no online agent could claim is closable by a non-holder", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const task = strandedRow(store, paths);
		expect(store.claim(task.id, "generalist", 300).ok).toBe(false);

		const closed = store.fail(task.id, "generalist", "no online agent holds reviewer; re-filed as task-9", {
			offlineAfterMs: 60_000,
		});
		expect(closed.ok).toBe(true);
		expect(store.getTask(task.id)?.status).toBe("failed");
		expect(store.getTask(task.id)?.claimedBy).toBeUndefined();
		const entry = store.searchBoard({ type: "FAIL", taskId: task.id })[0];
		expect(entry?.agentId).toBe("generalist");
		expect(entry?.content).toContain("no online agent holds reviewer");
		store.close();
	});

	test("a row an ONLINE agent could still claim is refused", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "reviewer", role: "reviewer", capabilities: ["reviewer", "general"] });
		const task = strandedRow(store, paths);

		const refused = store.fail(task.id, "generalist", "let me close it", { offlineAfterMs: 60_000 });
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("can still claim it");
		expect(store.getTask(task.id)?.status).toBe("ready");
		store.close();
	});

	test("an OFFLINE-only roster is not a licence to close ready work", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "reviewer", role: "reviewer", capabilities: ["reviewer", "general"] });
		// Heartbeat far in the past: the agent is in the pool but not online.
		const raw = openDatabase(paths);
		raw.run("UPDATE agents SET heartbeat_at=? WHERE id='reviewer'", Date.now() - 10 * 60_000);
		raw.close();
		const task = strandedRow(store, paths);

		// No online agent at all: refused, because an empty roster is the drain path's business.
		expect(store.fail(task.id, "generalist", "close it", { offlineAfterMs: 60_000 }).ok).toBe(false);
		expect(store.getTask(task.id)?.status).toBe("ready");
		store.close();
	});

	test("the grace window is real: a fresh row is refused, a stranded one is not", () => {
		const { store } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const fresh = store.createTask({ title: "fresh", createdBy: "boot", requiredCapabilities: ["reviewer"] });
		expect(store.fail(fresh.id, "generalist", "too early", { offlineAfterMs: 60_000 }).ok).toBe(false);
		expect(store.getTask(fresh.id)?.status).toBe("ready");

		// The default window is what refused it; an explicit wider override shows the row itself is eligible.
		expect(store.fail(fresh.id, "generalist", "eligible now", { offlineAfterMs: 60_000, graceMs: 0 }).ok).toBe(true);
		expect(UNROUTABLE_GRACE_MS).toBeGreaterThanOrEqual(60_000); // longer than the offline window it must outlast
		store.close();
	});

	test("a row whose dependency is not satisfied is refused, however unroutable it looks", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const dep = store.createTask({ title: "first", createdBy: "boot" });
		const blocked = store.createTask({ title: "later", createdBy: "boot", dependencies: [dep.id], requiredCapabilities: ["reviewer"] });
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - UNROUTABLE_GRACE_MS - 1_000, blocked.id);
		raw.close();

		expect(store.fail(blocked.id, "generalist", "close it", { offlineAfterMs: 60_000 }).ok).toBe(false);
		expect(store.getTask(blocked.id)?.status).toBe("blocked");
		store.close();
	});

	test("a row that declares no capability is never closed this way: anyone could claim it", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const open = store.createTask({ title: "anyone can take this", createdBy: "boot" });
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - UNROUTABLE_GRACE_MS - 1_000, open.id);
		raw.close();

		expect(store.fail(open.id, "generalist", "close it", { offlineAfterMs: 60_000 }).ok).toBe(false);
		expect(store.getTask(open.id)?.status).toBe("ready");
		store.close();
	});

	test("without the option the rule is unchanged, and the residue exit still closes with it", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const task = strandedRow(store, paths);
		// A store caller that does not name the window keeps the old behaviour exactly.
		const refused = store.fail(task.id, "generalist", "no option");
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("nothing here can close it");
		expect(store.getTask(task.id)?.status).toBe("ready");

		// …and passing the option does not disturb the residue path it has always had.
		const a = store.createTask({ title: "A", createdBy: "boot" });
		const b = store.createTask({ title: "B", createdBy: "boot", dependencies: [a.id] });
		store.claim(a.id, "generalist", 300);
		store.fail(a.id, "generalist", "superseded");
		expect(store.fail(b.id, "generalist", "residue", { offlineAfterMs: 60_000 }).ok).toBe(true);
		expect(store.getTask(b.id)?.status).toBe("failed");
		store.close();
	});

	test("a row closed this way is indistinguishable downstream from any other failed row", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const stranded = strandedRow(store, paths);
		const dependent = store.createTask({ title: "after it", createdBy: "boot", dependencies: [stranded.id] });

		expect(store.fail(stranded.id, "generalist", "nothing could claim it", { offlineAfterMs: 60_000 }).ok).toBe(true);
		// Same as the residue path: the dependent is now residue itself, and closable by the same rule.
		expect(store.deadDependencies(dependent.id)).toEqual([stranded.id]);
		expect(store.claim(dependent.id, "generalist", 300).ok).toBe(false);
		expect(store.fail(dependent.id, "generalist", "residue follows").ok).toBe(true);
		store.close();
	});
});

describe("review", () => {
	test("review-required work lands in review, then another agent approves it to done", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "reviewable", createdBy: "boot", reviewRequired: true });
		store.claim(task.id, "A", 300);
		const done = store.complete(task.id, "A", { summary: "implemented", reviewRequired: true, reviewEnabled: true });
		expect(done.ok).toBe(true);
		expect(store.getTask(task.id)?.status).toBe("review");

		const selfReview = store.claimReview(task.id, "A", 60);
		expect(selfReview.ok).toBe(false);
		expect(selfReview.reason).toContain("author");

		expect(store.claimReview(task.id, "B", 60).ok).toBe(true);
		const decision = store.decide(task.id, "B", true, "looks correct");
		expect(decision.ok).toBe(true);
		expect(store.getTask(task.id)?.status).toBe("done");
		expect(store.getTask(task.id)?.review.status).toBe("approved");
		store.close();
	});

	test("a rejection returns the task to ready with notes", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "redo", createdBy: "boot", reviewRequired: true });
		store.claim(task.id, "A", 300);
		store.complete(task.id, "A", { summary: "attempt", reviewRequired: true });
		store.decide(task.id, "B", false, "fails on nested tables");
		const after = store.getTask(task.id);
		expect(after?.status).toBe("ready");
		expect(after?.review.status).toBe("rejected");
		expect(after?.review.notes).toBe("fails on nested tables");
		expect(store.claim(task.id, "A", 300).ok).toBe(true);
		store.close();
	});

	test("approval unblocks dependents", () => {
		const { store } = makeRoot();
		const first = store.createTask({ title: "A", createdBy: "boot", reviewRequired: true });
		const second = store.createTask({ title: "B", createdBy: "boot", dependencies: [first.id] });
		store.claim(first.id, "A", 300);
		store.complete(first.id, "A", { summary: "done", reviewRequired: true });
		expect(store.getTask(second.id)?.status).toBe("blocked");
		store.decide(first.id, "B", true, "ok");
		expect(store.getTask(second.id)?.status).toBe("ready");
		store.close();
	});
});

describe("duplicate completion", () => {
	test("completing twice is refused, and only the first summary survives", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "once", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		expect(store.complete(task.id, "A", { summary: "first" }).ok).toBe(true);
		const again = store.complete(task.id, "A", { summary: "second" });
		expect(again.ok).toBe(false);
		expect(store.getTask(task.id)?.result).toBe("first");
		store.close();
	});

	test("a non-owner cannot complete or fail someone else's task", () => {
		const { store } = makeRoot();
		const task = store.createTask({ title: "owned", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		expect(store.complete(task.id, "B", { summary: "hijack" }).ok).toBe(false);
		expect(store.fail(task.id, "B", "hijack").ok).toBe(false);
		store.close();
	});
});

describe("blackboard", () => {
	test("concurrent writers from separate processes lose no entries", async () => {
		const { store, paths } = makeRoot();
		const perProcess = 25;
		const start = Date.now() + 400;
		await Promise.all(
			["A", "B", "C", "D"].map((agent) =>
				runChild([
					"--root",
					paths.root,
					"--op",
					"board-post",
					"--agent",
					agent,
					"--count",
					String(perProcess),
					"--start",
					String(start),
				]),
			),
		);
		const entries = store.searchBoard({ limit: 1000 });
		expect(entries.length).toBe(perProcess * 4);
		store.close();
	});

	test("search filters by type, agent, tag and keyword", () => {
		const { store } = makeRoot();
		store.postBoard({ type: "FACT", agentId: "A", content: "parser wants format=xxx", tags: ["parser"] });
		store.postBoard({ type: "FAIL", agentId: "B", content: "strategy X breaks nested tables", tags: ["parser", "dead-end"] });
		store.postBoard({ type: "RESULT", agentId: "A", content: "task done" });
		expect(store.searchBoard({ type: "FAIL" }).length).toBe(1);
		expect(store.searchBoard({ agentId: "A" }).length).toBe(2);
		expect(store.searchBoard({ tags: ["dead-end"] }).length).toBe(1);
		expect(store.searchBoard({ query: "nested tables" }).length).toBe(1);
		expect(store.boardCounts()).toEqual({ FACT: 1, FAIL: 1, RESULT: 1 });
		store.close();
	});
});

describe("reservations", () => {
	test("overlapping reservations conflict and non-overlapping ones do not", () => {
		const { store } = makeRoot();
		expect(store.acquireReservations("A", ["src/auth/**"], 300).ok).toBe(true);
		const conflict = store.acquireReservations("B", ["src/auth/token.ts"], 300);
		expect(conflict.ok).toBe(false);
		expect(conflict.conflicts[0]).toContain("src/auth/**");
		expect(store.acquireReservations("B", ["src/parser/**"], 300).ok).toBe(true);
		expect(store.releaseReservations("A", ["src/auth/**"])).toBe(1);
		expect(store.acquireReservations("B", ["src/auth/token.ts"], 300).ok).toBe(true);
		store.close();
	});

	test("expired reservations stop blocking", () => {
		const { store, paths } = makeRoot();
		store.acquireReservations("A", ["src/core/**"], 300);
		const other = openDatabase(paths);
		other.run("UPDATE reservations SET lease_until=? WHERE owner='A'", Date.now() - 1000);
		other.close();
		expect(store.acquireReservations("B", ["src/core/loop.ts"], 300).ok).toBe(true);
		store.close();
	});

	test("pattern overlap semantics", () => {
		expect(patternsConflict("src/auth/**", "src/auth/token.ts")).toBe(true);
		expect(patternsConflict("src/auth", "src/authz")).toBe(false);
		expect(patternsConflict("src/a.ts", "src/b.ts")).toBe(false);
	});
});

describe("messaging", () => {
	test("direct and broadcast inbox delivery", () => {
		const { store } = makeRoot();
		store.sendMessage({ to: "B", from: "A", body: "status?" });
		store.sendMessage({ to: "*", from: "C", body: "wave 2 done" });
		const inbox = store.inbox("B");
		expect(inbox.length).toBe(2);
		expect(store.inbox("D").length).toBe(1);
		store.markMessagesRead("B", inbox.map((m) => m.id));
		expect(store.inbox("B").length).toBe(0);
		store.close();
	});
});

describe("task ids across processes", () => {
	test("concurrent creators never allocate the same id", async () => {
		const { store, paths } = makeRoot();
		const start = Date.now() + 400;
		const seed = store.createTask({ title: "seed", createdBy: "boot" });
		expect(seed.id).toBe("task-1");
		await Promise.all(
			["A", "B", "C"].map((agent) =>
				runChild(["--root", paths.root, "--op", "claim", "--task", seed.id, "--agent", agent, "--start", String(start)]),
			),
		);
		const ids = store.listTasks({ limit: 100 }).map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
		store.close();
	});
});

describe("snapshot", () => {
	test("recentDone lists completed tasks newest first and is empty on a fresh store", () => {
		const { store, paths } = makeRoot();
		expect(store.snapshot(60, true).recentDone).toEqual([]);
		expect(store.recentDoneTasks()).toEqual([]);

		const ids = ["a", "b", "c"].map((title) => store.createTask({ title, createdBy: "boot" }).id);
		for (const id of ids) {
			store.claim(id, "A", 300);
			store.complete(id, "A", { summary: `${id} done` });
		}
		// completion time is `updated_at`; pin it so the order is not decided by clock resolution
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - 3 * 60_000, ids[0]);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - 2 * 60_000, ids[1]);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - 60_000, ids[2]);
		raw.close();

		expect(store.recentDoneTasks().map((t) => t.id)).toEqual([ids[2], ids[1], ids[0]]);
		expect(store.recentDoneTasks(2).map((t) => t.id)).toEqual([ids[2], ids[1]]);
		expect(store.snapshot(60, true).recentDone.map((t) => t.id)).toEqual([ids[2], ids[1], ids[0]]);

		const live = store.createTask({ title: "live", createdBy: "boot" });
		store.claim(live.id, "A", 300);
		expect(store.recentDoneTasks().map((t) => t.id)).not.toContain(live.id);
		store.close();
	});
});

describe("file overlap", () => {
	test("an open task sharing a path is reported; a closed, excluded or disjoint one is not", () => {
		const { store } = makeRoot();
		const owner = store.createTask({ title: "own the file", createdBy: "boot", files: ["src/a.ts"] });
		expect(store.tasksSharingFiles(["src/a.ts"]).map((t) => t.id)).toEqual([owner.id]);
		expect(store.tasksSharingFiles(["src/a.ts"], [owner.id])).toEqual([]);
		expect(store.tasksSharingFiles(["src/b.ts"])).toEqual([]);
		expect(store.tasksSharingFiles([])).toEqual([]);

		const other = store.createTask({ title: "other work", createdBy: "boot", files: ["src/b.ts"] });
		expect(store.tasksSharingFiles(["src/a.ts", "src/b.ts"]).map((t) => t.id).sort()).toEqual([owner.id, other.id].sort());

		store.claim(owner.id, "A", 300);
		expect(store.tasksSharingFiles(["src/a.ts"]).map((t) => t.id)).toEqual([owner.id]);
		store.complete(owner.id, "A", { summary: "done" });
		expect(store.tasksSharingFiles(["src/a.ts"])).toEqual([]);
		expect(store.tasksSharingFiles(["src/b.ts"]).map((t) => t.id)).toEqual([other.id]);
		store.close();
	});
});

describe("event log", () => {
	test("mutations are recorded as structured events in the table and jsonl", () => {
		const { store, paths } = makeRoot();
		const task = store.createTask({ title: "logged", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		store.complete(task.id, "A", { summary: "done" });
		const types = store.recentEvents(20).map((e) => e.type);
		expect(types).toContain("task.create");
		expect(types).toContain("task.claim");
		expect(types).toContain("task.complete");
		const lines = readFileSync(paths.eventsFile, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(JSON.parse(lines.at(-1) ?? "").type).toBe("task.complete");
		store.close();
	});
});

describe("sqlite handles", () => {
	test("a readonly handle can read what the writer committed", () => {
		const { store, paths } = makeRoot();
		store.createTask({ title: "visible", createdBy: "boot" });
		const reader = openDatabase(paths, { readonly: true });
		const row = reader.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks");
		reader.close();
		expect(row?.n).toBe(1);
		store.close();
	});
});
