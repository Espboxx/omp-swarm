/**
 * `/swarm web`'s pure surface: argument parsing, port validation, the free-port scan, URL formatting
 * and the dashboard's own state reporting. No host, no spawned process — the parts that need a real
 * child are proven live (see the task's transcript and port/orphan checks), and everything a typo can
 * break is asserted here.
 */
import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
	bunBinary,
	DEFAULT_WEB_PORT,
	isPortFree,
	isValidPort,
	MAX_PORT,
	nextFreePort,
	parseWebArgs,
	PORT_SCAN_ATTEMPTS,
	WEB_HOST,
	WebDashboard,
	webUrl,
} from "../../extension/web";

describe("parseWebArgs", () => {
	test("bare /swarm web starts, because one keystroke is the whole point", () => {
		const parsed = parseWebArgs([]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.options).toEqual({ action: "start", port: undefined });
	});

	test("the three actions are recognised", () => {
		for (const action of ["start", "stop", "status"] as const) {
			const parsed = parseWebArgs([action]);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.options.action).toBe(action);
		}
	});

	test("--port is accepted in both spellings", () => {
		const spaced = parseWebArgs(["start", "--port", "9100"]);
		const inline = parseWebArgs(["start", "--port=9100"]);
		expect(spaced.ok && inline.ok).toBe(true);
		if (spaced.ok) expect(spaced.options.port).toBe(9100);
		if (inline.ok) expect(inline.options.port).toBe(9100);
	});

	test("a repeated identical action is fine, two different ones are not", () => {
		expect(parseWebArgs(["start", "start"]).ok).toBe(true);
		const conflicting = parseWebArgs(["start", "stop"]);
		expect(conflicting.ok).toBe(false);
		if (!conflicting.ok) expect(conflicting.error).toContain("usage");
	});

	test("a bad port is refused with the offending value, never defaulted silently", () => {
		for (const bad of ["0", "-1", "65536", "1.5", "abc", ""]) {
			const parsed = parseWebArgs(["start", "--port", bad]);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain(JSON.stringify(bad));
		}
		const missing = parseWebArgs(["start", "--port"]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("--port needs a number");
	});

	test("an unknown option is refused rather than ignored", () => {
		const parsed = parseWebArgs(["start", "--verbose"]);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain("usage");
	});

	test("--port is only meaningful for a start", () => {
		expect(parseWebArgs(["status", "--port", "9000"]).ok).toBe(false);
		expect(parseWebArgs(["stop", "--port=9000"]).ok).toBe(false);
	});
});

describe("isValidPort", () => {
	test("the legal range is exactly 1..65535, integers only", () => {
		expect(isValidPort(1)).toBe(true);
		expect(isValidPort(DEFAULT_WEB_PORT)).toBe(true);
		expect(isValidPort(MAX_PORT)).toBe(true);
		expect(isValidPort(0)).toBe(false);
		expect(isValidPort(MAX_PORT + 1)).toBe(false);
		expect(isValidPort(8080.5)).toBe(false);
		expect(isValidPort(Number.NaN)).toBe(false);
		expect(isValidPort(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("nextFreePort", () => {
	test("takes the preferred port when it is free", () => {
		expect(nextFreePort(8787, () => true)).toBe(8787);
	});

	test("steps past taken ports", () => {
		const taken = new Set([8787, 8788, 8789]);
		expect(nextFreePort(8787, (port) => !taken.has(port))).toBe(8790);
	});

	test("gives up after the scan instead of walking the whole range", () => {
		let probes = 0;
		const found = nextFreePort(8787, (port) => {
			probes += 1;
			return port === 8799;
		});
		expect(found).toBe(8799);
		expect(probes).toBe(13); // 8787..8799, and nothing is probed past the hit

		let seen = 0;
		const hit = nextFreePort(8787, () => {
			seen += 1;
			return false;
		});
		expect(hit).toBeUndefined();
		expect(seen).toBe(PORT_SCAN_ATTEMPTS); // an all-taken range stops at the advertised bound
		expect(nextFreePort(8787, () => true, 1)).toBe(8787);
	});

	test("never proposes a port below 1, and stops at the top of the range", () => {
		expect(nextFreePort(-5, () => true)).toBe(1);
		expect(nextFreePort(MAX_PORT, () => true)).toBe(MAX_PORT);
		expect(nextFreePort(MAX_PORT, () => false)).toBeUndefined();
	});

	test("the default scan covers exactly the attempts it advertises", () => {
		const seen: number[] = [];
		nextFreePort(DEFAULT_WEB_PORT, (port) => {
			seen.push(port);
			return false;
		});
		expect(seen.length).toBe(PORT_SCAN_ATTEMPTS);
		expect(seen.at(0)).toBe(DEFAULT_WEB_PORT);
	});
});

describe("webUrl + WEB_HOST", () => {
	test("the URL is loopback-only and carries the real port", () => {
		expect(webUrl(8787)).toBe("http://127.0.0.1:8787");
		expect(WEB_HOST).toBe("127.0.0.1");
		expect(webUrl(9100)).toContain(WEB_HOST);
	});
});

describe("bunBinary", () => {
	test("either resolves a bun executable or says it cannot", () => {
		const found = bunBinary();
		if (found !== undefined) expect(/^bun(\.exe)?$/i.test(basename(found))).toBe(true);
	});
});

describe("WebDashboard without a process", () => {
	test("reports stopped, and stopping twice is safe", () => {
		const dashboard = new WebDashboard("/nowhere", "/nowhere/web/server.ts");
		expect(dashboard.isRunning()).toBe(false);
		expect(dashboard.state).toBeUndefined();
		expect(dashboard.stop()).toBe(false);
		expect(dashboard.stop()).toBe(false);
		expect(dashboard.statusLine()).toContain("stopped");
	});
});

describe("isPortFree", () => {
	test("sees a bound port as taken, and releases whatever it binds itself", () => {
		const server = Bun.serve({ hostname: WEB_HOST, port: 0, fetch: () => new Response("held") });
		const held = server.port ?? 0;
		expect(held).toBeGreaterThan(0);
		expect(isPortFree(held)).toBe(false); // bound by the other server
		server.stop(true);
		expect(isPortFree(held)).toBe(true); // free again
		expect(isPortFree(held)).toBe(true); // and the probe above did not leak the binding
	});
});
