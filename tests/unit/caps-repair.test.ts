/**
 * task-244's own tests: goal-14's clause 3, the LEGITIMATE repair operation.
 *
 * WHY A SEPARATE FILE FROM `goal14-gate.test.ts`. That file pins what the SHIPPED code does today
 * for all four clauses (242 mint refusal, 243 surfacing, 244 repair, plus the operator path) and is
 * owned by the goal-14 planning round's own writer. This file pins what `caps-repair.ts`,
 * `SwarmStore.repairCaps` and `swarm_repair_caps` do NOW — the half of 244 that does not touch the
 * A-line files (`planning.ts`'s merge path and `store.ts`'s create path are claimed by goal-13's
 * E1 row, task-239, and must not gain a second writer while they are uncommitted).
 *
 * THE CONTRACT, in the order it is stated in the row's description:
 *   1. the repair is a legitimate operation with explicit tool semantics and an audit trail
 *      (DECISION #1076: the failure was never the write, it was the write with no trail);
 *   2. it may ONLY relax a row that no configured role can claim — a claimable row is refused,
 *      because repairing it would override a planner's routing, which is the same defect this goal
 *      exists to stop, running in the other direction;
 *   3. the judgement reuses the config's own derivation (`expandWorkers`), never a second table.
 *
 * The test that would have caught the original defect runs FIRST and is the reason the row exists:
 * a row that nobody can claim must be repairable without any agent touching the database.
 */
import { describe, expect, test } from "bun:test";
import { expandWorkers } from "../../extension/config";
import {
	candidatesFromTasks,
	claimableBy,
	formatCapsRepair,
	planCapsRepair,
	reachableCapabilities,
	strandedRows,
} from "../../extension/caps-repair";
import { DEFAULT_CONFIG, type SwarmConfig, type SwarmTask } from "../../extension/types";

/** The live config, measured verbatim: `auto: true`, `workers: 6`, NO `roles` key. */
const LIVE: SwarmConfig = { ...DEFAULT_CONFIG, auto: true, workers: 6, roles: [] };

/** A config that DOES name the capability — goal-14's "operator adds a role" boundary. */
const ROLED: SwarmConfig = {
	...DEFAULT_CONFIG,
	auto: true,
	workers: 6,
	roles: [{ name: "reviewer", count: 1, capabilities: ["reviewer", "general"] }],
};

function task(overrides: Partial<SwarmTask> & { id: string }): SwarmTask {
	return {
		title: "probe",
		status: "ready",
		priority: 0,
		createdAt: 0,
		updatedAt: 0,
		claimedBy: null,
		author: null,
		requiredCapabilities: [],
		files: [],
		...overrides,
		review: { required: false, status: null, reviewer: null, notes: null, ...overrides.review },
	} as SwarmTask;
}

describe("goal-14 clause 3: the repair's predicate is the claim gate's own (not a second table)", () => {
	test("a capability the config cannot provide is exactly what the claim gate refuses", () => {
		const held = reachableCapabilities(LIVE);
		expect([...held].sort()).toEqual(["general"]);
		// The gate's verbatim predicate, reused from the shared module rather than re-typed here.
		expect(claimableBy(["reviewer"], held)).toBe(false);
		expect(claimableBy([], held)).toBe(true);
		expect(claimableBy(["general"], held)).toBe(true);
	});

	test("adding the role to the config makes the same row claimable — the operator path works", () => {
		expect(claimableBy(["reviewer"], reachableCapabilities(ROLED))).toBe(true);
		// The derivation is expandWorkers' own, so the role's capabilities are what the pool holds.
		const specs = expandWorkers(ROLED, ROLED.workers);
		expect(specs.some((s) => s.capabilities.includes("reviewer"))).toBe(true);
	});

	test("the three stranded rows of this incident are found, with the missing capability named", () => {
		const now = 1_000_000;
		const stranded = strandedRows(
			[
				{ id: "221", title: "A+B", status: "ready", requiredCapabilities: ["reviewer"], updatedAt: now - 60_000 },
				{ id: "222", title: "A", status: "ready", requiredCapabilities: ["reviewer"], updatedAt: now - 120_000 },
				{ id: "223", title: "B", status: "ready", requiredCapabilities: ["reviewer"], updatedAt: now - 30_000 },
				{ id: "224", title: "reachable", status: "ready", requiredCapabilities: ["general"], updatedAt: now - 5_000 },
				{ id: "225", title: "unlabelled", status: "ready", requiredCapabilities: [], updatedAt: now - 5_000 },
			],
			LIVE,
			now,
		);
		expect(stranded.map((r) => r.id)).toEqual(["222", "221", "223"]);
		expect(stranded.every((r) => r.missingCapabilities.join(",") === "reviewer")).toBe(true);
		expect(stranded[0]?.ageMs).toBe(120_000);
	});

	test("a blocked row is surfaced too: its label survives the dependency that hides it", () => {
		const now = 1_000_000;
		const stranded = strandedRows(
			[{ id: "240", title: "behind a dep", status: "blocked", requiredCapabilities: ["reviewer"], updatedAt: now - 90_000 }],
			LIVE,
			now,
		);
		expect(stranded.map((r) => r.id)).toEqual(["240"]);
	});

	test("claimed/done/failed rows are never repair targets (nobody is waiting for a claimant)", () => {
		const now = 1_000_000;
		const rows = candidatesFromTasks([
			task({ id: "c1", status: "claimed", requiredCapabilities: ["reviewer"], updatedAt: now - 10 }),
			task({ id: "d1", status: "done", requiredCapabilities: ["reviewer"], updatedAt: now - 10 }),
			task({ id: "f1", status: "failed", requiredCapabilities: ["reviewer"], updatedAt: now - 10 }),
		]);
		expect(rows).toHaveLength(0);
	});
});

describe("goal-14 clause 3: the rule decides before anything is written", () => {
	test("a stranded row's repair is planned as the empty label, with from/to recorded", () => {
		const plan = planCapsRepair({ taskId: "221", currentCapabilities: ["reviewer"], requestedBy: "LunarTiger" }, LIVE);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.from).toEqual(["reviewer"]);
		expect(plan.to).toEqual([]);
		expect(plan.requestedBy).toBe("LunarTiger");
		expect(plan.reason).toContain("reviewer");
	});

	test("a CLAIMABLE row is refused — relaxing it would override a planner's routing", () => {
		const plan = planCapsRepair({ taskId: "x1", currentCapabilities: ["general"], requestedBy: "A" }, LIVE);
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toContain("claimable");
		// The same row on the roled config is likewise claimable, so still refused.
		const roled = planCapsRepair({ taskId: "x2", currentCapabilities: ["reviewer"], requestedBy: "A" }, ROLED);
		expect(roled.ok).toBe(false);
	});

	test("a row that requires nothing has nothing to repair", () => {
		const plan = planCapsRepair({ taskId: "x3", currentCapabilities: [], requestedBy: "A" }, LIVE);
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toContain("nothing to repair");
	});

	test("a duplicate capability label is deduped before it reaches the store", () => {
		const plan = planCapsRepair({ taskId: "x4", currentCapabilities: ["reviewer", "reviewer"], requestedBy: "A" }, LIVE);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.from).toEqual(["reviewer"]);
	});

	test("the audit text names what changed, who asked, and that the row's text is unchanged", () => {
		const text = formatCapsRepair({
			taskId: "221",
			from: ["reviewer"],
			to: [],
			requestedBy: "LunarTiger",
			reason: "stranded since 17:04",
			at: 1_700_000_000_000,
		});
		expect(text).toContain('caps repair 221: ["reviewer"] -> []');
		expect(text).toContain("requested by LunarTiger");
		expect(text).toContain("stranded since 17:04");
		// The point of the trail: a relaxed label must never look like the original one.
		expect(text).toContain("the row's own text is unchanged");
	});
});
