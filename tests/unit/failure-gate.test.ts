/**
 * goal-17's L1: the retry gate, in the measured form it fixed.
 *
 * WHY THIS FILE EXISTS, IN THE MEASURED FORM. `store.retryTask` revived any `failed` or `blocked`
 * row on request and read nothing about WHY it failed, so a row whose deliverable was already live
 * under another id could be re-filed as a fresh attempt forever. The live pool's own numbers, read
 * from `.swarm/swarm.db` at the time this file was written and re-runnable at any time via
 * `bun scratch/goal17/replay-l1.ts` (which drives the SHIPPED classifier, not a copy of it): 45 rows
 * in `failed`, of which the classifier reads 44 into a repeatable family — duplicate 28, superseded
 * 15, blocked 1 — with task-125 (goal-1's planning round hit its 600s bound with no plan) the single
 * `other`, always retryable by design.
 *
 * A note on the number, because the raw keyword scan disagrees and a future reader must know why
 * the panel is smaller: `/SUPERSEDED|DUPLICATE/` matches 41 of 45 rows, but that scan cannot tell a
 * row whose cause is a DELIVERED DUPLICATE (28 of them, whose re-file is the loop) from a row a
 * terminal one OUTLIVED (15, which already has a live successor and a different remedy). The
 * classifier's split is the usable count; the keyword count is the trap.
 *
 * WHAT IS MEASURED HERE, in the two halves `alert-dedupe.test.ts` uses:
 *
 *   1. THE PURE RULE — `classifyFailure` and `retryGate` are pure: a reason string in, a decision
 *      out, with the clock and the memory passed by the caller. No store, no timers, no session.
 *   2. THE WIRING — a real `SwarmStore` on a real (in-memory) database, driven through
 *      `retryTask` itself, so "the same cause failed N times → the retry is held → one board entry
 *      names the family and the remedy" is a measurement of behaviour rather than a reading of a
 *      string the gate returned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { classifyFailure, retryEscalation, retryGate, type RetryDecision, type RetryMemory } from "../../extension/failure-gate";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";

/**
 * The OMP-SWARM repository root, the same way `host-free-load.test.ts` derives it — one level up
 * from `tests/unit/`. The swarm's own database lives OUTSIDE this repo, in the parent directory
 * (`C:/Users/93715/code/test4/.swarm/swarm.db`), which is why the live-pool test below goes up
 * twice: `tests/unit -> omp-swarm -> test4`.
 */
const REPO = resolve(import.meta.dir, "..", "..", "..");

/** A fresh gate memory: nothing has failed yet. */
const fresh = (): RetryMemory => ({ familyKey: undefined, lastAt: 0, count: 0 });

/** One decision, the way a caller makes it: reason in, decision out, memory in. */
function decide(reason: string, attempt: number, now: number, memory: RetryMemory | undefined, extra: { cooldownMs?: number; stopAfter?: number } = {}): RetryDecision {
	return retryGate({ deliverable: "the-same-deliverable", reason, attempt, now, memory, ...extra });
}

describe("classifyFailure reads the cause from the reason", () => {
	test("the measured duplicate family, verbatim from this pool's failed rows", () => {
		// task-154/155/156's own result text, and task-129/136/141's.
		expect(classifyFailure("SUPERSEDED / DUPLICATE — closed unexecuted. Same deliverable as canonical task-150").family).toBe("duplicate");
		expect(classifyFailure("SUPERSEDED / DUPLICATE — not executed, deliberately. Same deliverable as canonical task-151").family).toBe("duplicate");
		expect(classifyFailure("CLOSED AS SUPERSEDED — the deliverable is already delivered and live-verified").family).toBe("duplicate");
		expect(classifyFailure("DUPLICATE — this row's acceptance is already delivered, by the same verifier it names").family).toBe("duplicate");
	});

	test("a row a terminal one outlived is superseded, not duplicate", () => {
		expect(classifyFailure("SUPERSEDED BY task-199 (done at d617565) — the two minors it covered shipped inside task-199").family).toBe("superseded");
		expect(classifyFailure("CLOSED AS SUPERSEDED - panel-era residue; no work executed").family).toBe("superseded");
		// The order is load-bearing: "SUPERSEDED / DUPLICATE" names BOTH, and the remedy is the
		// duplicate one — the work is already live, so re-filing it is the loop.
		expect(classifyFailure("SUPERSEDED / DUPLICATE — same work twice").family).toBe("duplicate");
	});

	test("a failure nothing this pool can reach is blocked", () => {
		expect(classifyFailure("BLOCKED-BY-MECHANISM — the sanctioned retry->claim->fail cannot work").family).toBe("blocked");
		expect(classifyFailure("the mint was refused: the capability is unreachable").family).toBe("blocked");
		expect(classifyFailure("its dependencies can never reach done").family).toBe("blocked");
	});

	/**
	 * The counter-case that pins the markers' NARROWNESS, taken verbatim from the live rows that
	 * nearly proved it wrong. task-201's own text carries "a second writer is impossible by
	 * construction now", and task-129's carries "this row was unclaimable for ~13 minutes behind
	 * reservations" — both name a blocker-shaped phrase while describing a row whose real cause is a
	 * DELIVERED DUPLICATE. A loose marker (`impossible`, `unclaimable`, `reservations`) would
	 * classify them `blocked`, whose remedy is "re-file with a reachable capability" — it would stop
	 * the very retry that is the remedy and route the closer to the wrong action.
	 */
	test("blocker-shaped prose about ANOTHER row's constraint is not this row's family", () => {
		// task-201 verbatim tail, from .swarm/swarm.db.
		expect(classifyFailure("SUPERSEDED BY task-199 (DECISION #765 / #768 / #806). Closed unexecuted by LunarTiger under the authorization in DECISION #806: one claim, no file touched, no edit, no commit, nothing written. Rationale: task-199 landed this row's exact artifact set (extension/store.ts + extension/tools.ts + tests/unit/vote-store.test.ts + tools.test.ts) as commit d617565 — a second writer on it is impossible by construction now; and while this row stays `ready`, counts.ready never reaches 0").family).toBe("superseded");
		// task-166/168 verbatim shape: PERMANENTLY-BLOCKED RESIDUE whose DEPENDENCIES were minted
		// against duplicate rows. The cause of THIS row is the duplicate dep chain, not an
		// unreachable capability — so the duplicate remedy is the honest one.
		expect(classifyFailure("PERMANENTLY-BLOCKED RESIDUE — closed unexecuted. task-166 is a second \"consolidate the advisories into one handoff\" row, and its dependencies were minted against the DUPLICATE rows task-160 and task-161, both of which are now `failed`").family).toBe("duplicate");
		// And the real blocked row keeps its own family: task-88 says what is blocking, about itself.
		expect(classifyFailure("PARKED AS failed (NOT EXECUTED — the task's flow is impossible, no residue id could be closed). The sanctioned retry->claim->fail cannot work for any of the six: their deps are terminal-but-not-done").family).toBe("blocked");
	});

	/**
	 * The remedy is the payload, so it is asserted per family rather than left as prose. A family
	 * whose remedy pointed at the wrong action would hold the right retry for the wrong reason,
	 * which is the failure the module's own header names: a stop nobody can act on is the same as
	 * no gate at all, only slower.
	 */
	test("each family's remedy names the change that makes the retry fresh again", () => {
		const duplicate = decide("SUPERSEDED / DUPLICATE — same deliverable as canonical task-150", 3, 1_000_000, { familyKey: "duplicate", lastAt: 1_000_000 - 60_000, count: 2 });
		expect(duplicate.allow).toBe(false);
		expect(duplicate.remedy).toContain("already live under another row");
		// A caps-only re-file is the strand's documented remedy, so the gate must name it.
		expect(duplicate.remedy).toContain("close this row against it");
		const superseded = decide("CLOSED AS SUPERSEDED - panel-era residue (deps task-22/task-26 failed)", 3, 1_000_000, { familyKey: "superseded", lastAt: 1_000_000 - 60_000, count: 2 });
		expect(superseded.allow).toBe(false);
		expect(superseded.remedy).toContain("a terminal row outlives this one");
		const blocked = decide("BLOCKED-BY-MECHANISM — the capability is unreachable", 3, 1_000_000, { familyKey: "blocked", lastAt: 1_000_000 - 60_000, count: 2 });
		expect(blocked.allow).toBe(false);
		expect(blocked.remedy).toContain("reachable capability");
		// `other` has no remedy because it is never held: the remedy field must stay empty, or a
		// caller would print advice for an action it is not taking.
		const passed = decide("unsupported by the parser", 1, 1_000_000, undefined);
		expect(passed.allow).toBe(true);
		expect(passed.remedy).toBe("");
	});

	test("a real attempt that failed is `other`, and the retry is always its remedy", () => {
		expect(classifyFailure("unsupported by the parser").family).toBe("other");
		expect(classifyFailure("planning round for goal-1 hit its bound (600s) with no plan").family).toBe("other");
		expect(classifyFailure("").family).toBe("other");
	});

	test("classification is case- and whitespace-insensitive but never a keyword match on the whole text", () => {
		expect(classifyFailure("  DUPLICATE  ").family).toBe("duplicate");
		expect(classifyFailure("this task is not a DuPe of anything").family).toBe("other");
	});
});

describe("retryGate: the pure rule", () => {
	/**
	 * The `other`-family exemption, asserted at the GATE rather than only at the classifier, and
	 * driven by the worst memory the gate can be handed. This is goal-18 U3's own acceptance
	 * ("the task-125 exemption is made explicit and tested... asserted in
	 * tests/unit/failure-gate.test.ts"): the classifier test above proves the text reads `other`,
	 * and this one proves no amount of same-cause history can stop such a retry.
	 *
	 * The memory below is deliberately impossible-for-a-hold: `familyKey: "other"` so the cause
	 * matches, `count: 99` (33x `RETRY_STOP_AFTER`), and `lastAt` equal to `now` so the sighting is
	 * also inside the cooldown. A holdable family is refused by both of those; `other` must not be,
	 * because the exemption is the FIRST return in `retryGate` and `count` is never compared.
	 */
	test("an `other`-family row is always retryable, under the worst memory the gate can be handed", () => {
		const worst: RetryMemory = { familyKey: "other", lastAt: 1_000_000, count: 99 };
		for (const attempt of [1, 2, 3, 10, 100]) {
			const decision = decide("planning round for goal-1 hit its bound (600s) with no plan", attempt, 1_000_000, worst);
			expect(decision.allow).toBe(true);
			expect(decision.rule).toBe("pass");
			expect(decision.family).toBe("other");
			// No remedy: `other` is never held, so a caller must not be handed advice for an action
			// it is not taking. An empty remedy is part of the contract, not an omission.
			expect(decision.remedy).toBe("");
		}
	});

	/**
	 * The same exemption against a memory keyed on a HOLDABLE family, which is the case a reader
	 * would otherwise confuse with the one above: a row whose text reads `other` but whose memory
	 * carries a `duplicate` count must still be allowed, because the decision is made from the
	 * row's own reason — not from history belonging to a different cause.
	 */
	test("an `other` reason is allowed even when the memory counts a different, holdable cause", () => {
		const decision = decide("unsupported by the parser", 3, 1_000_000, { familyKey: "duplicate", lastAt: 1_000_000, count: 98 });
		expect(decision.allow).toBe(true);
		expect(decision.family).toBe("other");
		// And the memory moves to THIS cause, so the next same-cause failure starts counting from 1
		// rather than inheriting the duplicate family's history.
		expect(decision.next.familyKey).toBe("other");
		expect(decision.next.count).toBe(1);
	});

	test("the first same-cause failure is allowed — a stop must never fire on the first attempt", () => {
		const decision = decide("DUPLICATE — same deliverable as canonical task-150", 1, 1_000, undefined);
		expect(decision.allow).toBe(true);
		expect(decision.rule).toBe("pass");
		expect(decision.family).toBe("duplicate");
		expect(decision.next.count).toBe(1);
	});

	test("the same cause inside the cooldown is held, with the age a caller can print", () => {
		const first = decide("DUPLICATE — same deliverable as canonical task-150", 1, 1_000_000, undefined);
		const second = decide("SUPERSEDED / DUPLICATE — same deliverable as canonical task-150", 2, 1_000_000 + 24_000, first.next);
		expect(second.allow).toBe(false);
		expect(second.rule).toBe("cooldown");
		expect(second.reason).toContain("24s ago");
		expect(second.reason).toContain("cooldown is 300s");
		expect(second.remedy).toContain("wait out the cooldown");
	});

	test("the same cause past the cooldown is allowed again — a dead end is never permanent", () => {
		const first = decide("DUPLICATE — same deliverable as canonical task-150", 1, 1_000_000, undefined);
		const later = decide("DUPLICATE — same deliverable as canonical task-150", 2, 1_000_000 + 6 * 60_000, first.next);
		expect(later.allow).toBe(true);
		expect(later.rule).toBe("pass");
	});

	test("the Nth same-cause failure is held for good, and the reason names the count", () => {
		const reason = "DUPLICATE — same deliverable as canonical task-150";
		let memory = fresh();
		let decision: RetryDecision | undefined;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			decision = decide(reason, attempt, 1_000_000 + attempt * 60_000, memory);
			memory = decision.next;
		}
		expect(decision?.allow).toBe(false);
		expect(decision?.rule).toBe("stop");
		expect(decision?.reason).toContain("3 times");
		expect(decision?.remedy).toContain("already live under another row");
	});

	test("a DIFFERENT cause on the same deliverable resets the counter — the family is the state, not the row id", () => {
		const duplicate = decide("DUPLICATE — same deliverable as canonical task-150", 1, 1_000_000, undefined);
		const parser = decide("unsupported by the parser", 2, 1_000_000 + 10_000, duplicate.next);
		expect(parser.allow).toBe(true);
		expect(parser.next.count).toBe(1);
		// And the non-repeatable family never stops a retry, however many times it recurs.
		let memory: RetryMemory = parser.next;
		for (let i = 0; i < 5; i += 1) memory = decide("unsupported by the parser", 3 + i, 2_000_000 + i * 60_000, memory).next;
		expect(memory.count).toBe(6);
		expect(decide("unsupported by the parser", 9, 3_000_000, memory).allow).toBe(true);
	});

	test("`other` is never held, even inside the cooldown and with a low stop rule", () => {
		const first = decide("unsupported by the parser", 1, 1_000_000, undefined);
		for (let attempt = 2; attempt <= 6; attempt += 1) {
			const again = decide("parser still unhappy", attempt, 1_000_000 + attempt, first.next, { stopAfter: 3 });
			expect(again.allow).toBe(true);
			expect(again.rule).toBe("pass");
		}
	});

	test("the caller's own clock and memory are what decide: two callers never share state", () => {
		const shared = decide("DUPLICATE — same deliverable as canonical task-150", 1, 1_000_000, undefined).next;
		const inside = decide("DUPLICATE — same deliverable as canonical task-150", 2, 1_000_000 + 30_000, shared);
		const outside = decide("DUPLICATE — same deliverable as canonical task-150", 2, 1_000_000 + 400_000, shared);
		expect(inside.allow).toBe(false);
		expect(outside.allow).toBe(true);
	});

	/**
	 * The live-pool ledger, re-measured by whoever runs the suite — not a frozen count.
	 *
	 * The pool is the only honest corpus for this classifier: the markers were chosen from these
	 * rows' own text, so a count that drifts is either the pool moving (fine) or the markers
	 * failing on new text (a bug). The test therefore reads the LIVE `.swarm/swarm.db` and asserts
	 * the property the gate needs, rather than a number that would go stale the moment a row is
	 * filed or closed.
	 *
	 * The property: every `failed` row is either in a REPEATABLE family (the gate may hold it) or
	 * is `other` (the gate must never hold it), and the `other` set is the honest exception list —
	 * a real attempt that failed for a real reason, which the retry path exists to revive.
	 */
	test("the live pool's failed rows are all classified, and every non-`other` row is holdable", () => {
		// The probe that measured this lives at scratch/goal17/replay-l1.ts and can be re-run
		// against any tree; here the suite reads the same database read-only.
		const db = new Database(resolve(REPO, ".swarm", "swarm.db"), { readonly: true });
		try {
			const rows = db.query("SELECT id,result FROM tasks WHERE status='failed' ORDER BY id").all() as { id: string; result: string | null }[];
			expect(rows.length).toBeGreaterThan(0);
			const families: Record<string, string[]> = {};
			for (const row of rows) {
				const cls = classifyFailure(String(row.result ?? ""));
				(families[cls.family] ??= []).push(String(row.id));
			}
			// Every row landed in exactly one family: no row is unclassified, so the gate's route
			// over the whole failed set is total.
			expect(Object.values(families).reduce((sum, ids) => sum + ids.length, 0)).toBe(rows.length);
			// Each holdable family holds its own evidence, so a refusal can always quote it.
			for (const row of rows) {
				const cls = classifyFailure(String(row.result ?? ""));
				if (cls.family !== "other") expect(cls.evidence).not.toBe("");
			}
			// The `other` rows are the exception list, and the rule the comment declares is what the
			// code must check: a new `other` row is not a failure of this test, a row that STOPPED
			// being `other` while its text is unchanged is. This pool's failed set GROWS — the two
			// bound-missed planning rows (task-125 goal-1, task-293 goal-20) are the same shape in
			// different words — so naming the ids as a constant made the test a timed red (measured:
			// `Expected: "task-125" / Received: "task-293"`, CalmTiger FAIL #2174).
			//
			// It is not ONE cause any more, and that is a finding rather than noise. The `other`
			// family is "a real attempt that failed, which a retry is allowed to revive" — but the
			// pool has since produced a SECOND shape that must also never be retried: a row that
			// failed on a precondition it cannot reach (task-300, goal-22's S3, whose stop-the-pool
			// precondition no agent can satisfy). Both are non-retryable, and they are non-retryable
			// for DIFFERENT reasons, so the predicate is class-aware instead of id-aware: every
			// `other` row is either a planning round that missed its bound, or a row that says so
			// itself by failing on an unreachable precondition. A third cause still fails this test,
			// which is what keeps the exception list from going quietly stale again.
			const others = families.other ?? [];
			// A row passes when its result text names one of the causes this gate must not revive.
			// A third cause is not given a pattern here on purpose: it lands in `unmatched`, and the
			// assertion below fails naming it.
			const NON_RETRYABLE_CAUSES: Array<{ cause: string; pattern: RegExp }> = [
				{ cause: "a planning round that missed its bound", pattern: /planning round for goal-\d+ hit its bound \(\d+s\) with no plan/ },
				{ cause: "a precondition the row could not reach", pattern: /failed on an unmet precondition/i },
			];
			const unmatched: string[] = [];
			for (const row of rows) {
				const cls = classifyFailure(String(row.result ?? ""));
				if (cls.family !== "other") continue;
				const text = String(row.result ?? "");
				if (!NON_RETRYABLE_CAUSES.some((entry) => entry.pattern.test(text))) unmatched.push(row.id);
			}
			expect(unmatched).toEqual([]);
			// And the floor the rule needs to stay meaningful: at least one such row exists, so the
			// loop above is exercising rows rather than passing vacuously.
			expect(others.length).toBeGreaterThan(0);
			// And the holdable majority is the point of the gate: these are the rows whose re-file
			// is the loop.
			const holdable = (families.duplicate ?? []).length + (families.superseded ?? []).length + (families.blocked ?? []).length;
			expect(holdable).toBeGreaterThan(others.length);
		} finally {
			db.close();
		}
	});
});

describe("retryEscalation: the audit trail a held retry leaves", () => {
	test("the entry names the family, the remedy and the age, and carries the class as a tag", () => {
		const held = decide("DUPLICATE — same deliverable as canonical task-154", 4, 5_000_000, { familyKey: "duplicate", lastAt: 4_000_000, count: 3 }, { stopAfter: 3 });
		const escalation = retryEscalation({ taskId: "task-200", deliverable: "probe-wakeups", decision: held, firstSeenAt: 2_000_000, now: 5_000_000 });
		expect(escalation.content).toContain("RETRY HELD (goal-17 L1): task-200 was not retried");
		expect(escalation.content).toContain("REMEDY:");
		expect(escalation.content).toContain("first seen 50 minute(s) ago");
		expect(escalation.content).toContain("DELIVERABLE: probe-wakeups");
		expect(escalation.tags).toContain("retry-held");
		expect(escalation.tags).toContain("failure-family:duplicate");
	});
});

describe("the wiring: a real store, driven through the real retry path", () => {
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

	/**
	 * A real store on a real FILE database, so a second connection can reach the same events the
	 * gate reads — `ageEvents` is how "time passed" is expressed without a wall-clock sleep, and a
	 * `:memory:` database would make it silently no-op (measured: an aged in-memory DB shows the
	 * same 0s gap as an unaged one, so the cooldown would fire instead of the stop rule).
	 */
	function makeStore(): { store: SwarmStore; paths: SwarmPaths } {
		const paths = swarmPaths(mkdtempSync(join(tmpdir(), "swarm-retry-gate-")));
		roots.push(paths.root);
		return { store: new SwarmStore(openDatabase(paths), paths), paths };
	}

	/**
	 * Reach into the same DB from a second connection and push the row's own `task.retry` events
	 * into the past. "Time passed" without a wall-clock sleep, the way `store.test.ts`'s
	 * `ageDatabase` does it — the gate reads those events' timestamps, so aging them is what makes
	 * the STOP rule fire rather than the cooldown.
	 */
	function ageEvents(paths: SwarmPaths, taskId: string, ms: number): void {
		const raw = openDatabase(paths);
		raw.run("UPDATE events SET created_at = created_at - ? WHERE type='task.retry' AND task_id=?", ms, taskId);
		raw.close();
	}

	test("a healthy failure is retried exactly as before — no behaviour change where no loop exists", () => {
		const { store } = makeStore();
		const task = store.createTask({ title: "A", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		store.fail(task.id, "A", "unsupported by the parser");
		const retried = store.retryTask(task.id, "parser regression fixed", "B");
		expect(retried.ok).toBe(true);
		expect(retried.task?.status).toBe("ready");
		expect(retried.task?.attempts).toBe(2);
		expect(store.recentEvents(5).map((event) => event.type)).toContain("task.retry");
		store.close();
	});

	test("the same cause N times holds the retry, posts one DECISION naming the family and the remedy, and never writes the row", () => {
		const { store, paths } = makeStore();
		const task = store.createTask({ title: "Probe every model-call wakeup source", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		// The row's own reason is what the gate reads — task-154's text, verbatim.
		store.fail(task.id, "A", "SUPERSEDED / DUPLICATE — closed unexecuted. Same deliverable as canonical task-150");
		// Two retries pass the stop rule's first rungs; each is aged past the cooldown so the STOP
		// rule, not the cooldown, is what fires on the third.
		expect(store.retryTask(task.id, "re-file it", "B").ok).toBe(true);
		store.claim(task.id, "B", 300);
		store.fail(task.id, "B", "SUPERSEDED / DUPLICATE — same deliverable as canonical task-150");
		ageEvents(paths, task.id, 10 * 60_000);
		expect(store.retryTask(task.id, "re-file it again", "B").ok).toBe(true);
		store.claim(task.id, "B", 300);
		store.fail(task.id, "B", "SUPERSEDED / DUPLICATE — same deliverable as canonical task-150");
		ageEvents(paths, task.id, 10 * 60_000);

		const third = store.retryTask(task.id, "and again", "B");
		expect(third.ok).toBe(false);
		expect(third.reason).toContain("duplicate");
		expect(third.reason).toContain("3 times");

		// The row was NOT written back to ready: a held retry changes nothing.
		expect(store.getTask(task.id)?.status).toBe("failed");
		// The audit trail: the held event keeps the chain unbroken, and exactly ONE DECISION entry
		// names the family and the remedy.
		const held = store.recentEvents(20).filter((event) => event.type === "task.retry.held");
		expect(held.length).toBe(1);
		expect(held[0]?.data.family).toBe("duplicate");
		const entry = store.searchBoard({ type: "DECISION", taskId: task.id })[0];
		expect(entry?.content).toContain("RETRY HELD (goal-17 L1)");
		expect(entry?.content).toContain("REMEDY:");
		expect(entry?.tags).toContain("retry-held");
		store.close();
	});

	test("the same cause inside the cooldown is held, and a changed cause is a fresh attempt", () => {
		const { store, paths } = makeStore();
		const task = store.createTask({ title: "A", createdBy: "boot" });
		store.claim(task.id, "A", 300);
		store.fail(task.id, "A", "DUPLICATE — same deliverable as canonical task-150");
		expect(store.retryTask(task.id, "again", "B").ok).toBe(true);
		store.claim(task.id, "B", 300);
		store.fail(task.id, "B", "DUPLICATE — same deliverable as canonical task-150");
		// Immediately re-retried: the cooldown holds it, and the refusal carries the age. The hold
		// also leaves the row exactly as it was — still `failed`, nothing written back to `ready`.
		const held = store.retryTask(task.id, "again now", "B");
		expect(held.ok).toBe(false);
		expect(held.reason).toContain("cooldown");
		expect(store.getTask(task.id)?.status).toBe("failed");
		// Past the cooldown the same cause is allowed again, and a CHANGED cause is a fresh attempt:
		// the family is the state, not the row.
		ageEvents(paths, task.id, 10 * 60_000);
		expect(store.retryTask(task.id, "after the cooldown", "B").ok).toBe(true);
		store.claim(task.id, "B", 300);
		store.fail(task.id, "B", "unsupported by the parser");
		expect(store.retryTask(task.id, "the real fix", "B").ok).toBe(true);
		store.close();
	});

	test("the counter persists across processes: a second store on the same db sees the history", () => {
		const paths = swarmPaths(mkdtempSync(join(tmpdir(), "swarm-retry-persist-")));
		roots.push(paths.root);
		const first = new SwarmStore(openDatabase(paths), paths);
		const task = first.createTask({ title: "A", createdBy: "boot" });
		first.claim(task.id, "A", 300);
		first.fail(task.id, "A", "DUPLICATE — same deliverable as canonical task-150");
		first.retryTask(task.id, "once", "B");
		first.close();

		// A second process: the same row, the same reason, the counter read back from the events.
		const second = new SwarmStore(openDatabase(paths), paths);
		second.claim(task.id, "B", 300);
		second.fail(task.id, "B", "DUPLICATE — same deliverable as canonical task-150");
		ageEvents(paths, task.id, 10 * 60_000);
		expect(second.retryTask(task.id, "twice", "B").ok).toBe(true);
		second.claim(task.id, "B", 300);
		second.fail(task.id, "B", "DUPLICATE — same deliverable as canonical task-150");
		ageEvents(paths, task.id, 10 * 60_000);
		const held = second.retryTask(task.id, "thrice", "B");
		expect(held.ok).toBe(false);
		expect(held.reason).toContain("3 times");
		second.close();
	});
});

/**
 * REPLAY — the measurement this file's rules were written against, reproducible against the live
 * pool with the extension's own classifier (not a re-implementation of it):
 *
 * ```bash
 * cd C:/Users/93715/code/test4 && bun -e '
 * const {Database} = require("bun:sqlite");
 * const {classifyFailure} = require("./omp-swarm/extension/failure-gate.ts");
 * const db = new Database(".swarm/swarm.db", {readonly: true});
 * const rows = db.query("SELECT id,result FROM tasks WHERE status=\"failed\"").all();
 * const byFamily = {};
 * for (const r of rows) { const f = classifyFailure(r.result ?? "").family; (byFamily[f] ??= []).push(r.id); }
 * console.log("failed", rows.length, "families", Object.fromEntries(Object.entries(byFamily).map(([k,v]) => [k, v.length])));
 * '
 * ```
 *
 * Measured when this file was written: `failed 45` — `duplicate 28`, `superseded 15`,
 * `blocked 1`, `other 1`. The two numbers worth naming: every duplicate row's reason names
 * `SUPERSEDED / DUPLICATE` or `Same deliverable as canonical task-` (so `duplicate` outranks
 * `superseded` in the classifier's order), and the one `other` is a planning-round-bound closure
 * that was never re-filed at all. The `blocked` markers are deliberately narrow because two live
 * rows (task-201's "a second writer is impossible by construction", task-129's "this row was
 * unclaimable for ~13 minutes behind ... reservations") name a blocker-shaped word while their
 * real cause is a delivered duplicate — matching those would stop the retry that is the remedy.
 */
