/**
 * Voting: a pool-internal decision continues only when a STRICT super-majority of the eligible pool
 * approves it, and it is denied by default when the round runs out of time.
 *
 * The operator's constraint (goal-8) is one sentence — "every decision is voted on, and it continues
 * only when the yes share is > 75%" — and that sentence leaves five questions that decide whether the
 * mechanism can ever run or instead bricks the pool. This module answers all five as executable rules,
 * so there is no convention to remember, only this table:
 *
 * 1. WHO VOTES. A voter is an agent that is ONLINE by the same rule every other reader already uses
 *    (`status !== "offline"` and a heartbeat inside `offlineAfterMs` — exactly `findStarvation`), so
 *    the voter list and the starvation notice can never disagree about who is present. The
 *    coordinator (`main`) and the operator are NOT voters: they are the seed authority (2). An
 *    offline agent is ABSENT, never a veto: its absence shrinks the base instead of blocking the
 *    count forever.
 * 2. COLD START. The pool's first decisions cannot be voted on by a pool that does not exist yet
 *    (create a task -> needs a vote -> needs agents -> spawning agents needs a vote -> ...). So the
 *    coordinator opening a round and any operator instruction are SEEDS: they execute with no vote
 *    (`decide()` returns `seeded`). Only pool-internal decisions — create-task, close-task, spawn,
 *    stop, scale — need a round. The alternative (vote on literally everything, including the first
 *    agent) is a deadlock with no seed to break it; this is why the rule exists.
 * 3. TIMEOUT. A round is bounded (`timeoutMs`, default 90s) and its deadline DENIES by default:
 *    whoever has not approved by then is ABSENT, and `decide()` settles as `failed` carrying the full
 *    tally (for / against / absent) so the caller can write `vote_failed` to the events and the board.
 *    Silence is never a pass and nothing retries on its own.
 * 4. BOUNDARY. Strictly more than the threshold: at 0.75, 3/4 = 75% is NOT enough (4/4 is), and a tie
 *    fails. One agent, one ballot: a repeat from the same voter is ignored, and so is a ballot from a
 *    non-voter — both are recorded, neither is counted.
 * 5. THE SMALL-POOL ARITHMETIC, stated so nobody is surprised. A strict > 75% rule needs 1/1, 2/2,
 *    3/3, 4/4, 4/5, 5/6, 6/7, 7/8 approvals for bases 1..8 — i.e. UNANIMITY up to a base of four. A
 *    one-agent pool would therefore pass any vote with its own single ballot, which is precisely the
 *    "no single agent decides" the operator asked to prevent: that is what `minBase` is for. With the
 *    default `minBase = 2`, a base below 2 cannot decide at all and `decide()` says so
 *    (`quorum-unreachable`) instead of quietly letting one agent rule. The escape from that corner is
 *    rule 2, never a lowered threshold: a roster change asked for by the operator/coordinator is a
 *    seed. The model calls one round may cost are likewise bounded by the base: each eligible voter is
 *    asked AT MOST ONCE per round (`votingSignature` is the edge a new ballot produces, so a pending
 *    round is woken by votes arriving, never by a clock).
 * 6. THE OPERATOR KEEPS THE PEN. `resolveVotingConfig()` lets a request make the rule STRICTER (a
 *    higher threshold, a higher minimum base, a shorter timeout) and never looser: an agent that asks
 *    for 0.5, or for `minBase: 1`, still runs under the operator's policy.
 *
 * Pure and clock-injected like `starvation.ts`, so the table above is pinned by unit tests rather
 * than by a live pool. This module decides nothing and writes nothing: it answers "seeded / passed /
 * failed / pending, with what tally" for a given roster and ballot set, and the caller owns the event,
 * the board entry and the wake-up.
 */
import type { DecisionKind, SwarmAgent } from "./types";

export type { DecisionKind };

export interface VotingConfig {
	/** The yes share a decision must STRICTLY beat. 0.75 by default; 1 reads as unanimity (rule 5). */
	threshold: number;
	/** The smallest eligible base allowed to decide at all — a 1-agent pool cannot rule alone. */
	minBase: number;
	/** Hard bound on a round; at the deadline the not-yet-approved are absent and the round fails. */
	timeoutMs: number;
}

export const DEFAULT_VOTING: VotingConfig = { threshold: 0.75, minBase: 2, timeoutMs: 90_000 };

export interface VoteDecision {
	id: string;
	kind: DecisionKind;
	/** What is being decided, in one line, so the audit row reads without the surrounding chat. */
	question: string;
	/** The agent (or the coordinator) that opened the round. */
	openedBy: string;
	openedAt: number;
	/**
	 * Seed authority (rule 2): the coordinator opening a round, or an operator instruction. A seed
	 * executes without a ballot; every pool-internal decision votes.
	 */
	seed?: boolean;
}

/** One auditable ballot: who, when, and which way (rule 4). */
export interface Vote {
	voter: string;
	approve: boolean;
	at: number;
}

export type VoteStatus = "seeded" | "pending" | "passed" | "failed";

export interface VoteOutcome {
	status: VoteStatus;
	/** The eligible base the share is measured against (rule 1). */
	base: number;
	eligible: string[];
	/** Approvals strictly required to pass. */
	needed: number;
	approvals: string[];
	rejections: string[];
	/** Eligible voters with no ballot — the absent list `vote_failed` must publish (rule 3). */
	absent: string[];
	/** Ballots that did not count: a repeat from one voter, or a non-voter's (rule 4). */
	ignored: Vote[];
	/**
	 * Voters whose ballot did NOT count because they are offline at settlement (goal-9's minor ①). The
	 * arithmetic is unchanged — a voter who left drops out of the base, so nobody can stall a round by
	 * leaving — but the DROPPED approval is named instead of vanishing into `ignored`: a real yes that
	 * was silently discarded is the one thing the tally must never hide.
	 */
	offline: string[];
	/** One line the caller may publish verbatim. */
	reason: string;
	/** True when the round is over (seeded / passed / failed) and the caller must act or report. */
	settled: boolean;
}

export interface VotingInput {
	decision: VoteDecision;
	votes: Vote[];
	/** The pool roster as the caller sees it (heartbeats included). */
	agents: SwarmAgent[];
	/** The caller's clock. */
	now: number;
	/** Heartbeat age past which an agent is offline for every reader (`config.offlineAfterSeconds`). */
	offlineAfterMs: number;
	/** A requested config; it can only tighten `policy` (rule 6). */
	config?: Partial<VotingConfig>;
	/** The operator's policy being tightened. Defaults to {@link DEFAULT_VOTING}. */
	policy?: VotingConfig;
}

/**
 * Approvals strictly required for `base` voters at `threshold`.
 *
 * The `+ 1` is the whole "strictly greater" rule: when `base * threshold` lands exactly on an integer
 * (4 votes at 0.75 -> 3), 3/4 is exactly the threshold and therefore NOT enough, so one more is needed.
 * `threshold >= 1` is unanimity rather than "more than everyone", which is unsatisfiable by definition;
 * rule 5 states that reading so it is a decision, not an accident.
 */
export function approvalsRequired(base: number, threshold: number): number {
	if (base <= 0) return 1;
	if (threshold >= 1) return base;
	return Math.floor(base * threshold) + 1;
}

/**
 * The eligible voters, sorted so the tally is stable in every reader (rule 1). Mirrors the online test
 * in `findStarvation` on purpose: two readers of "who is here" must never disagree.
 */
export function eligibleVoters(agents: SwarmAgent[], now: number, offlineAfterMs: number): string[] {
	return agents
		.filter((agent) => agent.status !== "offline" && agent.heartbeatAt >= now - offlineAfterMs)
		.map((agent) => agent.id)
		.sort();
}

/**
 * A request may tighten the operator's policy and never loosen it (rule 6): a higher threshold, a
 * higher minimum base and a shorter timeout are accepted; anything more permissive is replaced by the
 * policy's own value. Nonsense values (non-finite, <= 0) also fall back to the policy.
 */
export function resolveVotingConfig(requested: Partial<VotingConfig> = {}, policy: VotingConfig = DEFAULT_VOTING): VotingConfig {
	const usable = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
	// A threshold above 1 would make every share unreachable; rule 5 defines 1 as unanimity, so it is the
	// ceiling a stricter ask can reach.
	const threshold = Math.min(usable(requested.threshold) ? Math.max(requested.threshold, policy.threshold) : policy.threshold, 1);
	const minBase = usable(requested.minBase) ? Math.max(requested.minBase, policy.minBase) : policy.minBase;
	const timeoutMs = usable(requested.timeoutMs) ? Math.min(requested.timeoutMs, policy.timeoutMs) : policy.timeoutMs;
	return { threshold, minBase: Math.round(minBase), timeoutMs: Math.round(timeoutMs) };
}

/**
 * A stable identity of a round's inputs: a NEW BALLOT, or a change in who is eligible, changes it, and
 * nothing else does. That is what makes the wait an edge instead of a poll — a pending round is woken
 * when this string changes (the same contract `promptSignature`/`edgeWake` already use), so a round
 * with no new vote costs zero model calls (task-170/171's win stays intact).
 */
export function votingSignature(decisionId: string, outcome: VoteOutcome): string {
	return [decisionId, outcome.status, outcome.base, outcome.approvals.length, outcome.rejections.length].join(":");
}

/**
 * The canonical identity of WHAT a round decided, so consent binds to the decision and not merely to
 * its kind (goal-9, VERDICT §3). Two payloads sign the same string only when they say the same thing:
 * object keys are sorted, object values recursed, strings trimmed, a list of names (`files`,
 * `dependencies`, `capabilities`) sorted because the order of a set is not part of the decision, and
 * `undefined` dropped.
 *
 * Nothing else is ever dropped: an unrecognised key still signs, so a ticket can only ever authorise
 * exactly the payload it froze — never more, and never "whatever the caller felt like meaning".
 */
export function payloadSignature(payload: Record<string, unknown>): string {
	return JSON.stringify(canonicalize(payload));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = value.map((item) => canonicalize(item));
		return items.every((item) => typeof item === "string") ? [...(items as string[])].sort() : items;
	}
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			const item = source[key];
			if (item === undefined) continue;
			out[key] = canonicalize(item);
		}
		return out;
	}
	return typeof value === "string" ? value.trim() : value;
}

/**
 * Decide a round. Pure: same input, same outcome, no clock of its own and no side effect.
 *
 * Settling EARLY is deliberate in both directions — a round that already has the approvals, or one
 * where even every remaining ballot could not reach them, is over the moment that is knowable. Only a
 * genuinely open round is `pending`, and a pending round is what the deadline (rule 3) eventually
 * denies.
 */
export function decide(input: VotingInput): VoteOutcome {
	const config = resolveVotingConfig(input.config, input.policy ?? DEFAULT_VOTING);
	const eligible = eligibleVoters(input.agents, input.now, input.offlineAfterMs);
	const base = eligible.length;
	const present = new Set(eligible);

	const approvals: string[] = [];
	const rejections: string[] = [];
	const ignored: Vote[] = [];
	const offline: string[] = [];
	const seen = new Set<string>();
	for (const vote of input.votes) {
		// A repeat is recorded but never counted: one agent, one ballot (rule 4).
		if (seen.has(vote.voter)) {
			ignored.push(vote);
			continue;
		}
		if (!present.has(vote.voter)) {
			// A ballot that does not count. Two very different reasons, kept apart on purpose (minor ①): a
			// voter who is STILL on the roster but offline at settlement is NAMED as such, because their
			// approval was real and only the arithmetic dropped it; anyone else (the coordinator, the
			// operator, an unknown id) is simply not a voter.
			if (input.agents.some((agent) => agent.id === vote.voter)) offline.push(vote.voter);
			else ignored.push(vote);
			continue;
		}
		seen.add(vote.voter);
		(vote.approve ? approvals : rejections).push(vote.voter);
	}

	const pending = eligible.filter((id) => !seen.has(id));
	const needed = approvalsRequired(base, config.threshold);
	const outcome = (status: VoteStatus, reason: string, settled: boolean, absent: string[] = pending): VoteOutcome => ({
		status,
		base,
		eligible,
		needed,
		approvals,
		rejections,
		absent,
		ignored,
		offline,
		// Never silent: a ballot the arithmetic discarded because its voter left is named in the line the
		// caller publishes, so the tally cannot read as "nobody was interested".
		reason:
			offline.length === 0
				? reason
				: `${reason}; ${offline.length} ballot(s) DROPPED, voter offline at settlement: ${offline.join(", ")}`,
		settled,
	});

	if (input.decision.seed) {
		return outcome("seeded", `seed authority (${input.decision.openedBy}): ${input.decision.kind} executes without a ballot`, true, []);
	}
	if (base < config.minBase) {
		// Rule 5: one agent (or none) may not rule alone. Reported, never silently allowed.
		return outcome(
			"failed",
			`quorum-unreachable: ${base} eligible voter(s) < minBase ${config.minBase} - a pool this small cannot decide (see rule 2: a roster change asked for by the operator/coordinator is a seed)`,
			true,
		);
	}
	if (approvals.length >= needed) {
		return outcome("passed", `${approvals.length}/${base} approved (needed ${needed}, threshold ${config.threshold})`, true);
	}
	// Even every remaining ballot cannot reach `needed`: the round is over now, not at the deadline.
	if (approvals.length + pending.length < needed) {
		return outcome(
			"failed",
			`unreachable: ${approvals.length} approved, ${pending.length} still open, ${needed} needed of ${base} - even a full turnout cannot pass`,
			true,
		);
	}
	if (input.now >= input.decision.openedAt + config.timeoutMs) {
		return outcome(
			"failed",
			`timeout: ${approvals.length}/${base} approved, needed ${needed} - not-yet-voted counted absent, default deny`,
			true,
		);
	}
	return outcome("pending", `${approvals.length}/${base} approved, needed ${needed}, ${pending.length} open`, false);
}
