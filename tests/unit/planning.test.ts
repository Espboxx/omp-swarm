/**
 * The planning round's pure rules: proposal parsing, the dedupe key, the merge and the creation
 * order. No store, no clock, no timers — a round is data, and this file pins the whole contract of
 * what the scribe does with it.
 */
import { describe, expect, test } from "bun:test";
import {
	DEDUPE_KEY_TEXT,
	GOAL_DEADLINE_MS,
	MAX_SCRIBE_ATTEMPTS,
	PROPOSAL_TAG,
	SCRIBE_STALL_MS,
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
	sameDeliverableReason,
	scribeVerdict,
	type Proposal,
} from "../../extension/planning";
import type { BlackboardEntry } from "../../extension/types";
import { GOAL3_ENTRIES, GOAL5_ENTRIES } from "./helpers/goal5-round";

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
			{ entryId: 1, agentId: "A", goalId: "goal-1", tasks: [], createdAt: 1 },
			{ entryId: 2, agentId: "B", goalId: "goal-1", tasks: [{ title: " " }], createdAt: 2 },
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

	test("an unknown kind pairs on the artifact it names, never on similar wording alone", () => {
		const shape = describeDeliverable("Improve the error handling", ["src/errors.ts"]);
		expect(shape.intent).toBe("other");
		// A title the verb families cannot classify (any Chinese one, or an English one that opens
		// with a noun) used to pair with nothing at all - not even its own twin. It names an artifact,
		// so the artifact decides, which is what the live counterexample needed.
		expect(isSameDeliverable(shape, shape)).toBe(true);
		// …but an unknown kind is not a licence to pair two wordings that merely look alike.
		expect(isSameDeliverable(shape, describeDeliverable("Speed up the parser loop", ["src/errors.ts"]))).toBe(false);
		expect(isSameDeliverable(shape, describeDeliverable("Improve the error handling", ["src/other.ts"]))).toBe(false);
	});

	test("a title naming a part of the artifact is marked as a fragment, the artifact itself is not", () => {
		expect(describeDeliverable("Write NOTES.md Alpha section", ["NOTES.md"]).section).toBe(true);
		expect(describeDeliverable("Write NOTES.md", ["NOTES.md"]).section).toBe(false);
		expect(describeDeliverable("Write NOTES.md chapter", ["NOTES.md"]).section).toBe(true);
	});

	test("the kind is read in Chinese too, so a fix cannot fold into a verification", () => {
		// The tokenizer keeps no CJK word, so this is a second table matched on substrings. Without
		// it every Chinese title was `other`, and `other` never contradicts anything - which is how
		// goal-3's fix swallowed a verification of a different artifact.
		expect(describeDeliverable("修复 settings.get 不是函数 运行时错误").intent).toBe("fix");
		expect(describeDeliverable("验证：受影响路径跑通且无回归").intent).toBe("verify");
		expect(describeDeliverable("只读审计：唤醒源清单 + 交接").intent).toBe("verify");
		expect(describeDeliverable("实现 settings 访问接口").intent).toBe("write");
		// A word that does not state the kind on its own must stay `other`: the live goal-5 rows are
		// titled this way and their cross-language pairs have to keep folding.
		expect(describeDeliverable("量化空转烧钱速率:转录记录数 x 任务持有状态(只读,可复现)").intent).toBe("other");
		expect(describeDeliverable("落地前刹车:配置档实测与一键还原(idleTickSeconds)").intent).toBe("other");
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

	test("two writers on one file are ONE deliverable even when each names different work", () => {
		// Inverted by task-212 against DEDUPE_KEY_TEXT, which is the authority this rule is published under:
		// "two WRITERS on one artifact are ALWAYS one deliverable (an artifact has one owner)". Both rows
		// would edit src/client.ts, and that shared file IS the collision the clause prevents; the previous
		// expectation (two rows) is what let the real goal-9 round mint THREE writers on
		// extension/store.ts (D1). Nothing is lost from the survivor: files, capabilities and dependencies
		// are unioned and the fold is recorded with its reason for the plan's DECISION to print.
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Fix the retry storm in src/client.ts", files: ["src/client.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Fix the timeout default in src/client.ts", files: ["src/client.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.folds.map((fold) => fold.reason)).toEqual(["one artifact has one owner: src/client.ts"]);
		expect(merged.tasks[0]?.agents).toEqual(["A", "B"]);
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

describe("the live counterexample: goal-5's round (3 splits, 20 rows) is 5 deliverables", () => {
	const round = (ids?: number[]): Proposal[] =>
		GOAL5_ENTRIES.filter((entry) => ids === undefined || ids.includes(entry.id)).map((entry) =>
			proposal(entry.agentId, { goal: "goal-1", tasks: entry.tasks }, entry.id),
		);
	const task = (entryId: number, startsWith: string) => {
		const found = GOAL5_ENTRIES.find((entry) => entry.id === entryId)?.tasks.find((candidate) => candidate.title.startsWith(startsWith));
		if (found === undefined) throw new Error(`no task "${startsWith}" in #${entryId}`);
		return found;
	};
	const burnEn = task(552, "Measure and publish the idle burn rate");
	const burnCn = task(553, "量化烧钱速率");
	const burnFile = task(554, "只读测量");
	const wakeEn = task(552, "Enumerate every model-call wakeup source");
	const wakeFile = task(554, "只读审计");
	const brakeEn = task(552, "Ship an operator brake");
	const obsEn = task(552, "Diagnose the observability defect");
	const obsCn = task(553, "可观测性缺陷");
	const handoff = task(552, "Consolidate the four advisories");

	test("the same artifact in four path spellings is ONE row", () => {
		const merged = mergeProposals([
			proposal("RapidTiger", { goal: "goal-1", tasks: [burnEn, wakeEn, brakeEn, obsEn, handoff] }, 552),
			proposal("VividTiger", { goal: "goal-1", tasks: [burnCn] }, 553),
			proposal("SwiftTiger", { goal: "goal-1", tasks: [burnFile] }, 554),
		]);
		expect(merged.tasks.length).toBe(5); // these three splits created 8 rows
		const burn = merged.tasks.find((candidate) => candidate.title === burnEn.title);
		expect(burn?.files.sort()).toEqual(["omp-swarm/scratch/advisory-burn/rate-table.md", "scratch/advisory-burnrate/**"]);
		expect(burn?.agents).toEqual(["RapidTiger", "VividTiger", "SwiftTiger"]);
		// A directory and a file are one deliverable, and the reason names both spellings.
		expect(merged.folds.map((fold) => fold.reason).join("\n")).toContain("scratch/advisory-burnrate ~ omp-swarm/scratch/advisory-burn/rate-table.md");
	});

	test("one directory holding three deliverables stays three rows", () => {
		// rate-table.md, wake-sources.md and brake.md all live under scratch/advisory-burn/, which is
		// why an artifact is matched by NAME and never by "the same directory".
		const merged = mergeProposals([proposal("SwiftTiger", { goal: "goal-1", tasks: GOAL5_ENTRIES[2]?.tasks ?? [] }, 554)]);
		expect(merged.tasks.length).toBe(3);
		expect(merged.folded).toEqual([]);
	});

	test("a directory and the file inside it pair on the compound their names share", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [wakeEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [wakeFile] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.folds[0]?.reason).toContain("two spellings of one artifact");
	});

	test("two containers whose names share no word pair on near-identical wording", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [obsEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [obsCn] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.folds[0]?.reason).toContain("container");
	});

	test("two containers with different names and different wording stay apart", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [brakeEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [obsEn] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
		expect(merged.folded).toEqual([]);
	});

	test("a wider declaration folds into the deliverable, and the extra artifact is named in the reason", () => {
		const wider = task(556, "落地前刹车");
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [brakeEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [wider] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.tasks[0]?.files).toEqual(["scratch/advisory-brake/**", "scratch/advisory-brake/", ".swarm/config.json"]);
		expect(merged.folds[0]?.reason).toContain(".swarm/config.json");
	});

	test("every folded row is auditable: a survivor and a reason, never a bare count", () => {
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [burnEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [burnCn, burnFile] }, 2),
		]);
		expect(merged.folds.map((fold) => fold.title)).toEqual([burnCn.title, burnFile.title]);
		expect(merged.folds.map((fold) => fold.into)).toEqual([deliverableKey(burnEn.title), deliverableKey(burnEn.title)]);
		for (const fold of merged.folds) expect(fold.reason.length).toBeGreaterThan(0);
	});

	test("the whole round of three splits collapses to the five deliverables it really holds", () => {
		const merged = mergeProposals(round([552, 553, 554]));
		expect(merged.tasks.length).toBe(5);
		expect(merged.folds.length).toBe(7);
		// The handoff still waits on all four advisories, resolved onto the survivors.
		const consolidated = merged.tasks.find((candidate) => candidate.title === handoff.title);
		expect(new Set(consolidated?.dependsOn)).toEqual(new Set(merged.tasks.filter((candidate) => candidate !== consolidated).map((candidate) => candidate.key)));
		expect(merged.unresolved).toEqual([]);
	});

	test("the whole five-entry round adds only the verification row LunarTiger really did propose", () => {
		const merged = mergeProposals(round());
		expect(merged.tasks.length).toBe(6); // 22 proposed tasks: 4 advisories + the handoff + the verifier
		expect(merged.tasks.filter((candidate) => candidate.files.some((file) => file.startsWith("scratch/advisory-verify"))).length).toBe(1);
	});

	test("…and the same two container names under different parents are two deliverables", () => {
		// A boundary probe on the live text: only the directory moves, and a container pair may only
		// collapse INSIDE one scope (a rename), never across two places.
		const moved = { ...obsCn, files: ["elsewhere/advisory-status/**"] };
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [obsEn] }, 1),
			proposal("B", { goal: "goal-1", tasks: [moved] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
		expect(merged.folded).toEqual([]);
	});
});

describe("the goal-3 false merge: a fix must never swallow a verification", () => {
	// #499 CalmTiger proposed the fix (`src/**`), #511 BrightTiger the verification (`omp-swarm/tests/**`).
	// The two prose blobs quote one error string, so wording overlap alone reached the container
	// fallback and the verification lost its identity inside the fix. Both rows are real: the rule
	// must keep them apart, and the fix's prose must never be able to absorb a CHECK of itself.
	const round = GOAL3_ENTRIES.map((entry) =>
		proposal(entry.agentId, { goal: "goal-1", tasks: entry.tasks }, entry.id),
	);

	test("the fix and the verification survive as two rows with their own artifacts", () => {
		const merged = mergeProposals(round);
		const fix = merged.tasks.find((task) => task.title.startsWith("修复 settings.get"));
		const verify = merged.tasks.find((task) => task.title.startsWith("验证：受影响路径跑通"));
		expect(fix?.files).toEqual(["src/**"]);
		expect(verify?.files).toEqual(["omp-swarm/tests/**"]);
		expect(merged.folds.map((fold) => fold.title)).not.toContain("验证：受影响路径跑通且无回归");
		expect(merged.folds).toEqual([]);
	});

	test("the whole goal-3 round is SEVEN rows: the six the live round created included the false fold", () => {
		// The live round created 6 rows from these 7 proposed tasks — the sixth was the false merge
		// (the verification folded into the fix). With the pair refused, the round holds 7 distinct
		// deliverables: two fixes and two verifications, on the two different artifacts the agents
		// disagreed about, plus the audit, the reconnaissance and the hygiene row.
		const merged = mergeProposals(round);
		expect(merged.tasks.length).toBe(7);
		expect(merged.folds).toEqual([]);
	});
});

describe("a merged row's union shape, and what must still not fold into it", () => {
	// `store.planGoal` skips a deliverable the pool already holds by re-describing the held row's
	// title + files and asking the merge predicate. A held row's files are the UNION of every spelling
	// that folded into it, so the predicate has to keep recognising those spellings - otherwise a
	// LATER round re-proposing one of them mints a duplicate row, which is the goal-6 complaint one
	// round on. BrightTiger's cross-check found two that were no longer recognised; this pins them.
	test("every spelling a survivor absorbed is still recognised through its stored shape", () => {
		const merged = mergeProposals(
			GOAL5_ENTRIES.map((entry) => proposal(entry.agentId, { goal: "goal-1", tasks: entry.tasks }, entry.id)),
		);
		const originals = GOAL5_ENTRIES.flatMap((entry) => entry.tasks);
		let checked = 0;
		for (const survivor of merged.tasks) {
			const held = describeDeliverable(survivor.title, survivor.files, survivor.deliverable ?? "");
			for (const fold of merged.folds.filter((candidate) => candidate.into === survivor.key)) {
				const original = originals.find((candidate) => candidate.title === fold.title);
				if (original === undefined) throw new Error(`no original task for ${fold.title}`);
				expect(isSameDeliverable(held, describeDeliverable(original.title, original.files, original.deliverable))).toBe(true);
				checked += 1;
			}
		}
		expect(checked).toBe(16); // every folded row of the five-entry round
	});

	test("two writers whose file lists NEST fold on the file they share", () => {
		// Inverted by task-212, same clause as the case above: the shared src/parser.ts makes these two rows
		// one owner. The evidence the old expectation protected is still evidence — `parser` and `lexer` share
		// no compound, so a narrower file list is not a RESPELLING of a wider one — but a respelling is not
		// what makes two writers one deliverable; the artifact they both edit is. The union keeps lexer.ts.
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Fix the parser crash", files: ["src/parser.ts", "src/lexer.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Fix the timeout", files: ["src/parser.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.tasks[0]?.files).toEqual(["src/parser.ts", "src/lexer.ts"]);
		expect(merged.folds.map((fold) => fold.reason)).toEqual(["one artifact has one owner: src/parser.ts"]);
	});
});

/**
 * The scribe-lost ladder, decided by the round's own data. This rule is what turns "the round died at
 * its bound with planner=null" (goal-6, re-derived in board FACT #728: held continuously, silent from
 * +363s, bound at +601s) into a round that either gets a plan or gets a reason: a silent holder is
 * re-offered, a re-offered round nobody takes is closed, and a round that burns MAX_SCRIBE_ATTEMPTS of
 * scribes ends explicitly instead of spinning.
 */
describe("scribeVerdict: a stalled round is re-offered, then closed with a reason", () => {
	const round = { planningTask: "task-1", heldBy: "A", attempts: 1, lastProgressAt: 1_000_000 };

	test("a producing scribe is never taken off the round, right up to the stall limit", () => {
		expect(scribeVerdict({ ...round, now: 1_000_000 + SCRIBE_STALL_MS - 1 })).toEqual({ action: "ok" });
	});

	test("one silent window hands the round back to the pool, naming the holder and the seconds", () => {
		const verdict = scribeVerdict({ ...round, now: 1_000_000 + SCRIBE_STALL_MS });
		expect(verdict.action).toBe("reclaim");
		if (verdict.action !== "reclaim") throw new Error("expected a reclaim");
		expect(verdict.reason).toContain("A held task-1");
		expect(verdict.reason).toContain("120s");
		expect(verdict.reason).toContain(`attempt 1 of ${MAX_SCRIBE_ATTEMPTS}`);
	});

	test("the ladder is bounded: a takeover is allowed up to the cap, and the cap closes the round", () => {
		expect(scribeVerdict({ ...round, attempts: 2, now: 1_000_000 + SCRIBE_STALL_MS }).action).toBe("reclaim");
		const last = scribeVerdict({ ...round, attempts: MAX_SCRIBE_ATTEMPTS, now: 1_000_000 + SCRIBE_STALL_MS });
		expect(last.action).toBe("fail");
		if (last.action !== "fail") throw new Error("expected a fail");
		expect(last.reason).toContain(`taken ${MAX_SCRIBE_ATTEMPTS} time(s)`);
	});

	test("a round that was re-offered and left sitting is closed, not spun to the bound", () => {
		const verdict = scribeVerdict({ ...round, heldBy: undefined, now: 1_000_000 + SCRIBE_STALL_MS });
		expect(verdict.action).toBe("fail");
		if (verdict.action !== "fail") throw new Error("expected a fail");
		expect(verdict.reason).toContain("claimable for 120s");
		expect(verdict.reason).toContain("1 claim(s)");
	});

	test("a fresh round nobody has ever claimed is the bound's business: the watchdog leaves it alone", () => {
		expect(scribeVerdict({ ...round, heldBy: undefined, attempts: 0, now: 1_000_000 + SCRIBE_STALL_MS * 10 })).toEqual({ action: "ok" });
	});
});

/**
 * task-212 — the merge's own two defects, measured on the REAL goal-9 round (board FAIL #780, repro
 * `bun run scratch/goal9-merge/merge-defects.ts`). The rows below are that round's, recorded verbatim
 * from the plan (DECISION #763 / the tasks table); the partition into the three proposals does not
 * affect a merge that folds by deliverable, so they travel as one round here.
 */
describe("task-212: one artifact has one owner, and a writer never folds into a verifier", () => {
	const GOAL9_ROUND: Array<[string, string[]]> = [
		[
			"Fix goal-9: payload-bound one-shot vote tickets + identity-checked, gated roster growth (SINGLE WRITER)",
			["omp-swarm/extension/store.ts", "omp-swarm/extension/tools.ts", "omp-swarm/extension/auto.ts", "omp-swarm/extension/planning.ts", "omp-swarm/tests/unit/vote-store.test.ts", "omp-swarm/tests/unit/vote-gate.test.ts"],
		],
		[
			"Fix vote tickets: bind each round to the payload it voted on and consume it inside the action's own transaction (extension/store.ts)",
			["omp-swarm/extension/store.ts", "omp-swarm/tests/unit/vote-store.test.ts", "omp-swarm/extension/db.ts"],
		],
		[
			"Fix: a passed vote is bound to its payload and consumed once (kill ticket replay)",
			["omp-swarm/extension/store.ts", "omp-swarm/extension/tools.ts", "omp-swarm/tests/unit/vote-store.test.ts", "omp-swarm/tests/unit/tools.test.ts"],
		],
		[
			"Fix: the tally is visible on the normal read path, and an offline voter is named, not silently dropped",
			["omp-swarm/extension/store.ts", "omp-swarm/extension/voting.ts", "omp-swarm/tests/unit/store.test.ts", "omp-swarm/tests/unit/voting.test.ts"],
		],
		[
			"Wire every remaining decision point to the round: gate the ticket in tools.ts, gate spawn/stop + the goal agents budget, and check identity on swarm_goal (extension/tools.ts + auto.ts + driver.ts)",
			["omp-swarm/extension/tools.ts", "omp-swarm/extension/auto.ts", "omp-swarm/extension/driver.ts", "omp-swarm/tests/unit/tools.test.ts", "omp-swarm/tests/unit/auto.test.ts"],
		],
		[
			"Fix: roster growth and the goal size budget must pass a vote; swarm_goal checks identity",
			["omp-swarm/extension/auto.ts", "omp-swarm/extension/tools.ts", "omp-swarm/tests/unit/auto.test.ts", "omp-swarm/tests/unit/tools.test.ts"],
		],
		["Verify goal-9 A: non-author adversarial re-attempt at the tool layer (replay / payload-swap / TOCTOU concurrency)", ["scratch/goal9-verify/tool-layer/"]],
		["Verify goal-9 B: roster growth + vote-wait liveness in a REAL controller process", ["scratch/goal9-verify/roster/"]],
		[
			"Non-author adversarial re-verification of the fixed tree: replay, payload swap, concurrent consume, identity paths, and the roster claim driven for real",
			["omp-swarm/scratch/goal9-verify/VERDICT.md", "omp-swarm/scratch/goal9-verify/adversarial.ts"],
		],
		[
			"Verify (non-author): drive the REAL AutoController process - roster growth and zero model calls during a wait",
			["omp-swarm/scratch/goal9-wiring/EVIDENCE.md", "omp-swarm/scratch/goal9-wiring/drive-roster.ts", "omp-swarm/scratch/goal9-wiring/run-output.json"],
		],
		[
			"Verify (non-author): adversarial re-attack on the fixed tree - replay, race, identity",
			["omp-swarm/scratch/goal9-verify/VERDICT.md", "omp-swarm/scratch/goal9-verify/adversarial.ts", "omp-swarm/scratch/goal9-verify/run-output.json"],
		],
		["Docs goal-9: ask the coordinator for the README write domain, then document the operator-visible rule change", ["omp-swarm/README.md"]],
		["Document the operator-visible boundary change: one decision = one one-shot round, spawn/stop included (README parity)", ["omp-swarm/README.md", "omp-swarm/extension/README.md"]],
	];

	test("the owner clause covers the whole mutating family, not only the literal `write` (D1)", () => {
		// The repro's own control pair: two `fix` rows, one file, wording that shares nothing. Only the
		// first clause covered `write`, so this stayed two rows and every `fix` row in a round was free to
		// claim an artifact another row was already editing.
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Fix alpha crash in src/a.ts", files: ["src/a.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Resolve bravo timeout in src/a.ts", files: ["src/a.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.folds.map((fold) => fold.reason)).toEqual(["one artifact has one owner: src/a.ts"]);
	});

	test("a writer never folds into the verifier of its own artifact (D2)", () => {
		// The wiring row read as `verify` off the incidental "check" in its second half, and its artifacts
		// then "spelled" the verifier's scratch directory through the shared word `tool` — so the deliverable
		// disappeared into the verification of itself, and the verifier inherited the source files it must
		// stay independent of.
		const writer = describeDeliverable(
			"Wire every remaining decision point to the round: gate the ticket in tools.ts, gate spawn/stop + the goal agents budget, and check identity on swarm_goal (extension/tools.ts + auto.ts + driver.ts)",
			["omp-swarm/extension/tools.ts", "omp-swarm/extension/auto.ts", "omp-swarm/extension/driver.ts"],
		);
		const verifier = describeDeliverable(
			"Verify goal-9 A: non-author adversarial re-attempt at the tool layer (replay / payload-swap / TOCTOU concurrency)",
			["scratch/goal9-verify/tool-layer/"],
		);
		// The kind comes from the LEADING word, so a noun or a later verb cannot state it: `wire` states no
		// kind, and neither `author` nor `check` gets to decide one.
		expect(writer.intent).toBe("other");
		expect(verifier.intent).toBe("verify");
		expect(describeDeliverable("Non-author adversarial re-verification of the fixed tree", ["scratch/v/VERDICT.md"]).intent).toBe("other");
		expect(describeDeliverable("Plan goal-9: merge the split proposals into the task graph").intent).toBe("other");
		expect(sameDeliverableReason(verifier, writer)).toBeUndefined();
		expect(isSameDeliverable(verifier, writer)).toBe(false);
	});

	test("the recorded goal-9 round merges to exactly ONE writer row on extension/store.ts (D1)", () => {
		const merged = mergeProposals([proposal("scribe", { goal: "goal-9", tasks: GOAL9_ROUND.map(([title, files]) => ({ title, files })) }, 1)]);
		const owners = merged.tasks.filter((task) => task.files.includes("omp-swarm/extension/store.ts"));
		expect(owners.length).toBe(1);
		expect(describeDeliverable(owners[0]?.title ?? "", owners[0]?.files ?? []).intent).toBe("fix");
		// Every file the folded rows declared survives in the union, and every fold carries its reason.
		expect(owners[0]?.files).toContain("omp-swarm/extension/db.ts");
		expect(owners[0]?.files).toContain("omp-swarm/extension/voting.ts");
		expect(merged.folds.length).toBeGreaterThanOrEqual(3);
		// The other half of the acceptance: no verification row may inherit a source file. A verification of
		// the tree is not the tree, and a verifier that owns the files it audits is no longer independent.
		const verifiers = merged.tasks.filter((task) => /^(Verify|Non-author)/.test(task.title));
		// Three, not five: the two rows that both write scratch/goal9-verify/VERDICT.md are one verification
		// deliverable and fold with each other, which is intended — it is folding into a WRITER that loses work.
		expect(verifiers.length).toBe(3);
		for (const verifier of verifiers) {
			expect(verifier.files.filter((file) => file.startsWith("omp-swarm/extension/"))).toEqual([]);
		}
	});

	test("the owner clause folds two DIFFERENT mutating kinds on one artifact (fix vs refactor)", () => {
		// The kind guard used to sit ABOVE the owner clause, so a `fix` and a `refactor` on one file — two
		// KNOWN kinds that differ — answered "two deliverables" before the clause was ever consulted, and a
		// round kept two writers for one artifact. The clause's own text says "whatever their kinds are",
		// and DEDUPE_KEY_TEXT promises one owner; this is the same defect as the literal-`write` one, one
		// level up (task-212's acceptance, measured by the reviewer).
		const fixing = describeDeliverable("Fix the retry bug in src/limiter.ts", ["src/limiter.ts"]);
		const refactoring = describeDeliverable("Refactor the token bucket in src/limiter.ts", ["src/limiter.ts"]);
		expect([fixing.intent, refactoring.intent]).toEqual(["fix", "refactor"]);
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Fix the retry bug in src/limiter.ts", files: ["src/limiter.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Refactor the token bucket in src/limiter.ts", files: ["src/limiter.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(1);
		expect(merged.folds.map((fold) => fold.reason)).toEqual(["one artifact has one owner: src/limiter.ts"]);
	});

	test("an unknown-kind row never folds with a verification of the same artifact", () => {
		// The second half of the reviewer's counterexample: `Wire ...` reads as `other`, and an unknown kind
		// contradicts nothing, so the artifact route happily folded it into (or out of) a verification of the
		// same file — the writer swallowed by a verifier, the one merge this rule must never make.
		const writer = describeDeliverable("Wire the ticket gate into src/tools.ts", ["src/tools.ts"]);
		const verifier = describeDeliverable("Verify the ticket gate in src/tools.ts", ["src/tools.ts"]);
		expect([writer.intent, verifier.intent]).toEqual(["other", "verify"]);
		expect(sameDeliverableReason(verifier, writer)).toBeUndefined();
		const merged = mergeProposals([
			proposal("A", { goal: "goal-1", tasks: [{ title: "Wire the ticket gate into src/tools.ts", files: ["src/tools.ts"] }] }, 1),
			proposal("B", { goal: "goal-1", tasks: [{ title: "Verify the ticket gate in src/tools.ts", files: ["src/tools.ts"] }] }, 2),
		]);
		expect(merged.tasks.length).toBe(2);
	});

	test("an unknown-kind row on a shared artifact still splits from a mutating row (deliberate)", () => {
		// PINNED ON PURPOSE, so nobody "fixes" it later: the classifier cannot tell an unknown-kind WRITER
		// from an unknown-kind verification, and folding them would swallow a deliverable whenever it
		// guessed writer and meant verifier. The rule splits instead — one visible duplicate row, which is
		// the direction it takes every time the evidence is ambiguous. Widening the verb families is the way
		// to close this, not a blanket "other means writer".
		const unknown = describeDeliverable("Wire the ticket gate into src/tools.ts", ["src/tools.ts"]);
		const mutating = describeDeliverable("Fix the roster growth gate in src/tools.ts", ["src/tools.ts"]);
		expect([unknown.intent, mutating.intent]).toEqual(["other", "fix"]);
		expect(sameDeliverableReason(unknown, mutating)).toBeUndefined();
	});
});
