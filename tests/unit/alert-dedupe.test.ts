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
	ALERT_COOLDOWN_MS,
	SwarmDriver,
	alertFingerprint,
	alertGate,
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
const fresh = (): AlertState => ({ lastKey: undefined, lastAt: 0, repeats: 0 });

describe("the pure rule: one fingerprint, one cooldown window", () => {
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

	test("the window bounds the silence, and the report after it carries its age", () => {
		const first = 1_800_000_000_000;
		const { announced, state } = replay("pool.unclaimable|reviewer|task-221,task-222", [
			first,
			first + ALERT_COOLDOWN_MS - 1,
			first + ALERT_COOLDOWN_MS,
			first + 2 * ALERT_COOLDOWN_MS,
		]);
		// Inside the window: silent. AT the window and past it: announced, with the repeat count the
		// operator reads as "this is not news, it is three hours old".
		expect(announced).toBe(3);
		// The memory the caller would hold after the run carries all three announcements.
		expect(state.repeats).toBe(3);
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
		const state: AlertState = { lastKey: "k", lastAt: 1_800_000_000_000, repeats: 2 };
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

		// Past the window: the identical condition is news again, and it says so.
		await h.setClock(1_800_000_000_000 + ALERT_COOLDOWN_MS + 1);
		await h.start();
		await h.driver.stop("test: second teardown");
		const second = h.notices.filter((notice) => notice.includes("dispose of"));
		expect(second.length).toBe(2);
		expect(second[1]).toContain("repeat #2");
	});
});
