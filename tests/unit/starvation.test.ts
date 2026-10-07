import { describe, expect, test } from "bun:test";
import { findStarvation } from "../../extension/starvation";
import type { AgentStatus, SwarmAgent, SwarmTask } from "../../extension/types";

const NOW = 1_700_000_000_000;
const WINDOW = 60_000;

function task(overrides: Partial<SwarmTask> & { id: string }): SwarmTask {
	return {
		title: overrides.id,
		description: "",
		status: "ready",
		priority: 0,
		createdBy: "main",
		createdAt: NOW - 1_000,
		updatedAt: NOW - 1_000,
		dependencies: [],
		requiredCapabilities: [],
		files: [],
		review: { required: false },
		attempts: 0,
		...overrides,
	};
}

function agent(id: string, capabilities: string[], overrides: Partial<SwarmAgent> = {}): SwarmAgent {
	return {
		id,
		role: capabilities[0] ?? "general",
		status: "idle" as AgentStatus,
		capabilities,
		joinedAt: NOW - 600_000,
		heartbeatAt: NOW - 1_000,
		...overrides,
	};
}

const find = (ready: SwarmTask[], agents: SwarmAgent[], now = NOW) =>
	findStarvation({ ready, agents, now, offlineAfterMs: WINDOW });

describe("starvation detection", () => {
	test("a ready row demanding a capability no online agent holds is reported", () => {
		const report = find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], [agent("SwiftTiger", ["general"]), agent("CalmTiger", ["general"])]);
		expect(report).toBeDefined();
		expect(report?.missing).toEqual(["reviewer"]);
		expect(report?.online).toBe(2);
		expect(report?.rows).toEqual([
			{ id: "task-95", requiredCapabilities: ["reviewer"], missing: ["reviewer"], why: "nobody online holds reviewer" },
		]);
	});

	test("a capable but BUSY agent is queueing, not starvation", () => {
		const busy = agent("VividTiger", ["reviewer", "general"], { status: "working" as AgentStatus });
		expect(find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], [busy, agent("SwiftTiger", ["general"])])).toBeUndefined();
	});

	test("an OFFLINE agent does not count as capable, even when it holds the capability", () => {
		const offline = agent("VividTiger", ["reviewer", "general"], { status: "offline" as AgentStatus });
		const report = find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], [offline, agent("SwiftTiger", ["general"])]);
		expect(report?.missing).toEqual(["reviewer"]);
		expect(report?.online).toBe(1);
	});

	test("a stale heartbeat makes an agent offline for this decision", () => {
		const stale = agent("VividTiger", ["reviewer"], { heartbeatAt: NOW - WINDOW - 1 });
		const report = find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], [stale]);
		expect(report).toBeDefined();
		expect(report?.online).toBe(0);
	});

	test("with no online agent at all, ready work is reported and named as unroutable", () => {
		const report = find([task({ id: "task-1" })], [agent("Ghost", ["general"], { status: "offline" as AgentStatus })]);
		expect(report?.online).toBe(0);
		expect(report?.missing).toEqual([]);
		expect(report?.rows.map((row) => row.id)).toEqual(["task-1"]);
	});

	test("one claimable row among unclaimable ones is queueing, not starvation", () => {
		const ready = [task({ id: "task-95", requiredCapabilities: ["reviewer"] }), task({ id: "task-100", requiredCapabilities: ["general"] })];
		expect(find(ready, [agent("SwiftTiger", ["general"])])).toBeUndefined();
	});

	test("a row needing two capabilities is unclaimable when no SINGLE agent holds both", () => {
		const ready = [task({ id: "task-77", requiredCapabilities: ["reviewer", "integrator"] })];
		const report = find(ready, [agent("VividTiger", ["reviewer"]), agent("SwiftTiger", ["integrator"])]);
		expect(report).toBeDefined();
		// Both capabilities exist in the pool, so nothing is "missing" — the row is unroutable because no
		// ONE agent holds them together, which is what the reason has to say.
		expect(report?.missing).toEqual([]);
		expect(report?.rows[0]?.why).toContain("together");
		expect(report?.rows[0]?.requiredCapabilities).toEqual(["reviewer", "integrator"]);
	});

	test("a pool that has registered no agent at all is assembly, not starvation", () => {
		expect(find([task({ id: "task-1", requiredCapabilities: ["reviewer"] })], [])).toBeUndefined();
	});

	test("nothing ready is never a report", () => {
		expect(find([], [agent("SwiftTiger", ["general"])])).toBeUndefined();
	});

	test("an ordinary pool with a capable idle agent stays silent (regression)", () => {
		expect(find([task({ id: "task-1", requiredCapabilities: ["general"] })], [agent("SwiftTiger", ["general"])])).toBeUndefined();
	});

	test("the key is stable for the same condition and changes with the row set", () => {
		const agents = [agent("SwiftTiger", ["general"])];
		const first = find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], agents);
		const again = find([task({ id: "task-95", requiredCapabilities: ["reviewer"] })], agents);
		expect(again?.key).toBe(first?.key ?? "missing");
		const other = find([task({ id: "task-103", requiredCapabilities: ["reviewer"] })], agents);
		expect(other?.key).not.toBe(first?.key);
		// Order of the ready rows must not change the identity of the condition.
		const reversed = find(
			[task({ id: "task-103", requiredCapabilities: ["reviewer"] }), task({ id: "task-95", requiredCapabilities: ["reviewer"] })],
			agents,
		);
		const forward = find(
			[task({ id: "task-95", requiredCapabilities: ["reviewer"] }), task({ id: "task-103", requiredCapabilities: ["reviewer"] })],
			agents,
		);
		expect(reversed?.key).toBe(forward?.key);
	});

	test("the condition clears when a capable agent comes online", () => {
		const ready = [task({ id: "task-95", requiredCapabilities: ["reviewer"] })];
		expect(find(ready, [agent("SwiftTiger", ["general"])])).toBeDefined();
		expect(find(ready, [agent("SwiftTiger", ["general"]), agent("VividTiger", ["reviewer"])])).toBeUndefined();
	});
});
