/**
 * The vote panel's data layer, asserted against REAL recorded snapshots — never against prose.
 *
 * Two kinds of evidence, each for what it can prove:
 *   - the FIXTURE snapshot (`web/assets/fixtures/snapshot.json`, checked in and stable): every
 *     deterministic claim — a settled round's tally, its reason, its board entry, an OPEN round's
 *     question/kind/deadline, and the open-round ballot gap;
 *   - the LIVE snapshot (`scratch/goal11/live-snapshot.json`, a real `/api/snapshot` read of this
 *     swarm's own database): the claim that the real mechanism's writes parse into the same shapes.
 *     Only feed-drift-proof assertions are made on it: the rounds it still carries, their statuses and
 *     their published tallies. A live feed drops old rows at `feed.limit`, so anything that depends on
 *     a specific `vote.open` still being present belongs on the fixture instead.
 *
 * The contract under test is the panel's honesty rule: every number on screen is READ from the
 * snapshot, and what the snapshot does not publish stays `null` / empty rather than being guessed. The
 * open-round ballot gap is the case the goal names ("report the gap instead of inventing placeholders").
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { voteBoardIds, votesFromSnapshot } from "../../web/assets/votes.js";
import type { VoteView } from "../../web/assets/votes";

const FIXTURE_SNAPSHOT = join(import.meta.dir, "..", "..", "web", "assets", "fixtures", "snapshot.json");
const LIVE_SNAPSHOT = join(import.meta.dir, "..", "..", "scratch", "goal11", "live-snapshot.json");

function snapshot(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const fixture = (): Record<string, unknown> => snapshot(FIXTURE_SNAPSHOT);
/** The live capture is a build-time artifact: a machine without it runs only the fixture assertions. */
const live = (): Record<string, unknown> | undefined => (existsSync(LIVE_SNAPSHOT) ? snapshot(LIVE_SNAPSHOT) : undefined);

describe("the checked-in fixture: a settled round's own published tally", () => {
	test("a passed round is read back with its tally, reason and board reference", () => {
		const rounds = votesFromSnapshot(fixture()) as VoteView[];
		const passed = rounds.find((round) => round.id === "vote-41");
		expect(passed).toBeDefined();
		if (passed === undefined) throw new Error("unreachable");
		expect(passed.status).toBe("passed");
		expect(passed.kind).toBe("spawn");
		expect(passed.question).toBe("Grow the pool toward 5 ready tasks?");
		// The mechanism published all four lists in its own vote.passed event: they are read, not derived.
		expect(passed.for).toEqual(["SwiftTiger", "CalmTiger", "VividTiger", "BrightTiger"]);
		expect(passed.against).toEqual([]);
		expect(passed.absent).toEqual([]);
		expect(passed.offline).toEqual([]);
		expect(passed.reason).toBe("4/4 approved (needed 4, threshold 0.75)");
		// base = for + against + absent, exactly what decide() counts; needed is the round's arithmetic.
		expect(passed.base).toBe(4);
		expect(passed.needed).toBe(4);
		// A settled round's tally IS its ballot record: who voted what is published.
		expect(passed.ballotsReadable).toBe(true);
		// The deadline is its own openedAt + timeoutMs (the field is already milliseconds).
		expect(passed.openedAtMs).toBe(1791417600000 - 1_200_000);
		expect(passed.deadlineMs).toBe(1791417600000 - 1_200_000 + 900_000);
		// And the board entry it published is offered to the view.
		expect(voteBoardIds(fixture()).get("vote-41")).toBe(380);
	});

	test("a failed round keeps the tally and the reason it published", () => {
		const rounds = votesFromSnapshot(fixture()) as VoteView[];
		const failed = rounds.find((round) => round.id === "vote-42");
		expect(failed).toBeDefined();
		if (failed === undefined) throw new Error("unreachable");
		expect(failed.status).toBe("failed");
		expect(failed.kind).toBe("close-task");
		expect(failed.for).toEqual(["CalmTiger"]);
		expect(failed.against).toEqual(["SwiftTiger"]);
		expect(failed.absent).toEqual(["BrightTiger", "VividTiger"]);
		expect(failed.reason).toContain("timeout: 1/4 approved, needed 4");
		expect(failed.base).toBe(4);
		expect(failed.needed).toBe(4);
		expect(voteBoardIds(fixture()).get("vote-42")).toBe(381);
	});
});

describe("the checked-in fixture: an open round and its honest gap", () => {
	test("an open round shows question, kind and deadline, and reports that its ballots are not published", () => {
		const rounds = votesFromSnapshot(fixture()) as VoteView[];
		const open = rounds.find((round) => round.id === "vote-43");
		expect(open).toBeDefined();
		if (open === undefined) throw new Error("unreachable");
		expect(open.status).toBe("pending");
		expect(open.kind).toBe("create-task");
		// Nothing invented: no voter, no ballot count, no tally, no base.
		expect(open.ballots).toEqual([]);
		expect(open.ballotsReadable).toBe(false);
		expect(open.for).toEqual([]);
		expect(open.against).toEqual([]);
		expect(open.absent).toEqual([]);
		expect(open.base).toBeNull();
		expect(open.needed).toBeNull();
		// The threshold the round's own vote.open published is kept, so the panel can state the pass line.
		expect(open.threshold).toBe(0.75);
		// And the deadline is a real countdown from its own timeoutMs.
		expect(open.deadlineMs).toBe(1791417600000 - 60_000 + 90_000);
	});

	test("the event rows the snapshot ships carry only type, createdAtMs and content", () => {
		// The gap is structural: the voter lands in the DB row's agent_id, and this is the whole field
		// list the read-only interface publishes. Asserted against the fixture so it cannot drift.
		const events = (fixture() as { events: unknown[] }).events as { type: string }[];
		const ballot = events.find((event) => event.type === "vote.ballot");
		expect(ballot).toBeDefined();
		const keys = ballot !== undefined && typeof ballot === "object" ? Object.keys(ballot).sort() : [];
		expect(keys).toEqual(["content", "createdAtMs", "type"]);
	});

	test("a round with no vote events in the feed yields no rows, and says so", () => {
		expect(votesFromSnapshot({ now: 0, events: [], agents: [], board: [] })).toEqual([]);
	});
});

describe("votesFromSnapshot: what the fixture cannot produce", () => {
	test("an unpublished timeoutMs leaves the deadline null rather than a guessed time", () => {
		const snapshot = {
			now: 4_000_000,
			agents: [{ id: "w1" }],
			events: [{ createdAtMs: 3_900_000, type: "vote.open", content: JSON.stringify({ vote: "vote-8", kind: "stop", question: "stop?" }) }],
			board: [],
		};
		const round = (votesFromSnapshot(snapshot) as VoteView[])[0] as VoteView;
		expect(round.deadlineMs).toBeNull();
		expect(round.openedAtMs).toBe(3_900_000);
	});

	test("a malformed or absent payload is an empty object, never a throw", () => {
		const snapshot = {
			now: 5_000_000,
			agents: [],
			events: [
				{ createdAtMs: 4_900_000, type: "vote.open", content: "not json" },
				{ createdAtMs: 4_950_000, type: "vote.ballot", content: null },
				{ createdAtMs: 4_960_000, type: "vote.failed", content: JSON.stringify({ vote: null, kind: null, for: "x", reason: null }) },
			],
			board: [],
		};
		const rounds = votesFromSnapshot(snapshot) as VoteView[];
		// Three malformed rows, none able to name a vote id: each kept as its own row, newest first.
		expect(rounds).toHaveLength(3);
		expect(rounds.map((round) => round.id)).toEqual([null, null, null]);
		expect(rounds.every((round) => round.question === "" && round.for.length === 0 && round.absent.length === 0)).toBe(true);
		expect(rounds.map((round) => round.status)).toEqual(["failed", "pending", "pending"]);
	});

	test("a terminal event arriving before its own vote.open (the feed is newest-first)", () => {
		const snapshot = {
			now: 6_000_000,
			agents: [{ id: "w1" }],
			events: [
				{ createdAtMs: 5_950_000, type: "vote.passed", content: JSON.stringify({ vote: "vote-5", kind: "create-task", question: "make a row?", for: ["w1"], against: [], absent: [], reason: "1/1 approved (needed 1)" }) },
				{ createdAtMs: 5_900_000, type: "vote.open", content: JSON.stringify({ vote: "vote-5", kind: "create-task", question: "make a row?", timeoutMs: 90_000 }) },
			],
			board: [],
		};
		const round = (votesFromSnapshot(snapshot) as VoteView[])[0] as VoteView;
		// The open row is not lost to being "already seen": the round keeps both its deadline and its tally.
		expect(round.status).toBe("passed");
		expect(round.deadlineMs).toBe(5_900_000 + 90_000);
		expect(round.openedAtMs).toBe(5_900_000);
		expect(round.for).toEqual(["w1"]);
	});

	test("a settled round's late ballots never downgrade its published tally", () => {
		const snapshot = {
			now: 7_000_000,
			agents: [{ id: "w1" }],
			events: [
				{ createdAtMs: 6_950_000, type: "vote.ballot", content: JSON.stringify({ vote: "vote-6", approve: true }) },
				{ createdAtMs: 6_900_000, type: "vote.passed", content: JSON.stringify({ vote: "vote-6", kind: "scale", question: "resize?", for: ["w1"], against: [], absent: [], reason: "1/1 approved (needed 1)" }) },
				{ createdAtMs: 6_800_000, type: "vote.open", content: JSON.stringify({ vote: "vote-6", kind: "scale", question: "resize?", timeoutMs: 90_000 }) },
			],
			board: [],
		};
		const round = (votesFromSnapshot(snapshot) as VoteView[])[0] as VoteView;
		expect(round.status).toBe("passed");
		expect(round.ballotsReadable).toBe(true);
		expect(round.for).toEqual(["w1"]);
	});

	test("a round whose vote.open aged out of the feed is still shown from its terminal event", () => {
		const snapshot = {
			now: 3_000_000,
			agents: [],
			events: [
				{ createdAtMs: 2_900_000, type: "vote.passed", content: JSON.stringify({ vote: "vote-7", kind: "spawn", question: "resize?", for: ["a", "b", "c"], against: [], absent: [], reason: "3/3 approved (needed 3, threshold 0.75)" }) },
			],
			board: [{ id: 12, content: "vote_passed vote-7 (spawn): resize?" }],
		};
		const round = (votesFromSnapshot(snapshot) as VoteView[])[0] as VoteView;
		expect(round.id).toBe("vote-7");
		expect(round.status).toBe("passed");
		expect(round.question).toBe("resize?");
		expect(round.base).toBe(3);
		expect(round.needed).toBe(3);
		expect(round.boardId).toBeNull();
		expect(voteBoardIds(snapshot).get("vote-7")).toBe(12);
	});

	test("newest first, the order every other feed on the page uses", () => {
		const snapshot = {
			now: 8_000_000,
			agents: [],
			events: [
				{ createdAtMs: 7_100_000, type: "vote.open", content: JSON.stringify({ vote: "vote-1", question: "older", timeoutMs: 1000 }) },
				{ createdAtMs: 7_200_000, type: "vote.open", content: JSON.stringify({ vote: "vote-2", question: "newer", timeoutMs: 1000 }) },
			],
			board: [],
		};
		expect((votesFromSnapshot(snapshot) as VoteView[]).map((round) => round.id)).toEqual(["vote-2", "vote-1"]);
	});
});

describe("the live swarm's own recorded rounds (feed-drift-proof assertions only)", () => {
	test("every real vote event parses into a round with a real status and no invented fields", () => {
		const captured = live();
		if (captured === undefined) return;
		const rounds = votesFromSnapshot(captured) as VoteView[];
		// The live capture holds this swarm's own write (a spawn round that timed out, a create-task that
		// passed 4/4), both of which announced themselves in the feed the snapshot shipped.
		expect(rounds.length).toBeGreaterThanOrEqual(2);
		for (const round of rounds) {
			expect(["pending", "passed", "failed"]).toContain(round.status);
			// Whatever the feed still carries: nothing derived that the payload does not state.
			if (round.status === "pending") {
				expect(round.ballots).toEqual([]);
				expect(round.ballotsReadable).toBe(false);
				expect(round.base).toBeNull();
			} else {
				expect(round.ballotsReadable).toBe(true);
				expect(round.base).toBe(round.for.length + round.against.length + round.absent.length);
			}
		}
		// The spawn round the swarm really opened is there with the tally it really published.
		const spawn = rounds.find((round) => round.kind === "spawn");
		expect(spawn).toBeDefined();
		if (spawn === undefined) throw new Error("unreachable");
		expect(spawn.status).toBe("failed");
		expect(spawn.for).toEqual(["VividTiger"]);
		expect(spawn.absent).toEqual(["BrightTiger", "CalmTiger", "SwiftTiger"]);
		expect(spawn.reason).toContain("timeout: 1/4 approved, needed 4");
	});
});
