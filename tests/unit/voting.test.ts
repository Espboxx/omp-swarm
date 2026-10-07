import { describe, expect, test } from "bun:test";
import {
	approvalsRequired,
	decide,
	DEFAULT_VOTING,
	eligibleVoters,
	resolveVotingConfig,
	votingSignature,
	type Vote,
	type VoteDecision,
	type VotingInput,
} from "../../extension/voting";
import type { AgentStatus, SwarmAgent } from "../../extension/types";

const NOW = 1_700_000_000_000;
const WINDOW = 60_000;

function agent(id: string, overrides: Partial<SwarmAgent> = {}): SwarmAgent {
	return {
		id,
		role: "general",
		status: "idle" as AgentStatus,
		capabilities: ["general"],
		joinedAt: NOW - 600_000,
		heartbeatAt: NOW - 1_000,
		...overrides,
	};
}

function decision(overrides: Partial<VoteDecision> = {}): VoteDecision {
	return { id: "vote-1", kind: "create-task", question: "create task: x", openedBy: "CalmTiger", openedAt: NOW - 1_000, ...overrides };
}

const ballot = (voter: string, approve: boolean, at = NOW - 500): Vote => ({ voter, approve, at });

/** A round over `ids` (all online) with `votes` cast, evaluated at the caller's clock. */
const round = (ids: string[], votes: Vote[], extra: Partial<VotingInput> = {}) =>
	decide({ decision: decision(), votes, agents: ids.map((id) => agent(id)), now: NOW, offlineAfterMs: WINDOW, ...extra });

describe("voting: the strict > 75% arithmetic (rule 5)", () => {
	test("a base of n needs 1,2,3,4,4,5,6,7 approvals for n=1..8", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => approvalsRequired(n, 0.75))).toEqual([1, 2, 3, 4, 4, 5, 6, 7]);
	});

	test("exactly 75% (3 of 4) is NOT enough: it stays open while the last voter could still approve", () => {
		const outcome = round(["a", "b", "c", "d"], [ballot("a", true), ballot("b", true), ballot("c", true)]);
		expect(outcome.needed).toBe(4);
		expect(outcome.status).toBe("pending");
		expect(outcome.settled).toBe(false);
	});

	test("3 of 4 approve and the fourth rejects: the 75% share is short, so the round FAILS now", () => {
		const outcome = round(["a", "b", "c", "d"], [ballot("a", true), ballot("b", true), ballot("c", true), ballot("d", false)]);
		expect(outcome.status).toBe("failed");
		expect(outcome.settled).toBe(true);
		expect(outcome.reason).toContain("unreachable");
		expect(outcome.approvals).toEqual(["a", "b", "c"]);
		expect(outcome.rejections).toEqual(["d"]);
	});

	test("4 of 4 passes", () => {
		const outcome = round(["a", "b", "c", "d"], ["a", "b", "c", "d"].map((id) => ballot(id, true)));
		expect(outcome.status).toBe("passed");
		expect(outcome.settled).toBe(true);
		expect(outcome.reason).toContain("4/4");
	});

	test("a threshold of 1 reads as unanimity, not as an unsatisfiable share", () => {
		expect(approvalsRequired(3, 1)).toBe(3);
		const twoOfThree = round(["a", "b", "c"], [ballot("a", true), ballot("b", true)], { config: { threshold: 1 } });
		expect(twoOfThree.status).toBe("pending");
		const threeOfThree = round(["a", "b", "c"], ["a", "b", "c"].map((id) => ballot(id, true)), { config: { threshold: 1 } });
		expect(threeOfThree.status).toBe("passed");
	});
});

describe("voting: eligibility (rule 1)", () => {
	test("the eligible list is the online roster, sorted, and mirrors the offline window", () => {
		const agents = [
			agent("b"),
			agent("a"),
			agent("gone", { status: "offline" as AgentStatus }),
			agent("stale", { heartbeatAt: NOW - WINDOW - 1 }),
		];
		expect(eligibleVoters(agents, NOW, WINDOW)).toEqual(["a", "b"]);
	});

	test("an offline agent is ABSENT, never a veto: the online base still decides", () => {
		const agents = [agent("a"), agent("b"), agent("offline", { status: "offline" as AgentStatus })];
		const outcome = decide({
			decision: decision(),
			votes: [ballot("a", true), ballot("b", true)],
			agents,
			now: NOW,
			offlineAfterMs: WINDOW,
		});
		expect(outcome.base).toBe(2);
		expect(outcome.status).toBe("passed");
		expect(outcome.eligible).toEqual(["a", "b"]);
	});

	test("a voter going offline mid-round shrinks the base, so nobody can stall the round", () => {
		const cast = [ballot("a", true), ballot("b", true), ballot("c", true)];
		const stillThere = round(["a", "b", "c", "d"], cast);
		expect(stillThere.status).toBe("pending");
		const dLeft = round(["a", "b", "c", "d"], cast, {
			agents: [agent("a"), agent("b"), agent("c"), agent("d", { status: "offline" as AgentStatus })],
		});
		expect(dLeft.base).toBe(3);
		expect(dLeft.status).toBe("passed");
	});
});

describe("voting: boundary cases (rule 4)", () => {
	test("a tie fails", () => {
		const outcome = round(["a", "b"], [ballot("a", true), ballot("b", false)]);
		expect(outcome.needed).toBe(2);
		expect(outcome.status).toBe("failed");
	});

	test("one agent, one ballot: a repeat is recorded but not counted", () => {
		const outcome = round(["a", "b"], [ballot("a", true), ballot("a", true), ballot("b", true)]);
		expect(outcome.approvals).toEqual(["a", "b"]);
		expect(outcome.ignored.map((v) => v.voter)).toEqual(["a"]);
		expect(outcome.status).toBe("passed");
	});

	test("a non-voter's ballot is recorded but cannot tip a round", () => {
		const outcome = round(["a", "b"], [ballot("a", true), ballot("main", true), ballot("operator", true)]);
		expect(outcome.approvals).toEqual(["a"]);
		expect(outcome.ignored.map((v) => v.voter)).toEqual(["main", "operator"]);
		expect(outcome.status).toBe("pending");
	});
});

describe("voting: timeout defaults to deny (rule 3)", () => {
	test("at the deadline the not-yet-voted are absent and the round fails with the full tally", () => {
		// The roster must still be ONLINE at the evaluated clock, or the base would collapse for the
		// wrong reason (the offline window, not the vote timeout).
		const at = NOW - 1_000 + DEFAULT_VOTING.timeoutMs;
		const outcome = decide({
			decision: decision(),
			votes: [ballot("a", true), ballot("b", true)],
			agents: ["a", "b", "c", "d"].map((id) => agent(id, { heartbeatAt: at - 1_000 })),
			now: at,
			offlineAfterMs: WINDOW,
		});
		expect(outcome.base).toBe(4);
		expect(outcome.status).toBe("failed");
		expect(outcome.settled).toBe(true);
		expect(outcome.reason).toContain("timeout");
		expect(outcome.absent).toEqual(["c", "d"]);
	});

	test("a round that is already decided does not wait for the deadline", () => {
		const passed = round(["a", "b", "c", "d", "e"], ["a", "b", "c", "d"].map((id) => ballot(id, true)));
		expect(passed.status).toBe("passed");
		expect(passed.absent).toEqual(["e"]);
		const hopeless = round(["a", "b", "c", "d"], [ballot("a", false)]);
		expect(hopeless.status).toBe("failed");
		expect(hopeless.reason).toContain("unreachable");
	});
});

describe("voting: seed authority (rule 2)", () => {
	test("a seed decision executes without a ballot", () => {
		const outcome = decide({
			decision: decision({ seed: true, openedBy: "main", kind: "spawn" }),
			votes: [],
			agents: [],
			now: NOW,
			offlineAfterMs: WINDOW,
		});
		expect(outcome.status).toBe("seeded");
		expect(outcome.settled).toBe(true);
		expect(outcome.approvals).toEqual([]);
	});
});

describe("voting: the small-pool corner is reported, not silently allowed (rule 5)", () => {
	test("a one-agent pool cannot rule alone under the default minBase", () => {
		const outcome = round(["solo"], [ballot("solo", true)]);
		expect(outcome.base).toBe(1);
		expect(outcome.status).toBe("failed");
		expect(outcome.reason).toContain("quorum-unreachable");
		expect(outcome.ignored).toEqual([]);
	});

	test("when the OPERATOR's policy sets minBase 1, the same 1/1 ballot passes - the arithmetic is visible, not hidden", () => {
		const outcome = round(["solo"], [ballot("solo", true)], { policy: { threshold: 0.75, minBase: 1, timeoutMs: 90_000 } });
		expect(outcome.needed).toBe(1);
		expect(outcome.status).toBe("passed");
	});
});

describe("voting: the operator keeps the pen (rule 6)", () => {
	test("a request can tighten the policy", () => {
		expect(resolveVotingConfig({ threshold: 0.9, minBase: 3, timeoutMs: 30_000 })).toEqual({ threshold: 0.9, minBase: 3, timeoutMs: 30_000 });
	});

	test("a request cannot loosen the policy, and nonsense falls back to it", () => {
		expect(resolveVotingConfig({ threshold: 0.5, minBase: 1, timeoutMs: 600_000 })).toEqual(DEFAULT_VOTING);
		expect(resolveVotingConfig({ threshold: Number.NaN, minBase: -4, timeoutMs: 0 })).toEqual(DEFAULT_VOTING);
	});

	test("the threshold can never be raised past unanimity", () => {
		expect(resolveVotingConfig({ threshold: 4 }).threshold).toBe(1);
	});
});

describe("voting: the wait is an edge, not a clock (rule 5 / task-170-171)", () => {
	test("the signature changes when a ballot arrives and is stable while nothing does", () => {
		const before = round(["a", "b", "c"], []);
		const again = round(["a", "b", "c"], []);
		expect(votingSignature("vote-1", before)).toBe(votingSignature("vote-1", again));
		const after = round(["a", "b", "c"], [ballot("a", true)]);
		expect(votingSignature("vote-1", after)).not.toBe(votingSignature("vote-1", before));
	});

	test("the signature changes when the eligible base changes", () => {
		const withFour = round(["a", "b", "c", "d"], [ballot("a", true)]);
		const withThree = round(["a", "b", "c"], [ballot("a", true)]);
		expect(votingSignature("vote-1", withThree)).not.toBe(votingSignature("vote-1", withFour));
	});
});
