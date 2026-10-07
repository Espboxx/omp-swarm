/**
 * goal-15's R1 index: the durable memory the board never had.
 *
 * The two failure shapes this file pins, both measured in this session's real board data
 * (`.swarm/swarm.db`, 328 FAIL/DECISION rows):
 *
 *   1. The four "SUPERSEDED / DUPLICATE — Same deliverable as canonical task-150" entries (#584-587,
 *      #591-597) are ONE class under a rephrasing — a content hash would call them four classes and
 *      dedupe none of them, which is exactly the loop the operator watched.
 *   2. A keyword `LIKE` search cannot tell "already posted" from "mentions the same word": entries
 *      #257/#264 carry the same class as #223/#227 with completely different headlines.
 */
import { describe, expect, test } from "bun:test";
import { boardClassKey, boardClasses, boardDuplicateVerdict, repeatedBoardClasses } from "../../extension/board";

/** One board row in the shape the index reads: id, type, agent, and the tags that name its class. */
const entry = (id: number, type: string, agentId: string, tags: string[]) => ({ id, type, agentId, tags });

describe("the class key: WHAT an entry says, not how it was worded", () => {
	test("two rephrasings of the same failure are one class", () => {
		// The real shape: the same class posted under four different lead sentences.
		const a = entry(584, "FAIL", "BrightTiger", ["failure", "superseded", "duplicate"]);
		const b = entry(585, "FAIL", "BrightTiger", ["failure", "superseded", "duplicate"]);
		expect(boardClassKey(a)).toBe(boardClassKey(b));
		expect(boardClassKey(a)).toBe("duplicate,superseded");
	});

	test("a tag's order and its duplicates are not part of the identity", () => {
		expect(boardClassKey(entry(1, "FAIL", "a", ["b", "a", "a"]))).toBe(boardClassKey(entry(2, "FAIL", "a", ["a", "b"])));
	});

	test("a keyword overlap is NOT a shared class: one shared tag is not enough on its own", () => {
		const a = entry(1, "FAIL", "a", ["duplicate"]);
		const b = entry(2, "FAIL", "a", ["duplicate", "width"]);
		expect(boardClassKey(a)).not.toBe(boardClassKey(b));
	});

	test("the meta tags name the entry's TYPE, so they never identify a class", () => {
		// `fail` vs `failure` vs `fact` are labels for what the entry IS. Two entries that differ only
		// by those are the same class, not two classes.
		expect(boardClassKey(entry(1, "FAIL", "a", ["fail", "reservations"]))).toBe(boardClassKey(entry(2, "FACT", "a", ["fact", "reservations"])));
	});

	test("a task-<id> tag names one row, so it is not part of a cross-row class", () => {
		// task-58/59/60 were four rows repeating ONE class; keying on the row id would make four classes.
		expect(boardClassKey(entry(58, "FAIL", "a", ["task-58", "failure", "duplicate"]))).toBe("duplicate");
	});

	test("an iteration-<n> tag names a round, so it is not part of a class", () => {
		expect(boardClassKey(entry(1, "DECISION", "a", ["iteration-3", "panel"]))).toBe("panel");
	});

	test("an entry with no class-bearing tag has an empty key, so it is never called a repeat", () => {
		expect(boardClassKey(entry(1, "FAIL", "a", ["fail"]))).toBe("");
		expect(boardClassKey(entry(1, "OBSERVATION", "a", []))).toBe("");
		expect(boardClassKey(entry(1, "PROPOSAL", "a", ["proposal", "goal:goal-3"]))).toBe("goal:goal-3");
	});

	test("a goal tag scopes the class, because that is the level the operator measured", () => {
		expect(boardClassKey(entry(1, "FAIL", "a", ["goal:goal-11", "reservations"]))).toBe("goal:goal-11,reservations");
		expect(boardClassKey(entry(2, "FAIL", "a", ["reservations", "goal:goal-9"]))).toBe("goal:goal-9,reservations");
	});
});

describe("the index: every class with its full history", () => {
	const board = [
		entry(100, "OBSERVATION", "CalmTiger", ["dedupe", "goal:goal-11"]),
		entry(150, "FAIL", "LunarTiger", ["dedupe", "goal:goal-11"]),
		entry(200, "FAIL", "SwiftTiger", ["dedupe", "goal:goal-11"]),
		entry(210, "OBSERVATION", "BrightTiger", ["reservations"]),
	];

	test("one class, every prior id, newest first", () => {
		const found = boardClasses(board).find((entry) => entry.key === "dedupe,goal:goal-11");
		expect(found).toBeDefined();
		expect(found?.count).toBe(3);
		expect(found?.entryIds).toEqual([100, 150, 200]);
		expect(found?.latestId).toBe(200);
	});

	test("every agent that posted a class is named, newest first", () => {
		const found = boardClasses(board).find((entry) => entry.key === "dedupe,goal:goal-11");
		expect(found?.agentIds).toEqual(["SwiftTiger", "LunarTiger", "CalmTiger"]);
	});

	test("the types read newest-first so an answer after a report is visible", () => {
		const found = boardClasses(board).find((entry) => entry.key === "dedupe,goal:goal-11");
		expect(found?.types).toEqual(["FAIL", "FAIL", "OBSERVATION"]);
	});

	test("a single-entry class is not a repeat", () => {
		expect(repeatedBoardClasses(board).map((entry) => entry.key)).toEqual(["dedupe,goal:goal-11"]);
	});

	test("entries with no class-bearing tag are dropped from the index, not bucketed together", () => {
		const withNoise = [...board, entry(300, "FAIL", "a", ["fail"]), entry(301, "OBSERVATION", "a", [])];
		// Newest first: `reservations` is #210, `dedupe,goal:goal-11`'s newest is #200.
		expect(boardClasses(withNoise).map((entry) => entry.key)).toEqual(["reservations", "dedupe,goal:goal-11"]);
	});
});

describe("boardDuplicateVerdict: already posted, and already answered?", () => {
	const board = [
		entry(100, "OBSERVATION", "CalmTiger", ["dedupe", "goal:goal-11"]),
		entry(150, "FAIL", "LunarTiger", ["dedupe", "goal:goal-11"]),
	];

	test("a brand-new class is the first report, with no prior ids", () => {
		const verdict = boardDuplicateVerdict(board, { tags: ["width", "failure"] });
		expect(verdict.known).toBe(false);
		expect(verdict.priorCount).toBe(0);
		expect(verdict.priorEntryIds).toEqual([]);
		expect(verdict.reason).toContain("first report");
	});

	test("a repeat of an UNANSWERED class is named a repeat, with its history", () => {
		const verdict = boardDuplicateVerdict(board, { tags: ["fail", "dedupe", "goal:goal-11"] });
		expect(verdict.key).toBe("dedupe,goal:goal-11");
		expect(verdict.known).toBe(true);
		expect(verdict.remedied).toBe(false);
		expect(verdict.priorCount).toBe(2);
		expect(verdict.priorEntryIds).toEqual([100, 150]);
		expect(verdict.reason).toContain("NOT yet answered");
	});

	test("a DECISION answers the class even when a later OBSERVATION re-reports it", () => {
		// The real sequence: report, answer, fresh sighting. The answer still stands.
		const answered = [...board, entry(180, "DECISION", "SwiftTiger", ["dedupe", "goal:goal-11"]), entry(190, "OBSERVATION", "a", ["dedupe", "goal:goal-11"])];
		const verdict = boardDuplicateVerdict(answered, { tags: ["dedupe", "goal:goal-11"] });
		expect(verdict.remedied).toBe(true);
		expect(verdict.priorCount).toBe(4);
		expect(verdict.reason).toContain("DECISION #180");
	});

	test("the meta-tag difference between the entries never changes the verdict", () => {
		const verdict = boardDuplicateVerdict(board, { tags: ["failure", "dedupe", "goal:goal-11"] });
		expect(verdict.known).toBe(true);
		expect(verdict.key).toBe(boardDuplicateVerdict(board, { tags: ["fail", "dedupe", "goal:goal-11"] }).key);
	});

	test("an entry that names no class is never mistaken for a repeat", () => {
		const verdict = boardDuplicateVerdict(board, { tags: ["fail"] });
		expect(verdict.known).toBe(false);
		expect(verdict.key).toBe("");
		expect(verdict.reason).toContain("no class-bearing tag");
	});
});
