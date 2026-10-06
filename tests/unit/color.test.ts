import { describe, expect, test } from "bun:test";
import { visibleWidth as hostWidth } from "@oh-my-pi/pi-tui/utils";
import {
	agentPalette,
	assignAgentColors,
	colorEnabled,
	fitColored,
	paint,
	sanitizeField,
	statusColor,
	visibleWidth,
} from "../../extension/color";

const RESET = "\x1b[0m";

describe("colorEnabled", () => {
	test("a plain interactive TTY is on, a pipe is off", () => {
		expect(colorEnabled({}, true)).toBe(true);
		expect(colorEnabled({}, false)).toBe(false);
		expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(false);
		expect(colorEnabled({ TERM: "xterm-256color" }, true)).toBe(true);
	});

	test("NO_COLOR is off when present and non-empty, and only then", () => {
		expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
		expect(colorEnabled({ NO_COLOR: "anything" }, true)).toBe(false);
		expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
		expect(colorEnabled({}, true)).toBe(true);
	});

	test("FORCE_COLOR=0 is off; any other value does not disable", () => {
		expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
		expect(colorEnabled({ FORCE_COLOR: "2" }, true)).toBe(true);
		expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
	});
});

describe("agentPalette / assignAgentColors", () => {
	test("the palette is 8 distinct 256-color indices", () => {
		const palette = agentPalette();
		expect(palette).toHaveLength(8);
		expect(new Set(palette).size).toBe(8);
		for (const index of palette) {
			expect(Number.isInteger(index)).toBe(true);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThanOrEqual(255);
		}
	});

	test("a live roster gets one distinct slot per agent, in order", () => {
		const palette = agentPalette();
		const two = assignAgentColors(["a", "b"]);
		expect(two.get("a")).toBe(palette[0]);
		expect(two.get("b")).toBe(palette[1]);
		expect(two.get("a")).not.toBe(two.get("b"));

		const eight = assignAgentColors(["a", "b", "c", "d", "e", "f", "g", "h"]);
		expect(new Set(eight.values()).size).toBe(8);
	});

	test("the ninth agent repeats the first slot and the first eight are unchanged", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
		const nine = assignAgentColors(ids);
		const eight = assignAgentColors(ids.slice(0, 8));
		for (const id of ids.slice(0, 8)) expect(nine.get(id)).toBe(eight.get(id));
		expect(nine.get("i")).toBe(nine.get("a"));
		expect(new Set(nine.values()).size).toBe(8);
	});

	test("the mapping is deterministic and a single-id roster is slot 0 whatever the id", () => {
		expect([...assignAgentColors(["x", "y"])]).toEqual([...assignAgentColors(["x", "y"])]);
		expect(assignAgentColors(["solo"]).get("solo")).toBe(agentPalette()[0]);
		expect(assignAgentColors(["other"]).get("other")).toBe(agentPalette()[0]);
	});

	test("a repeated id keeps its slot instead of consuming another", () => {
		const dup = assignAgentColors(["a", "a", "b"]);
		expect(dup.size).toBe(2);
		expect(dup.get("b")).toBe(agentPalette()[1]);
	});
});

describe("statusColor", () => {
	test("the six statuses are six distinct colors", () => {
		const statuses = ["working", "reviewing", "waiting", "blocked", "idle", "offline"];
		const colors = statuses.map(statusColor);
		expect(new Set(colors).size).toBe(6);
	});

	test("the semantics hold: working green, blocked red-family, idle/offline dim grey", () => {
		expect(statusColor("working")).toBe(40);
		expect(statusColor("blocked")).toBe(203);
		expect(statusColor("idle")).toBe(245);
		expect(statusColor("offline")).toBe(240);
		expect(statusColor("blocked")).not.toBe(statusColor("working"));
	});

	test("an unknown status reads the neutral default instead of throwing", () => {
		expect(statusColor("napping")).toBe(245);
		expect(statusColor("")).toBe(245);
		expect(statusColor("idle")).toBe(statusColor("napping"));
	});
});

describe("paint", () => {
	test("disabled (undefined or false) returns the input exactly, with zero escapes", () => {
		for (const opts of [undefined, {}, { enabled: false }, { bold: true }]) {
			const out = paint("BraveFox", 39, opts);
			expect(out).toBe("BraveFox");
			expect(out.includes("\x1b")).toBe(false);
		}
	});

	test("enabled wraps in 38;5;n and always ends closed", () => {
		const out = paint("BraveFox", 39, { enabled: true });
		expect(out).toBe("\x1b[38;5;39mBraveFox\x1b[0m");
		expect(out.endsWith(RESET)).toBe(true);
	});

	test("bold adds its own attribute before the text", () => {
		expect(paint("x", 203, { enabled: true, bold: true })).toBe("\x1b[38;5;203m\x1b[1mx\x1b[0m");
	});

	test("a non-finite or out-of-range index degrades to the neutral grey, never NaN", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3, 999]) {
			const out = paint("x", bad, { enabled: true });
			expect(out).not.toContain("NaN");
			expect(out).not.toContain("Infinity");
			expect(out).toMatch(/^\x1b\[38;5;([0-9]{1,3})m/);
		}
		expect(paint("x", Number.NaN, { enabled: true })).toBe("\x1b[38;5;245mx\x1b[0m");
		expect(paint("x", -3, { enabled: true })).toBe("\x1b[38;5;0mx\x1b[0m");
	});

	test("empty text paints to empty, never a bare reset", () => {
		expect(paint("", 39, { enabled: true })).toBe("");
		expect(paint("", 39)).toBe("");
	});
});

describe("visibleWidth", () => {
	test("plain text counts one column per character", () => {
		expect(visibleWidth("")).toBe(0);
		expect(visibleWidth("> BraveFox · working")).toBe(20);
	});

	test("escapes contribute zero width", () => {
		expect(visibleWidth("\x1b[38;5;39mabc\x1b[0m")).toBe(3);
		expect(visibleWidth("\x1b[1m\x1b[38;5;203mx\x1b[0m\x1b[0m")).toBe(1);
		expect(visibleWidth(paint("> BraveFox", 39, { enabled: true }))).toBe(visibleWidth("> BraveFox"));
	});

	test("wide and combining characters count display columns, not code units", () => {
		expect(visibleWidth("日本語")).toBe(6);
		expect(visibleWidth("e\u0301")).toBe(1);
		expect(visibleWidth("😀")).toBe(2);
	});
});

describe("fitColored", () => {
	test("a string that already fits is returned byte-identically", () => {
		expect(fitColored("abc", 10)).toBe("abc");
		const painted = paint("abc", 39, { enabled: true });
		expect(fitColored(painted, 3)).toBe(painted);
		expect(fitColored(painted, 99)).toBe(painted);
	});

	test("an empty string stays empty at any width", () => {
		expect(fitColored("", 5)).toBe("");
		expect(fitColored("", 0)).toBe("");
		expect(fitColored("", -1)).toBe("");
		expect(fitColored("", 5).includes("\x1b")).toBe(false);
	});

	test("a plain clip cuts at the column and adds no escape", () => {
		expect(fitColored("abcdef", 3)).toBe("abc");
		expect(fitColored("abcdef", 3).includes("\x1b")).toBe(false);
		expect(fitColored("abcdef", 0)).toBe("");
	});

	test("a colored clip keeps the escapes balanced and re-closes the run", () => {
		const closed = paint("abcdef", 213, { enabled: true });
		const clipped = fitColored(closed, 3);
		expect(clipped).toBe("\x1b[38;5;213mabc\x1b[0m");
		expect(clipped.endsWith(RESET)).toBe(true);
		expect(visibleWidth(clipped)).toBe(3);

		// A pre-existing open run (no reset in the input) is closed by the clip, not by test text.
		const open = "\x1b[38;5;213mabcdef";
		expect(fitColored(open, 3)).toBe("\x1b[38;5;213mabc\x1b[0m");
	});

	test("width is counted on visible columns, so escapes neither eat text nor overflow", () => {
		const row = `${paint("> BraveFox", 39, { enabled: true })} · ${paint("working", 40, { enabled: true })} · tail`;
		const clipped = fitColored(row, 12);
		expect(visibleWidth(clipped)).toBe(12);
		expect(clipped.startsWith("\x1b[38;5;39m")).toBe(true);
		expect(clipped.endsWith(RESET)).toBe(true);
	});

	test("a clip never splits a surrogate pair", () => {
		expect(fitColored("😀😀😀", 2)).toBe("😀");
		expect(fitColored("😀😀😀", 3)).toBe("😀");
		expect(visibleWidth(fitColored("😀😀😀", 3))).toBe(2);
	});
});

/** Every script a row can carry: ASCII, CJK, emoji, joiners, escapes, tabs, box drawing. */
const WIDTH_CORPUS = [
	"",
	"> BraveFox · working",
	"中文任务标题",
	"修复：颜色（每代理）",
	"done 🎉🚀",
	"family 👨‍👩‍👧‍👦",
	"flag 🇨🇳",
	"keycap 1️⃣",
	"e\u0301clair",
	"한국어",
	"ＡＢＣ１２３",
	"─│┌┐└┘",
	"a\tb",
	"\x1b[31mRED\x1b[39m",
	"\x1b[38;5;213mabc\x1b[0m",
	"\x1b]8;;http://x\x07link\x1b]8;;\x07",
	"a\x1b[2Jb",
	"\x1b]",
	"\x1b[",
	"\x1b",
	"\x1b]8;;http://x",
	"\x1b]52;c;x\x07",
	"\x1b]한👨‍👩‍👧‍👦\t\u0000\x1b[0m",
	// OSC 66 text sizing and APC spans: Bun strips both to zero, the host scales the first and
	// deletes the second, so these are the classes that used to under-measure (task-55).
	"\x1b]66;s=20;abc\x07",
	"\x1b]66;w=5;x\x07",
	"\x1b]66;s=3;ab\x07",
	"\x1b]66;s=20;abc",
	"a\x1b]66;w=5;x\x07b",
	"\x1b_abc\x07🎉\x1b]0;title\x1b]8;;http://x\x1b\\\x1bP",
	"\x1b_abc\x1b\\",
	"\x1b_G",
	"\x1bP1;2;3x\x1b\\",
	"\ud800",
	"\u009b",
];

describe("visibleWidth host parity", () => {
	test("agrees with the host's own width for every script a row can carry", () => {
		for (const text of WIDTH_CORPUS) expect(visibleWidth(text)).toBe(hostWidth(text));
	});

	test("the cases the hand-rolled table got wrong are the host's numbers now", () => {
		expect(visibleWidth("🚀")).toBe(2);
		expect(visibleWidth("✅")).toBe(2);
		expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
		expect(visibleWidth("a\tb")).toBe(5);
		expect(visibleWidth("✅".repeat(20))).toBe(40);
	});
});

describe("fitColored host parity", () => {
	test("a clipped string is never wider than the budget the host wraps at", () => {
		for (const text of WIDTH_CORPUS) {
			for (const width of [0, 1, 2, 3, 5, 8, 12, 20, 40]) {
				expect(hostWidth(fitColored(text, width))).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a joiner sequence is kept or dropped whole, never in pieces", () => {
		expect(fitColored("👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 2)).toBe("👨‍👩‍👧‍👦");
		expect(fitColored("👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 3)).toBe("👨‍👩‍👧‍👦");
		expect(fitColored("👨‍👩‍👧‍👦X", 2)).toBe("👨‍👩‍👧‍👦");
	});

	// Found by the fixed fuzz in scratch/color/fuzz.ts: an unterminated escape run is zero-width to the
	// token walk but not to the host, so these used to clip WIDER than the budget.
	test("a malformed or unterminated escape cannot push the clip past the budget", () => {
		const hostile = [
			"\x1b]한👨‍👩‍👧‍👦\t\u0000\x1b[0m",
			"🎉☑️\x1b]👨‍👩‍👧‍👦\x1b]🀄🀄修复\t·\x1b[0m",
			"\x1b[38;5;208m中🧑🏽‍🚀\x1b中\x1b]\t\x1b[0m",
			"\x1b]",
			"\x1b[",
			"\x1b",
			"\x1b]8;;http://x",
			"\x1b]52;c;x\x07",
			"\x1b]52;c;x\x07Z1️⃣",
		];
		for (const text of hostile) {
			for (const width of [0, 1, 2, 3, 5, 8, 12]) {
				const clipped = fitColored(text, width);
				expect(hostWidth(clipped)).toBeLessThanOrEqual(width);
				expect(visibleWidth(clipped)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("sanitizeField", () => {
	test("printable text is returned byte-identically", () => {
		for (const text of ["", "BraveFox", "中文任务标题", "done ✅🚀", "👨‍👩‍👧‍👦", "e\u0301clair", "a · b", "VeryLong"]) {
			expect(sanitizeField(text)).toBe(text);
		}
	});

	test("SGR, CSI, OSC and a bare ESC are all dropped, the text around them kept", () => {
		expect(sanitizeField("\x1b[31mRED\x1b[39m")).toBe("RED");
		expect(sanitizeField("\x1b[1;38;5;208mX\x1b[22m")).toBe("X");
		expect(sanitizeField("ok\x1b[2Jgone")).toBe("okgone");
		expect(sanitizeField("a\x1b]8;;http://x\x07link\x1b]8;;\x07b")).toBe("alinkb");
		expect(sanitizeField("\x1b]52;c;Y2xpcA==\x07clip")).toBe("clip");
		expect(sanitizeField("a\x1bb")).toBe("ab");
	});

	test("C0 and C1 controls never survive", () => {
		expect(sanitizeField("a\u0000b")).toBe("ab");
		expect(sanitizeField("a\u0007b")).toBe("ab");
		expect(sanitizeField("a\tb")).toBe("ab");
		expect(sanitizeField("a\nb")).toBe("ab");
		expect(sanitizeField("a\u009bb")).toBe("ab");
	});

	test("an unpaired surrogate is dropped, a valid pair is kept", () => {
		expect(sanitizeField("a\ud83db")).toBe("ab");
		expect(sanitizeField("a\udc00b")).toBe("ab");
		expect(sanitizeField("a🚀b")).toBe("a🚀b");
		expect(sanitizeField("a👨‍👩‍👧‍👦b")).toBe("a👨‍👩‍👧‍👦b");
	});
});

// The counterexamples task-53 found in the task-51 delta: an OSC 66 span is zero cells to
// `Bun.stringWidth` but three or five to the host, so `fitColored` used to return a clip the
// host measured wider than its budget (and would wrap under itself, the 8e1a468 defect).
describe("OSC 66 / APC host parity", () => {
	test("a text-sizing span is counted by the host's rule, not stripped to zero", () => {
		const scaledOutOfRange = "\x1b]66;s=20;abc\x07"; // s=20 is outside 1..7, so the scale stays 1
		const explicitWidth = "\x1b]66;w=5;x\x07";
		expect(visibleWidth(scaledOutOfRange)).toBe(3);
		expect(hostWidth(scaledOutOfRange)).toBe(3);
		expect(visibleWidth(explicitWidth)).toBe(5);
		expect(hostWidth(explicitWidth)).toBe(5);
	});

	test("an s= inside 1..7 multiplies the payload, an unterminated span stays zero", () => {
		expect(visibleWidth("\x1b]66;s=3;ab\x07")).toBe(6);
		expect(hostWidth("\x1b]66;s=3;ab\x07")).toBe(6);
		expect(visibleWidth("\x1b]66;s=20;abc")).toBe(0);
		expect(hostWidth("\x1b]66;s=20;abc")).toBe(0);
	});

	test("no width of either counterexample can overflow the budget", () => {
		for (const text of ["\x1b]66;s=20;abc\x07", "\x1b]66;w=5;x\x07", "a\x1b]66;w=5;x\x07"]) {
			for (let width = 0; width <= 8; width++) {
				const clipped = fitColored(text, width);
				expect(hostWidth(clipped)).toBeLessThanOrEqual(width);
				expect(visibleWidth(clipped)).toBeLessThanOrEqual(width);
			}
		}
		expect(fitColored("\x1b]66;s=20;abc\x07", 1)).toBe("");
		expect(fitColored("\x1b]66;w=5;x\x07", 4)).toBe("");
		expect(fitColored("\x1b]66;w=5;x\x07", 5)).toBe("\x1b]66;w=5;x\x07");
		// The walk copies a span as a zero-column token, so the guard sends the line to the prefix
		// search: a span that does not fit is dropped whole, a line that fits is byte-identical.
		expect(fitColored("a\x1b]66;w=5;x\x07", 5)).toBe("a");
		expect(fitColored("a\x1b]66;w=5;x\x07", 6)).toBe("a\x1b]66;w=5;x\x07");
	});

	test("an APC span is deleted before measuring, not counted as printable", () => {
		const apc = "\x1b_abc\x07🎉\x1b]0;title\x1b]8;;http://x\x1b\\\x1bP";
		expect(visibleWidth(apc)).toBe(hostWidth(apc));
		for (const width of [0, 1, 2, 3, 8]) {
			expect(hostWidth(fitColored(apc, width))).toBeLessThanOrEqual(width);
		}
	});

	test("every other escape class still measures zero in both implementations", () => {
		const zeroInBoth = [
			"\x1b[38;5;208m",
			"\x1b[0m",
			"\x1b[2J",
			"\x1b]52;c;x\x07",
			"\x1b]8;;http://x\x07",
			"\x1b]0;title\x07",
			"\x1bP1;2;3x\x1b\\",
			"\x1bPq",
			"\x1b_G",
			"\x1b_abc\x1b\\",
			"\x1b^pm",
			"\x1bXsos",
			"\x1b\\",
			"\x1b",
			"\u009b",
		];
		for (const text of zeroInBoth) {
			expect(visibleWidth(text)).toBe(0);
			expect(hostWidth(text)).toBe(0);
		}
	});
});
