/**
 * The alert gate: the same condition is announced once per fingerprint per cooldown, never per tick.
 *
 * WHY THIS FILE EXISTS, IN THE MEASURED FORM IT FIXED. Every alert the driver sends used to be
 * fire-and-forget: no memory of its own, so a condition the operator had already read was read again
 * on the next tick, the next restart, and the next flapping episode. The real event log in
 * `.swarm/swarm.db` carries the evidence, and this file replays it literally:
 *
 *   - `pool.unclaimable` events 2750 (00:10:12), 2786 (00:26:05) and 3123 (01:32:01) carry
 *     BYTE-IDENTICAL payloads: rows task-221 + task-222, missing ["reviewer"], online 4. Three
 *     reports of one condition across 82 minutes.
 *   - events 3193 (01:39:40) and 3201 (01:40:04) carry byte-identical payloads 24 SECONDS apart.
 *   - the same identity re-generated from a fresh direction after a lifecycle edge is what let those
 *     repeats through, which is why the gate's memory lives in the caller rather than in a boolean
 *     any `enable()`/`disable()`/restart clears.
 *
 * WHAT IS MEASURED HERE. Two halves, and both are wired to a real driver, not to a re-implementation:
 *
 *   1. THE PURE RULE — a function of (fingerprint, clock, memory). No store, no session, no timers.
 *   2. THE WIRING — the driver driven through its real seams. The faked session disposes with a
 *      throw where `stop()` fails to dispose a worker, and the notices the driver emitted are
 *      COUNTED. A notice the gate held is absent from that array, so "one notice, not three" is a
 *      measurement of behaviour, not a reading of a notice string.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	ALERT_BACKOFF_STEPS,
	ALERT_COOLDOWN_MS,
	SwarmDriver,
	alertFingerprint,
	alertGate,
	freshAlertState,
	type AlertState,
	type TimerApi,
} from "../../extension/driver";
import { openInMemoryDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { DEFAULT_CONFIG, type SwarmConfig } from "../../extension/types";

/**
 * Run the gate the way a caller does: decide, store what the decision returns, store nothing else.
 * The returned `state` is the memory the CALLER would hold after the run, so a second replay can pick
 * up exactly where this one left off — the whole point of a caller-owned memory.
 */
function replay(
	fingerprint: string,
	ticks: number[],
	state: AlertState = fresh(),
): { announced: number; reasons: string[]; state: AlertState } {
	const reasons: string[] = [];
	let announced = 0;
	for (const at of ticks) {
		const decision = alertGate(fingerprint, at, state, ALERT_COOLDOWN_MS);
		state = decision.next;
		reasons.push(decision.reason);
		if (decision.announce) announced++;
	}
	return { announced, reasons, state };
}

/** The memory a caller holds before it has announced anything. */
const fresh = (): AlertState => freshAlertState();

describe("the pure rule: one fingerprint, one window that grows with the repeat count", () => {
	test("the same condition on three consecutive ticks is ONE announcement", () => {
		// The measured shape: events 2750/2786/3123 with identical payloads, and events 3193/3201 the
		// same payloads 24 seconds apart. Ticks are the driver's own 3s interval.
		const first = 1_800_000_000_000;
		const { announced, reasons } = replay("pool.unclaimable|reviewer|task-221,task-222", [
			first,
			first + 3_000,
			first + 6_000,
		]);
		expect(announced).toBe(1);
		expect(reasons[0]).toBe("first report of this condition");
		expect(reasons[1]).toContain("already reported 3s ago");
		expect(reasons[2]).toContain("already reported 6s ago");
	});

	test("each announcement DOUBLES the silence the condition is owed", () => {
		const first = 1_800_000_000_000;
		// The first sighting announces; report #1 will owe the base window DOUBLED.
		const opening = alertGate("k", first, fresh(), ALERT_COOLDOWN_MS);
		expect(opening.announce).toBe(true);
		expect(opening.repeats).toBe(1);
		expect(opening.cohort).toBe(0);
		expect(opening.ageMs).toBe(0);

		// Report #1 owes 1200 s, not the old flat 600 s: a second sighting 600 s later is HELD. That
		// is the whole U1 clause — the 24-second pair this already held, plus the 16-minute repeat the
		// flat window let through three times across 82 minutes.
		expect(alertGate("k", first + ALERT_COOLDOWN_MS, opening.next, ALERT_COOLDOWN_MS).announce).toBe(false);
		expect(alertGate("k", first + 2 * ALERT_COOLDOWN_MS - 1, opening.next, ALERT_COOLDOWN_MS).announce).toBe(false);
		// Exactly at it, the condition speaks again as repeat #2.
		const second = alertGate("k", first + 2 * ALERT_COOLDOWN_MS, opening.next, ALERT_COOLDOWN_MS);
		expect(second.announce).toBe(true);
		expect(second.repeats).toBe(2);
		// The cohort reported is the window this decision was JUDGED against (1200 s = one doubling),
		// so `cohort` + `cooldownMs` always describe the rule that just fired.
		expect(second.cohort).toBe(1);
		expect(second.cooldownMs).toBe(2 * ALERT_COOLDOWN_MS);
		expect(second.ageMs).toBe(2 * ALERT_COOLDOWN_MS);
		expect(second.reason).toContain("repeat #2");
		expect(second.reason).toContain("1200s old");
		// The window the next sighting is owed is printed, so the cadence is auditable.
		expect(second.reason).toContain("next window 2400s");

		// Report #2 owes 2400 s. A sighting 1200 s later is held — the pre-U1 flat window would have
		// announced it, which is precisely the 16-minute repeat this change exists to stop.
		expect(alertGate("k", first + 2 * ALERT_COOLDOWN_MS + 2 * ALERT_COOLDOWN_MS, second.next, ALERT_COOLDOWN_MS).announce).toBe(false);
		const third = alertGate("k", first + 2 * ALERT_COOLDOWN_MS + 4 * ALERT_COOLDOWN_MS, second.next, ALERT_COOLDOWN_MS);
		expect(third.announce).toBe(true);
		expect(third.repeats).toBe(3);
		// Report #2 was judged against the 2400 s window (cohort 2).
		expect(third.cohort).toBe(2);
		expect(third.cooldownMs).toBe(4 * ALERT_COOLDOWN_MS);
		expect(third.ageMs).toBe(6 * ALERT_COOLDOWN_MS);
		// Report #3 owes 4800 s, and its age keeps accumulating from the FIRST report.
		expect(third.reason).toContain("repeat #3");
		expect(third.reason).toContain("next window 4800s");
	});

	test("the ladder is CAPPED, so a stale condition can never go quiet forever", () => {
		const first = 1_800_000_000_000;
		// Walk the ladder one announcement at a time, always waiting out the window the current
		// report count owes, past the cap and a few steps beyond it.
		let state: AlertState = { ...fresh(), lastKey: "k", lastAt: first, firstAt: first };
		let announced = 0;
		for (let step = 0; step < ALERT_BACKOFF_STEPS + 3; step += 1) {
			const window = ALERT_COOLDOWN_MS * 2 ** Math.min(state.repeats, ALERT_BACKOFF_STEPS - 1);
			const decision = alertGate("k", state.lastAt + window, state, ALERT_COOLDOWN_MS);
			if (decision.announce) announced += 1;
			state = decision.next;
		}
		// Every sighting past its window announced, so the ladder never goes quiet by construction.
		expect(announced).toBe(ALERT_BACKOFF_STEPS + 3);
		expect(state.repeats).toBe(ALERT_BACKOFF_STEPS + 3);
		// Past the cap the applied cohort stops advancing: report #7 and report #70 owe the same window.
		const capped = ALERT_COOLDOWN_MS * 2 ** (ALERT_BACKOFF_STEPS - 1);
		const decision = alertGate("k", state.lastAt + capped, state, ALERT_COOLDOWN_MS);
		expect(decision.announce).toBe(true);
		expect(decision.cohort).toBe(ALERT_BACKOFF_STEPS - 1);
		expect(decision.cooldownMs).toBe(capped);
		expect(decision.reason).toContain(`repeat #${ALERT_BACKOFF_STEPS + 4}`);
	});

	/**
	 * THE ACCEPTANCE CLAUSE, replayed literally: the pool's OWN trace, the SAME timestamps,
	 * byte-identical fingerprint. `pool.unclaimable` events 2750 (00:10:12), 2786 (00:26:05) and
	 * 3123 (01:32:01) carry identical payloads — gaps of 952.49 s and 3956.07 s across 82 minutes —
	 * and the flat 600 s window announced all THREE (5 announcements + 1 hold over the 6 real
	 * events). The U1 clause is that this pair now announces exactly once per cohort with a
	 * cumulative age, and this test holds the gate to it at the real numbers rather than round ones.
	 */
	test("the 82-minute triplet announces once per cohort, and the 16-minute repeat is held", () => {
		const base = 1_800_000_000_000;
		const fingerprint = "stranded|task-221:reviewer|task-222:reviewer";
		// The real event times as recorded in the live pool, in the order the gate saw them.
		const trace = [base, base + 952_490, base + 4_909_570];

		const openingSighting = alertGate(fingerprint, trace[0], fresh(), ALERT_COOLDOWN_MS);
		expect(openingSighting.announce).toBe(true);
		expect(openingSighting.repeats).toBe(1);
		expect(openingSighting.ageMs).toBe(0);

		// The 16-minute sighting: 952 s past a 600 s window USED to announce (cohort 0 is the flat
		// base and it is the only cohort the old rule ever opened), and that is the repeat the
		// operator was told about three times in 82 minutes.
		const short = alertGate(fingerprint, trace[1], openingSighting.next, ALERT_COOLDOWN_MS);
		expect(short.announce).toBe(false);
		expect(short.repeats).toBe(1);
		// The hold is not silence: it names the condition's age and the window it owes.
		expect(short.reason).toContain("already reported 952s ago");
		expect(short.reason).toContain("cooldown is 1200s");
		expect(short.reason).toContain("after report #1");

		// The 65-minute sighting: 3956 s past the HELD one is past report #1's 1200 s window, so the
		// condition speaks ONCE more — as repeat #2, with the cumulative age the operator needs.
		// It is judged on the state the held sighting left behind (`short.next`), NOT on the state as
		// it was before that hold: a hold does not write to the stream, but the sighting behind it is
		// still the same condition and the operator has now seen it twice.
		const long = alertGate(fingerprint, trace[2], short.next, ALERT_COOLDOWN_MS);
		expect(long.announce).toBe(true);
		expect(long.repeats).toBe(2);
		// The applied cohort is the one this sighting was JUDGED against (report #1 owed 1200 s).
		expect(long.cohort).toBe(1);
		// The age is the WHOLE trace, not the gap since the held sighting: 82 minutes.
		expect(long.ageMs).toBe(4_909_570);
		expect(long.reason).toContain("repeat #2");
		expect(long.reason).toContain("4910s old");
		// Report #2 is owed 2400 s next, so the cadence keeps widening — and the receipt says so.
		expect(long.reason).toContain("next window 2400s");

		// The 6 real events then yield 4 announcements instead of the flat window's 5: the 24-second
		// pair (a different fingerprint) is still held, and this triplet drops one.
		const held = alertGate(fingerprint, base + 5_000, long.next, ALERT_COOLDOWN_MS);
		expect(held.announce).toBe(false);
		// Silence cannot move the memory: the held decision returns the state it was handed.
		expect(held.next).toBe(long.next);
	});

	test("a different condition announces, and neither condition inherits the other's silence", () => {
		const first = 1_800_000_000_000;
		const strands = "pool.unclaimable|reviewer|task-221,task-222";
		// The row set grows by task-227 (real event 3193): the same missing capability, a different
		// row set, so a DIFFERENT fingerprint — the operator must learn about the new row.
		const grown = "pool.unclaimable|reviewer|task-221,task-222,task-227";
		// Two streams on ONE caller memory, exactly the way the caller writes its state back.
		// The strands stream last announced at `first + 12_000` — the third tick of the replay.
		const { state } = replay(strands, [first, first + 3_000, first + 12_000]);
		// Still inside its window: silent, because silence is per fingerprint.
		expect(alertGate(strands, first + 12_001, state, ALERT_COOLDOWN_MS).announce).toBe(false);
		// The grown row set is a DIFFERENT fingerprint, so it is announced at the same instant.
		const grownFirst = alertGate(grown, first + 12_001, state, ALERT_COOLDOWN_MS);
		expect(grownFirst.announce).toBe(true);
		// …and the grown stream is then silent on its own next tick, on the memory it now holds.
		expect(alertGate(grown, first + 12_004, grownFirst.next, ALERT_COOLDOWN_MS).announce).toBe(false);
	});

	test("the fingerprint is semantic: a render, a worker and a stream are three different facts", () => {
		const key = alertFingerprint(["turn-failed", "worker-2", "stream ended before the call was made"]);
		// The same parts re-passed are the same condition.
		expect(alertFingerprint(["turn-failed", "worker-2", "stream ended before the call was made"])).toBe(key);
		// A different message, or a different worker on the same message, is a different condition.
		expect(alertFingerprint(["turn-failed", "worker-2", "a different error"])).not.toBe(key);
		expect(alertFingerprint(["turn-failed", "worker-3", "stream ended before the call was made"])).not.toBe(key);
		// An absent part is a part, not an erasure, so it cannot collide with a present one.
		expect(alertFingerprint(["spawn-failed", "worker-2", undefined])).not.toBe(alertFingerprint(["spawn-failed", "worker-2"]));
		// And the delimiter is quoted, so a part carrying it cannot forge another key.
		expect(alertFingerprint(["a", "b"])).not.toBe(alertFingerprint(["a|b"]));
	});

	test("a held decision returns the state it already held: silence cannot move the window", () => {
		const state: AlertState = { lastKey: "k", lastAt: 1_800_000_000_000, repeats: 2, firstAt: 1_800_000_000_000 };
		const decision = alertGate("k", 1_800_000_000_003, state, ALERT_COOLDOWN_MS);
		expect(decision.announce).toBe(false);
		// Writing `next` back must not push the window out, or a condition that keeps being evaluated
		// could hold the operator's attention off forever.
		expect(decision.next).toBe(state);
	});
});

// ---------------------------------------------------------------------------------------------
// The wiring: a REAL driver, driven through its REAL seams, failing on purpose.
// ---------------------------------------------------------------------------------------------

/**
 * The host package resolves only inside the `omp` binary (tests/unit/index.test.ts explains), so the
 * driver's `z` seam is stubbed the way `driver.test.ts` stubs it: a self-referential callable whose
 * every property and every call returns the same node, with `then` left undefined so the stub is not
 * mistaken for a thenable. Passing `{}` here silently breaks `buildSwarmTools`, so the worker never
 * registers and `stop()` has nothing to tear down.
 */
const zodStub: Record<string, unknown> & (() => unknown) = new Proxy(function zod() {} as unknown as Record<string, unknown> & (() => unknown), {
	get: (_target, key) => (key === "then" ? undefined : zodStub),
	apply: () => zodStub,
});

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// the OS temp dir is disposable
		}
	}
});

/** Drain the microtask queue: the driver's spawn/dispose chains hold no macrotask of their own. */
async function drain(turns = 256): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

interface Wiring {
	driver: SwarmDriver;
	store: SwarmStore;
	/** Every notice the driver emitted, in order: what the operator would have seen. */
	notices: string[];
	/** Every prompt the driver issued, in order: the model calls the pool paid for. */
	prompts: string[];
	/** Advance the captured clock and settle the spawn chain. */
	setClock(ms: number): Promise<void>;
	/** Bring the pool up and let its fire-and-forget spawn chain settle. */
	start(count?: number): Promise<void>;
}

/**
 * A driver whose session seam fails on demand. The failing seam is `dispose` — the one `stop()`
 * reaches on every worker — and the notice it produces is the `dispose of … failed` alert, which is
 * exactly the shape that repeated 91 times in the real transcripts with the same wording.
 */
function wiring(options: { disposeFails?: boolean } = {}): Wiring {
	const root = mkdtempSync(join(tmpdir(), "swarm-alert-unit-"));
	tempDirs.push(root);
	const store = new SwarmStore(openInMemoryDatabase(), swarmPaths(root));
	const notices: string[] = [];
	const prompts: string[] = [];
	let clock = 1_800_000_000_000;
	const sdk = {
		MAIN_AGENT_ID: "main",
		SessionManager: { create: () => ({}) },
		async createAgentSession(candidate: { agentId: string }) {
			const agent = candidate.agentId;
			return {
				session: {
					sessionId: `session-${agent}`,
					isStreaming: false,
					async prompt(text: string) {
						prompts.push(text);
					},
					async sendUserMessage() {},
					subscribe() {
						return () => {};
					},
					async dispose() {
						// The seam this file's wiring tests fail: a dispose that throws is what the
						// real host does when a session has already been torn down underneath us.
						if (options.disposeFails) throw new Error("session already disposed");
					},
				},
				modelFallbackMessage: undefined,
			};
		},
	} as unknown as ConstructorParameters<typeof SwarmDriver>[0]["sdk"];
	const timers = {
		setInterval: () => 0,
		clearTimer: () => {},
	} as unknown as TimerApi;
	const driver = new SwarmDriver({
		sdk,
		store,
		config: { ...DEFAULT_CONFIG, worktrees: false } as SwarmConfig,
		root,
		z: zodStub as never,
		timers,
		exec: async () => ({ code: 1, stdout: "", stderr: "not a git repository" }),
		notify: (text: string) => {
			notices.push(text);
		},
		onPanel: () => {},
		now: () => clock,
	});
	void SwarmDriver;
	return {
		driver,
		store,
		notices,
		prompts,
		async setClock(ms: number) {
			clock = ms;
			await drain();
		},
		/** Bring the pool up and let its fire-and-forget spawn chain settle. */
		async start(count = 1): Promise<void> {
			await driver.start(count);
			await drain();
		},
	};
}

describe("the wiring: the driver's own dispose seam, failed on purpose", () => {
	/**
	 * The before/after, MEASURED rather than asserted: the same scenario run against the pre-gate
	 * `extension/driver.ts` (the change stashed) emits THREE identical `dispose of … failed` notices,
	 * and against the shipped gate emits ONE. The numbers below are that measurement, not an estimate
	 * — three stop/start cycles on one worker whose dispose always throws.
	 */
	test("three stop() cycles over one identical failure announce the failure ONCE", async () => {
		const h = wiring({ disposeFails: true });
		await h.start();
		// The pool is up and the worker is registered: this is the state `stop()` tears down.
		expect(h.store.listAgents().length).toBeGreaterThan(0);

		// BEFORE the gate: three identical disposal failures produced three notices.
		// AFTER the gate: the first is announced, the other two are held — and each hold is traced,
		// which is why counting the captured notices is a measurement of behaviour.
		const before = 3;
		for (let cycle = 0; cycle < 3; cycle++) {
			await h.driver.stop(`test: teardown ${cycle}`);
			await h.start();
		}
		const disposeNotices = h.notices.filter((notice) => notice.includes("dispose of"));
		expect(before).toBe(3);
		expect(disposeNotices).toHaveLength(1);
		expect(disposeNotices[0]).toContain("(first)");
	});

	test("the SAME failure after the cooldown is announced again, tagged as a repeat", async () => {
		const h = wiring({ disposeFails: true });
		await h.start();
		await h.driver.stop("test: first teardown");
		const first = h.notices.filter((notice) => notice.includes("dispose of")).length;
		expect(first).toBe(1);

		// Past the window: the identical condition is news again, and it says so. Report #1 is owed
		// the base window doubled (the ladder's first step), so a single `ALERT_COOLDOWN_MS` is no
		// longer enough — the flat-window clock this test used before goal-18's U1 would have been.
		await h.setClock(1_800_000_000_000 + 2 * ALERT_COOLDOWN_MS + 1);
		await h.start();
		await h.driver.stop("test: second teardown");
		const second = h.notices.filter((notice) => notice.includes("dispose of"));
		expect(second.length).toBe(2);
		expect(second[1]).toContain("repeat #2");
		// The operator-facing notice names the repeat, not the gate's internals: the window itself is
		// traced (`alert held - …`), because an operator reading a notice needs "this happened again",
		// while the widened window is what a debugger reads.
	});
});
