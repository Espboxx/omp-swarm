import { describe, expect, test } from "bun:test";
import { agentNavKey, announceCompletion, loadKeyMatcher, type HostNotification } from "../../extension/index";

/**
 * The host module (`@oh-my-pi/pi-tui`) is not a declared dependency: it resolves only because the
 * `omp` binary embeds it. Everything the extension needs from it goes through one of the three
 * exported seams below, each of which takes its loader as a parameter - so both halves of "the host
 * module is there" and "the host module is gone" are reachable here without a host.
 */

const NOTIFICATION: HostNotification = {
	title: "SWARM DONE",
	body: "SWARM DONE · 2/2 tasks (2 done) · 3 agents · 45s",
	type: "completion",
	urgency: "normal",
};

/** The bytes a terminal sends for the keys the picker documents. */
const BYTES: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", k: "k", j: "j", q: "q", x: "x" };

/** A matcher over that table, standing in for the host's `matchesKey`. */
const matcherFor = (table: Record<string, string>) => (data: string, keyId: string): boolean => table[keyId] === data;

describe("loadKeyMatcher", () => {
	test("returns the host's matcher when the module resolves", async () => {
		const matchesKey = matcherFor(BYTES);
		expect(await loadKeyMatcher(async () => ({ matchesKey }))).toBe(matchesKey);
	});

	test("an unavailable host module is a value, not a throw", async () => {
		const matcher = await loadKeyMatcher(async () => {
			throw new Error("Cannot find package '@oh-my-pi/pi-tui'");
		});
		expect(matcher).toBeUndefined();
	});
});

describe("agentNavKey", () => {
	const matcher = matcherFor(BYTES);

	test("maps the documented keys, including both spellings of the movement and close keys", () => {
		expect(agentNavKey(BYTES.up, matcher)).toBe("up");
		expect(agentNavKey(BYTES.k, matcher)).toBe("up");
		expect(agentNavKey(BYTES.down, matcher)).toBe("down");
		expect(agentNavKey(BYTES.j, matcher)).toBe("down");
		expect(agentNavKey(BYTES.enter, matcher)).toBe("enter");
		expect(agentNavKey(BYTES.escape, matcher)).toBe("close");
		expect(agentNavKey(BYTES.q, matcher)).toBe("close");
	});

	test("ignores a key the picker does not own", () => {
		expect(agentNavKey(BYTES.x, matcher)).toBeUndefined();
		expect(agentNavKey("", matcher)).toBeUndefined();
	});

	test("a matcher that knows nothing leaves every key unowned (the picker degrades to inert, never crashes)", () => {
		const nothing = () => false;
		for (const bytes of Object.values(BYTES)) expect(agentNavKey(bytes, nothing)).toBeUndefined();
	});
});

describe("announceCompletion", () => {
	test("sends on the host's own completion channel AND still calls the in-TUI fallback", async () => {
		const sent: HostNotification[] = [];
		let fallbacks = 0;
		const sentOk = await announceCompletion(
			NOTIFICATION,
			() => {
				fallbacks += 1;
			},
			async () => ({
				TERMINAL: {
					sendNotification: (notification: HostNotification) => {
						sent.push(notification);
					},
				},
			}),
		);
		expect(sentOk).toBe(true);
		expect(sent).toEqual([NOTIFICATION]);
		expect(fallbacks).toBe(1);
	});

	test("a missing host module reports failure and leaves the fallback as the only channel", async () => {
		let fallbacks = 0;
		const sentOk = await announceCompletion(
			NOTIFICATION,
			() => {
				fallbacks += 1;
			},
			async () => {
				throw new Error("Cannot find package '@oh-my-pi/pi-tui'");
			},
		);
		expect(sentOk).toBe(false);
		expect(fallbacks).toBe(1);
	});

	test("a terminal that cannot notify degrades the same way, without throwing", async () => {
		let fallbacks = 0;
		const sentOk = await announceCompletion(
			NOTIFICATION,
			() => {
				fallbacks += 1;
			},
			async () => ({
				TERMINAL: {
					sendNotification: () => {
						throw new Error("this terminal has no OSC 99");
					},
				},
			}),
		);
		expect(sentOk).toBe(false);
		expect(fallbacks).toBe(1);
	});
});
