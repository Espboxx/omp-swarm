import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	cleanupFixtureRoots,
	insertAgent,
	insertBoardEntry,
	insertDependency,
	insertEvent,
	insertMessage,
	insertReservation,
	insertTask,
	makeFixtureDb,
	type FixtureDb,
} from "../../web/lib/fixture";
import { openReadonlyDb, type ReadonlyDatabase } from "../../web/lib/readonly";
import { TASK_LIMIT, buildSnapshot, buildSummary, readCounts } from "../../web/snapshot";
import type { Snapshot, SnapshotSummary } from "../../web/lib/types";

/** A fixed clock: every expected value below is derived from it, never from `Date.now()`. */
const NOW = 1_700_000_000_000;

/** Read-only handles opened by a test, closed on the way out so temp roots stay removable. */
const handles: ReadonlyDatabase[] = [];

function handle(fixture: FixtureDb): ReadonlyDatabase {
	const db = openReadonlyDb(fixture.path);
	handles.push(db);
	return db;
}

function readSnapshot(fixture: FixtureDb, overrides: { feedLimit?: number; offlineAfterSeconds?: number } = {}): Snapshot {
	return buildSnapshot(handle(fixture), { now: NOW, swarmRoot: fixture.root, ...overrides });
}

function readSummary(fixture: FixtureDb, now = NOW): SnapshotSummary {
	return buildSummary(handle(fixture), now);
}

afterEach(() => {
	for (const db of handles.splice(0)) db.close();
	cleanupFixtureRoots();
});

describe("snapshot counts", () => {
	test("every bucket matches the SQL truth, and total counts an unknown legacy status", () => {
		const fixture = makeFixtureDb();
		insertTask(fixture.db, { id: "task-1", status: "ready", createdAt: NOW - 5_000 });
		insertTask(fixture.db, { id: "task-2", status: "ready", createdAt: NOW - 4_000 });
		insertTask(fixture.db, { id: "task-3", status: "claimed", createdAt: NOW - 3_000 });
		insertTask(fixture.db, { id: "task-4", status: "done", createdAt: NOW - 2_000 });
		// A status the six buckets do not name: `total` must stay the SQL truth, not their sum.
		insertTask(fixture.db, { id: "task-5", status: "archived", createdAt: NOW - 1_000 });

		const sql = fixture.db
			.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
			.all();
		const counts = readCounts(handle(fixture));

		expect(counts).toEqual({ ready: 2, claimed: 1, review: 0, blocked: 0, done: 1, failed: 0, total: 5 });
		expect(counts.total).toBe(sql.reduce((sum, row) => sum + row.n, 0));
		expect(counts.ready).toBe(sql.find((row) => row.status === "ready")?.n ?? -1);
	});

	test("an empty pool reads as seven zeros", () => {
		const fixture = makeFixtureDb();
		expect(readCounts(handle(fixture))).toEqual({ ready: 0, claimed: 0, review: 0, blocked: 0, done: 0, failed: 0, total: 0 });
	});
});

describe("snapshot agents", () => {
	test("maps a working agent, a stale one, a reviewer's lease, and main", () => {
		const fixture = makeFixtureDb();
		const { db } = fixture;
		insertTask(db, {
			id: "task-1",
			status: "claimed",
			createdAt: NOW - 60_000,
			claimedBy: "SwiftTiger",
			claimedAt: NOW - 30_000,
			leaseUntil: NOW + 270_000,
			attempts: 1,
		});
		insertTask(db, {
			id: "task-2",
			status: "review",
			createdAt: NOW - 50_000,
			reviewRequired: true,
			reviewStatus: "pending",
			reviewer: "VividTiger",
			reviewLeaseUntil: NOW + 120_000,
		});
		insertAgent(db, {
			id: "SwiftTiger",
			role: "general",
			status: "working",
			capabilities: ["general", "reviewer"],
			currentTask: "task-1",
			worktree: "C:/tmp/wt",
			joinedAt: NOW - 600_000,
			heartbeatAt: NOW - 5_000,
		});
		insertAgent(db, { id: "main", role: "main", status: "idle", joinedAt: NOW - 600_000, heartbeatAt: NOW - 90_000 });
		insertAgent(db, {
			id: "VividTiger",
			role: "reviewer",
			status: "reviewing",
			capabilities: ["reviewer"],
			joinedAt: NOW - 600_000,
			heartbeatAt: NOW - 1_000,
		});
		insertAgent(db, { id: "Ghost", role: "general", status: "offline", joinedAt: NOW - 600_000, heartbeatAt: NOW - 900_000 });

		const byId = new Map(readSnapshot(fixture).agents.map((agent) => [agent.id, agent]));

		expect(byId.get("SwiftTiger")).toEqual({
			id: "SwiftTiger",
			role: "general",
			status: "working",
			currentTask: "task-1",
			capabilities: ["general", "reviewer"],
			worktree: "C:/tmp/wt",
			heartbeatAgeMs: 5_000,
			leaseUntilMs: NOW + 270_000,
			isMain: false,
		});
		// Heartbeat older than the offline window: reported offline without any write.
		expect(byId.get("main")?.status).toBe("offline");
		expect(byId.get("main")?.isMain).toBe(true);
		expect(byId.get("main")?.heartbeatAgeMs).toBe(90_000);
		// The lease an agent holds is the one on the task it reviews.
		expect(byId.get("VividTiger")?.leaseUntilMs).toBe(NOW + 120_000);
		expect(byId.get("VividTiger")?.currentTask).toBeNull();
		// An explicit offline row stays offline, and a row with no lease reads null.
		expect(byId.get("Ghost")?.status).toBe("offline");
		expect(byId.get("Ghost")?.leaseUntilMs).toBeNull();
	});
});

describe("snapshot tasks", () => {
	test("maps an unclaimed task and a claimed one, with age from createdAtMs", () => {
		const fixture = makeFixtureDb();
		const { db } = fixture;
		insertTask(db, {
			id: "task-1",
			title: "unclaimed",
			status: "ready",
			priority: 3,
			createdAt: NOW - 7_000,
			requiredCapabilities: ["general"],
			files: ["src/a.ts"],
		});
		insertTask(db, {
			id: "task-2",
			title: "claimed",
			status: "claimed",
			createdAt: NOW - 9_000,
			updatedAt: NOW - 4_000,
			claimedBy: "CalmTiger",
			claimedAt: NOW - 4_000,
			leaseUntil: NOW + 296_000,
			attempts: 2,
			reviewRequired: true,
			reviewStatus: "pending",
			result: "partial",
			commit: "abc1234",
		});

		const byId = new Map(readSnapshot(fixture).tasks.map((task) => [task.id, task]));

		expect(byId.get("task-1")).toMatchObject({
			title: "unclaimed",
			status: "ready",
			priority: 3,
			claimedBy: null,
			claimedAtMs: null,
			leaseUntilMs: null,
			ageMs: 7_000,
			createdAtMs: NOW - 7_000,
			updatedAtMs: NOW - 7_000,
			requiredCapabilities: ["general"],
			files: ["src/a.ts"],
			reviewRequired: false,
			reviewStatus: null,
			result: null,
			commit: null,
			blockedReason: null,
		});
		expect(byId.get("task-2")).toMatchObject({
			claimedBy: "CalmTiger",
			claimedAtMs: NOW - 4_000,
			leaseUntilMs: NOW + 296_000,
			attempts: 2,
			ageMs: 9_000,
			reviewRequired: true,
			reviewStatus: "pending",
			result: "partial",
			commit: "abc1234",
		});
	});

	test("dependencies come back ordered, and blockedReason mirrors the store's wording", () => {
		const fixture = makeFixtureDb();
		const { db } = fixture;
		insertTask(db, { id: "task-1", status: "done", createdAt: NOW - 10_000 });
		insertTask(db, { id: "task-2", status: "ready", createdAt: NOW - 9_000 });
		insertTask(db, { id: "task-3", status: "blocked", createdAt: NOW - 8_000 });
		insertTask(db, { id: "task-4", status: "blocked", createdAt: NOW - 7_000 });
		insertTask(db, { id: "task-5", status: "blocked", createdAt: NOW - 6_000 });
		insertTask(db, { id: "task-6", status: "ready", createdAt: NOW - 5_000 });
		// task-3 waits on real, unfinished dependencies.
		insertDependency(db, "task-3", "task-1");
		insertDependency(db, "task-3", "task-2");
		// task-4 waits on an id that no longer exists (a legacy row).
		insertDependency(db, "task-4", "task-404");
		// task-5 sits in a cycle.
		insertDependency(db, "task-5", "task-6");
		insertDependency(db, "task-6", "task-5");

		const byId = new Map(readSnapshot(fixture).tasks.map((task) => [task.id, task]));

		expect(byId.get("task-3")?.dependencies).toEqual(["task-1", "task-2"]);
		expect(byId.get("task-3")?.blockedReason).toBe("waiting");
		expect(byId.get("task-4")?.blockedReason).toBe("missing: task-404");
		expect(byId.get("task-5")?.blockedReason).toBe("cycle: task-6 -> task-5 -> task-6");
		// A task that is not blocked never carries a reason, even with dependencies.
		expect(byId.get("task-6")?.blockedReason).toBeNull();
	});
});

describe("snapshot feeds", () => {
	test("board, messages and events are newest-first and limited by feed.limit", () => {
		const fixture = makeFixtureDb();
		const { db } = fixture;
		for (let i = 1; i <= 3; i++) {
			const at = NOW - (10 - i) * 1_000;
			insertBoardEntry(db, { type: "FACT", agentId: "SwiftTiger", content: `entry ${i}`, taskId: `task-${i}`, createdAt: at });
			insertMessage(db, { to: "all", from: "CalmTiger", body: `message ${i}`, urgent: i === 3, createdAt: at, readAt: i === 1 ? NOW : null });
			insertEvent(db, { type: "board.post", agentId: "SwiftTiger", data: `{"i":${i}}`, createdAt: at });
		}
		insertReservation(db, { pattern: "src/auth/**", owner: "SwiftTiger", taskId: "task-1", leaseUntil: NOW + 60_000, createdAt: NOW - 500 });

		const snapshot = readSnapshot(fixture, { feedLimit: 2 });

		expect(snapshot.feed).toEqual({ limit: 2 });
		expect(snapshot.board.map((entry) => entry.content)).toEqual(["entry 3", "entry 2"]);
		expect(snapshot.board[0]).toEqual({
			id: 3,
			type: "FACT",
			taskId: "task-3",
			author: "SwiftTiger",
			createdAtMs: NOW - 7_000,
			content: "entry 3",
		});
		expect(snapshot.messages.map((message) => message.content)).toEqual(["message 3", "message 2"]);
		expect(snapshot.messages[0]?.urgent).toBe(true);
		expect(snapshot.messages[0]?.read).toBe(false);
		expect(snapshot.events.map((event) => event.content)).toEqual(['{"i":3}', '{"i":2}']);
		expect(snapshot.events[0]?.createdAtMs).toBe(NOW - 7_000);
		expect(snapshot.reservations).toEqual([
			{ path: "src/auth/**", agentId: "SwiftTiger", taskId: "task-1", leaseUntilMs: NOW + 60_000 },
		]);

		// The read side of a message: only a stamped `read_at` counts as read.
		const read = new Map(readSnapshot(fixture, { feedLimit: 3 }).messages.map((message) => [message.content, message.read]));
		expect(read.get("message 1")).toBe(true);
		expect(read.get("message 2")).toBe(false);
	});

	test("feedLimit 0 empties the feeds without dropping the rest of the snapshot", () => {
		const fixture = makeFixtureDb();
		insertBoardEntry(fixture.db, { type: "FACT", agentId: "main", content: "x", createdAt: NOW });
		insertTask(fixture.db, { id: "task-1", createdAt: NOW });

		const snapshot = readSnapshot(fixture, { feedLimit: 0 });
		expect(snapshot.board).toEqual([]);
		expect(snapshot.messages).toEqual([]);
		expect(snapshot.events).toEqual([]);
		expect(snapshot.feed).toEqual({ limit: 0 });
		expect(snapshot.tasks).toHaveLength(1);
	});

	test("the task list is capped at TASK_LIMIT and ordered priority DESC then creation ASC", () => {
		const fixture = makeFixtureDb();
		const { db } = fixture;
		db.exec("BEGIN IMMEDIATE");
		for (let i = 1; i <= TASK_LIMIT + 5; i++) {
			insertTask(db, { id: `task-${i}`, status: "done", priority: 0, createdAt: NOW + i });
		}
		insertTask(db, { id: "task-priority", status: "done", priority: 9, createdAt: NOW + TASK_LIMIT + 6 });
		db.exec("COMMIT");

		const tasks = readSnapshot(fixture).tasks;
		expect(tasks).toHaveLength(TASK_LIMIT);
		expect(tasks[0]?.id).toBe("task-priority");
		expect(tasks[1]?.id).toBe("task-1");
	});
});

describe("change summary", () => {
	test("the hash is stable while nothing changes and moves when it does", () => {
		const fixture = makeFixtureDb();
		insertTask(fixture.db, { id: "task-1", status: "ready", createdAt: NOW });

		const first = readSummary(fixture);
		expect(readSummary(fixture, NOW + 1_000).hash).toBe(first.hash);
		expect(first.counts.ready).toBe(1);

		insertBoardEntry(fixture.db, { type: "DECISION", agentId: "main", content: "later", createdAt: NOW + 2_000 });
		const second = readSummary(fixture, NOW + 2_000);
		expect(second.hash).not.toBe(first.hash);

		insertTask(fixture.db, { id: "task-2", status: "done", createdAt: NOW + 3_000 });
		const third = readSummary(fixture, NOW + 3_000);
		expect(third.counts).toMatchObject({ ready: 1, done: 1, total: 2 });
		expect(new Set([first.hash, second.hash, third.hash]).size).toBe(3);
	});
});

describe("read-only guarantee", () => {
	test("a readonly connection refuses a write with the sqlite error", () => {
		const fixture = makeFixtureDb();
		fixture.close();
		const readonly = new Database(fixture.path, { readonly: true });
		expect(() =>
			readonly.run("INSERT INTO board (type, agent_id, content, tags, files, created_at) VALUES ('FACT','x','y','[]','[]',1)"),
		).toThrow(/readonly/i);
		readonly.close();
	});

	test("reading a WAL database left by a closed writer changes no bytes and adds no unexpected file", () => {
		const fixture = makeFixtureDb();
		insertTask(fixture.db, { id: "task-1", status: "ready", createdAt: NOW });
		fixture.close();

		const dir = join(fixture.path, "..");
		const bytesBefore = readFileSync(fixture.path);
		const filesBefore = readdirSync(dir).sort();

		const db = openReadonlyDb(fixture.path);
		const snapshot = buildSnapshot(db, { now: NOW, swarmRoot: fixture.root });
		db.close();

		expect(snapshot.counts.ready).toBe(1);
		expect(readFileSync(fixture.path).equals(bytesBefore)).toBe(true);
		// SQLite attaches its standard WAL siblings (`-wal`/`-shm`) even for a read-only connection;
		// the same two files the live writer maintains. Anything else appearing, or any file
		// disappearing, would be a real surprise.
		const after = readdirSync(dir).sort();
		expect(filesBefore.filter((name) => !after.includes(name))).toEqual([]);
		expect(after.filter((name) => name !== "swarm.db-wal" && name !== "swarm.db-shm" && !filesBefore.includes(name))).toEqual([]);
	});
});
