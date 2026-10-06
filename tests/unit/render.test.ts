import { describe, expect, test } from "bun:test";
import {
	drainSummaryLines,
	drainSummaryTitle,
	fitSummaryLines,
	progressBar,
	progressLine,
	renderAgents,
	renderPanel,
	renderSummary,
	renderTasks,
} from "../../extension/render";
import type { DrainSummary } from "../../extension/render";
import type { StatusSnapshot } from "../../extension/store";
import type { SwarmAgent, SwarmTask, TaskCounts } from "../../extension/types";

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

function counts(overrides: Partial<TaskCounts> = {}): TaskCounts {
	return { ready: 0, claimed: 0, blocked: 0, review: 0, done: 0, failed: 0, ...overrides };
}

function drain(overrides: Partial<DrainSummary> = {}): DrainSummary {
	return { counts: counts({ done: 1 }), elapsedMs: 0, agents: 1, tasks: [], ...overrides };
}

describe("progressBar", () => {
	test("fills the finished half and leaves the rest light", () => {
		expect(progressBar(counts({ done: 5, ready: 5 }), 10)).toBe("█████░░░░░");
		expect(progressBar(counts({ done: 7, failed: 1, ready: 1 }), 10)).toBe("█████████░");
		expect(progressBar(counts({ claimed: 2, ready: 2 }), 4)).toBe("░░░░");
	});

	test("reaches the end only when every actionable task is finished", () => {
		expect(progressBar(counts({ done: 7, failed: 2 }), 4)).toBe("████");
		expect(progressBar(counts({ done: 1, ready: 1 }), 4)).toBe("██░░");
	});

	test("ignores the permanently-blocked residue that would hold the bar short of the end", () => {
		// 1 finished of 2 actionable - the six blocked tasks are not part of the denominator
		expect(progressBar(counts({ done: 1, ready: 1, blocked: 6 }), 10)).toBe("█████░░░░░");
	});

	test("renders nothing without actionable work or without room", () => {
		expect(progressBar(counts({ blocked: 6 }), 10)).toBe("");
		expect(progressBar(counts({ done: 3 }), 0)).toBe("");
		expect(progressBar(counts({ done: 3 }), -3)).toBe("");
	});
});

describe("progressLine", () => {
	test("reads 0% with the ready work named", () => {
		expect(progressLine(counts({ ready: 3 }))).toBe("TASKS 0/3 · 3 ready · 0%");
	});

	test("counts claimed and review as running, blocked separately, finished over actionable", () => {
		// 7 finished + 1 running + 1 ready = 9 actionable; the blocked task is excluded from it
		expect(progressLine(counts({ claimed: 1, done: 6, failed: 1, ready: 1, blocked: 1 }))).toBe(
			"TASKS 7/9 · 1 running · 1 ready · 1 blocked · 78%",
		);
		expect(progressLine(counts({ claimed: 1, done: 6, failed: 1 }))).toBe("TASKS 7/8 · 1 running · 88%");
		expect(progressLine(counts({ review: 1, done: 1, ready: 1 }))).toBe("TASKS 1/3 · 1 running · 1 ready · 33%");
	});

	test("counts a failure as finished work", () => {
		expect(progressLine(counts({ failed: 1 }))).toBe("TASKS 1/1 · 100%");
		expect(progressLine(counts({ done: 9 }))).toBe("TASKS 9/9 · 100%");
	});

	test("an empty actionable pool reads as a sentence, blocked or not", () => {
		expect(progressLine(counts())).toBe("TASKS - · no tasks");
		expect(progressLine(counts({ blocked: 6 }))).toBe("TASKS - · no tasks");
	});
});

describe("drainSummaryTitle", () => {
	test("carries the done/failed split, the agents, the compact elapsed and the cost", () => {
		expect(
			drainSummaryTitle({ counts: counts({ done: 7, failed: 2 }), elapsedMs: 12 * MINUTE + 40 * SECOND, agents: 3, costUsd: 0.42, tasks: [] }),
		).toBe("SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42");
	});

	test("drops the failed half at zero and omits an unknown cost instead of faking one", () => {
		expect(drainSummaryTitle(drain({ counts: counts({ done: 9 }), elapsedMs: 45 * SECOND, agents: 2, tasks: [] }))).toBe(
			"SWARM DONE · 9/9 tasks (9 done) · 2 agents · 45s",
		);
		expect(drainSummaryTitle(drain({ costUsd: undefined }))).not.toContain("$");
	});

	test("compacts the hour boundary and keeps the blocked residue out of the denominator", () => {
		expect(drainSummaryTitle(drain({ elapsedMs: 66 * MINUTE }))).toContain(" · 1h06m");
		expect(drainSummaryTitle(drain({ counts: counts({ done: 5, blocked: 6 }) }))).toContain("5/5 tasks");
	});
});

describe("drainSummaryLines", () => {
	test("leads with the title and orders the tasks by their numeric id", () => {
		const summary = drain({
			tasks: [
				{ id: "task-10", title: "second", status: "done" },
				{ id: "task-2", title: "first", status: "done" },
			],
		});
		const lines = drainSummaryLines(summary, { width: 120 });
		expect(lines[0]).toBe(drainSummaryTitle(summary));
		expect(lines[1]).toContain("task-2 first");
		expect(lines[2]).toContain("task-10 second");
	});

	test("prints who finished a task and how long it took, and omits what is unknown", () => {
		const lines = drainSummaryLines(
			drain({
				tasks: [
					{ id: "task-30", title: "fix the panel", status: "done", agent: "SwiftTiger", durationMs: 12 * MINUTE + 40 * SECOND },
					{ id: "task-31", title: "build the page", status: "done", durationMs: 45 * SECOND },
					{ id: "task-32", title: "no detail", status: "done" },
				],
			}),
			{ width: 120 },
		);
		expect(lines[1]).toBe("  v task-30 fix the panel (SwiftTiger · 12m40s)");
		expect(lines[2]).toBe("  v task-31 build the page (45s)");
		expect(lines[3]).toBe("  v task-32 no detail");
		expect(lines.join("\n")).not.toContain("undefined");
		expect(lines.join("\n")).not.toContain("()");
	});

	test("prints a failure with its reason, and says only that it failed when there is none", () => {
		const lines = drainSummaryLines(
			drain({
				tasks: [
					{ id: "task-31", title: "build the page", status: "failed", reason: "typecheck: missing export" },
					{ id: "task-32", title: "silent failure", status: "failed" },
				],
			}),
			{ width: 120 },
		);
		expect(lines[1]).toBe("  x task-31 build the page (failed: typecheck: missing export)");
		expect(lines[2]).toBe("  x task-32 silent failure (failed)");
	});

	test("caps the list at eight tasks and counts the rest", () => {
		const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i + 1}`, title: `job ${i + 1}`, status: "done" as const }));
		const lines = drainSummaryLines(drain({ tasks }), { width: 120 });
		expect(lines.length).toBe(10); // title + 8 tasks + the tail
		expect(lines.at(-1)).toBe("  … +2 more");
		expect(lines[8]).toContain("task-8");
		expect(lines.join("\n")).not.toContain("job 9");
	});

	test("fits every line to the width by clipping the title only", () => {
		const task = { id: "task-30", title: "x".repeat(200), status: "done" as const, agent: "SwiftTiger", durationMs: 3 * MINUTE };
		for (const width of [80, 120]) {
			const lines = drainSummaryLines(drain({ tasks: [task] }), { width });
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\t");
			}
			expect(lines[1]).toContain("(SwiftTiger · 3m)");
			expect(lines[1]).toContain("…");
		}
		expect(drainSummaryLines(drain({ tasks: [task] }), { width: 80 })[1].length).toBe(80);
	});

	test("keeps the id separated by one space and still marks a clipped title at tight widths", () => {
		const task = {
			id: "task-26",
			title: "Build the pure split-page layout module (left rail geometry + hit testing)",
			status: "failed" as const,
			reason: "superseded by the operator rollback; no code change made",
		};
		for (const width of [40, 50, 60, 70, 80]) {
			const line = drainSummaryLines(drain({ tasks: [task] }), { width })[1];
			expect(line.length).toBeLessThanOrEqual(width);
			expect(line.startsWith("  x task-26 …")).toBe(true);
			expect(line.slice(0, 12)).toBe("  x task-26 ");
			expect(line[12]).toBe("…"); // the title slot is never dropped, only clipped
			expect(line).not.toMatch(/\s{2}\(/);
		}
	});

	test("clipping a wide title never leaves half a character behind", () => {
		const task = { id: "task-30", title: "🎬 场景".repeat(40), status: "done" as const, agent: "A", durationMs: 1000 };
		const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		for (let width = 12; width <= 100; width += 1) {
			for (const line of drainSummaryLines(drain({ tasks: [task] }), { width })) {
				expect(line.length).toBeLessThanOrEqual(width);
				expect(lone.test(line)).toBe(false);
			}
		}
	});
});

describe("fitSummaryLines", () => {
	const marker = (taskCount: number): string[] =>
		drainSummaryLines(
			drain({
				tasks: Array.from({ length: taskCount }, (_, index) => ({
					id: `task-${index + 1}`,
					title: `work ${index + 1}`,
					status: "done" as const,
					agent: "SwiftTiger",
					durationMs: MINUTE,
				})),
			}),
			{ width: 120 },
		);

	test("hands an already-fitting block back untouched, tail and all", () => {
		const block = marker(3); // headline + 3 task lines
		expect(block).toHaveLength(4);
		expect(fitSummaryLines(block, 10)).toEqual(block);
		expect(fitSummaryLines(block, 4)).toEqual(block);
		// A copy, so a later repaint cannot mutate the stored marker.
		const fitted = fitSummaryLines(block, 10);
		fitted.push("x");
		expect(block).toHaveLength(4);
	});

	test("returns nothing when no line fits or the block is empty", () => {
		expect(fitSummaryLines(marker(3), 0)).toEqual([]);
		expect(fitSummaryLines(marker(3), -4)).toEqual([]);
		expect(fitSummaryLines([], 5)).toEqual([]);
	});

	test("keeps only the headline when a single line fits", () => {
		expect(fitSummaryLines(marker(3), 1)).toEqual([drainSummaryTitle(drain({ tasks: [] }))]);
	});

	test("spends the room on the headline, the task lines and a recomputed tail", () => {
		const block = marker(5); // headline + 5 task lines
		expect(block).toHaveLength(6);
		expect(fitSummaryLines(block, 2)).toEqual([block[0] as string, "  … +5 more"]);
		expect(fitSummaryLines(block, 3)).toEqual([block[0] as string, block[1] as string, "  … +4 more"]);
		expect(fitSummaryLines(block, 5)).toEqual([block[0] as string, block[1] as string, block[2] as string, block[3] as string, "  … +2 more"]);
	});

	test("absorbs the tail the block already carried instead of dropping its count", () => {
		const block = marker(12); // headline + 8 task lines + "… +4 more"
		expect(block).toHaveLength(10);
		expect(block[9]).toBe("  … +4 more");
		const fitted = fitSummaryLines(block, 4);
		expect(fitted).toHaveLength(4);
		expect(fitted[0]).toBe(block[0] as string);
		expect(fitted[1]).toBe(block[1] as string);
		expect(fitted[2]).toBe(block[2] as string);
		expect(fitted[3]).toBe("  … +10 more"); // 12 tasks, 2 shown
	});

	test("reports exactly the hidden task count when it truncates", () => {
		const block = marker(4); // headline + 4 task lines
		expect(block).toHaveLength(5);
		const fitted = fitSummaryLines(block, 3);
		expect(fitted).toEqual([block[0] as string, block[1] as string, "  … +3 more"]);
		// A block that fits is never given a tail (see the pass-through case above).
		expect(fitSummaryLines(block, 5)).toEqual(block);
	});

	test("floors a fractional budget and never returns more lines than the room", () => {
		const block = marker(12);
		for (let room = 0; room <= 10; room += 0.5) {
			const fitted = fitSummaryLines(block, room);
			expect(fitted.length).toBeLessThanOrEqual(Math.max(0, Math.floor(room)));
		}
		expect(fitSummaryLines(block, 3.9)).toHaveLength(3);
		// The real widget budget: 4 workers + auto header + run line + counters + BOARD leaves 2.
		const widgetRoom = 10 - 1 - (1 + 4 + 2);
		expect(widgetRoom).toBe(2);
		const inWidget = fitSummaryLines(block, widgetRoom);
		expect(inWidget).toHaveLength(2);
		expect(inWidget[1]).toBe("  … +12 more"); // 12 tasks, none shown
	});

	test("keeps every fitted line tab-free", () => {
		for (const line of fitSummaryLines(marker(12), 5)) expect(line).not.toContain("\t");
	});
});
