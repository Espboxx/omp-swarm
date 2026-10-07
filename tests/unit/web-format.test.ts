import { describe, expect, test } from "bun:test";
import { breakablePath } from "../../web/assets/format.js";

/** The inverse the contract promises: stripping the invisible characters returns the input. */
const strip = (value: string): string => value.split("\u200B").join("");

/**
 * The dashboard may break a path ONLY at its separators (task-116): `body { overflow-wrap: anywhere }`
 * lets the browser split any token, and a Windows path has no break opportunity at all, so a long one
 * was hard-split mid-token (`C:\Users\93715\code\test` + a bare `4`). `breakablePath` inserts a
 * zero-width space after every separator, which is a LEGAL break point the browser always prefers.
 */
describe("breakablePath", () => {
	test("a zero-width space follows every separator and nothing else", () => {
		expect(breakablePath("C:\\Users\\93715\\code\\test4")).toBe("C:\\\u200BUsers\\\u200B93715\\\u200Bcode\\\u200Btest4");
	});

	test("it is lossless: stripping the invisible characters returns the input", () => {
		for (const path of [
			"C:\\Users\\93715\\code\\test4",
			"/home/agent/work/tree",
			"src/parser.ts",
			"relative-name.md",
			".",
			"",
		]) {
			expect(strip(breakablePath(path))).toBe(path);
		}
	});

	test("no invisible character lands inside a name segment", () => {
		// Every piece of a split at the inserted zero-width spaces, except a trailing empty one, must END
		// with a separator — that is what makes the break clean instead of a stray fragment.
		const pieces = breakablePath("C:\\Users\\93715\\code\\test4").split("\u200B").filter((piece) => piece !== "");
		for (const piece of pieces.slice(0, -1)) expect(/[/\\]$/.test(piece)).toBe(true);
		expect(pieces.at(-1)).toBe("test4");
	});

	test("a path with no separator is unchanged (there is nothing to break at)", () => {
		expect(breakablePath("notes.md")).toBe("notes.md");
	});

	test("mixed separators both get a break point", () => {
		expect(breakablePath("a/b\\c").split("\u200B").length).toBe(3);
		expect(strip(breakablePath("a/b\\c"))).toBe("a/b\\c");
	});

	test("a non-string value is coerced rather than throwing in the render path", () => {
		expect(breakablePath(undefined)).toBe("");
	});
});
