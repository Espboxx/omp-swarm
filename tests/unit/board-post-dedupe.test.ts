/**
 * goal-15's R1, at the MECHANISM level: the class index must have a CALLER.
 *
 * WHY THIS FILE EXISTS. `board.ts` shipped as a pure module with 18 green unit tests (OBSERVATION
 * #1566 measured it), and the pool's own rule about a spec-shaped deliverable applied: green tests
 * over an isolated module are not an acceptance, because nothing in the running system ever consults
 * it. The measurement was `grep -rn boardDuplicateVerdict extension/*.ts` → zero call sites. So
 * `board_post` posted unconditionally and every agent kept re-reporting the same class invisibly.
 *
 * This file pins the two properties the wiring must hold, in the order they matter:
 *
 *   1. THE ENTRY IS ALWAYS POSTED. The board is append-only. A repeat is NOT dropped and NOT refused;
 *      the poster is TOLD. Silently swallowing an entry to prevent a repeat would be a worse defect
 *      than the repeat (that is LunarTiger's measurement, adopted verbatim, and it is the reason the
 *      wiring is a notice rather than a gate).
 *   2. THE NOTICE IS ONLY THERE WHEN THERE IS SOMETHING TO SAY. A first report — the common case —
 *      must be byte-identical to what it was before the wiring, or the pool trains itself to ignore
 *      the line and the notice is worthless.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { buildSwarmTools, type SwarmIdentity } from "../../extension/tools";
import type { SwarmConfig } from "../../extension/types";

const roots: string[] = [];

function makeTools() {
	const root = mkdtempSync(join(tmpdir(), "board-post-dedupe-"));
	roots.push(root);
	const paths = swarmPaths(root);
	const store = new SwarmStore(openDatabase(paths), paths);
	const identity: SwarmIdentity = { id: "VividTiger", role: "general", capabilities: ["general"], isMain: false };
	const config = { review: false } as unknown as SwarmConfig;
	const tools = buildSwarmTools({ store, config, identity, z: zod });
	const call = async (name: string, params: Record<string, unknown>) => {
		const picked = tools.find((candidate) => candidate.name === name);
		if (picked === undefined) throw new Error(`the tool ${name} is not in the catalog`);
		type ToolRun = (id: string, params: object) => Promise<{ content: readonly { type: string; text?: string }[]; details?: Record<string, unknown> }>;
		const result = await (picked.execute as unknown as ToolRun)("call-1", params);
		return {
			text: result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n"),
			details: result.details ?? {},
		};
	};
	return { store, call };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// The OS temp dir is disposable; a held WAL handle on Windows is not a test failure.
		}
	}
});

/** A post, through the real tool surface. */
const post = (call: ReturnType<typeof makeTools>["call"], type: string, content: string, tags: string[]) =>
	call("board_post", { type, content, tags });

describe("the first report of a class is unchanged", () => {
	test("a class with no prior entry posts with no duplicate line at all", async () => {
		const { store, call } = makeTools();
		const result = await post(call, "FAIL", "a brand-new failure class", ["fail", "brand-new-class"]);

		// The exact pre-wiring text, and the entry really landed.
		expect(result.text).toBe("posted #1 FAIL");
		expect(store.searchBoard({ limit: 1 }).length).toBe(1);
		// No notice in the text — that is the part an agent must not learn to skip. The verdict object
		// rides along in `details` so a caller can read the class it belongs to, but it is not a repeat.
		expect(result.text).not.toContain("DUPLICATE CLASS");
		expect((result.details.duplicate as { known: boolean } | undefined)?.known).toBe(false);
	});

	test("an entry that names no class-bearing tag is never called a repeat", async () => {
		const { call } = makeTools();
		await post(call, "FAIL", "first", ["failure"]);
		const result = await post(call, "FAIL", "second", ["failure"]);
		expect(result.text).toBe("posted #2 FAIL");
		// The verdict object is still returned (so a caller can read the class it belongs to), but it
		// names no class and is NOT a known repeat — the notice text stays silent.
		const duplicate = result.details.duplicate as { known: boolean; key: string; reason: string } | undefined;
		expect(duplicate?.known).toBe(false);
		expect(duplicate?.key).toBe("");
		expect(result.text).not.toContain("DUPLICATE CLASS");
	});
});

describe("a repeat is posted AND named", () => {
	test("the same class twice posts both entries and tells the second poster it is a repeat", async () => {
		const { store, call } = makeTools();
		await post(call, "FAIL", "the first sighting", ["fail", "duplicate", "goal:goal-11"]);
		const result = await post(call, "FAIL", "the same failure again", ["fail", "duplicate", "goal:goal-11"]);

		// APPEND-ONLY HOLDS: both entries are on the board. Nothing was dropped.
		expect(store.searchBoard({ limit: 50 }).length).toBe(2);

		// The notice names the class, its history, and that nothing has answered it yet.
		expect(result.text).toContain("posted #2 FAIL");
		expect(result.text).toContain("DUPLICATE CLASS");
		expect(result.text).toContain("already reported 1x (#1)");
		expect(result.text).toContain("NOT yet answered");

		const duplicate = result.details.duplicate as { known: boolean; remedied: boolean; priorEntryIds: number[] } | undefined;
		expect(duplicate?.known).toBe(true);
		expect(duplicate?.remedied).toBe(false);
		expect(duplicate?.priorEntryIds).toEqual([1]);
	});

	test("a DECISION answers the class, and a later OBSERVATION about it is told so", async () => {
		const { call } = makeTools();
		await post(call, "OBSERVATION", "a problem appears", ["observation", "residue", "goal:goal-9"]);
		await post(call, "DECISION", "here is the answer", ["decision", "residue", "goal:goal-9"]);
		const again = await post(call, "OBSERVATION", "a fresh sighting", ["observation", "residue", "goal:goal-9"]);

		expect(again.text).toContain("DUPLICATE CLASS");
		expect(again.text).toContain("answered by DECISION #2");
		expect(again.text).not.toContain("NOT yet answered");
	});

	test("the notice counts the repeats, so the third time reads as the third time", async () => {
		const { call } = makeTools();
		await post(call, "FAIL", "first", ["fail", "spin"]);
		await post(call, "FAIL", "second", ["fail", "spin"]);
		const third = await post(call, "FAIL", "third", ["fail", "spin"]);
		expect(third.text).toContain("already reported 2x (#1, #2)");
	});

	test("the meta/outcome tag difference between two posts does not hide the repeat", async () => {
		const { call } = makeTools();
		await post(call, "FACT", "measured once", ["fact", "same-class"]);
		const again = await post(call, "FAIL", "measured again", ["fail", "same-class"]);
		expect(again.text).toContain("DUPLICATE CLASS");
	});
});
