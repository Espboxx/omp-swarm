/**
 * goal-17's L3: the coordinator ledger, in the measured form it fixed.
 *
 * WHY THIS FILE EXISTS, IN THE MEASURED FORM. Every goal this pool opens starts from nothing. The
 * board already carried 361 FAIL/DECISION conclusions across 17 goals when this was written — 76 of
 * 162 distinct classes already answered by a DECISION — and a new goal's planning round read NONE of
 * it. The operator's observation is the measured cost: 200 board entries mention the reviewer-capability
 * knot, spread over eight separate goals (goal-5, 6, 11, 12, 13, 14, 15, 16), and the knot was
 * re-diagnosed from scratch more than once because nothing handed the next coordinator what the last
 * one already knew.
 *
 * WHAT IS MEASURED HERE, in the two halves `failure-gate.test.ts` uses:
 *
 *   1. THE PURE RULE — `goalLedger`, `goalKind`/`goalArtifacts`/`goalFingerprint`, `ledgerInjection`
 *      and `goalDuplicateVerdict` are pure: entries in, a verdict out. No store, no clock.
 *   2. THE WIRING — a real `SwarmStore` on a real database, driven through `createGoal` itself, so
 *      "the board carries conclusions → the goal's planning task carries them in its brief" is a
 *      measurement of behaviour, and the fresh-pool brief is proven byte-identical to the pre-L3 one.
 *
 * THE FINDING THAT SHAPED THE SHAPE. A goal-level duplicate REFUSAL refuses nothing on this pool:
 * measured over the 17 live goals, 0 exact-duplicate texts, 0 pairs at >=0.6 word overlap, and 0
 * kind+artifact fingerprint collisions. So the shipped shape is the one the goal's own text names for
 * exactly this case ("只做注入不做拒绝"): inject what is known, report the honest verdict, keep the
 * refusal off behind `LEDGER_REFUSE_DUPLICATES`. A test that pretended the gate refuses anything
 * would be testing a fiction, so the tests below measure what the ledger actually decides.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	LEDGER_READ_LIMIT,
	goalArtifacts,
	goalDuplicateVerdict,
	goalFingerprint,
	goalKind,
	goalLedger,
	ledgerInjection,
	type LedgerEntry,
} from "../../extension/coordinator-ledger";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { planningTaskBrief, goalTag } from "../../extension/planning";

/** One conclusion row as the ledger reads it. */
function entry(id: number, type: string, tags: string[]): LedgerEntry {
	return { id, type, agentId: "A", tags };
}

/** The kind each goal asked for, as `coordinatorLedger()` supplies it from the goals table. */
const kinds = new Map([
	["goal-1", "fix" as const],
	["goal-2", "verify" as const],
	["goal-3", "diagnose" as const],
]);

describe("goalKind and goalArtifacts read what a goal is about", () => {
	test("the kind comes from the vocabulary, in English and Chinese", () => {
		expect(goalKind("Verify extension/store.ts against the contract")).toBe("verify");
		expect(goalKind("Fix the broken mint")).toBe("fix");
		expect(goalKind("Document the ledger")).toBe("document");
		expect(goalKind("Diagnose why the round died")).toBe("diagnose");
		expect(goalKind("闭环 goal-16 之后的验证与固化")).toBe("verify");
		expect(goalKind("ship the thing")).toBe("other");
	});

	test("the artifacts are the named files and paths, never a word list", () => {
		expect(goalArtifacts("Fix `extension/store.ts` now")).toEqual(["extension/store.ts"]);
		expect(goalArtifacts("touch omp-swarm/extension/tools.ts and tests/unit/x.test.ts")).toEqual(["extension/tools.ts", "tests/unit/x.test.ts"]);
		// A prose word list is the keyword `LIKE` trap: 9 of this pool's 17 goals say "token" or
		// "burn" while doing different work, so a word list would collide them all.
		expect(goalArtifacts("the idle workers burn token forever")).toEqual([]);
		// Two spellings of one path fold — the repo prefix is stripped, exactly as the merge's own
		// `canonicalArtifact` reduction does (measured: without the strip they are two artifacts).
		expect(goalArtifacts("`extension/store.ts` and extension/store.ts")).toEqual(["extension/store.ts"]);
		expect(goalArtifacts("`omp-swarm/extension/store.ts` and extension/store.ts")).toEqual(["extension/store.ts"]);
	});

	test("the fingerprint joins kind + artifacts with the unit separator, and is empty with no artifact", () => {
		expect(goalFingerprint("Fix `extension/store.ts`")).toBe("fix\x1fextension/store.ts");
		// A goal with nothing to key on can never be called a duplicate of another one.
		expect(goalFingerprint("make the pool stop spinning")).toBe("");
	});
});

describe("goalLedger indexes the conclusions a new goal must be handed", () => {
	const rows = [
		entry(1, "FAIL", ["fail", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
		entry(2, "DECISION", ["decision", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
		entry(3, "FAIL", ["fail", "goal:goal-2", "tests/unit/x.test.ts"]),
		entry(4, "OBSERVATION", ["proposal", "goal:goal-2"]), // not a conclusion: filtered out
		entry(5, "RESULT", ["result", "goal:goal-1"]), // not a conclusion either
		entry(6, "FAIL", ["fail"]), // no class-bearing tag: unclassifiable
	];

	test("only FAIL and DECISION rows are read, and each class is indexed once", () => {
		const ledger = goalLedger(rows);
		expect(ledger.readRows).toBe(4); // rows 1, 2, 3 and 6: the OBSERVATION and RESULT are not conclusions
		expect(ledger.classes.length).toBe(2);
		expect(ledger.unclassifiableRows).toBe(1);
		const answered = ledger.classes.find((c) => c.answered === true);
		expect(answered?.key).toBe("extension/store.ts,goal:goal-1,reviewer-knot");
		expect(answered?.count).toBe(2);
		expect(answered?.entryIds).toEqual([1, 2]);
		expect(answered?.latestId).toBe(2);
		expect(ledger.answeredCount).toBe(1);
		expect(ledger.openCount).toBe(1);
	});

	test("the class's kinds come from the caller's goal rows, so a new goal's kind can be compared", () => {
		const ledger = goalLedger(rows, kinds);
		const knot = ledger.classes.find((c) => c.key.includes("reviewer-knot"));
		expect(knot?.kinds).toEqual(["fix"]); // goal-1 asked for a fix
	});

	test("the caller's limit is honoured, so a bigger board is not read whole", () => {
		const many: LedgerEntry[] = [];
		for (let id = 1; id <= 20; id += 1) many.push(entry(id, "FAIL", ["fail", `class-${id}`, "goal:goal-1"]));
		const capped = goalLedger(many, kinds, 5);
		expect(capped.readRows).toBe(5);
		expect(capped.classes.length).toBe(5);
		expect(LEDGER_READ_LIMIT).toBe(500);
	});

	test("an empty board produces an empty ledger, not a division", () => {
		const ledger = goalLedger([]);
		expect(ledger.classes).toEqual([]);
		expect(ledger.readRows).toBe(0);
		expect(ledger.answeredCount).toBe(0);
		expect(ledger.openCount).toBe(0);
		expect(ledgerInjection(ledger, "anything", goalDuplicateVerdict(ledger, "anything"))).toBe("");
	});
});

describe("goalDuplicateVerdict: the strict reading of 'open goal 按指纹去重'", () => {
	const rows = [
		entry(1, "FAIL", ["fail", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
		entry(2, "DECISION", ["decision", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
		entry(3, "FAIL", ["fail", "goal:goal-2", "tests/unit/x.test.ts"]), // open, never answered
	];

	test("a goal that names no artifact is never a duplicate — a text comparison is the keyword trap", () => {
		const ledger = goalLedger(rows, kinds);
		const verdict = goalDuplicateVerdict(ledger, "the pool keeps spinning");
		expect(verdict.duplicate).toBe(false);
		expect(verdict.reason).toContain("names no artifact");
	});

	test("a goal whose artifacts sit in an UNANSWERED class is not a duplicate: new work on known ground", () => {
		const ledger = goalLedger(rows, kinds);
		const verdict = goalDuplicateVerdict(ledger, "Verify tests/unit/x.test.ts");
		expect(verdict.duplicate).toBe(false);
		expect(verdict.reason).toContain("no answered class");
	});

	test("the same artifacts under the same kind, in an ANSWERED class, is the duplicate", () => {
		const ledger = goalLedger(rows, kinds);
		const verdict = goalDuplicateVerdict(ledger, "Fix `extension/store.ts` again");
		expect(verdict.duplicate).toBe(true);
		expect(verdict.key).toBe("extension/store.ts,goal:goal-1,reviewer-knot");
		expect(verdict.priorEntryIds).toEqual([1, 2]);
		expect(verdict.reason).toContain("already answered by a DECISION");
		expect(verdict.remedy).toContain("read those entries before opening this round");
	});

	test("a DIFFERENT kind on the same artifacts is different work — a verify of a settled fix is not a duplicate", () => {
		const ledger = goalLedger(rows, kinds);
		const verdict = goalDuplicateVerdict(ledger, "Verify `extension/store.ts`");
		expect(verdict.duplicate).toBe(false);
	});
});

describe("ledgerInjection: the text the round is handed", () => {
	test("an empty board injects nothing, so a fresh pool's brief is unchanged", () => {
		const ledger = goalLedger([], kinds);
		expect(ledgerInjection(ledger, "ship it", goalDuplicateVerdict(ledger, "ship it"))).toBe("");
	});

	test("a populated board injects the answered classes with their entry ids, and the open ones separately", () => {
		const rows = [
			entry(1, "FAIL", ["fail", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
			entry(2, "DECISION", ["decision", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
			entry(3, "FAIL", ["fail", "goal:goal-2", "scratch/goal11/A.md"]),
		];
		const ledger = goalLedger(rows, kinds);
		const text = ledgerInjection(ledger, "Verify extension/store.ts", goalDuplicateVerdict(ledger, "Verify extension/store.ts"));
		expect(text).toContain("COORDINATOR LEDGER (goal-17 L3)");
		expect(text).toContain("3 conclusion row(s) read, 2 distinct class(es): 1 already answered by a DECISION, 1 still open");
		expect(text).toContain("extension/store.ts,goal:goal-1,reviewer-knot — 2 entry(ies) (1, 2), newest DECISION #2");
		expect(text).toContain("Still open (dead ends earlier rounds met):");
		// The class key is the SORTED tag set, so `goal:goal-2` sorts before `scratch/...`: the
		// injection prints the key the index already holds rather than re-spelling it.
		expect(text).toContain("goal:goal-2,scratch/goal11/A.md");
		// A NON-duplicate goal gets the ledger without the warning section at all: the reminder is
		// what was already known, not an accusation that this round is a repeat.
		expect(text).not.toContain("DUPLICATE WARNING");
	});

	test("a duplicate verdict is injected as a warning with its remedy, and the default does not refuse", () => {
		const rows = [
			entry(1, "FAIL", ["fail", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
			entry(2, "DECISION", ["decision", "goal:goal-1", "extension/store.ts", "reviewer-knot"]),
		];
		const ledger = goalLedger(rows, kinds);
		const verdict = goalDuplicateVerdict(ledger, "Fix `extension/store.ts` again");
		const text = ledgerInjection(ledger, "Fix `extension/store.ts` again", verdict);
		expect(text).toContain("DUPLICATE WARNING:");
		expect(text).toContain("REMEDY: read those entries before opening this round");
		expect(text).toContain("This is an injection, not a refusal");
		expect(text).not.toContain("REFUSE this goal");
	});
});

describe("the wiring: a real store, driven through the real createGoal", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows may still hold the WAL handle for a moment; the OS temp dir is disposable.
			}
		}
	});

	function makeStore(): { store: SwarmStore; paths: SwarmPaths } {
		const paths = swarmPaths(mkdtempSync(join(tmpdir(), "swarm-l3-")));
		roots.push(paths.root);
		return { store: new SwarmStore(openDatabase(paths), paths), paths };
	}

	test("a fresh pool's planning brief is byte-identical to the pre-L3 brief", () => {
		const { store } = makeStore();
		const opened = store.createGoal({ goal: "Ship the split logic", agents: 2, createdBy: "main" });
		const expected = planningTaskBrief({ id: "goal-1", goal: "Ship the split logic", agents: 2, createdBy: "main" });
		expect(opened.planningTask.description).toBe(expected);
		store.close();
	});

	test("a board that already carries conclusions injects them into the new goal's brief", () => {
		const { store } = makeStore();
		const task = store.createTask({ title: "Fix extension/store.ts identity key", createdBy: "boot" });
		store.claim(task.id, "A", 300, ["general"]);
		store.fail(task.id, "A", "the capability is unreachable: reviewer missing");
		store.postBoard({ type: "FAIL", agentId: "A", content: "reviewer knot again", tags: ["fail", "goal:goal-1", "extension/store.ts", "reviewer-knot"] });
		store.postBoard({ type: "DECISION", agentId: "B", content: "answered: retag the caps", tags: ["decision", "goal:goal-1", "extension/store.ts", "reviewer-knot"] });

		const opened = store.createGoal({ goal: "Verify extension/store.ts against the contract", agents: 3, createdBy: "main" });
		const description = opened.planningTask.description;
		expect(description).toContain("COORDINATOR LEDGER (goal-17 L3)");
		expect(description).toContain("extension/store.ts,goal:goal-1,reviewer-knot");
		expect(description).toContain("newest DECISION #2");
		// The pre-L3 brief is still there, ahead of the injection: the round's instructions are not displaced.
		expect(description).toContain("This is the goal's ONLY planning task");
		expect(description.indexOf("This is the goal's ONLY planning task")).toBeLessThan(description.indexOf("COORDINATOR LEDGER"));

		// And the goal.open event carries the counts, so the audit trail shows what the round was handed.
		const event = store.recentEvents(10).find((e) => e.type === "goal.open");
		expect(event?.data.ledgerRows).toBe(3);
		expect(event?.data.ledgerClasses).toBe(1);
		expect(event?.data.ledgerAnswered).toBe(1);
		store.close();
	});

	test("coordinatorLedger() reports the real classes, and the verdict it computes is honest", () => {
		const { store } = makeStore();
		const opened = store.createGoal({ goal: "Fix extension/store.ts and retag the reviewer caps", agents: 2, createdBy: "main" });
		// The real pool tags conclusions with its own goal's id, which is what the store's ledger
		// reads the kind from. A tag naming a goal row that does not exist contributes no kind —
		// measured on a fresh store, the class still indexes but its kinds are empty, and the
		// verdict refuses to call an unkinded class a duplicate.
		store.postBoard({ type: "FAIL", agentId: "A", content: "knot", tags: ["fail", goalTag(opened.goal.id), "extension/store.ts", "reviewer-knot"] });
		store.postBoard({ type: "DECISION", agentId: "B", content: "answered", tags: ["decision", goalTag(opened.goal.id), "extension/store.ts", "reviewer-knot"] });
		const ledger = store.coordinatorLedger();
		expect(ledger.readRows).toBeGreaterThanOrEqual(2);
		expect(ledger.answeredCount).toBeGreaterThanOrEqual(1);
		const knot = ledger.classes.find((c) => c.key.includes("reviewer-knot"));
		expect(knot?.answered).toBe(true);
		expect(knot?.kinds).toEqual(["fix"]); // the goal's own text named a fix
		store.close();
	});

	test("a class whose goal row no longer exists keeps its class and simply carries no kind", () => {
		const { store } = makeStore();
		store.postBoard({ type: "FAIL", agentId: "A", content: "knot", tags: ["fail", goalTag("goal-99"), "extension/store.ts", "reviewer-knot"] });
		store.postBoard({ type: "DECISION", agentId: "B", content: "answered", tags: ["decision", goalTag("goal-99"), "extension/store.ts", "reviewer-knot"] });
		const ledger = store.coordinatorLedger();
		const knot = ledger.classes.find((c) => c.key.includes("reviewer-knot"));
		expect(knot?.answered).toBe(true);
		expect(knot?.kinds).toEqual([]);
		// With no kind to compare, the duplicate verdict refuses rather than guessing: an unkinded
		// class must never be the reason a new goal is called a repeat.
		const verdict = goalDuplicateVerdict(ledger, "Fix `extension/store.ts`");
		expect(verdict.duplicate).toBe(false);
		expect(verdict.reason).toContain("no answered class");
		store.close();
	});
});

/**
 * REPLAY — the surface the injection is measured against, against the live pool. `createGoal`'s
 * injection is read-only, so this can be run against the live root without a copy:
 *
 * ```bash
 * cd C:/Users/93715/code/test4 && bun -e '
 * const {Database} = require("bun:sqlite");
 * const {boardClassKey, boardClasses} = require("./omp-swarm/extension/board.ts");
 * const db = new Database(".swarm/swarm.db", {readonly: true});
 * const rows = db.query("SELECT id,type,agent_id,tags FROM board WHERE type IN (\x27FAIL\x27,\x27DECISION\x27) ORDER BY id").all()
 *   .map(r => ({id:r.id,type:r.type,agentId:r.agent_id,tags:JSON.parse(r.tags)}));
 * const classes = boardClasses(rows);
 * const answered = classes.filter(c => c.types.includes("DECISION"));
 * console.log("conclusion rows", rows.length, "classes", classes.length, "answered", answered.length);
 * const unclassifiable = rows.filter(r => boardClassKey(r) === "").length;
 * console.log("rows with no class key", unclassifiable);
 * '
 * ```
 *
 * Measured when this file was written: `conclusion rows 361, classes 162, answered 76, rows with no
 * class key 199`. The 199 unclassifiable rows are why the ledger's INJECTION is the value and its
 * REFUSAL is off: over half the board's conclusions carry no class-bearing tag at all, so a gate that
 * refused on the other half would be reading a partial index and calling it the truth.
 */
