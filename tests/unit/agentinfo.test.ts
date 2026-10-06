import { describe, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { visibleWidth as hostWidth } from "@oh-my-pi/pi-tui/utils";
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
import { agentPalette, assignAgentColors, statusColor, visibleWidth } from "../../extension/color";

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

describe("agentinfo color", () => {
	const SGR = /^\x1b\[38;5;(\d+)m/;
	const ANY_SGR = /\x1b\[[0-9;]*m/g;
	/** `assignAgentColors` is a lookup, so a single-row roster resolves to slot 0: 39. */
	const RICH_COLOR = assignAgentColors([rich.id]).get(rich.id) ?? -1;
	const indices = (line: string): number[] => [...line.matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) => Number(m[1]));

	test("color off is the default and is byte-identical to today", () => {
		expect(formatRow(rich, { now: NOW, color: false })).toBe(formatRow(rich, { now: NOW }));
		expect(formatRow(rich, { now: NOW, color: false })).not.toContain("\x1b");
		const rows = [rich, makeAgent({ id: "a2", name: "CalmTiger", state: "idle" })];
		expect(renderAgentInfoRows(rows, { width: 200, now: NOW, color: false })).toEqual(
			renderAgentInfoRows(rows, { width: 200, now: NOW }),
		);
	});

	test("an empty pool stays a plain line even with color on", () => {
		expect(renderAgentInfoRows([], { width: 80, now: NOW, color: true })).toEqual(["no agents"]);
	});

	test("a colored row carries the same visible text and width as the plain one", () => {
		const plain = renderAgentInfoRows([rich], { width: 200, now: NOW })[0];
		const colored = renderAgentInfoRows([rich], { width: 200, now: NOW, color: true })[0];
		expect(colored).not.toBe(plain);
		expect(colored.replace(ANY_SGR, "")).toBe(plain);
		expect(visibleWidth(colored)).toBe(visibleWidth(plain));
		expect(visibleWidth(colored)).toBe(plain.length);
	});

	test("only the name and the state token are painted", () => {
		const colored = renderAgentInfoRows([rich], { width: 200, now: NOW, color: true })[0];
		expect(colored.match(SGR)?.[1]).toBe(String(RICH_COLOR));
		expect(colored).toStartWith(`\x1b[38;5;${RICH_COLOR}m> BraveFox\x1b[0m · `);
		expect(colored).toContain(`· \x1b[38;5;${statusColor("working")}mworking\x1b[0m · `);
		// The task field, ctx, tokens, cost and branch stay default - exactly two painted tokens.
		expect(indices(colored)).toEqual([RICH_COLOR, statusColor("working")]);
	});

	test("two live agents get two different colors and each state its own", () => {
		const rows = [
			makeAgent({ id: "a1", name: "Aaa", state: "working", taskId: "task-1", taskTitle: "work" }),
			makeAgent({ id: "b2", name: "Bbb", state: "idle" }),
		];
		const lines = renderAgentInfoRows(rows, { width: 200, now: NOW, color: true });
		expect(lines[0]).toStartWith("\x1b[38;5;39m> Aaa\x1b[0m");
		expect(lines[1]).toStartWith("\x1b[38;5;213m- Bbb\x1b[0m");
		expect(agentPalette()[0]).not.toBe(agentPalette()[1]);
		expect(indices(lines[0])).toEqual([39, statusColor("working")]);
		expect(indices(lines[1])).toEqual([213, statusColor("idle")]);
		expect(statusColor("working")).not.toBe(statusColor("idle"));
	});

	test("a blocked row paints its state with the blocked color, not the idle one", () => {
		const blocked = makeAgent({ id: "z9", name: "Zed", state: "blocked" });
		const line = renderAgentInfoRows([blocked], { width: 200, now: NOW, color: true })[0];
		expect(line).toContain(`\x1b[38;5;${statusColor("blocked")}mblocked\x1b[0m`);
		expect(statusColor("blocked")).not.toBe(statusColor("idle"));
	});

	test("coloring does not change the fit: same fields, same column at every width", () => {
		const longTitle = "Restore the iteration-2 status surface after the overlay panel rollback";
		const rows = [{ ...rich, taskTitle: longTitle }];
		for (const width of [200, 120, 80, 60, 40, 5]) {
			const plain = renderAgentInfoRows(rows, { width, now: NOW })[0];
			const colored = renderAgentInfoRows(rows, { width, now: NOW, color: true })[0];
			expect(colored.replace(ANY_SGR, "")).toBe(plain);
			expect(visibleWidth(colored)).toBe(visibleWidth(plain));
			expect(visibleWidth(colored)).toBeLessThanOrEqual(width);
			expect(colored).not.toBe(plain);
		}
	});

	test("a colored name wider than the terminal hard-clips to the same visible width", () => {
		const rows = [makeAgent({ id: "long", name: "VeryLongAgentName" })];
		const colored = renderAgentInfoRows(rows, { width: 5, now: NOW, color: true })[0];
		expect(visibleWidth(colored)).toBe(5);
		expect(colored.endsWith("…")).toBe(true);
		const plain = renderAgentInfoRows(rows, { width: 5, now: NOW })[0];
		expect(colored.replace(ANY_SGR, "")).toBe(plain);
	});
});

describe("agentinfo row safety", () => {
	const SGR = /\x1b\[[0-9;]*m/g;
	/**
	 * The break the host applies to a widget row: `new Text(line, 1, 0)` rendered at the terminal
	 * width, which wraps at `width - 2 * paddingX` - so a row fed the app's `columns - 2` budget
	 * has exactly `width` columns of content and must stay one line.
	 */
	const hostLines = (line: string, width: number): number => new Text(line, 1, 0).render(width + 2).length;

	test("a wide task title never grows past the width the host wraps at", () => {
		const titles = [
			"修复颜色并让每个代理都不同：一个足够长的中文任务标题用来测试宽度",
			"✅".repeat(20),
			"🚀".repeat(20),
			"family 👨‍👩‍👧‍👦 shot",
			"Restore the iteration-2 status surface after the overlay panel rollback",
		];
		for (const taskTitle of titles) {
			for (const color of [false, true]) {
				const row = renderAgentInfoRows([makeAgent({ taskId: "task-49", taskTitle })], { width: 118, now: NOW, color })[0];
				expect(hostWidth(row)).toBeLessThanOrEqual(118);
				expect(hostLines(row, 118)).toBe(1);
			}
		}
	});

	test("a control sequence in a title reaches neither the plain nor the colored row", () => {
		const rows = [{ ...rich, taskTitle: "ok\x1b[2Jgone\x1b]52;c;Y2xpcA==\x07" }];
		const plain = renderAgentInfoRows(rows, { width: 200, now: NOW })[0];
		expect(plain.includes("\x1b")).toBe(false);
		expect(plain).toContain('task-30 "okgone"');

		const colored = renderAgentInfoRows(rows, { width: 200, now: NOW, color: true })[0];
		expect(colored).not.toContain("\x1b[2J");
		expect(colored).not.toContain("\x1b]52");
		expect(colored.replace(SGR, "")).toBe(plain);
	});

	test("an id that is nothing but an escape sequence drops out, never a dangling separator", () => {
		const row = renderAgentInfoRows([makeAgent({ taskId: "\x1b[31m", taskTitle: "\x1b[2J" })], { width: 200, now: NOW })[0];
		expect(row.includes("\x1b")).toBe(false);
		expect(row).not.toContain(" ·  · ");
		expect(row).not.toContain(" · · ");
		expect(row.startsWith("> BraveFox · working · ctx")).toBe(true);
	});

	test("a title clipped across an emoji leaves no half surrogate and still fits", () => {
		const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		const titles = ["x".repeat(38) + "🚀y", "🚀".repeat(30), "x".repeat(39) + "👨‍👩‍👧‍👦", "é".repeat(41)];
		for (const taskTitle of titles) {
			for (const color of [false, true]) {
				const row = renderAgentInfoRows([makeAgent({ taskId: "task-51", taskTitle })], { width: 20, now: NOW, color })[0];
				expect(row).toMatch(/\S/);
				expect(LONE_SURROGATE.test(row)).toBe(false);
				expect(hostWidth(row)).toBeLessThanOrEqual(20);
				expect(hostLines(row, 20)).toBe(1);
			}
		}
	});
});

describe("agentinfo stable colors", () => {
	const roster = (entries: [string, AgentInfo["state"]][]): AgentInfo[] =>
		entries.map(([name, state]) => makeAgent({ id: name, name, state }));
	/** Agent name -> its painted index, read off a real rendered roster. */
	const colorsByName = (rows: AgentInfo[]): Record<string, number> => {
		const map: Record<string, number> = {};
		for (const line of renderAgentInfoRows(rows, { width: 200, now: NOW, color: true })) {
			const name = line.replace(/\x1b\[[0-9;]*m/g, "").slice(2).split(" · ")[0];
			map[name] = Number(/\x1b\[38;5;(\d+)m/.exec(line)?.[1]);
		}
		return map;
	};

	test("a state change reorders the lines but leaves every agent its color", () => {
		const allIdle = roster([
			["SwiftTiger", "idle"],
			["CalmTiger", "idle"],
			["BrightTiger", "idle"],
		]);
		const oneWorking = roster([
			["SwiftTiger", "working"],
			["CalmTiger", "idle"],
			["BrightTiger", "idle"],
		]);

		const before = colorsByName(allIdle);
		expect(before).toEqual({ BrightTiger: 39, CalmTiger: 213, SwiftTiger: 141 });
		expect(new Set(Object.values(before)).size).toBe(3);
		// The roster is identical and one agent changed state: no color may move.
		expect(colorsByName(oneWorking)).toEqual(before);

		// ...and the display order really did change, so the check above is not vacuous.
		const order = (rows: AgentInfo[]) =>
			renderAgentInfoRows(rows, { width: 200, now: NOW }).map((line) => line.slice(2).split(" · ")[0]);
		expect(order(allIdle)).toEqual(["BrightTiger", "CalmTiger", "SwiftTiger"]);
		expect(order(oneWorking)).toEqual(["SwiftTiger", "BrightTiger", "CalmTiger"]);
	});

	test("the mapping does not depend on the order the caller passes the roster in", () => {
		const entries: [string, AgentInfo["state"]][] = [
			["SwiftTiger", "idle"],
			["VividTiger", "working"],
			["CalmTiger", "blocked"],
			["BrightTiger", "offline"],
		];
		const rows = roster(entries);
		expect(colorsByName([...rows].reverse())).toEqual(colorsByName(rows));
		expect(new Set(Object.values(colorsByName(rows))).size).toBe(4);
	});

	test("a joining agent may shift a later slot, an unrelated state change never does", () => {
		const three = roster([
			["BrightTiger", "idle"],
			["CalmTiger", "idle"],
			["SwiftTiger", "idle"],
		]);
		const four = [...three, makeAgent({ id: "Zed", name: "Zed", state: "idle" })];
		expect(colorsByName(three).BrightTiger).toBe(colorsByName(four).BrightTiger);
		expect(colorsByName(three).CalmTiger).toBe(colorsByName(four).CalmTiger);
		expect(colorsByName(four).Zed).toBe(agentPalette()[3]);
	});
});
