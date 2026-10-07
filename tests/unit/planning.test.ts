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
	describeDeliverable,
	goalTag,
	isSameDeliverable,
	mergeProposals,
	orderForCreation,
	parseProposal,
	parseProposedTask,
	peakParallelism,
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

describe("peakParallelism", () => {
	function merged(title: string, dependsOn: string[] = []) {
		return { key: deliverableKey(title), title, deliverable: undefined, capabilities: [], files: [], dependsOn, reviewRequired: false, agents: ["A"] };
	}

	test("independent work runs as wide as it is", () => {
		expect(peakParallelism([merged("a"), merged("b"), merged("c"), merged("d")])).toBe(4);
	});

	test("a chain is one worker wide, and the widest wave is what counts", () => {
		expect(peakParallelism([merged("a"), merged("b", ["a"]), merged("c", ["b"])])).toBe(1);
		// two roots, then their two children: the widest wave is 2
		expect(peakParallelism([merged("a"), merged("b"), merged("c", ["a"]), merged("d", ["b"])])).toBe(2);
	});

	test("an empty round wants nobody", () => {
		expect(peakParallelism([])).toBe(0);
	});

	test("a cycle asks for one worker, because creation drops the edge that cannot resolve", () => {
		expect(peakParallelism([merged("a", ["b"]), merged("b", ["a"])])).toBe(1);
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
		// The scribe is the one agent guaranteed to be looking at the whole plan, so the brief it is handed
		// names the tool that corrects a wrong size (task-115's audit reported its absence) — and says the
		// operator's ceiling still binds.
		expect(brief).toContain("swarm_scale({ agents, reason })");
		expect(brief).toContain("clamps to config.workers");
	});

	test("a custom bound is the one the brief states", () => {
		expect(planningTaskBrief({ id: "goal-2", goal: "g", agents: 1, createdBy: "main" }, 120_000)).toContain("2 minute(s)");
	});
});

describe("describeDeliverable", () => {
	test("the kind of work comes from the first verb, the artifact from files, else from the title", () => {
		expect(describeDeliverable("Verify NOTES.md", ["NOTES.md"]).intent).toBe("verify");
		expect(describeDeliverable("Write tests for the parser", ["src/parser.ts"]).intent).toBe("write");
		expect(describeDeliverable("Author NOTES.md").artifacts).toEqual(["notes.md"]);
		expect(describeDeliverable("Ship the thing").artifacts).toEqual([]);
	});

	test("an unknown kind is `other`, which pairs with nothing at all", () => {
		const shape = describeDeliverable("Improve the error handling", ["src/errors.ts"]);
		expect(shape.intent).toBe("other");
		expect(isSameDeliverable(shape, shape)).toBe(false);
	});

	test("a title naming a part of the artifact is marked as a fragment, the artifact itself is not", () => {
		expect(describeDeliverable("Write NOTES.md Alpha section", ["NOTES.md"]).section).toBe(true);
		expect(describeDeliverable("Write NOTES.md", ["NOTES.md"]).section).toBe(false);
		expect(describeDeliverable("Write NOTES.md chapter", ["NOTES.md"]).section).toBe(true);
	});

	test("an absolute and a bare path name the same artifact; two different directories do not", () => {
		expect(
			isSameDeliverable(
				describeDeliverable("Write NOTES.md", ["C:/repo/docs/NOTES.md"]),
				describeDeliverable("Write NOTES.md", ["NOTES.md"]),
			),
		).toBe(true);
		expect(
			isSameDeliverable(describeDeliverable("Wire the API", ["src/api.ts"]), describeDeliverable("Wire the API", ["lib/api.ts"])),
		).toBe(false);
	});
});

describe("the deliverable key: a rephrasing is the same task, a different deliverable is not", () => {
	test("the stated dedupe rule is the implemented one", () => {
		expect(DEDUPE_KEY_TEXT).toContain("TARGET ARTIFACT");
		expect(DEDUPE_KEY_TEXT).toContain("WRITERS");
		expect(DEDUPE_KEY_TEXT).not.toContain("normalized title");
	});

	test("the four rephrasings of one artifact from the live counterexample (FAIL #396) become ONE task", () => {
		const merged = mergeProposals([
			proposal("BrightTiger", { goal: "goal-1", tasks: [{ title: "Write NOTES.md with exactly three headings Alpha, Beta, Gamma", files: ["NOTES.md"] }] }, 1),
			proposal("CalmTiger", { goal: "goal-1", tasks: [{ title: "Create NOTES.md with Alpha, Beta, Gamma headings", files: ["NOTES.md"] }] }, 2),
			proposal("SwiftTiger", { goal: "goal-1", tasks: [{ title: "Author NOTES.md with Alpha/Beta/Gamma headings", files: ["NOTES.md"] }] }, 3),
			proposal("BrightTiger", { goal: "goal-1", tasks: [{ title: "Author NOTES.md with three headings Alpha, Beta, Gamma", files: ["NOTES.md"] }] }, 4),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.tasks[0]?.title).toBe("Write NOTES.md with exactly three headings Alpha, Beta, Gamma");
		expect(merged.tasks[0]?.agents).toEqual(["BrightTiger", "CalmTiger", "SwiftTiger"]);
		expect(merged.folded).toEqual([deliverableKey("Write NOTES.md with exactly three headings Alpha, Beta, Gamma")]);
	});

	test("the whole live round (5 proposals, 10 tasks, 1 file) plans 4 tasks: one writer, three genuinely different checks", () => {
		const merged = mergeProposals([
			proposal("BrightTiger", { goal: "goal-1", tasks: [
				{ title: "Write NOTES.md with exactly three headings Alpha, Beta, Gamma", files: ["NOTES.md"] },
				{ title: "Author NOTES.md with three headings Alpha, Beta, Gamma", files: ["NOTES.md"] },
			] }, 1),
			proposal("CalmTiger", { goal: "goal-1", tasks: [
				{ title: "Create NOTES.md with Alpha, Beta, Gamma headings", files: ["NOTES.md"] },
				{ title: "Write NOTES.md Alpha section", files: ["NOTES.md"] },
			] }, 2),
			proposal("SwiftTiger", { goal: "goal-1", tasks: [
				{ title: "Author NOTES.md with Alpha/Beta/Gamma headings", files: ["NOTES.md"] },
				{ title: "Append Notes Beta section", files: ["NOTES.md"] },
				{ title: "Append Notes Gamma section", files: ["NOTES.md"] },
				{ title: "Verify NOTES.md has exactly Alpha, Beta, Gamma", files: ["NOTES.md"] },
				{ title: "Verify NOTES.md has exactly three headings and one line each", files: ["NOTES.md"] },
				{ title: "Verify NOTES.md headings and content shape", files: ["NOTES.md"] },
			] }, 3),
		]);
		expect(merged.tasks.length).toBe(4); // was 10 before the deliverable key
		const writers = merged.tasks.filter((task) => task.key === deliverableKey("Write NOTES.md with exactly three headings Alpha, Beta, Gamma"));
		expect(writers.length).toBe(1);
		expect(writers[0]?.agents).toEqual(["BrightTiger", "CalmTiger", "SwiftTiger"]);
		expect(writers[0]?.files).toEqual(["NOTES.md"]);
		expect(merged.tasks.filter((task) => /^verify/i.test(task.title)).length).toBe(3);
		expect(merged.folded).toEqual([deliverableKey("Write NOTES.md with exactly three headings Alpha, Beta, Gamma")]);
	});

	test("the four rephrasings also carry a dependency: one depends_on another under different wording", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Write NOTES.md with exactly three headings Alpha, Beta, Gamma", files: ["NOTES.md"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Verify NOTES.md has exactly Alpha, Beta, Gamma", files: ["NOTES.md"], depends_on: ["Author NOTES.md with Alpha/Beta/Gamma headings"] }] }, 2),
		]);
		const verify = merged.tasks.find((task) => /^verify/i.test(task.title));
		const write = merged.tasks[0];
		expect(merged.tasks.length).toBe(2);
		expect(verify?.dependsOn).toEqual([write?.key]);
		expect(merged.unresolved).toEqual([]);
	});

	test("two writers of one artifact are ONE deliverable, whichever way each phrases it", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Add the retry logic to src/client.ts", files: ["src/client.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Implement the retry logic in src/client.ts", files: ["src/client.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
	});

	test("the same file with genuinely different work stays two deliverables", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Fix the retry storm in src/client.ts", files: ["src/client.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Fix the timeout default in src/client.ts", files: ["src/client.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
	});

	test("different artifacts never collapse", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Implement src/parser.ts", files: ["src/parser.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Write README.md", files: ["README.md"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
	});

	test("a deliverable that names no artifact never merges on wording alone", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Improve the error handling" }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Improve the error messages" }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
		expect(merged.folded).toEqual([]);
	});

	test("writing an artifact and verifying it are different deliverables", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Write NOTES.md", files: ["NOTES.md"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Verify NOTES.md", files: ["NOTES.md"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
	});

	test("a section of an artifact folds into the whole-artifact deliverable, and the whole title wins", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Write NOTES.md Alpha section", files: ["NOTES.md"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Write NOTES.md", files: ["NOTES.md"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.tasks[0]?.title).toBe("Write NOTES.md");
		expect(merged.tasks[0]?.agents).toEqual(["A", "B"]);
	});

	test("a dotted version token is not an artifact, so two release-shaped deliverables never merge", () => {
		expect(describeDeliverable("Add support for 1.2.3").artifacts).toEqual([]);
		expect(describeDeliverable("Implement v2.0.0 upgrade guide").artifacts).toEqual([]);
		expect(isSameDeliverable(describeDeliverable("Add support for 1.2.3"), describeDeliverable("Create notes for 1.2.3"))).toBe(false);
		expect(
			isSameDeliverable(describeDeliverable("Implement v2.0.0 upgrade guide"), describeDeliverable("Write the v2.0.0 changelog")),
		).toBe(false);
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Add support for 1.2.3" }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Create notes for 1.2.3" }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
		// …while a real file name in the same position is still an artifact.
		expect(describeDeliverable("Add support for NOTES.md").artifacts).toEqual(["notes.md"]);
		expect(describeDeliverable("Ship src/parser.ts").artifacts).toEqual(["src/parser.ts"]);
	});

	test("a version WORD in the final segment is not a file name, so release writers still stay apart", () => {
		// Both sides are asserted WRITE first: an `other` intent is an absolute gate that would make the
		// pair pass for the wrong reason, which is exactly how the first version of this rule survived.
		expect(describeDeliverable("Write the v1.0.beta release notes").intent).toBe("write");
		expect(describeDeliverable("Create the v1.0.beta announcement").intent).toBe("write");
		expect(describeDeliverable("Write the v1.0.beta release notes").artifacts).toEqual([]);
		expect(describeDeliverable("Write notes for v2.1.alpha").artifacts).toEqual([]);
		expect(
			isSameDeliverable(describeDeliverable("Write the v1.0.beta release notes"), describeDeliverable("Create the v1.0.beta announcement")),
		).toBe(false);
		expect(isSameDeliverable(describeDeliverable("Write notes for v2.1.alpha"), describeDeliverable("Create notes for v2.1.alpha"))).toBe(false);
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Write the v1.0.beta release notes" }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Create the v1.0.beta announcement" }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
	});

	test("only a token that can BE a file name is read as one", () => {
		// A bare token needs a known extension; a path-shaped token is trusted whatever it ends in.
		expect(describeDeliverable("Write NOTES.md").artifacts).toEqual(["notes.md"]);
		expect(describeDeliverable("Ship src/parser.ts").artifacts).toEqual(["src/parser.ts"]);
		expect(describeDeliverable("Bump main.go").artifacts).toEqual(["main.go"]);
		expect(describeDeliverable("Patch src/theme.zzz").artifacts).toEqual(["src/theme.zzz"]);
		expect(describeDeliverable("Publish report.beta").artifacts).toEqual([]);
		expect(describeDeliverable("Publish report.2024.md").artifacts).toEqual(["report.2024.md"]);
		// The declared-`files` path is untouched by any of this: an explicit list is authoritative.
		expect(describeDeliverable("Write the tracker", ["1.2.3"]).artifacts).toEqual(["1.2.3"]);
		expect(describeDeliverable("Write the tracker", ["/repo/docs/NOTES.md"]).artifacts).toEqual(["/repo/docs/notes.md"]);
		expect(isSameDeliverable(describeDeliverable("Write it", ["/repo/docs/NOTES.md"]), describeDeliverable("Write it too", ["docs/NOTES.md"]))).toBe(true);
	});
});
