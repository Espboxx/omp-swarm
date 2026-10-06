import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "../../extension/agentinfo";
import { MAIN_ID, markerFor, moveSelection, navEntries, renderNavLines } from "../../extension/agentnav";
import { statusColor, visibleWidth } from "../../extension/color";

const NOW = 1_700_000_000_000;

/** A row with every optional fact present; `over` replaces any field. */
const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({ id, name: id, state: "idle", ...over });

const ROSTER: AgentInfo[] = [
	agent("c1", {
		name: "CalmTiger",
		state: "working",
		taskId: "task-70",
		taskTitle: "Add the pure selection model",
		turns: 7,
		lastActivityAt: NOW - 3 * 60_000,
		branch: "master",
		ctx: { used: 62_000, total: 100_000 },
		tokens: { in: 12_345, out: 678 },
		costUsd: 0.42,
	}),
	agent("b1", { name: "BrightTiger", state: "reviewing", taskId: "task-63", turns: 2, lastActivityAt: NOW - 60_000 }),
	agent("s1", { name: "SwiftTiger", state: "idle" }),
];

describe("navEntries", () => {
	test("main is entry 0 even when there are no agents at all", () => {
		const entries = navEntries([]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({ id: MAIN_ID, isMain: true });
	});

	test("keeps the incoming order - it is not a second sort", () => {
		// `sortAgentInfo` would move the working agent first; the navigation list must not.
		expect(navEntries(ROSTER).map((entry) => entry.id)).toEqual(["main", "c1", "b1", "s1"]);
		expect(navEntries([...ROSTER].reverse()).map((entry) => entry.id)).toEqual(["main", "s1", "b1", "c1"]);
	});

	test("an agent carrying the main id is folded into entry 0, never listed twice", () => {
		const entries = navEntries([agent(MAIN_ID, { name: "ThisSession", state: "working" }), agent("c1")]);
		expect(entries.map((entry) => entry.id)).toEqual(["main", "c1"]);
		expect(entries[0].isMain).toBe(true);
		expect(entries[0].info?.name).toBe("ThisSession");
	});

	test("a custom main id is honoured, and an empty one falls back to the default", () => {
		expect(navEntries([agent("primary")], { id: "primary" }).map((entry) => entry.id)).toEqual(["primary"]);
		expect(navEntries([], { id: "" })[0].id).toBe(MAIN_ID);
	});
});

describe("moveSelection", () => {
	test("wraps in both directions", () => {
		expect(moveSelection(0, -1, 3)).toBe(2);
		expect(moveSelection(2, 1, 3)).toBe(0);
		expect(moveSelection(1, 1, 3)).toBe(2);
		expect(moveSelection(1, -1, 3)).toBe(0);
	});

	test("clamps a garbage index into range instead of propagating it", () => {
		expect(moveSelection(Number.NaN, 1, 4)).toBe(1);
		expect(moveSelection(-9, 1, 4)).toBe(1);
		expect(moveSelection(2.7, -1, 4)).toBe(1);
		expect(moveSelection(99, 0, 4)).toBe(3);
		expect(moveSelection(Number.POSITIVE_INFINITY, 0, 4)).toBe(0);
	});

	test("an empty list has nothing to select; a single entry stays put", () => {
		expect(moveSelection(3, 1, 0)).toBe(0);
		expect(moveSelection(0, -1, -4)).toBe(0);
		expect(moveSelection(Number.NaN, 1, Number.NaN)).toBe(0);
		expect(moveSelection(0, 1, 1)).toBe(0);
		expect(moveSelection(0, -1, 1)).toBe(0);
	});

	test("a multi-row step wraps too", () => {
		expect(moveSelection(0, -4, 3)).toBe(2);
		expect(moveSelection(1, 5, 3)).toBe(0);
	});
});

describe("markerFor", () => {
	test("is three ASCII columns: selection, current target, separator", () => {
		expect(markerFor(true, true)).toBe(">* ");
		expect(markerFor(true, false)).toBe(">  ");
		expect(markerFor(false, true)).toBe(" * ");
		expect(markerFor(false, false)).toBe("   ");
		for (const selected of [true, false]) {
			for (const current of [true, false]) {
				const marker = markerFor(selected, current);
				expect(marker).toHaveLength(3);
				expect(marker).toMatch(/^[>* ]{3}$/);
			}
		}
	});
});

describe("renderNavLines", () => {
	test("one line per entry, main first and labelled as the main session", () => {
		const entries = navEntries(ROSTER);
		const lines = renderNavLines(entries, { selectedIndex: 0, currentTargetId: MAIN_ID, width: 120, now: NOW });
		expect(lines).toHaveLength(entries.length);
		expect(lines[0]).toBe(">* main session · this terminal");
		expect(lines[1]).toContain("CalmTiger");
	});

	test("main renders the caller's own facts when it is given some", () => {
		const entries = navEntries([agent(MAIN_ID, { name: "ThisSession", state: "working" })]);
		const lines = renderNavLines(entries, { selectedIndex: 0, currentTargetId: MAIN_ID, width: 120, now: NOW });
		expect(lines[0]).toBe(">* > ThisSession · working · no task · ctx --% · 0/0 tok · $? · -");
	});

	test("the cursor and the current target are independent markers", () => {
		const entries = navEntries(ROSTER);
		const lines = renderNavLines(entries, { selectedIndex: 1, currentTargetId: "s1", width: 120, now: NOW });
		expect(lines[1].startsWith(">")).toBe(true);
		expect(lines[1].charAt(1)).toBe(" ");
		expect(lines[3].startsWith(" *")).toBe(true);
		expect(lines[1]).toContain("CalmTiger");
		expect(lines[3]).toContain("SwiftTiger");
	});

	test("the cursor follows the selection index through a wrap", () => {
		const entries = navEntries(ROSTER);
		const last = moveSelection(0, -1, entries.length);
		expect(last).toBe(3);
		const lines = renderNavLines(entries, { selectedIndex: last, currentTargetId: MAIN_ID, width: 120, now: NOW });
		expect(lines.map((line) => line.charAt(0))).toEqual([" ", " ", " ", ">"]);
	});

	test("no line is ever wider than the budget, plain or coloured, and colour adds no column", () => {
		const entries = navEntries(ROSTER);
		for (const width of [1, 2, 3, 8, 20, 40, 80, 120]) {
			const plain = renderNavLines(entries, { selectedIndex: 2, currentTargetId: "b1", width, now: NOW });
			const colored = renderNavLines(entries, { selectedIndex: 2, currentTargetId: "b1", width, now: NOW, color: true });
			expect(colored.map(visibleWidth)).toEqual(plain.map(visibleWidth));
			for (const line of [...plain, ...colored]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("colour off emits zero escape bytes, colour on paints the selected row bold", () => {
		const entries = navEntries(ROSTER);
		const opts = { selectedIndex: 2, currentTargetId: "b1", width: 120, now: NOW };
		const plain = renderNavLines(entries, opts);
		expect(plain.join("")).not.toContain("\x1b");
		const colored = renderNavLines(entries, { ...opts, color: true });
		expect(colored.join("")).toContain("\x1b[38;5;");
		expect(colored[2]).toContain("\x1b[1m");
		expect(colored[0]).not.toContain("\x1b[1m");
	});

	test("a width of zero yields one empty line per entry rather than an overflowing one", () => {
		const entries = navEntries(ROSTER);
		for (const width of [0, -5, Number.NaN]) {
			const lines = renderNavLines(entries, { selectedIndex: 1, currentTargetId: "b1", width, now: NOW });
			expect(lines).toHaveLength(entries.length);
			expect(lines.every((line) => line === "")).toBe(true);
		}
	});

	test("an entry with no facts keeps agentinfo's degraded placeholders", () => {
		const entries = navEntries([agent("ghost", { name: "Ghost" })]);
		const line = renderNavLines(entries, { selectedIndex: 0, currentTargetId: MAIN_ID, width: 200, now: NOW })[1];
		expect(line).toContain("Ghost");
		expect(line).toContain("no task");
		expect(line).toContain("ctx --%");
		expect(line).toContain("0/0 tok");
		expect(line).toContain("$?");
	});

	test("an entry that carries only an id renders the id; a control byte in it is sanitized away", () => {
		const lines = renderNavLines([{ id: "ghost", isMain: false }], {
			selectedIndex: 0,
			currentTargetId: "",
			width: 40,
			now: NOW,
		});
		expect(lines[0]).toBe(">  ghost");
		const hostile = renderNavLines([{ id: "\x1b[2Jevil", isMain: false }], {
			selectedIndex: 0,
			currentTargetId: "",
			width: 40,
			now: NOW,
		});
		expect(hostile[0]).toBe(">  evil");
		expect(hostile[0]).not.toContain("\x1b");
	});

	test("an omitted `now` still leaves no undefined or NaN in any line", () => {
		const entries = navEntries([agent("c1", { turns: 3, lastActivityAt: NOW - 90_000 })]);
		const lines = renderNavLines(entries, { selectedIndex: 1, currentTargetId: "c1", width: 200 });
		expect(lines.join("")).not.toContain("undefined");
		expect(lines.join("")).not.toContain("NaN");
	});

	test("a name wider than the terminal is clipped, not left to wrap", () => {
		const entries = navEntries([agent("wide", { name: "w".repeat(300), state: "working" })]);
		const lines = renderNavLines(entries, { selectedIndex: 1, currentTargetId: "wide", width: 30, now: NOW });
		expect(visibleWidth(lines[1])).toBeLessThanOrEqual(30);
		expect(lines[1].startsWith(">* ")).toBe(true);
	});

	test("each row keeps its own identity colour: the marker matches that row's name", () => {
		const entries = navEntries(ROSTER);
		const colored = renderNavLines(entries, { selectedIndex: 0, currentTargetId: MAIN_ID, width: 120, now: NOW, color: true });
		const tints = colored.map((line) => [...line.matchAll(/\x1b\[38;5;(\d+)m/g)].map((match) => match[1]));
		// A worker row paints the marker, then the name, then the status token - with the SAME colour
		// for the first two. Rendering one row at a time would hand every name slot 0 instead.
		for (const index of [1, 2, 3]) expect(tints[index][0]).toBe(tints[index][1]);
		expect(new Set([tints[1][1], tints[2][1], tints[3][1]]).size).toBe(3);
		expect(tints[3][2]).not.toBe(tints[3][1]);
		// main carries no facts, so it has no identity colour: its selected run is the neutral grey,
		// which no palette slot can collide with.
		expect(tints[0]).toEqual([String(statusColor(""))]);
		expect([tints[1][1], tints[2][1], tints[3][1]]).not.toContain(tints[0][0]);
	});

	test("the selected line is one bold run, never a nested one", () => {
		const entries = navEntries(ROSTER);
		const colored = renderNavLines(entries, { selectedIndex: 1, currentTargetId: "c1", width: 120, now: NOW, color: true });
		const selected = colored[1];
		expect(selected.match(/\x1b\[38;5;\d+m/g)).toHaveLength(1);
		expect(selected.match(/\x1b\[0m/g)).toHaveLength(1);
		expect(selected).toContain("\x1b[1m");
		expect(colored[2].match(/\x1b\[38;5;\d+m/g)?.length).toBeGreaterThan(1);
	});

	test("each line carries its own entry's marker on the entry's own row", () => {
		const entries = navEntries(ROSTER);
		const lines = renderNavLines(entries, { selectedIndex: 0, currentTargetId: "main", width: 60, now: NOW });
		expect(lines[0].charAt(1)).toBe("*");
		for (const line of lines.slice(1)) expect(line.charAt(1)).toBe(" ");
	});
});
