/**
 * task-244's store-level tests: the repair is a real operation on real rows, with a real trail.
 *
 * THE ROW THIS FILE EXISTS FOR. task-221/222/223 sat `ready` with `caps=["reviewer"]` while all
 * six agents carried `["general"]` — visible to the host every tick as "ready work nobody online
 * can claim", with no outcome but a human editing the row. The pure half is pinned in
 * `caps-repair.test.ts`; this file pins the half that touches state: one INSERT, one
 * single-column UPDATE, one event, one board entry, and three refusals that keep the repair narrow.
 *
 * The first test is the incident itself, replayed end to end: mint, observe the strand, repair
 * through the store, and see the row become claimable WITHOUT anyone writing to the database
 * behind the store's back.
 *
 * An in-memory database over a tmpdir path (the pattern `auto.test.ts` already uses): every store
 * here is closed by the end of its test, so a file-backed database would only leave a Windows
 * file lock behind for `afterEach` to fight.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDatabase, openInMemoryDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore, type CapsRepairPolicy } from "../../extension/store";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

const openStores: SwarmStore[] = [];

function makeStore(): { store: SwarmStore; paths: SwarmPaths } {
	const paths = swarmPaths(join(tmpdir(), `caps-repair-${Math.random().toString(36).slice(2)}`));
	const store = new SwarmStore(openInMemoryDatabase(), paths);
	openStores.push(store);
	return { store, paths };
}

/** The live config, measured verbatim from this pool: 6 workers, no `roles` key. */
const LIVE: SwarmConfig = { ...DEFAULT_CONFIG, auto: true, workers: 6, roles: [] };
/** A config that DOES provide the capability, so the "operator adds a role" path is testable. */
const ROLED: SwarmConfig = {
	...DEFAULT_CONFIG,
	auto: true,
	workers: 6,
	roles: [{ name: "reviewer", count: 1, capabilities: ["reviewer", "general"] }],
};
const policy = (overrides: Partial<CapsRepairPolicy> = {}): CapsRepairPolicy => ({ config: LIVE, ...overrides });

describe("task-244 strandedRows: the incident, replayed", () => {
	test("mint a row nobody can claim, then repair it through the store and claim it", () => {
		const { store, paths } = makeStore();
		const strandedRow = store.createTask({
			title: "goal-11 B: independently verify the voting view",
			description: "caps that no role provides",
			requiredCapabilities: ["reviewer"],
			createdBy: "main",
		});
		store.registerAgent({ id: "generalist", role: "general", capabilities: ["general"] });

		// The strand is reported by the same predicate the claim gate uses.
		const stranded = store.strandedTasks(LIVE);
		expect(stranded.map((r) => r.id)).toEqual([strandedRow.id]);
		expect(stranded[0]?.missingCapabilities).toEqual(["reviewer"]);

		// And the claim gate refuses, exactly as the strand says it will.
		const refused = store.claim(strandedRow.id, "generalist", 60, ["general"]);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reason).toContain("missing capabilities");

		// Repair through the legitimate operation — no direct database write anywhere.
		const repaired = store.repairCaps(strandedRow.id, "generalist", policy({ reason: "stranded for two hours; nobody holds reviewer" }));
		expect(repaired.ok).toBe(true);
		expect(repaired.task?.requiredCapabilities).toEqual([]);

		// Now the same agent can claim it.
		const claimed = store.claim(strandedRow.id, "generalist", 60, ["general"]);
		expect(claimed.ok).toBe(true);

		// The trail: exactly one caps.repair event, naming what changed and who asked.
		const repairs = store.eventsOfType("caps.repair");
		expect(repairs).toHaveLength(1);
		expect(repairs[0]?.agentId).toBe("generalist");
		expect(repairs[0]?.taskId).toBe(strandedRow.id);
		expect(repairs[0]?.data).toMatchObject({ from: ["reviewer"], to: [] });
		const board = store.searchBoard({ query: "caps repair" });
		expect(board.length).toBeGreaterThan(0);
		expect(board.some((entry) => entry.content.includes(strandedRow.id))).toBe(true);
	});

	test("the audit entry says the row's text is unchanged, so a relaxed label is never mistaken for the original", () => {
		const { store } = makeStore();
		const row = store.createTask({ title: "stranded", requiredCapabilities: ["reviewer"], createdBy: "main" });
		store.repairCaps(row.id, "tester", policy());
		const entry = store.searchBoard({ query: "caps repair" }).find((e) => e.content.includes(row.id));
		expect(entry?.content).toContain("the row's own text is unchanged");
		// The row's own text really is unchanged: only the label moved.
		expect(store.getTask(row.id)?.title).toBe("stranded");
	});
});

describe("task-244 the repair stays narrow", () => {
	test("a CLAIMABLE row is refused: relaxing it would override a planner's routing", () => {
		const { store } = makeStore();
		const row = store.createTask({ title: "general work", requiredCapabilities: ["general"], createdBy: "main" });
		const result = store.repairCaps(row.id, "tester", policy());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("claimable");
		expect(store.getTask(row.id)?.requiredCapabilities).toEqual(["general"]);
	});

	test("when the config DOES provide the capability the same row is claimable, so still refused", () => {
		const { store } = makeStore();
		const row = store.createTask({ title: "reviewer work", requiredCapabilities: ["reviewer"], createdBy: "main" });
		const result = store.repairCaps(row.id, "tester", policy({ config: ROLED }));
		expect(result.ok).toBe(false);
		// The label therefore survives: the repair cannot be used to widen a working row.
		expect(store.getTask(row.id)?.requiredCapabilities).toEqual(["reviewer"]);
	});

	test("a row that requires nothing has nothing to repair", () => {
		const { store } = makeStore();
		const row = store.createTask({ title: "unlabelled", createdBy: "main" });
		expect(store.repairCaps(row.id, "tester", policy()).ok).toBe(false);
	});

	test("a claimed row is refused: no claimant is waiting", () => {
		const { store } = makeStore();
		const row = store.createTask({ title: "in flight", requiredCapabilities: ["reviewer"], createdBy: "main" });
		expect(store.claim(row.id, "someone", 60, ["reviewer"]).ok).toBe(true);
		const result = store.repairCaps(row.id, "tester", policy());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("claimed");
	});

	test("an unknown row is refused with a name, not a crash", () => {
		const { store } = makeStore();
		const result = store.repairCaps("task-9999", "tester", policy());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("unknown task");
	});
});

describe("task-244 the repair writes exactly one column", () => {
	test("a repair leaves priority, files, description, status and dependencies untouched", () => {
		const { store } = makeStore();
		const dep = store.createTask({ title: "prerequisite", createdBy: "main" });
		store.complete(dep.id, "main", { summary: "done" });
		const row = store.createTask({
			title: "stranded with a dependency",
			description: "this description must survive",
			priority: 7,
			files: ["extension/a.ts"],
			dependencies: [dep.id],
			requiredCapabilities: ["reviewer"],
			createdBy: "main",
		});
		const before = store.getTask(row.id)!;
		expect(store.repairCaps(row.id, "tester", policy()).ok).toBe(true);
		const after = store.getTask(row.id)!;
		expect(after.requiredCapabilities).toEqual([]);
		expect(after.priority).toBe(before.priority);
		expect(after.files).toEqual(before.files);
		expect(after.description).toBe(before.description);
		expect(after.status).toBe(before.status);
		// The dependency edge survives the repair and still resolves: the row is `waiting` on a dep
		// that is simply not swept back to `ready` yet, NOT `missing` or `cycle`. (A `done`
		// dependency stays listed — that is the row's history, not its blocker.)
		expect(store.deadDependencies(row.id)).toEqual([]);
		expect(store.blockedReason(row.id)).toBe("waiting");
	});
});
