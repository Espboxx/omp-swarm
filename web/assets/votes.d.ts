/**
 * Types for `votes.js`, which the page loads as a plain ES module (no build step). Tests import the
 * module directly, so this declaration is what gives those imports real types instead of `any`.
 */

export interface VoteView {
	id: string | null;
	question: string;
	kind: string | null;
	openedBy: string | null;
	openedAtMs: number;
	/** Absolute deadline, when the `vote.open` event published a `timeoutMs`; `null` otherwise. */
	deadlineMs: number | null;
	/** The threshold the round's own `vote.open` published; `null` when it did not. */
	threshold: number | null;
	/** The round's own base (eligible + absent) once its tally is published; `null` before that. */
	base: number | null;
	/** Approvals strictly required to pass at the round's own threshold; `null` before the tally exists. */
	needed: number | null;
	status: "pending" | "passed" | "failed";
	/** The one-line reason the terminal event published. `null` while pending. */
	reason: string | null;
	for: string[];
	against: string[];
	absent: string[];
	offline: string[];
	/**
	 * Ballots the snapshot publishes for this round. Always empty: `castBallot` records the voter in the
	 * event row's `agent_id` column and the frozen v1 snapshot contract drops it, so a per-agent ballot
	 * list is not on this read-only path. A settled round's tally above is what records who voted what.
	 */
	ballots: [];
	/**
	 * Whether the snapshot publishes this round's ballots at all: `true` for a settled round (its tally
	 * is inside the terminal event) and `false` for one still in progress.
	 */
	ballotsReadable: boolean;
	boardId: number | null;
}

export function votesFromSnapshot(snapshot: unknown): VoteView[];

export function voteBoardIds(snapshot: unknown): Map<string, number>;
