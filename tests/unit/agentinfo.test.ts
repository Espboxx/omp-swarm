import { describe, expect, test } from "bun:test";
import {
	compactAge,
	compactCost,
	compactTokens,
	contextPct,
	formatRow,
	renderAgentInfoRows,
	sortAgentInfo,
} from "../../extension/agentinfo";
import type { AgentInfo } from "../../extension/agentinfo";

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return { id: "a1", name: "BraveFox", state: "working", ...overrides };
}

const rich: AgentInfo = {
	id: "a1",
	name: "BraveFox",
	state: "working",
	taskId: "task-30",
	taskTitle: "Rollback: remove the agent-list panel",
	taskStatus: "claimed",
	branch: "master",
	turns: 7,
	lastActivityAt: NOW - 3 * MINUTE,
	worktree: "/tmp/wt",
	ctx: { used: 62, total: 100 },
	tokens: { in: 131_072, out: 12_288, cacheRead: 4096 },
	costUsd: 0.4213,
};

describe("compactTokens", () => {
	test("keeps whole values below 1024 and compacts 1024-based above", () => {
		expect(compactTokens(999)).toBe("999");
		expect(compactTokens(1023)).toBe("1023");
		expect(compactTokens(1024)).toBe("1k");
		expect(compactTokens(12_345)).toBe("12.1k");
		expect(compactTokens(131_072)).toBe("128k");
		expect(compactTokens(1_048_576)).toBe("1M");
		expect(compactTokens(1_234_567)).toBe("1.18M");
	});

	test("a non-finite or negative count is zero, never a negative token string", () => {
		expect(compactTokens(0)).toBe("0");
		expect(compactTokens(-5)).toBe("0");
	});
});

describe("compactCost / contextPct / compactAge", () => {
	test("cost is $0 for a true zero, $? when unknown, else two decimals", () => {
		expect(compactCost(0)).toBe("$0");
		expect(compactCost(0.4213)).toBe("$0.42");
		expect(compactCost(undefined)).toBe("$?");
	});

	test("context percent degrades on an unusable window instead of inventing one", () => {
		expect(contextPct({ used: 62, total: 100 })).toBe("62%");
		expect(contextPct({ used: 0, total: 100 })).toBe("0%");
		expect(contextPct({ used: 5, total: 0 })).toBe("--%");
		expect(contextPct(undefined)).toBe("--%");
	});

	test("age compacts to s/m/h/d and clamps a future timestamp", () => {
		expect(compactAge(30_000)).toBe("30s");
		expect(compactAge(3 * MINUTE)).toBe("3m");
		expect(compactAge(2 * 60 * MINUTE)).toBe("2h");
		expect(compactAge(4 * 24 * 60 * MINUTE)).toBe("4d");
		expect(compactAge(-5000)).toBe("0s");
	});
});

describe("formatRow", () => {
	test("the rich row matches the frozen shape field for field", () => {
		expect(formatRow(rich, { now: NOW })).toBe(
			'> BraveFox · working · task-30 "Rollback: remove the agent-list panel" · ctx 62% · 128k/12k tok · $0.42 · master · 7t 3m',
		);
	});

	test("every missing fact degrades to its placeholder", () => {
		expect(formatRow(makeAgent({ state: "idle" }), { now: NOW })).toBe("- BraveFox · idle · no task · ctx --% · 0/0 tok · $? · -");
		expect(formatRow(makeAgent({ state: "offline", turns: 5 }), { now: NOW })).toBe(
			". BraveFox · offline · no task · ctx --% · 0/0 tok · $? · - · 5t",
		);
		expect(formatRow(makeAgent({ taskId: "task-7", state: "blocked" }), { now: NOW })).toBe(
			"x BraveFox · blocked · task-7 · ctx --% · 0/0 tok · $? · -",
		);
	});

	test("a clipped task title keeps the id and never exceeds the title cap", () => {
		const line = formatRow(makeAgent({ taskId: "task-9", taskTitle: "x".repeat(200) }), { now: NOW });
		expect(line).toContain(`task-9 "${"x".repeat(39)}…"`);
	});

	test("the age half follows `now`, so two frames can differ without a clock read", () => {
		const later = formatRow(rich, { now: NOW + 10 * MINUTE });
		expect(later).toContain("7t 13m");
		expect(later).not.toBe(formatRow(rich, { now: NOW }));
	});
});

describe("sortAgentInfo", () => {
	test("orders by state visibility, then name, and keeps equal rows stable", () => {
		const rows = [
			makeAgent({ id: "b", name: "Bbb", state: "offline" }),
			makeAgent({ id: "c", name: "Mmm", state: "idle" }),
			makeAgent({ id: "d", name: "Zzz", state: "working" }),
			makeAgent({ id: "e", name: "Rrr", state: "reviewing" }),
			makeAgent({ id: "f", name: "Www", state: "waiting" }),
			makeAgent({ id: "g", name: "Aaa", state: "blocked" }),
			makeAgent({ id: "h", name: "Aaa", state: "working" }),
		];
		const before = rows.map((r) => r.id);
		expect(sortAgentInfo(rows).map((r) => r.id)).toEqual(["h", "d", "e", "f", "g", "c", "b"]);
		expect(rows.map((r) => r.id)).toEqual(before);

		const first = makeAgent({ id: "first", name: "Twin", state: "working" });
		const second = makeAgent({ id: "second", name: "Twin", state: "working" });
		expect(sortAgentInfo([first, second]).map((r) => r.id)).toEqual(["first", "second"]);
		expect(sortAgentInfo([second, first]).map((r) => r.id)).toEqual(["second", "first"]);
	});
});

describe("renderAgentInfoRows", () => {
	const longTitle = "Restore the iteration-2 status surface after the overlay panel rollback";
	const longRow = { ...rich, taskTitle: longTitle };

	test("an empty pool reads as one line, not an empty array", () => {
		expect(renderAgentInfoRows([], { width: 80, now: NOW })).toEqual(["no agents"]);
	});

	test("width <= 0 means no truncation", () => {
		expect(renderAgentInfoRows([rich], { width: 0, now: NOW })).toEqual([formatRow(rich, { now: NOW })]);
	});

	test("drops whole fields from the right until the line fits", () => {
		const full = renderAgentInfoRows([longRow], { width: 400, now: NOW })[0];
		const at120 = renderAgentInfoRows([longRow], { width: 120, now: NOW })[0];
		const at80 = renderAgentInfoRows([longRow], { width: 80, now: NOW })[0];
		const at60 = renderAgentInfoRows([longRow], { width: 60, now: NOW })[0];

		// 120 fits everything but the turns/age group; 80 had to drop branch, cost, tokens and ctx.
		expect(at120).toContain("ctx 62%");
		expect(at120).toContain(" · master");
		expect(at120).not.toContain("7t 3m");
		expect(at80).not.toContain("ctx 62%");
		expect(full.startsWith(at120)).toBe(true);
		expect(at80.startsWith("> BraveFox · working")).toBe(true);

		// 60 can only fit the head, so the title itself shrinks and stays marked as clipped.
		expect(at60).toMatch(/^> BraveFox · working · task-30 "/);
		expect(at60.endsWith('…"')).toBe(true);

		for (const line of [full, at120, at80, at60]) {
			expect(line.includes(" · · ")).toBe(false);
			expect(line.startsWith(" · ")).toBe(false);
			expect(line.endsWith(" · ")).toBe(false);
		}
		expect(at120.length).toBeLessThanOrEqual(120);
		expect(at80.length).toBeLessThanOrEqual(80);
		expect(at60.length).toBeLessThanOrEqual(60);
		expect(full.length).toBeGreaterThan(at120.length);
	});

	test("a name wider than the terminal is clipped, never wrapped", () => {
		const line = renderAgentInfoRows([makeAgent({ name: "VeryLongAgentName" })], { width: 5, now: NOW })[0];
		expect(line.length).toBe(5);
		expect(line.endsWith("…")).toBe(true);
	});

	test("rows come out sorted, one line per agent", () => {
		const rows = [
			makeAgent({ id: "z", name: "Zed", state: "idle" }),
			makeAgent({ id: "w", name: "Woo", state: "working", taskId: "task-1", taskTitle: "work" }),
		];
		expect(renderAgentInfoRows(rows, { width: 120, now: NOW })[0]).toStartWith("> Woo");
		expect(renderAgentInfoRows(rows, { width: 120, now: NOW })).toHaveLength(2);
	});
});
