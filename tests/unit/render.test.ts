import { describe, expect, test } from "bun:test";
import { renderAgents, renderPanel, renderSummary, renderTasks } from "../../extension/render";
import type { StatusSnapshot } from "../../extension/store";
import type { SwarmAgent, SwarmTask } from "../../extension/types";

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function makeTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
	return {
		id: "task-1",
		title: "do the thing",
		description: "",
		status: "ready",
		priority: 1,
		createdBy: "main",
		createdAt: NOW - 10 * MINUTE,
		updatedAt: NOW - 10 * MINUTE,
		dependencies: [],
		requiredCapabilities: [],
		files: [],
		review: { required: false },
		attempts: 0,
		...overrides,
	};
}

function makeAgent(overrides: Partial<SwarmAgent> = {}): SwarmAgent {
	return {
		id: "SwiftTiger",
		role: "general",
		status: "working",
		capabilities: ["general"],
		joinedAt: NOW - MINUTE,
		heartbeatAt: NOW - 5 * SECOND,
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		now: NOW,
		running: true,
		agents: [],
		counts: { ready: 0, claimed: 0, blocked: 0, review: 0, done: 0, failed: 0 },
		board: {},
		claimable: 0,
		inFlight: [],
		recentDone: [],
		...overrides,
	};
}

describe("renderPanel", () => {
	test("a working agent shows its task id and the age of its claim", () => {
		const snapshot = makeSnapshot({
			agents: [makeAgent({ currentTask: "task-17" })],
			inFlight: [makeTask({ id: "task-17", status: "claimed", claimedBy: "SwiftTiger", claimedAt: NOW - 3 * MINUTE })],
		});
		const lines = renderPanel(snapshot);
		expect(lines[1]).toContain("task-17 3m");
		expect(lines[1]).toContain("hb 5s");
	});

	test("an agent with no live claim shows '-' - no task, or a pointer to a task it does not hold", () => {
		const withoutTask = renderPanel(makeSnapshot({ agents: [makeAgent({ status: "idle" })] }));
		expect(withoutTask[1]).toContain(" - (hb 5s)");

		const stalePointer = renderPanel(makeSnapshot({ agents: [makeAgent({ status: "idle", currentTask: "task-17" })] }));
		expect(stalePointer[1]).toContain(" - (hb 5s)");
		expect(stalePointer[1]).not.toContain("task-17");
	});

	test("keeps the counts line and the board histogram, and collapses agents past five", () => {
		const agents = Array.from({ length: 7 }, (_, i) => makeAgent({ id: `agent-${i}`, status: "idle" }));
		const lines = renderPanel(
			makeSnapshot({
				agents,
				counts: { ready: 2, claimed: 1, blocked: 0, review: 0, done: 3, failed: 0 },
				board: { FACT: 3, FAIL: 1 },
			}),
		);
		expect(lines).toContain(" … 2 more");
		expect(lines.some((l) => l.includes("READY 2") && l.includes("CLAIMED 1") && l.includes("DONE 3"))).toBe(true);
		expect(lines.at(-1)).toBe(" BOARD FACT 3  FAIL 1");
	});

	test("never exceeds maxLines", () => {
		const agents = Array.from({ length: 9 }, (_, i) => makeAgent({ id: `agent-${i}` }));
		expect(renderPanel(makeSnapshot({ agents }), 3).length).toBe(3);
		expect(renderPanel(makeSnapshot({ agents }), 0).length).toBe(0);
	});
});

describe("renderTasks", () => {
	test("a claimed task shows attempts and the claim age", () => {
		const row = renderTasks(
			[makeTask({ id: "task-2", status: "claimed", claimedBy: "SwiftTiger", claimedAt: NOW - 3 * MINUTE, attempts: 2 })],
			NOW,
		);
		expect(row).toContain("[att=2 run=3m]");
	});

	test("an unclaimed task carries no claim block", () => {
		const row = renderTasks([makeTask({ status: "ready", attempts: 2 })], NOW);
		expect(row).not.toContain("att=");
		expect(row).not.toContain("run=");
	});

	test("a long title is truncated with an ellipsis", () => {
		const row = renderTasks([makeTask({ title: "x".repeat(80) })], NOW);
		expect(row).toContain("…");
		expect(row).not.toContain("x".repeat(46));
	});

	test("empty input reads as a sentence", () => {
		expect(renderTasks([], NOW)).toBe("No tasks.");
		expect(renderAgents([], NOW)).toBe("No agents registered. Start a swarm with /swarm start.");
	});
});

describe("age formatting", () => {
	test("steps across the s/m/h boundaries", () => {
		const at = (seconds: number) => renderAgents([makeAgent({ heartbeatAt: NOW - seconds * SECOND })], NOW);
		expect(at(0)).toContain("hb=0s");
		expect(at(59)).toContain("hb=59s");
		expect(at(60)).toContain("hb=1m");
		expect(at(59 * 60)).toContain("hb=59m");
		expect(at(60 * 60)).toContain("hb=1h");
	});
});

describe("renderSummary", () => {
	test("lists each in-flight task with owner, attempts, elapsed and claim age", () => {
		const summary = renderSummary(
			makeSnapshot({
				counts: { ready: 0, claimed: 1, blocked: 0, review: 0, done: 0, failed: 0 },
				inFlight: [
					makeTask({
						id: "task-17",
						status: "claimed",
						claimedBy: "SwiftTiger",
						createdAt: NOW - 12 * MINUTE,
						claimedAt: NOW - 3 * MINUTE,
						attempts: 2,
					}),
				],
			}),
		);
		expect(summary).toContain("in flight:");
		expect(summary).toContain("task-17 claimed owner=SwiftTiger attempts=2 elapsed=12m claimed=3m");
		expect(summary).toContain("total tasks: ready 0, claimed 1, review 0, blocked 0, done 0, failed 0");
	});

	test("caps the in-flight list at five and counts the rest", () => {
		const inFlight = Array.from({ length: 7 }, (_, i) =>
			makeTask({ id: `task-${i}`, status: "claimed", claimedBy: "A", claimedAt: NOW - MINUTE }),
		);
		const summary = renderSummary(makeSnapshot({ inFlight }));
		expect(summary).toContain(" … 2 more");
	});

	test("reports done work over the window the snapshot proves", () => {
		const fromClaims = renderSummary(
			makeSnapshot({
				counts: { ready: 0, claimed: 1, blocked: 0, review: 0, done: 3, failed: 0 },
				inFlight: [makeTask({ id: "task-17", status: "claimed", claimedBy: "A", claimedAt: NOW - 12 * MINUTE })],
			}),
		);
		expect(fromClaims).toContain("throughput done 3 in 12m");

		const fromAgents = renderSummary(
			makeSnapshot({ counts: { ready: 0, claimed: 0, blocked: 0, review: 0, done: 3, failed: 0 }, agents: [makeAgent({ joinedAt: NOW - 12 * MINUTE })] }),
		);
		expect(fromAgents).toContain("throughput done 3 in 12m");

		const oldestWins = renderSummary(
			makeSnapshot({
				counts: { ready: 0, claimed: 1, blocked: 0, review: 0, done: 3, failed: 0 },
				agents: [makeAgent({ joinedAt: NOW - 20 * MINUTE })],
				inFlight: [makeTask({ id: "task-17", status: "claimed", claimedBy: "A", claimedAt: NOW - 12 * MINUTE })],
			}),
		);
		expect(oldestWins).toContain("throughput done 3 in 20m");
	});

	test("drops the window instead of inventing one when nothing is observable", () => {
		const summary = renderSummary(makeSnapshot({ counts: { ready: 0, claimed: 0, blocked: 0, review: 0, done: 2, failed: 0 } }));
		expect(summary).toContain("throughput done 2");
		expect(summary).not.toContain(" in ");
	});

	test("pairs the completion count with the window their own timestamps prove", () => {
		const summary = renderSummary(
			makeSnapshot({
				counts: { ready: 0, claimed: 1, blocked: 0, review: 0, done: 3, failed: 0 },
				agents: [makeAgent({ joinedAt: NOW - 60 * MINUTE })],
				inFlight: [makeTask({ id: "task-17", status: "claimed", claimedBy: "A", claimedAt: NOW - 3 * MINUTE })],
				recentDone: [
					makeTask({ id: "task-11", status: "done", updatedAt: NOW - 5 * MINUTE }),
					makeTask({ id: "task-12", status: "done", updatedAt: NOW - 12 * MINUTE }),
				],
			}),
		);
		// the completions on hand over their own oldest entry, not the 3m claim nor the hour-old join
		expect(summary).toContain("throughput done 2 in 12m");
		expect(summary).not.toContain("throughput done 3");
	});

	test("counts the completions the snapshot carries, not the lifetime total", () => {
		const summary = renderSummary(
			makeSnapshot({
				counts: { ready: 0, claimed: 0, blocked: 0, review: 0, done: 200, failed: 0 },
				recentDone: [makeTask({ id: "task-9", status: "done", updatedAt: NOW - 5 * MINUTE })],
			}),
		);
		expect(summary).toContain("throughput done 1 in 5m");
	});
});
