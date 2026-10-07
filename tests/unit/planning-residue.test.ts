/**
 * The goal-5 residue, replayed from the live data: the round's dependency edges were minted onto rows
 * that were later closed as duplicates (task-166 <- task-160/161 and task-168 <- task-162/163/164/167
 * in .swarm/swarm.db), so those rows sat `blocked` forever - the permanent residue the goal-6 operator
 * caught. This file pins the two rules that keep it from happening again: a dependency resolves only
 * onto a survivor of the round, and a reference that cannot resolve is REPORTED rather than becoming a
 * row of its own.
 */
import { describe, expect, test } from "bun:test";
import { deliverableKey, mergeProposals, parseProposal, PROPOSAL_TAG, type Proposal } from "../../extension/planning";
import { GOAL5_ENTRIES } from "./helpers/goal5-round";

function goal5Proposals(): Proposal[] {
	return GOAL5_ENTRIES.map((entry) => {
		const parsed = parseProposal({
			id: entry.id,
			type: "OBSERVATION",
			agentId: entry.agentId,
			content: JSON.stringify({ goal: "goal-5", tasks: entry.tasks }),
			tags: [PROPOSAL_TAG, "goal:goal-5"],
			files: [],
			createdAt: 0,
		});
		if (parsed === undefined) throw new Error(`#${entry.id} is not a proposal`);
		return parsed;
	});
}

describe("goal-5's dependency residue", () => {
	const merged = mergeProposals(goal5Proposals());
	const survivors = new Set(merged.tasks.map((task) => task.key));

	test("every dependency edge lands on a survivor of the same round", () => {
		const edges = merged.tasks.flatMap((task) => task.dependsOn);
		expect(edges.length).toBeGreaterThan(0);
		for (const dep of edges) expect(survivors.has(dep)).toBe(true);
	});

	test("no task row carries a title that folded away", () => {
		const titles = new Set(merged.tasks.map((task) => task.title));
		expect(merged.folds.length).toBeGreaterThan(0);
		for (const fold of merged.folds) expect(titles.has(fold.title)).toBe(false);
	});

	test("the consolidation row waits on the four advisories, not on the spellings that lost", () => {
		const handoff = merged.tasks.find((task) => task.title.startsWith("Consolidate the four advisories"));
		expect(handoff).toBeDefined();
		// The four advisories are every other row except the verifier, which is not an advisory.
		const advisories = merged.tasks.filter((task) => task !== handoff && !task.files.some((file) => file.startsWith("scratch/advisory-verify")));
		expect(advisories.length).toBe(4);
		expect(new Set(handoff?.dependsOn)).toEqual(new Set(advisories.map((task) => task.key)));
		for (const dep of handoff?.dependsOn ?? []) expect(survivors.has(dep)).toBe(true);
	});

	test("the verification row resolves its Chinese references onto the survivors too", () => {
		const verify = merged.tasks.find((task) => task.files.some((file) => file.startsWith("scratch/advisory-verify")));
		expect(verify).toBeDefined();
		expect(verify?.dependsOn.length).toBeGreaterThan(0);
		for (const dep of verify?.dependsOn ?? []) expect(survivors.has(dep)).toBe(true);
	});

	test("a reference that cannot resolve is reported, never turned into a row of its own", () => {
		const only = mergeProposals([
			{
				entryId: 1,
				agentId: "A",
				goalId: "goal-1",
				tasks: [{ title: "Only task", dependsOn: ["Never proposed anywhere"] }],
				createdAt: 1,
			},
		]);
		expect(only.tasks.length).toBe(1);
		expect(only.unresolved).toEqual([{ task: deliverableKey("Only task"), dep: "Never proposed anywhere" }]);
	});
});
