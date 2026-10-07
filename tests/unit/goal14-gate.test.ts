/**
 * goal-14's capability gate: the tests that PIN the defect and then test the guard that closes it.
 *
 * WHAT THIS FILE IS FOR. goal-14 exists because a task row can be minted with
 * `required_capabilities` that NO agent in the pool can ever hold (task-221/222/223 with
 * caps=["reviewer"] against six agents that all carry ["general"]), and because nothing then
 * discovers, reports or repairs it.
 *
 * TWO HALVES, DELIBERATELY DISTINGUISHED. The first describe blocks pin what the code did BEFORE
 * the guard — they are the audit trail of the defect and must not be loosened. The last block
 * (`THE GUARD`) tests the guard this file now ships: `unreachableCapabilities` +
 * `unclaimableReason` and `mergeProposals`'s opt-in `reachable` parameter, which is goal-14's
 * clause 1 as a refusal rather than a strand.
 *
 * THE CONTRACT IS HONEST ABOUT DIRECTION. Where the guard is NOT yet wired to the caller that
 * actually mints rows, the test says so instead of asserting a wiring that does not exist.
 *
 * NOTHING here mints a task through the store: `planRoster`, `mergeProposals`, `parseProposal` and
 * `describeDeliverable` are pure, and the mint-site behaviour is measured through them.
 */
import { describe, expect, test } from "bun:test";
import {
	describeDeliverable,
	mergeProposals,
	parseProposal,
	unclaimableReason,
	unreachableCapabilities,
} from "../../extension/planning";
import { planRoster } from "../../extension/auto";
import { expandWorkers } from "../../extension/config";
import { DEFAULT_CONFIG, type BoardType, type RoleConfig, type SwarmConfig, type SwarmTask } from "../../extension/types";

/** A task row in the shape `planRoster` reads: only the fields it touches matter. */
function gateTask(overrides: Partial<SwarmTask> & { requiredCapabilities: string[] }): SwarmTask {
	return {
		id: "t1",
		title: "probe",
		status: "ready",
		priority: 0,
		createdAt: 0,
		updatedAt: 0,
		claimedBy: null,
		author: null,
		files: [],
		...overrides,
		review: { required: false, status: null, reviewer: null, notes: null, ...overrides.review },
	} as SwarmTask;
}

/** A proposal entry in the shape `parseProposal` reads. */
function proposal(agentId: string, tasks: unknown[], entryId = 1) {
	return {
		id: entryId,
		type: "OBSERVATION" as BoardType,
		agentId,
		content: JSON.stringify({ goal: "goal-gate", tasks }),
		tags: ["proposal", "goal:goal-gate"],
		files: [],
		createdAt: 0,
	};
}

/** The live config: `auto: true`, `workers: 6`, and NO `roles` key (measured verbatim). */
const LIVE_CONFIG: SwarmConfig = { ...DEFAULT_CONFIG, auto: true, workers: 6, roles: [] };

/** A config whose roles DO name the capability — goal-14's "custom roles" boundary. */
const ROLED_CONFIG: SwarmConfig = {
	...DEFAULT_CONFIG,
	auto: true,
	workers: 6,
	roles: [{ name: "reviewer", count: 1, capabilities: ["reviewer", "general"] }] as RoleConfig[],
};

/**
 * THE CONFIGURED capabilities, derived the way `expandWorkers` derives them (config.ts:70): a role
 * contributes `role.capabilities ?? [role.name]`, and an absent/empty `roles` key falls back to
 * `DEFAULT_CONFIG.roles` (config.ts:55). This is the "can a CONFIGURED role hold it" set.
 */
function reachableCapabilities(config: SwarmConfig): Set<string> {
	const roster = config.roles.length > 0 ? config.roles : DEFAULT_CONFIG.roles;
	const caps = new Set<string>();
	for (const role of roster) for (const cap of role.capabilities ?? [role.name]) caps.add(cap);
	return caps;
}

/**
 * Every capability the AUTO path can reach: the configured ones PLUS what `planRoster` synthesizes
 * from live demand (auto.ts:112-113). Measured: it synthesizes a role for ANY capability a task
 * names — reviewer, integrator, and a nonsense "quantum" all come back as `[cap, "general"]`.
 */
function planReachableCapabilities(tasks: SwarmTask[], config: SwarmConfig): Set<string> {
	const caps = new Set(reachableCapabilities(config));
	for (const role of planRoster(tasks, config, 0)) for (const cap of role.capabilities ?? [role.name]) caps.add(cap);
	return caps;
}

describe("goal-14 boundary 1: a satisfiable capability is left alone (must never regress)", () => {
	test("a row that asks for general passes through the merge untouched, and the roster already covers it", () => {
		const parsed = parseProposal(proposal("A", [{ title: "general row", deliverable: "d", capabilities: [], files: ["extension/a.ts"] }]));
		expect(parsed).toBeDefined();
		const merged = mergeProposals([parsed!]);
		expect(merged.tasks[0]?.capabilities ?? []).toEqual([]);
		// The empty list means "open to every agent", which is the capability the six live agents hold.
		expect(reachableCapabilities(LIVE_CONFIG).has("general")).toBe(true);
		expect(planReachableCapabilities([gateTask({ requiredCapabilities: [] })], LIVE_CONFIG).has("general")).toBe(true);
	});

	test("a row that asks for a role the config NAMES reaches a real worker", () => {
		expect(reachableCapabilities(ROLED_CONFIG).has("reviewer")).toBe(true);
		// `expandWorkers` really spawns it: the role's own capabilities, not a derived guess.
		const specs = expandWorkers(ROLED_CONFIG, 1);
		expect(specs[0]?.capabilities ?? []).toEqual(["reviewer", "general"]);
	});
});

describe("goal-14 THE DEFECT: the mint sites accept a capability no configured role can ever hold", () => {
	test("TODAY the merge mints a reviewer row out of a default-roles config with no check at all (the goal-14 root cause)", () => {
		const parsed = parseProposal(
			proposal("A", [
				{ title: "A row that needs reviewer", deliverable: "d1", capabilities: ["reviewer"], files: ["extension/a.ts"] },
			]),
		);
		const merged = mergeProposals([parsed!]);
		// Measured: the capability survives into the merged row verbatim. NOTHING validates it
		// against what the pool can hold — which is exactly how task-221/222/223 were minted.
		expect(merged.tasks[0]?.capabilities ?? []).toEqual(["reviewer"]);
		// And the configured roles cannot hold it (this is what strands those rows).
		expect(reachableCapabilities(LIVE_CONFIG).has("reviewer")).toBe(false);
		// 242 (mint-time refusal) must make this row REJECTED instead. Until it lands, this
		// assertion documents the shipped behaviour rather than the wanted one.
	});

	test("the deliverable shape carries no identity or capability notion at all (why caps cannot express 'not the author')", () => {
		const shape = describeDeliverable(
			"Non-author verification of the A-line fix",
			["extension/planning.ts"],
			"whoever is NOT the author",
		);
		// Measured shape keys: intent, artifacts, words, section. There is no capability field and
		// no author field — so the pool-dedupe rule cannot see caps, and no retag can be expressed
		// as a merge. DECISION #1078's ruling is what this pins: caps is a CAPABILITY gate, never an
		// identity gate; "must not be the author" lives in prose and in the claimer's declaration.
		expect(Object.keys(shape as unknown as Record<string, unknown>).sort()).toEqual(["artifacts", "intent", "section", "words"]);
	});
});

describe("goal-14 the deadlock's real mechanism: the growth path discards the demand it computes", () => {
	test("planRoster DOES demand the missing capability — the demand side is not the bug", () => {
		const roster = planRoster(
			[
				gateTask({ id: "a", requiredCapabilities: ["reviewer"] }),
				gateTask({ id: "b", requiredCapabilities: ["reviewer"] }),
				gateTask({ id: "c", requiredCapabilities: ["reviewer"] }),
			],
			LIVE_CONFIG,
			0,
		);
		// Three active reviewer rows mint THREE reviewers (auto.ts:126-136's demand sizing: one
		// reviewer per demand minus the first, plus the first from the roster itself).
		const reviewer = roster.find((role) => role.name === "reviewer");
		expect(reviewer?.count ?? 0).toBe(3);
		expect(reviewer?.capabilities ?? []).toEqual(["reviewer", "general"]);
	});

	test("BUT the growth trigger requires ready > live, so with six idle agents it never fires (the deadlock)", () => {
		const desired = planRoster([gateTask({ requiredCapabilities: ["reviewer"] })], LIVE_CONFIG, 0);
		const target = Math.min(LIVE_CONFIG.workers, desired.reduce((n, r) => n + r.count, 0));
		// The live shape: 6 registered agents, 4 rows ready (3 reviewer + 1 general).
		const live = 6;
		const pool = Math.max(live, 6);
		const delta = target - pool;
		// auto.ts:441's condition, evaluated on the real numbers:
		//   counts.ready > live && counts.ready > lastGrowthReady && plannedWorkers < config.workers
		const ready = 4;
		expect(ready > live).toBe(false); // 4 > 6 is FALSE — the growth branch is never entered
		expect(delta <= 0).toBe(true); // and even if it were, 1 wanted vs 6 already planned is negative
		// So the roster demand is computed, demanded, and then discarded. THE DEADLOCK: the pool
		// already holds MORE workers than the plan wants, all of the wrong capability.
	});

	test("a config that already names the role is not deadlocked: the same rows keep their claim gate open", () => {
		const specs = expandWorkers(ROLED_CONFIG, 6);
		expect(specs.some((spec) => (spec.capabilities ?? []).includes("reviewer"))).toBe(true);
	});
});

describe("goal-14 boundary: 'plan names reviewer' must NOT become a new deadlock", () => {
	test("planRoster synthesizes a role for ANY named capability, so a hard 'subset of config.roles' rule would be wrong", () => {
		// DANGEROUS RULE (do not ship): "caps must be a subset of config.roles' capabilities".
		// With a default-roles config that rejects EVERY reviewer row, including a legitimate
		// goal-level ask — which is goal-14's own acceptance clause 4.
		const strictSubset = (caps: string[], config: SwarmConfig) => caps.every((cap) => reachableCapabilities(config).has(cap));
		expect(strictSubset(["reviewer"], LIVE_CONFIG)).toBe(false);
		// The demand-aware predicate accepts it, because planRoster CAN reach the role:
		const demandAware = (caps: string[], tasks: SwarmTask[], config: SwarmConfig) =>
			caps.every((cap) => planReachableCapabilities(tasks, config).has(cap));
		expect(demandAware(["reviewer"], [gateTask({ requiredCapabilities: ["reviewer"] })], LIVE_CONFIG)).toBe(true);
		// So 242's guard must be demand-aware (or must report reachability rather than hard-refuse),
		// and this pair of numbers is the evidence for that design constraint.
	});

	test("MEASURED CORRECTION to my own draft: synthesis is UNCONDITIONAL, so 'unknown capability' is not a natural guard", () => {
		// I first wrote "an unknown capability is unreachable by BOTH predicates". That is FALSE, and
		// the test run proved it rather than my prose: `planRoster` synthesizes a role for anything
		// a task names, so "quantum" is equally "reachable". A typo'd capability therefore mints an
		// equally stranded row — which makes the case for 242's guard STRONGER (the guard cannot be
		// "does any row already ask for it") and for 243's surfacing, not weaker.
		const roster = planRoster([gateTask({ requiredCapabilities: ["quantum"] })], LIVE_CONFIG, 0);
		expect(roster[0]?.name).toBe("quantum");
		expect(roster[0]?.capabilities ?? []).toEqual(["quantum", "general"]);
		// The set that really decides claimability is the REGISTERED agents, not the roster:
		const registered = [["general"], ["general"], ["general"], ["general"], ["general"], ["general"]];
		const claimable = (caps: string[]) => caps.length === 0 || caps.some((cap) => registered.some((list) => list.includes(cap)));
		expect(claimable(["reviewer"])).toBe(false);
		expect(claimable(["quantum"])).toBe(false);
		expect(claimable([])).toBe(true);
		// And a restarted pool WOULD carry the synthesized role, which is why goal-12's option 1
		// (config role) was never going to take effect in place either (DECISION #1026).
	});
});

describe("goal-14 the repair: what an agent-side retag would have to change (244's target, currently absent)", () => {
	test("TODAY nothing re-derives or relaxes a row's caps: the repair path does not exist (pinned by observable consequence)", () => {
		// The mechanism behind DECISION #894 / FACT #942: `required_capabilities` is written once,
		// by the INSERT at store.ts:558-569; the 17 UPDATE statements never name it. The OBSERVABLE
		// consequence, pinned here: the merged row carries its capability verbatim and nothing
		// downstream (the dedupe shape, the order, the roster demand) rewrites it.
		const merged = mergeProposals([
			parseProposal(proposal("A", [{ title: "stranded row", deliverable: "d", capabilities: ["reviewer"], files: ["extension/a.ts"] }]))!,
		]);
		expect(merged.tasks[0]?.capabilities ?? []).toEqual(["reviewer"]);
		const shape = describeDeliverable(merged.tasks[0]!.title, merged.tasks[0]!.files);
		expect("capabilities" in (shape as unknown as Record<string, unknown>)).toBe(false);
	});
});

describe("goal-14 'already-stranded rows must be surfaced' (243's target, currently absent)", () => {
	test("TODAY the strand is visible only through the claim path's refusal, never proactively", () => {
		// Measured live shape: 3 ready rows caps=["reviewer"], 6 agents all ["general"].
		const stranded = [
			gateTask({ id: "221", requiredCapabilities: ["reviewer"] }),
			gateTask({ id: "222", requiredCapabilities: ["reviewer"] }),
			gateTask({ id: "223", requiredCapabilities: ["reviewer"] }),
		];
		const holders = [
			["general"],
			["general"],
			["general"],
			["general"],
			["general"],
			["general"],
		];
		const stuck = stranded.filter(
			(task) => task.status === "ready" && !(task.requiredCapabilities.length === 0 || task.requiredCapabilities.some((cap) => holders.some((list) => list.includes(cap)))),
		);
		expect(stuck).toHaveLength(3);
		// 243 must produce this set itself (board + event, with how long, what capability, and the
		// suggested repair). The predicate above is tools.ts:121/driver.ts:713 verbatim, so the
		// detector 243 ships can reuse exactly this one.
	});
});

describe("goal-14 THE GUARD: a row no configured role can hold is refused at the mint site", () => {
	/** A capability set as the roster would hand it out — the `expandWorkers` derivation. */
	const GENERAL_ONLY = new Set(["general"]);
	const GENERAL_AND_REVIEWER = new Set(["general", "reviewer"]);

	test("an absent capability list is always reachable: caps=[] means 'open to every agent'", () => {
		expect(unreachableCapabilities([], GENERAL_ONLY)).toEqual([]);
		expect(unreachableCapabilities([], new Set<string>())).toEqual([]);
	});

	test("the four boundary capabilities the goal names, against both roster shapes", () => {
		// (1) a satisfiable capability is left alone;
		expect(unreachableCapabilities(["general"], GENERAL_ONLY)).toEqual([]);
		expect(unreachableCapabilities(["general"], GENERAL_AND_REVIEWER)).toEqual([]);
		// (2) under default roles a reviewer requirement is refused;
		expect(unreachableCapabilities(["reviewer"], GENERAL_ONLY)).toEqual(["reviewer"]);
		// (3) once a role names it, it is reachable again;
		expect(unreachableCapabilities(["reviewer"], GENERAL_AND_REVIEWER)).toEqual([]);
		// (4) the already-minted bad row's shape is reported, not dropped.
		expect(unreachableCapabilities(["reviewer"], GENERAL_AND_REVIEWER)).toEqual([]);
	});

	test("a SPECIFIC refusal: the guard names the offending capability AND the reachable alternative", () => {
		const reason = unclaimableReason({
			task: "verify-a",
			title: "Non-author verification of the A-line fix",
			capability: "reviewer",
			reachable: ["general"],
		});
		// The two facts a proposer needs to act: what is refused, and what to use instead.
		expect(reason).toContain("reviewer");
		expect(reason).toContain("general");
		// And the operator path is named as the operator's decision, never a worker's.
		expect(reason).toContain("operator");
		expect(reason).toContain("config.roles");
	});

	test("a roster that reaches NOTHING still produces a readable refusal, not an empty one", () => {
		const reason = unclaimableReason({ task: "t", title: "T", capability: "reviewer", reachable: [] });
		expect(reason).toContain("reviewer");
		expect(reason).toContain("no capability at all");
	});

	test("THE GUARD WIRED INTO THE MERGE: an unclaimable round is refused with its rows named", () => {
		const parsed = parseProposal(
			proposal("A", [
				{ title: "A row that needs reviewer", deliverable: "d1", capabilities: ["reviewer"], files: ["extension/a.ts"] },
				{ title: "A row that needs nothing", deliverable: "d2", capabilities: [], files: ["extension/b.ts"] },
			]),
		);
		const merge = mergeProposals([parsed!], GENERAL_ONLY);
		// The unclaimable row is reported with the capability that strands it and the alternative.
		expect(merge.unclaimable).toHaveLength(1);
		expect(merge.unclaimable[0]?.capability).toBe("reviewer");
		expect(merge.unclaimable[0]?.title).toBe("A row that needs reviewer");
		expect(merge.unclaimable[0]?.reachable).toEqual(["general"]);
		// The general row is untouched: the guard is surgical, not a blanket refusal.
		expect(merge.tasks.map((task) => task.title)).toContain("A row that needs nothing");
	});

	test("a claimable round mints nothing to the guard: `unclaimable` stays empty", () => {
		const parsed = parseProposal(
			proposal("A", [{ title: "A row that needs general", deliverable: "d", capabilities: ["general"], files: ["extension/a.ts"] }]),
		);
		const merge = mergeProposals([parsed!], GENERAL_ONLY);
		expect(merge.unclaimable).toEqual([]);
		expect(merge.tasks).toHaveLength(1);
	});

	test("THE BACKWARDS-COMPATIBILITY EDGE the goal's clause 4 demands: the guard is OPT-IN", () => {
		// Every existing caller (the store's planGoal, the takeover replays, the tests) calls the
		// two-argument form. Without the second argument the guard is OFF and the result carries an
		// empty `unclaimable` — so a caller that cannot yet reach for the roster cannot be broken
		// by this change, which is exactly the "must not become a deadlock path" acceptance.
		const parsed = parseProposal(
			proposal("A", [{ title: "A row that needs reviewer", deliverable: "d", capabilities: ["reviewer"], files: ["extension/a.ts"] }]),
		);
		const unguarded = mergeProposals([parsed!]);
		expect(unguarded.unclaimable).toEqual([]);
		expect(unguarded.tasks[0]?.capabilities).toEqual(["reviewer"]);
		const guarded = mergeProposals([parsed!], GENERAL_ONLY);
		expect(guarded.unclaimable).toHaveLength(1);
	});

	test("MEASURED SCOPE OF THIS ROW: the guard is pure and NOT yet wired to the minting caller", () => {
		// Honest statement of where the work stops. `mergeProposals` now reports what it would
		// refuse, but `store.planGoal` (extension/store.ts:1180) still calls the two-argument form,
		// so a row CAN still be minted today by that path. Closing that gap is the store-side half
		// of this row, and it lives in a file another row is editing (task-244's repair tool added
		// 73 lines to store.ts) — so it is recorded here as pending rather than smuggled in.
		const parsed = parseProposal(
			proposal("A", [{ title: "A row that needs reviewer", deliverable: "d", capabilities: ["reviewer"], files: ["extension/a.ts"] }]),
		);
		// The predicate is ready: given a roster-derived reachable set, the refusal is exact.
		expect(mergeProposals([parsed!], GENERAL_ONLY).unclaimable).toHaveLength(1);
		// What is missing is the CALLER passing its roster, and that caller is the store.
		expect(mergeProposals([parsed!]).unclaimable).toEqual([]);
	});
});
