import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { findStarvation } from "../../extension/starvation";
import { SwarmStore, UNROUTABLE_GRACE_MS, patternsConflict } from "../../extension/store";
import { DEFAULT_CONFIG } from "../../extension/types";

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

/** Reach into the same DB from a second connection: "time passed" without a wall-clock sleep. */
function ageDatabase(paths: SwarmPaths, sql: string, ...params: (number | string)[]): void {
	const clock = openDatabase(paths);
	clock.run(sql, ...params);
	clock.close();
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
		// goal-18's U4: the reason no longer says "can still claim it, OR it is not old enough yet"
		// — the two refusals that used to share one sentence. It names the guard that actually
		// decided: this row's full capability set IS held by an online agent.
		expect(refused.reason).toContain("an online agent holds its full capability set");
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

/**
 * goal-18's U4 (task-279): the refusal REASON names the guard that decided, so a row that can never
 * be closed reads differently from a row that is simply not old enough yet.
 *
 * The defect: one sentence ("an online agent can still claim it, or it has not been stranded for
 * the grace window yet") covered five guards, and its first half is TRUE BY DEFINITION for a
 * `caps=[]` row — the exact shape the exit refuses at `required.length === 0`. Measured by
 * `omp-swarm/scratch/goal18/u4-ladder-probe.ts`, section B. The row's own status is asserted too,
 * because a diagnostic that arrives with the row already closed is not a diagnostic.
 */
describe("goal-18 U4: the unroutable refusal names the guard that decided", () => {
	test("a caps=[] row is refused with a reason that says WHY the exit is not for it", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const task = store.createTask({ title: "verify with no caps", createdBy: "boot" });
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - UNROUTABLE_GRACE_MS - 1_000, task.id);
		raw.close();

		const refused = store.fail(task.id, "generalist", "close it", { offlineAfterMs: 60_000 });
		expect(refused.ok).toBe(false);
		// The row is trivially claimable, so the OLD wording was true and useless. The reason now
		// names the guard and says what the exit IS for.
		expect(refused.reason).toContain("declares no capability at all");
		expect(refused.reason).toContain("it is for a capability nobody holds");
		expect(store.getTask(task.id)?.status).toBe("ready");
		store.close();
	});

	test("a row inside the grace window is refused with its age and the window", () => {
		const { store } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const task = store.createTask({ title: "audit", createdBy: "boot", requiredCapabilities: ["reviewer"] });
		// Freshly minted: 0s of the 10-minute grace window has elapsed.
		const refused = store.fail(task.id, "generalist", "close it", { offlineAfterMs: 60_000 });
		expect(refused.ok).toBe(false);
		expect(refused.reason).toContain("has not been stranded for the grace window");
		expect(store.getTask(task.id)?.status).toBe("ready");
		store.close();
	});

	test("a row with unresolved dependencies is refused naming THAT, not the clock", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });
		const parent = store.createTask({ title: "parent", createdBy: "boot" });
		const child = store.createTask({ title: "child", createdBy: "boot", requiredCapabilities: ["reviewer"], dependencies: [parent.id] });
		const raw = openDatabase(paths);
		raw.run("UPDATE tasks SET updated_at=? WHERE id=?", Date.now() - UNROUTABLE_GRACE_MS - 1_000, child.id);
		raw.close();

		const refused = store.fail(child.id, "generalist", "close it", { offlineAfterMs: 60_000 });
		expect(refused.ok).toBe(false);
		// `deadDependencies` says "not dead", so the honest reason names the dependency, not the
		// cooldown or the capability set.
		expect(refused.reason).toContain("still has unresolved dependencies");
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

	test("a controller decision reaches the events table, not only the jsonl", () => {
		const { store, paths } = makeRoot();
		store.logEvent("roster.shrink", "main", { workers: 3, stopped: ["A"], ready: 10, requested: 1 });
		// The proof fixtures and the web panel read the DATABASE, not the jsonl:
		// `SELECT id, data FROM events WHERE type='roster.shrink'`. A controller event that only
		// appended to the jsonl made the pool look like it had never changed size.
		const reader = openDatabase(paths, { readonly: true });
		const rows = reader.all<{ data: string }>("SELECT data FROM events WHERE type='roster.shrink'");
		reader.close();
		expect(rows.length).toBe(1);
		expect(JSON.parse(rows[0]?.data ?? "{}")).toEqual({ workers: 3, stopped: ["A"], ready: 10, requested: 1 });
		const lines = readFileSync(paths.eventsFile, "utf8").trim().split("\n");
		expect(JSON.parse(lines.at(-1) ?? "{}").type).toBe("roster.shrink");
		store.close();
	});
});

describe("the offline marker is a read-side judgement, not a sentence", () => {
	/** Age every heartbeat by `seconds`, the way a stopped beat loop or a long turn does. */
	function age(paths: SwarmPaths, seconds: number): void {
		const clock = openDatabase(paths);
		clock.run("UPDATE agents SET heartbeat_at=?", Date.now() - seconds * 1000);
		clock.close();
	}

	test("a beat revives a stale offline row — and says 'working' when it still holds", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "BrightTiger", role: "general", capabilities: ["general"], status: "working" });
		store.registerAgent({ id: "SwiftTiger", role: "general", capabilities: ["general"], status: "idle" });
		const task = store.createTask({ title: "held work", createdBy: "main" });
		expect(store.claim(task.id, "BrightTiger", 300, ["general"]).ok).toBe(true);

		age(paths, 120);
		store.snapshot(60, true); // ANY status read writes the corpse marker
		expect(store.listAgents().every((a) => a.status === "offline")).toBe(true);

		// The call shape that used to make the marker permanent: the beat passes the STORED status back.
		for (const agent of store.listAgents()) store.heartbeat(agent.id, agent.status ?? "idle", undefined, 300);

		const after = new Map(store.listAgents().map((a) => [a.id, a]));
		expect(after.get("BrightTiger")?.status).toBe("working");
		expect(after.get("SwiftTiger")?.status).toBe("idle");
		store.close();
	});

	test("a corpse stays unavailable: the row nobody beats is still offline, and starvation sees it", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "BrightTiger", role: "general", capabilities: ["general"], status: "working" });
		store.registerAgent({ id: "CalmTiger", role: "reviewer", capabilities: ["reviewer"], status: "working" });
		age(paths, 120);
		store.snapshot(60, true);

		// Only BrightTiger is still in the beat set (the other session was released/disposed): a beat
		// revives it, and nothing beats CalmTiger, so its marker stands.
		const stored = store.listAgents().find((a) => a.id === "BrightTiger")?.status ?? "idle";
		store.heartbeat("BrightTiger", stored, undefined, 300);
		const agents = store.listAgents();
		expect(agents.find((a) => a.id === "BrightTiger")?.status).not.toBe("offline");
		expect(agents.find((a) => a.id === "CalmTiger")?.status).toBe("offline");

		// Acceptance (b): the pool's own availability logic must NOT have gained the corpse.
		const needsReviewer = store.createTask({ title: "needs a reviewer", createdBy: "main", requiredCapabilities: ["reviewer"] });
		const report = findStarvation({
			ready: [needsReviewer],
			agents: store.listAgents(),
			now: Date.now(),
			offlineAfterMs: 60_000,
		});
		expect(report?.missing).toEqual(["reviewer"]);
		store.close();
	});

	test("a worker whose beat is fresh is never swept, so a busy worker keeps its status", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "BrightTiger", role: "general", capabilities: ["general"], status: "working" });
		age(paths, 20); // one beat ago: heartbeatSeconds is 20
		store.snapshot(60, true);
		expect(store.listAgents()[0]?.status).toBe("working");
		store.close();
	});

	test("a transition reports what the agent still holds instead of hard-coding idle + NULL", () => {
		const { store } = makeRoot();
		store.registerAgent({ id: "BrightTiger", role: "general", capabilities: ["general"], status: "idle" });
		const one = store.createTask({ title: "one", createdBy: "main" });
		const two = store.createTask({ title: "two", createdBy: "main" });
		expect(store.claim(one.id, "BrightTiger", 300, ["general"]).ok).toBe(true);
		expect(store.claim(two.id, "BrightTiger", 300, ["general"]).ok).toBe(true);

		expect(store.complete(one.id, "BrightTiger", { summary: "done" }).ok).toBe(true);
		const agent = store.listAgents()[0];
		expect(agent?.status).toBe("working");
		expect(agent?.currentTask).toBe(two.id);

		expect(store.release(two.id, "BrightTiger", "nothing left")).toBe(true);
		expect(store.listAgents()[0]?.status).toBe("idle");
		expect(store.listAgents()[0]?.currentTask).toBeFalsy();
		store.close();
	});
});

describe("an agent row cannot claim a state its holdings do not justify", () => {
	/**
	 * The same class as the offline marker, one member further on: `reviewing` (and `working`) were echoed
	 * back by every beat, so a status outlived the row that caused it. LunarTiger read `reviewing` with
	 * NO review lease in the tasks table (msg #235) and nothing could ever correct it, because the beat
	 * passed the stored status straight back and `heartbeat()` used it verbatim.
	 */
	test("a review taken over by another reviewer settles the first one on its next beat", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "LunarTiger", role: "reviewer", capabilities: ["reviewer"], status: "idle" });
		store.registerAgent({ id: "SwiftTiger", role: "reviewer", capabilities: ["reviewer"], status: "idle" });
		const task = store.createTask({ title: "needs a look", createdBy: "main" });
		expect(store.claim(task.id, "peer-author", 300, ["general"]).ok).toBe(true);
		expect(store.complete(task.id, "peer-author", { summary: "done", reviewRequired: true }).ok).toBe(true);

		expect(store.claimReview(task.id, "LunarTiger", 60).ok).toBe(true);
		expect(store.listAgents().find((a) => a.id === "LunarTiger")?.status).toBe("reviewing");

		// Its 60s lease lapses and another reviewer takes the slot: the tasks table no longer grants
		// LunarTiger anything, so `reviewing` on its row is a state with no cause.
		ageDatabase(paths, "UPDATE tasks SET review_lease_until=? WHERE id=?", Date.now() - 1_000, task.id);
		expect(store.claimReview(task.id, "SwiftTiger", 60).ok).toBe(true);

		store.heartbeat("LunarTiger", undefined, undefined, 300);
		const row = store.listAgents().find((a) => a.id === "LunarTiger");
		expect(row?.status).toBe("idle"); // never a review the tasks table does not grant
		expect(row?.currentTask ?? null).toBeNull();
		store.close();
	});

	test("a claim swept away settles a stale `working` on the next beat", () => {
		const { store, paths } = makeRoot();
		store.registerAgent({ id: "BrightTiger", role: "general", capabilities: ["general"], status: "idle" });
		const task = store.createTask({ title: "held work", createdBy: "main" });
		expect(store.claim(task.id, "BrightTiger", 300, ["general"]).ok).toBe(true);
		expect(store.listAgents()[0]?.status).toBe("working");

		ageDatabase(paths, "UPDATE tasks SET lease_until=? WHERE id=?", Date.now() - 1_000, task.id);
		store.sweep(60); // the lease lapses and the row returns to the pool
		expect(store.getTask(task.id)?.status).toBe("ready");

		store.heartbeat("BrightTiger", undefined, undefined, 300);
		expect(store.listAgents()[0]?.status).toBe("idle");
		expect(store.listAgents()[0]?.currentTask ?? null).toBeNull();
		store.close();
	});

	test("the two declared states survive a beat: blocked/waiting are not derived from holdings", () => {
		const { store } = makeRoot();
		store.registerAgent({ id: "CalmTiger", role: "general", capabilities: ["general"], status: "idle" });
		store.setAgentStatus("CalmTiger", "blocked");
		store.heartbeat("CalmTiger", undefined, undefined, 300);
		expect(store.listAgents()[0]?.status).toBe("blocked");

		store.setAgentStatus("CalmTiger", "waiting");
		store.heartbeat("CalmTiger", undefined, undefined, 300);
		expect(store.listAgents()[0]?.status).toBe("waiting");
		store.close();
	});

	test("a refused decision never stamps the reviewer", () => {
		const { store } = makeRoot();
		store.registerAgent({ id: "LunarTiger", role: "reviewer", capabilities: ["reviewer"], status: "idle" });
		store.registerAgent({ id: "SwiftTiger", role: "reviewer", capabilities: ["reviewer"], status: "idle" });
		const task = store.createTask({ title: "needs a look", createdBy: "main" });
		expect(store.claim(task.id, "peer-author", 300, ["general"]).ok).toBe(true);
		expect(store.complete(task.id, "peer-author", { summary: "done", reviewRequired: true }).ok).toBe(true);
		expect(store.claimReview(task.id, "SwiftTiger", 60).ok).toBe(true);

		const denied = store.decide(task.id, "LunarTiger", true, "notes");
		expect(denied.ok).toBe(false);
		expect(store.listAgents().find((a) => a.id === "LunarTiger")?.status).toBe("idle");
		expect(store.getTask(task.id)?.status).toBe("review"); // the holder keeps it
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

/**
 * goal-14's clause 1, at the createTask mint site (task-249).
 *
 * WHY THIS FILE AND WHY THESE TESTS. `swarm_task_create` bypasses `mergeProposals` and reaches
 * `#createTaskLocked` directly, so commit 495ec30's merge guard does not cover it: a direct create
 * with a capability no configured role can hold is still ACCEPTED, which is exactly how task-221/
 * 222/223 sat `ready` for two hours. The guard is opt-in (`reachable?: Set<string>`, the shape
 * `mergeProposals` already took) so that every other caller of `#createTaskLocked` — the goal's
 * planning task, `swarm_integrate`'s hardcoded `["integrator"]`, the operator's `/swarm task`, the
 * vote-executed creates — is byte-identical when it passes nothing.
 */
describe("a mint whose capability no configured role can reach is refused, not created", () => {
	const LIVE = new Set<string>(["general"]);
	const ROLED = new Set<string>(["general", "reviewer"]);

	test("an unreachable capability is refused with the reason, and no row is created", () => {
		const { store } = makeRoot();
		const before = store.listTasks({ limit: 1000 }).length;
		const refused = store.createTask({
			title: "Verify the voting view non-author",
			description: "the historical shape: a label nobody in the pool holds",
			createdBy: "main",
			requiredCapabilities: ["reviewer"],
			files: ["scratch/goal11/webverify/VERDICT.md"],
			reachable: LIVE,
		});
		// The refusal is a REPORT, not an exception and not a silently dropped row: the caller gets a
		// task-shaped object marked `refused`, so it can act on it without a second query.
		expect(refused.status).toBe("refused");
		expect(refused.mintRefusal).toContain("reviewer");
		expect(refused.mintRefusal).toContain("general"); // the reachable alternative is named
		expect(refused.mintRefusal).toContain("config.roles"); // the operator's path is named
		// And no row was written: the pool cannot see a refused mint through any query.
		expect(store.listTasks({ limit: 1000 }).length).toBe(before);
		expect(store.listTasks({ status: ["ready"], limit: 1000 }).some((task) => task.title === "Verify the voting view non-author")).toBe(false);
		store.close();
	});

	test("the same row is accepted once a role provides the capability", () => {
		const { store } = makeRoot();
		const made = store.createTask({
			title: "Verify the voting view non-author",
			description: "the operator added the role",
			createdBy: "main",
			requiredCapabilities: ["reviewer"],
			reachable: ROLED,
		});
		expect(made.status).not.toBe("refused");
		expect(made.requiredCapabilities).toEqual(["reviewer"]);
		store.close();
	});

	test("no capability and a reachable capability are unchanged", () => {
		const { store } = makeRoot();
		expect(store.createTask({ title: "no label", createdBy: "main", reachable: LIVE }).status).toBe("ready");
		expect(store.createTask({ title: "general work", createdBy: "main", requiredCapabilities: ["general"], reachable: LIVE }).status).toBe("ready");
		// And the same two rows, with NO reachability set at all: the historical behaviour.
		expect(store.createTask({ title: "no label, unguarded", createdBy: "main" }).status).toBe("ready");
		expect(store.createTask({ title: "reviewer, unguarded", createdBy: "main", requiredCapabilities: ["reviewer"] }).status).toBe("ready");
		store.close();
	});

	test("a partly-unreachable label names only the capability that strands it", () => {
		const { store } = makeRoot();
		const refused = store.createTask({
			title: "verify, then integrate",
			description: "one reachable and one unreachable capability",
			createdBy: "main",
			requiredCapabilities: ["general", "integrator"],
			reachable: LIVE,
		});
		expect(refused.status).toBe("refused");
		expect(refused.mintRefusal).toContain("integrator");
		store.close();
	});

	test("the refusal is reported on the board, so the pool can see a row it never got", () => {
		const { store } = makeRoot();
		store.createTask({ title: "Verify the voting view non-author", createdBy: "main", requiredCapabilities: ["reviewer"], reachable: LIVE });
		const entries = store.searchBoard({ type: "DECISION", limit: 20 });
		expect(entries.some((entry) => entry.tags.includes("mint-refusal"))).toBe(true);
		store.close();
	});

	test("a merged round whose row nobody can claim is refused as a whole, and nothing is written", () => {
		const { store } = makeRoot();
		const opened = store.createGoal({ goal: "split the work", agents: 2, createdBy: "main" });
		store.postProposal(opened.goal, "A", [
			{ title: "Verify the voting view non-author", deliverable: "d1", files: ["a.md"], capabilities: ["reviewer"] },
		]);
		store.postProposal(opened.goal, "B", [{ title: "General work", deliverable: "d2", files: ["b.md"], capabilities: [] }]);
		store.claim(opened.planningTask.id, "A", 300, ["general"]);
		const rowsBefore = store.listTasks({ limit: 100 }).length;
		const planned = store.planGoal(opened.goal.id, "A", { ceiling: 6, config: { ...DEFAULT_CONFIG, roles: [] } });
		expect(planned.ok).toBe(false);
		expect(planned.reason).toContain("reviewer");
		// The whole round rolled back: only the planning task exists, and the goal stays open so the
		// round can be re-taken by the next scribe rather than sitting half-written.
		expect(store.listTasks({ limit: 100 }).length).toBe(rowsBefore);
		expect(store.getGoal(opened.goal.id)?.status).toBe("open");
		store.close();
	});

	test("the same round plans normally without a config, and with a clean one with a config", () => {
		const { store } = makeRoot();
		const unguarded = store.createGoal({ goal: "no roster", agents: 2, createdBy: "main" });
		store.postProposal(unguarded.goal, "A", [{ title: "Reviewer row", deliverable: "d1", files: ["z.md"], capabilities: ["reviewer"] }]);
		store.postProposal(unguarded.goal, "B", [{ title: "Another row", deliverable: "d2", files: ["y.md"], capabilities: [] }]);
		store.claim(unguarded.planningTask.id, "A", 300, ["general"]);
		// No config: the pre-existing behaviour, byte for byte.
		expect(store.planGoal(unguarded.goal.id, "A", { ceiling: 6 }).created.length).toBe(2);

		const clean = store.createGoal({ goal: "clean round", agents: 2, createdBy: "main" });
		store.postProposal(clean.goal, "A", [{ title: "Clean one", deliverable: "d1", files: ["c.md"], capabilities: ["general"] }]);
		store.postProposal(clean.goal, "B", [{ title: "Clean two", deliverable: "d2", files: ["d.md"], capabilities: [] }]);
		store.claim(clean.planningTask.id, "A", 300, ["general"]);
		expect(store.planGoal(clean.goal.id, "A", { ceiling: 6, config: { ...DEFAULT_CONFIG, roles: [] } }).ok).toBe(true);
		store.close();
	});
});
