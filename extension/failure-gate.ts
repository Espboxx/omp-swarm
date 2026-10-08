/**
 * goal-17's L1: the retry path had no memory of WHY a row failed.
 *
 * WHAT THIS FILE IS FOR. `store.retryTask` revives any `failed` or `blocked` row on request. It
 * counts attempts, but it never reads the row's failure reason, so the reason carries no weight at
 * all: a row that failed because its deliverable was already delivered under another id can be
 * re-filed as a brand-new attempt, forever, and nothing on the pool says stop.
 *
 * The measured size of that hole, from `.swarm/swarm.db` at the time this module was written:
 * 45 rows sit in `failed`, and the classifier reads **44 of them into a repeatable family** —
 * duplicate 28, superseded 15, blocked 1 — with exactly one exception, task-125 (goal-1's planning
 * round hit its 600s bound with no plan: a real failure of a real kind, which a retry must always
 * be allowed to revive). Those 44 rows were closed unexecuted by their own holders: the pool never
 * minted a gate to stop the NEXT one.
 *
 * The raw-keyword count (41 of 45 matching `/SUPERSEDED|DUPLICATE/`) is NOT the number a gate needs,
 * and the difference matters: a row whose cause is a delivered duplicate and a row a terminal one
 * outlived get different remedies, so a scan that cannot tell them apart over-counts the family that
 * must be stopped and under-counts the one that already has a successor. Re-measured at any time by
 * `bun scratch/goal17/replay-l1.ts`, which drives THIS classifier over the live rows.
 *
 * This module is the pure half of that gate, and it is pure on purpose: no db, no clock, no I/O, so
 * the rule and its wiring can be tested apart, exactly the division `driver.ts`'s `alertGate` and
 * `board.ts`'s `boardClassKey` use. It answers three questions:
 *
 *   1. {@link classifyFailure} — WHAT is the cause of this failure? A `FailureFamily` read from the
 *      row's own result text, never from an id the caller inventored.
 *   2. {@link retryGate} — should this retry be allowed? A decision of (family key, clock, memory,
 *      attempt count), modelled on the shipped `alertGate` so the pool speaks ONE gate language:
 *      a repeat inside the window is held, a repeat outside it escalates with the age.
 *   3. {@link retryEscalation} — the board entry a held retry must leave, naming the prior attempt
 *      and the remedy, because a refusal nobody can audit is the prose-sentence failure mode
 *      `planGoal`'s `skipped` already cost the pool once.
 *
 * WHY A FAMILY AND NOT A TITLE. Two failures that name the same cause are one problem even when
 * their titles differ, and the same title re-failed for two different causes are two problems. The
 * family is read from the REASON (what actually went wrong), which is the only field that carries
 * the cause; the deliverable key is carried alongside it so the gate can tell "this deliverable
 * keeps failing the same way" from "this deliverable failed two different ways" without reading
 * `tasks.author` or any other policy field as a dedupe key.
 */

/** The cause families a failure reason can name, and what the pool should do about each. */
export type FailureFamily =
	/** The work was already delivered under another id: re-filing it is the loop, not the remedy. */
	| "duplicate"
	/** A row the pool holds was closed because a terminal one outlived it (superseded/parked residue). */
	| "superseded"
	/** Something this pool cannot reach blocked it: a capability, a dead dependency, an impossible flow. */
	| "blocked"
	/** Everything else: a real attempt that failed, which a retry is allowed to revive. */
	| "other";

/** The classification of ONE failure reason, with the evidence that produced it. */
export interface FailureClass {
	/** The family this reason belongs to. */
	family: FailureFamily;
	/** The first reason fragment that decided the family — the evidence a caller can quote. */
	evidence: string;
	/** The family's own key: `duplicate`, `superseded`, `blocked` or `other`. */
	key: string;
}

/** How long after a same-cause failure a retry may be granted again without an escalation. */
export const RETRY_COOLDOWN_MS = 5 * 60_000;

/** How many same-cause failures one deliverable may take before the retry gate holds for good. */
export const RETRY_STOP_AFTER = 3;

/**
 * What a retry gate decides, in the shape `driver.ts`'s `AlertDecision` uses, so a caller that
 * already handles one gate handles the other.
 */
export interface RetryDecision {
	/** Whether the retry should be allowed to run. */
	allow: boolean;
	/** One line naming the prior attempt and the family, never a bare "duplicate". */
	reason: string;
	/** What the caller should do instead — always present when `allow` is false. */
	remedy: string;
	/** Which rule fired: the stop rule, the cooldown, or the pass-through. */
	rule: "stop" | "cooldown" | "pass";
	/** The memory the caller holds after this decision. */
	next: RetryMemory;
	/** The family the gate classified the failure into. */
	family: FailureFamily;
}

/** The caller's memory: the last same-cause failure this deliverable took, and how many. */
export interface RetryMemory {
	/** The family key of the last failure this memory holds, or `undefined` before the first. */
	familyKey?: string;
	/** When that failure happened (the caller's clock). */
	lastAt?: number;
	/** How many same-cause failures this memory has counted. */
	count: number;
}

/**
 * The reason fragments that name a DUPLICATE cause, in the order they are read.
 *
 * These are measured against this pool's own 45 failed rows rather than invented, and the counts
 * below are the split `classifyFailure` gives over those rows (duplicate 28, superseded 15, blocked 1,
 * other 1 — re-measured by `bun scratch/goal17/replay-l1.ts`, which is the one place the numbers
 * stay true as the pool moves). The `already delivered` fragment is load-bearing on its own: it is
 * what task-136 and task-141 carry verbatim ("no code written, no file touched, no commit; the
 * deliverable is already delivered twice over"), and without it those two land in `superseded` and
 * get pointed at the wrong remedy.
 *
 * `superseded` is deliberately NOT in the duplicate family — a row superseded by a NEWER refinement of
 * the same work has a live successor and needs a different remedy than a row whose twin was already
 * delivered. The order inside `classifyFailure` puts duplicate FIRST for the same reason: task-156/
 * 158/164 name BOTH ("SUPERSEDED / DUPLICATE"), and their remedy is the duplicate one.
 */
const DUPLICATE_MARKERS = [
	"duplicate",
	"same deliverable as canonical",
	"already delivered",
	"already delivered and live-verified",
	"closed unexecuted so no idle peer re-does it",
];

/** The markers of a row the pool closed because a terminal row outlived it. */
const SUPERSEDED_MARKERS = ["superseded", "closed as covered", "covered by", "parked as", "dead residue"];

/**
 * The markers of a failure nothing this pool can reach could have cleared.
 *
 * Measured narrowly, and the narrowness is the point: this pool's real blockers say what is
 * blocking (`BLOCKED-BY-MECHANISM`, `the capability is unreachable`, `deps ... are terminal`, `the
 * task's flow is impossible`). Two rows nearly proved the loose version wrong — task-201's "a
 * second writer is impossible by construction" and task-129's "this row was unclaimable for ~13
 * minutes behind ... reservations" both name a blocker-shaped word while describing a row whose
 * real cause is a delivered duplicate. A marker that matches prose about ANOTHER row's constraint
 * would stop a retry that is exactly the remedy, so the marker must name THIS row's blocker.
 */
const BLOCKED_MARKERS = [
	"blocked-by-mechanism",
	"flow is impossible",
	"capability is unreachable",
	"unreachable capability",
	"deps are terminal",
	"dependencies are terminal",
	"can never reach done",
	"refused: the capability",
];

/** The first marker of `markers` the reason contains, or `undefined` — the evidence a caller quotes. */
function firstMarker(reason: string, markers: ReadonlyArray<string>): string | undefined {
	const text = reason.toLowerCase().replace(/\s+/g, " ").trim();
	for (const marker of markers) {
		if (text.includes(marker)) return marker;
	}
	return undefined;
}

/**
 * Classify why a row failed, from its own result text.
 *
 * The order is deliberate and measured, not alphabetical: `duplicate` wins over `superseded`
 * because task-156/158/164 name BOTH ("SUPERSEDED / DUPLICATE") and their remedy is the duplicate
 * one — the work is already live, so re-filing it is the loop the goal is asking us to stop.
 * `blocked` is read before both so a row that failed because a capability is unreachable is never
 * mistaken for a duplicate merely because the strand notice mentioned a duplicate task.
 */
export function classifyFailure(reason: string): FailureClass {
	const duplicate = firstMarker(reason ?? "", DUPLICATE_MARKERS);
	if (duplicate !== undefined) return { family: "duplicate", evidence: duplicate, key: "duplicate" };
	const blocked = firstMarker(reason ?? "", BLOCKED_MARKERS);
	if (blocked !== undefined) return { family: "blocked", evidence: blocked, key: "blocked" };
	const superseded = firstMarker(reason ?? "", SUPERSEDED_MARKERS);
	if (superseded !== undefined) return { family: "superseded", evidence: superseded, key: "superseded" };
	return { family: "other", evidence: "", key: "other" };
}

/**
 * Should this retry run? A pure decision of (deliverable key, family, attempt count, clock, memory).
 *
 * The rule, in one place:
 *
 *   - a failure whose family is NOT repeatable (`duplicate`, `superseded`, `blocked`) is held from
 *     {@link RETRY_STOP_AFTER} same-cause attempts on. Below that, a retry inside
 *     {@link RETRY_COOLDOWN_MS} of the last same-cause failure is held with the age — a re-file 24
 *     seconds after the same cause is the loop, not a fresh attempt.
 *   - `other` is always allowed: a real attempt that failed for a real reason is exactly what the
 *     retry path exists for, and nothing here may make a dead end permanent.
 *
 * The `count` that stops a retry is the memory's own same-cause count, NOT `tasks.attempts`: the
 * attempts column counts every claim, and a row that was claimed, reviewed and re-claimed three
 * times for a healthy reason would hit a stop rule keyed on it. The family key is the state that
 * distinguishes them, which is why it is in {@link RetryMemory} and not re-derived from a title.
 */
export function retryGate(input: {
	/** The deliverable the failing row carries (its normalised title — see `deliverableKey`). */
	deliverable: string;
	/** The reason the row failed, from which the family is read. */
	reason: string;
	/** The attempt number the retry would become (1 for the first retry). */
	attempt: number;
	/** The caller's clock. */
	now: number;
	/** The caller's memory for this deliverable; absent means a fresh gate. */
	memory?: RetryMemory;
	/** Override for tests and for an operator who knows the window should differ. */
	cooldownMs?: number;
	stopAfter?: number;
}): RetryDecision {
	const cooldownMs = input.cooldownMs ?? RETRY_COOLDOWN_MS;
	const stopAfter = input.stopAfter ?? RETRY_STOP_AFTER;
	const memory = input.memory ?? { familyKey: undefined, lastAt: 0, count: 0 };
	const failure = classifyFailure(input.reason);
	// `other` counts too, so the memory stays an honest ledger of this deliverable's failures — but
	// a NON-repeatable family can never reach the stop rule, because the branches below return for
	// `other` before `count` is ever compared against `stopAfter`.
	const count = memory.familyKey === failure.key ? memory.count + 1 : 1;
	const next: RetryMemory = { familyKey: failure.key, lastAt: input.now, count };
	if (failure.family === "other") {
		return {
			allow: true,
			reason: `attempt ${input.attempt}: this failure is not a repeatable family (${failure.evidence || "no cause marker"}), so the retry is the remedy`,
			remedy: "",
			rule: "pass",
			next,
			family: failure.family,
		};
	}
	if (count >= stopAfter) {
		return {
			allow: false,
			reason: `attempt ${input.attempt} refused: the same cause family "${failure.key}" (${failure.evidence}) has now failed ${count} times on one deliverable — re-filing it does not change the outcome`,
			remedy: duplicateRemedy(failure.family, input.deliverable),
			rule: "stop",
			next,
			family: failure.family,
		};
	}
	if (memory.familyKey === failure.key && memory.lastAt !== undefined && input.now - memory.lastAt < cooldownMs) {
		const silentFor = Math.max(0, Math.round((input.now - memory.lastAt) / 1000));
		return {
			allow: false,
			reason: `attempt ${input.attempt} refused: the same cause family "${failure.key}" failed ${silentFor}s ago; the retry cooldown is ${Math.round(cooldownMs / 1000)}s`,
			remedy: `wait out the cooldown (${Math.round(cooldownMs / 1000)}s) or change the row so the cause no longer applies: ${duplicateRemedy(failure.family, input.deliverable)}`,
			rule: "cooldown",
			next,
			family: failure.family,
		};
	}
	return {
		allow: true,
		reason: `attempt ${input.attempt}: ${count === 1 ? "first" : `${count}`} same-cause failure of family "${failure.key}" (${failure.evidence}); below the stop rule of ${stopAfter}`,
		remedy: "",
		rule: "pass",
		next,
		family: failure.family,
	};
}

/** What a caller should do instead of re-filing the row, per family. */
function duplicateRemedy(family: FailureFamily, deliverable: string): string {
	switch (family) {
		case "duplicate":
			return `the deliverable is already live under another row: find it (the reason names it) and close this row against it, or extend "${deliverable}" so the work differs`;
		case "superseded":
			return `a terminal row outlives this one: close this row against its successor instead of re-filing the same work`;
		case "blocked":
			return `nothing this pool can reach clears this cause: re-file the row with a reachable capability or a satisfied dependency, or ask the operator — a retry cannot change the blocker`;
		default:
			return "";
	}
}

/** The board entry a held retry leaves: the audit trail, so a stop is reversible and reviewable. */
export function retryEscalation(input: {
	taskId: string;
	deliverable: string;
	decision: RetryDecision;
	/** When the first same-cause failure happened (the caller's clock), for the age. */
	firstSeenAt?: number;
	now: number;
}): { content: string; tags: string[] } {
	const ageMinutes = input.firstSeenAt === undefined ? 0 : Math.max(0, Math.round((input.now - input.firstSeenAt) / 60_000));
	return {
		content: [
			`RETRY HELD (goal-17 L1): ${input.taskId} was not retried.`,
			"",
			`${input.decision.reason}`,
			"",
			`REMEDY: ${input.decision.remedy}`,
			`FAMILY: ${input.decision.family} — the same cause, in this deliverable, ${ageMinutes > 0 ? `first seen ${ageMinutes} minute(s) ago` : "first attempt"}.`,
			`DELIVERABLE: ${input.deliverable}`,
			"",
			"The retry is recoverable: change the cause (the files, the capability, the deliverable's scope) and the next retry is a fresh attempt. This entry is the audit trail of the stop, written once.",
		].join("\n"),
		tags: ["retry-held", `failure-family:${input.decision.family}`, "goal-17"],
	};
}
