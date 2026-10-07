/**
 * The planning round's pure rules: proposal parsing, the dedupe key, the merge and the creation
 * order. No store, no clock, no timers — a round is data, and this file pins the whole contract of
 * what the scribe does with it.
 */
import { describe, expect, test } from "bun:test";
import {
	DEDUPE_KEY_TEXT,
	GOAL_DEADLINE_MS,
	PROPOSAL_TAG,
	deliverableKey,
	goalTag,
	mergeProposals,
	orderForCreation,
	parseProposal,
	parseProposedTask,
	planningTaskBrief,
	type Proposal,
} from "../../extension/planning";
import type { BlackboardEntry } from "../../extension/types";

function entry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
	return {
		id: 1,
		type: "OBSERVATION",
		agentId: "A",
		content: "{}",
		tags: [PROPOSAL_TAG, goalTag("goal-1")],
		files: [],
		createdAt: 0,
		...overrides,
	};
}

function proposal(agentId: string, content: unknown, id = 1): Proposal {
	const parsed = parseProposal(entry({ id, agentId, content: JSON.stringify(content) }));
	if (parsed === undefined) throw new Error(`not a proposal: ${JSON.stringify(content)}`);
	return parsed;
}

describe("deliverableKey", () => {
	test("the same deliverable in any casing, spacing or trailing punctuation is ONE key", () => {
		const key = deliverableKey("Build the parser.");
		expect(key).toBe(deliverableKey("build the PARSER"));
		expect(key).toBe(deliverableKey("  Build   the parser ,  "));
		expect(key).toBe("build the parser");
	});

	test("different deliverables never collide", () => {
		expect(deliverableKey("Build the parser")).not.toBe(deliverableKey("Build the lexer"));
		expect(deliverableKey("")).toBe("");
	});
});

describe("parseProposal", () => {
	test("only a board entry carrying the proposal tag is one", () => {
		expect(parseProposal(entry({ tags: ["fact"] }))).toBeUndefined();
		expect(parseProposal(entry({ tags: [PROPOSAL_TAG], content: "not json" }))).toBeUndefined();
		expect(parseProposal(entry({ tags: [PROPOSAL_TAG], content: JSON.stringify({ goal: "goal-1", tasks: [] }) }))).toBeUndefined();
		expect(parseProposal(entry({ tags: [PROPOSAL_TAG], content: JSON.stringify(["x"]) }))).toBeUndefined();
	});

	test("the swarm_propose shape parses, and a manual board_post of the same shape parses too", () => {
		const entryPoints = [
			{ goal: "goal-1", tasks: [{ title: "One", deliverable: "d", files: ["a.ts"], capabilities: ["general"] }] },
			[{ title: "One", deliverable: "d", files: ["a.ts"], capabilities: ["general"] }],
		];
		for (const content of entryPoints) {
			const parsed = parseProposal(entry({ content: JSON.stringify(content) }));
			expect(parsed?.tasks).toEqual([
				{ title: "One", deliverable: "d", capabilities: ["general"], files: ["a.ts"], dependsOn: [], reviewRequired: false },
			]);
		}
	});

	test("the goal id comes from the JSON when present, otherwise from the goal tag", () => {
		expect(proposal("A", { goal: "goal-7", tasks: [{ title: "x" }] }).goalId).toBe("goal-7");
		expect(parseProposal(entry({ content: JSON.stringify({ tasks: [{ title: "x" }] }), tags: [PROPOSAL_TAG, goalTag("goal-9")] }))?.goalId).toBe(
			"goal-9",
		);
	});

	test("a task without a usable title is dropped, and the entry stays a proposal when others survive", () => {
		const parsed = proposal("A", { goal: "goal-1", tasks: [{ title: "  " }, { nope: 1 }, { title: "Kept" }] });
		expect(parsed.tasks.map((task) => task.title)).toEqual(["Kept"]);
	});

	test("malformed list fields never throw: they become empty", () => {
		const task = parseProposedTask({ title: "x", files: "src/a.ts", capabilities: [1, "general"], depends_on: [null, "Other"] });
		expect(task).toEqual({ title: "x", deliverable: undefined, capabilities: ["general"], files: [], dependsOn: ["Other"], reviewRequired: false });
		expect(parseProposedTask(null)).toBeUndefined();
		expect(parseProposedTask("x")).toBeUndefined();
	});
});

describe("mergeProposals", () => {
	test("two proposals naming the same deliverable become ONE task with the fields unioned", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Build the parser", deliverable: "short", files: ["src/a.ts"], capabilities: ["general"] }] }, 1),
			proposal(
				"B",
				{
					goal: "goal-1",
					tasks: [
						{
							title: "build   the PARSER.",
							deliverable: "a much longer description of the same deliverable",
							files: ["tests/a.test.ts", "src/a.ts"],
							capabilities: ["reviewer"],
							review_required: true,
						},
					],
				},
				2,
			),
		]);
		expect(merged.proposals).toBe(2);
		expect(merged.tasks.length).toBe(1);
		const task = merged.tasks[0];
		expect(task?.title).toBe("Build the parser"); // first proposal wins the title
		expect(task?.deliverable).toBe("a much longer description of the same deliverable");
		expect(task?.files).toEqual(["src/a.ts", "tests/a.test.ts"]);
		expect(task?.capabilities).toEqual(["general", "reviewer"]);
		expect(task?.reviewRequired).toBe(true);
		expect(task?.agents).toEqual(["A", "B"]);
		expect(merged.folded).toEqual([deliverableKey("Build the parser")]);
		expect(merged.empty).toBe(0);
	});

	test("dependency references resolve across proposals, by title", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Wire the CLI", depends_on: ["Build the parser"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Build the parser" }] }, 2),
		]);
		const cli = merged.tasks.find((task) => task.key === deliverableKey("Wire the CLI"));
		const parser = merged.tasks.find((task) => task.key === deliverableKey("Build the parser"));
		expect(cli?.dependsOn.length).toBe(1);
		expect(cli?.dependsOn[0]).toBe(parser?.key);
		expect(parser?.dependsOn).toEqual([]);
		expect(merged.unresolved).toEqual([]);
	});

	test("a self-reference and an unknown title are dropped and reported, never kept as dead edges", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Only task", depends_on: ["only TASK", "Never proposed"] }] }, 1),
		]);
		expect(merged.tasks[0]?.dependsOn).toEqual([]);
		expect(merged.unresolved).toEqual([
			{ task: deliverableKey("Only task"), dep: "only TASK" },
			{ task: deliverableKey("Only task"), dep: "Never proposed" },
		]);
	});

	test("a round whose proposals carry no task is reported as empty, not as a plan", () => {
		const merged = mergeProposals([
			{ entryId: 1, agentId: "A", goalId: "goal-1", tasks: [] },
			{ entryId: 2, agentId: "B", goalId: "goal-1", tasks: [{ title: " " }] },
		]);
		expect(merged.tasks).toEqual([]);
		expect(merged.empty).toBe(2);
		expect(merged.proposals).toBe(2);
	});

	test("a proposal whose every task is unusable is not a proposal at all", () => {
		expect(parseProposal(entry({ content: JSON.stringify({ goal: "goal-1", tasks: [{ title: " " }] }) }))).toBeUndefined();
	});
});

describe("orderForCreation", () => {
	function mergedTask(title: string, dependsOn: string[] = []) {
		return { key: deliverableKey(title), title, deliverable: undefined, capabilities: [], files: [], dependsOn, reviewRequired: false, agents: ["A"] };
	}

	test("a dependency chain is created in the only order that can succeed", () => {
		const order = orderForCreation([mergedTask("third", ["second"]), mergedTask("second", ["first"]), mergedTask("first")]);
		expect(order.ordered.map((task) => task.title)).toEqual(["first", "second", "third"]);
		expect(order.deferred).toEqual([]);
	});

	test("independent deliverables keep proposal order", () => {
		const order = orderForCreation([mergedTask("a"), mergedTask("b"), mergedTask("c")]);
		expect(order.ordered.map((task) => task.title)).toEqual(["a", "b", "c"]);
	});

	test("a cyclic round still terminates: every task is placed once and the broken edges are reported", () => {
		const order = orderForCreation([mergedTask("a", ["b"]), mergedTask("b", ["a"])]);
		expect(order.ordered.map((task) => task.title)).toEqual(["a", "b"]);
		expect(order.deferred).toEqual([{ task: "a", dep: "b" }]);
	});
});

describe("planningTaskBrief", () => {
	test("carries the goal, the split instructions, the dedupe rule and the bound", () => {
		const brief = planningTaskBrief({ id: "goal-1", goal: "ship the split", agents: 3, createdBy: "main" });
		expect(brief).toContain("GOAL goal-1 (3 agent(s), opened by main): ship the split");
		expect(brief).toContain("swarm_propose");
		expect(brief).toContain("swarm_plan");
		expect(brief).toContain(goalTag("goal-1"));
		expect(brief).toContain(DEDUPE_KEY_TEXT);
		expect(GOAL_DEADLINE_MS).toBe(600_000);
		expect(brief).toContain("10 minute(s)");
	});

	test("a custom bound is the one the brief states", () => {
		expect(planningTaskBrief({ id: "goal-2", goal: "g", agents: 1, createdBy: "main" }, 120_000)).toContain("2 minute(s)");
	});
});
