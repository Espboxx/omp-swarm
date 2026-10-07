/**
 * The stranded-row surfacer: goal-14 clause 2 ("别让静默成为默认") in the page's own DOM... in the
 * module's own pure functions.
 *
 * What the goal's acceptance names, each pinned here:
 *   1. a stranded condition is reported with how long it has been stuck, what is missing, and a
 *      ranked repair path;
 *   2. the same condition posts ONCE, not once per tick (the controller ticks every 2s);
 *   3. a CHANGED condition (a row stranded, a row rescued, a capability added) posts again;
 *   4. nothing is posted when the pool is healthy — no stranded rows, or a capable agent exists;
 *   5. the repair advice keeps the operator path as the OPERATOR's, never as an agent's write;
 *   6. the ages come from the caller's clock and the rows' own createdAtMs, so a test is invariant.
 */
import { describe, expect, test } from "bun:test";
import { findStarvation } from "../../extension/starvation";
import { postStrandedNotice, strandedNotice, type StrandedBoardPost } from "../../extension/stranded";
import type { BlackboardEntry, SwarmAgent, SwarmTask } from "../../extension/types";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A task row in the shape the surfacer reads: createdAtMs is the only time it needs. */
function task(id: string, caps: string[], createdAtMs: number, title = `row ${id}`): SwarmTask {
	return {
		id,
		title,
		description: "",
		status: "ready",
		priority: 0,
		createdBy: "probe",
		createdAt: createdAtMs,
		updatedAt: createdAtMs,
		dependencies: [],
		requiredCapabilities: caps,
		files: [],
		review: { required: false },
	} as unknown as SwarmTask;
}

const agent = (id: string, capabilities: string[]): SwarmAgent =>
	({ id, capabilities, role: "general", status: "online", heartbeatAt: NOW, joinedAt: NOW }) as unknown as SwarmAgent;

const agesOf = (tasks: SwarmTask[]): Map<string, { createdAt: number; title: string }> =>
	new Map(tasks.map((t) => [t.id, { createdAt: t.createdAt, title: t.title }]));

describe("a stranded condition is reported with age, cause and remedy", () => {
	test("the entry names the row, how long it has been stranded, and what is missing", () => {
		// task-221 was created 137 minutes before now — the real shape of this pool's strand.
		const rows = [task("task-221", ["reviewer"], NOW - 137 * MINUTE)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 });
		expect(report).toBeDefined();
		const notice = strandedNotice(report!, agesOf(rows), NOW, undefined);
		expect(notice).toBeDefined();
		expect(notice!.oldestMinutes).toBe(137);
		expect(notice!.rows[0]!.missing).toEqual(["reviewer"]);
		const content = notice!.entry!.content;
		expect(content).toContain("task-221");
		expect(content).toContain("stranded 2 h 17 min");
		expect(content).toContain("nobody online holds reviewer");
		expect(content).toContain("Repair paths, cheapest first");
	});

	test("the remedy list is ordered cheapest-first and names the operator path as the operator's", () => {
		const rows = [task("t1", ["reviewer"], NOW - 5 * MINUTE)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const content = strandedNotice(report, agesOf(rows), NOW, undefined)!.entry!.content;
		const refile = content.indexOf("RE-FILE");
		const addRole = content.indexOf("ADD the capability");
		const repair = content.indexOf("REPAIR the existing row");
		expect(refile).toBeGreaterThanOrEqual(0);
		expect(addRole).toBeGreaterThan(refile);
		expect(repair).toBeGreaterThan(addRole);
		// The operator path is explicit that it is NOT an agent's decision.
		expect(content).toContain("OPERATOR's decision, not an agent's");
		expect(content).toContain("DECISION #1076");
	});

	test("the entry carries the tags a later reader can query by", () => {
		const rows = [task("t1", ["reviewer"], NOW)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		expect(strandedNotice(report, agesOf(rows), NOW, undefined)!.entry!.tags).toEqual(["stranded", "capability-gate", "needs-repair"]);
	});
});

describe("one condition posts once, a changed condition posts again", () => {
	test("the same stranded key is silent on the next tick", () => {
		const rows = [task("t1", ["reviewer"], NOW - 10 * MINUTE)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const first = strandedNotice(report, agesOf(rows), NOW, undefined);
		expect(first).toBeDefined();
		const second = strandedNotice(report, agesOf(rows), NOW + 2_000, first!.key);
		expect(second).toBeUndefined();
	});

	test("a NEWLY stranded row is a different key, so it reports", () => {
		const before = [task("t1", ["reviewer"], NOW - 10 * MINUTE)];
		const reportA = findStarvation({ ready: before, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const first = strandedNotice(reportA, agesOf(before), NOW, undefined)!;
		const after = [...before, task("t2", ["reviewer"], NOW - 1 * MINUTE)];
		const reportB = findStarvation({ ready: after, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const second = strandedNotice(reportB, agesOf(after), NOW, first.key);
		expect(second).toBeDefined();
		expect(second!.rows.map((r) => r.id)).toEqual(["t1", "t2"]);
	});

	test("a rescued row is a different key too, so the pool learns the strand shrank", () => {
		const two = [task("t1", ["reviewer"], NOW), task("t2", ["reviewer"], NOW)];
		const full = findStarvation({ ready: two, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const posted = strandedNotice(full, agesOf(two), NOW, undefined)!;
		const one = [task("t2", ["reviewer"], NOW)];
		const shrunk = findStarvation({ ready: one, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const again = strandedNotice(shrunk, agesOf(one), NOW, posted.key);
		expect(again?.rows.map((r) => r.id)).toEqual(["t2"]);
	});

	test("a healthy pool posts nothing at all", () => {
		expect(findStarvation({ ready: [], agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })).toBeUndefined();
		const claimable = [task("t1", ["general"], NOW)];
		expect(findStarvation({ ready: claimable, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })).toBeUndefined();
		// A caps=[] row is claimable by anybody online: queueing, not starvation.
		const open = [task("t2", [], NOW)];
		expect(findStarvation({ ready: open, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })).toBeUndefined();
	});

	test("postStrandedNotice writes exactly one entry and returns it, and nothing the second time", () => {
		const rows = [task("t1", ["reviewer"], NOW - 3 * MINUTE)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const posted: StrandedBoardPost[] = [];
		const post = (entry: StrandedBoardPost): BlackboardEntry => {
			posted.push(entry);
			return { id: posted.length, agentId: entry.agentId, content: entry.content, tags: entry.tags, type: entry.type, createdAt: NOW, files: [] };
		};
		const first = postStrandedNotice(report, agesOf(rows), NOW, undefined, post, "w1");
		expect(first).toBeDefined();
		expect(posted).toHaveLength(1);
		expect(posted[0]!.agentId).toBe("w1");
		const second = postStrandedNotice(report, agesOf(rows), NOW + 2_000, first!.notice.key, post, "w1");
		expect(second).toBeUndefined();
		expect(posted).toHaveLength(1);
	});

	test("an unknown row (no createdAt in the ages map) reads as 0 minutes rather than inventing one", () => {
		const rows = [task("ghost", ["reviewer"], NOW - 99 * MINUTE)];
		const report = findStarvation({ ready: rows, agents: [agent("w1", ["general"])], now: NOW, offlineAfterMs: 60_000 })!;
		const notice = strandedNotice(report, new Map(), NOW, undefined)!;
		expect(notice.rows[0]!.ageMinutes).toBe(0);
		expect(notice.oldestMinutes).toBe(0);
		expect(notice.entry!.content).toContain("under a minute");
	});
});

describe("the combination strand (caps exist, never on one agent)", () => {
	test("a row needing A+B together reports the combination, not a phantom missing capability", () => {
		const rows = [task("t1", ["reviewer", "integrator"], NOW - 7 * MINUTE)];
		const agents = [agent("w1", ["reviewer", "general"]), agent("w2", ["integrator", "general"])];
		const report = findStarvation({ ready: rows, agents, now: NOW, offlineAfterMs: 60_000 })!;
		const notice = strandedNotice(report, agesOf(rows), NOW, undefined)!;
		// Neither capability is missing from the POOL; the strand is that no ONE agent holds both.
		expect(notice.rows[0]!.missing).toEqual([]);
		expect(notice.entry!.content).toContain("no single online agent holds them all");
	});
});
