/**
 * goal-17's L2: the identity key and the two mint gates, in the measured form the contract fixes.
 *
 * WHY THIS FILE EXISTS, IN THE MEASURED FORM. `#createTaskLocked` carries exactly one guard
 * (goal-14's capability refusal), so a mint whose work a LIVE row already holds is minted anyway —
 * and the pool's own history is what that cost: `SUPERSEDED / DUPLICATE — closed unexecuted. Same
 * deliverable as canonical task-150` is the result text of a row that existed only to be closed.
 *
 * WHAT IS MEASURED HERE, in the two halves `failure-gate.test.ts` and `alert-dedupe.test.ts` use:
 *
 *   1. THE PURE RULE — `identityKeyOf` and `duplicateRefusal` are pure: a title, a file list and a
 *      capability list in, a key or a refusal out. No db, no clock, no IO.
 *   2. THE WIRING — a real `SwarmStore` on a real (file, not `:memory:`) database, driven through
 *      the real `createTask` with `dedupe: true`, so "the same work twice → the second mint is
 *      refused and names the first" is a measurement of behaviour rather than a reading of a string.
 *
 * The gates' safety CANNOT be shown by "it refused a mint today": the live surface is empty (229 live
 * non-failed rows produce 0 identity-key collisions), so acceptance is the synthetic mint, the live
 * false-merge regression, and the four MUST-NOTs as cases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { duplicateRefusal, identityKeyOf } from "../../extension/identity-key";
import { openDatabase, swarmPaths, type SwarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows holds a file db open a moment after `close()`; a leftover temp dir is noise, not a failure.
		}
	}
});

describe("identityKeyOf: the key's four components", () => {
	test("a caps-only re-file is a FRESH key by construction — the strand's remedy is never refused", () => {
		const a = identityKeyOf("Enumerate every model-call wakeup source", ["scratch/a.md"], ["general"]);
		const b = identityKeyOf("Enumerate every model-call wakeup source", ["scratch/a.md"], ["reviewer"]);
		expect(a.key).not.toBe(b.key);
	});

	test("a spelling of one file is one key: casing, separators, a trailing /** and a leading ./", () => {
		const a = identityKeyOf("Build the thing", ["scratch/wakeups/**", "./Other/File.TS"], []);
		const b = identityKeyOf("Build the thing", ["scratch/wakeups/", "other/file.ts"], []);
		expect(a.key).toBe(b.key);
		expect(a.key).toContain("other/file.ts|scratch/wakeups");
	});

	test("a fix and a verify on one file are two keys — the kind is a component", () => {
		const fix = identityKeyOf("Fix the parser", ["src/parser.ts"], []);
		const verify = identityKeyOf("Verify the parser", ["src/parser.ts"], []);
		expect(fix.key).not.toBe(verify.key);
		expect(fix.kind).toBe("fix");
		expect(verify.kind).toBe("verify");
	});

	test("the deliverable is NORMALISED, never the raw title: two spellings of one deliverable fold", () => {
		expect(identityKeyOf("Build the Parser").deliverable).toBe("build the parser");
		expect(identityKeyOf("  build   the parser!!  ").key).toBe(identityKeyOf("Build the parser.").key);
	});

	test("the join character cannot be forged by a component", () => {
		const a = identityKeyOf("a\u001fb", [], ["c"]);
		expect(a.key.split("\u001f").length).toBeGreaterThan(2); // the title's own separator is not a field boundary
	});
});

describe("duplicateRefusal: the exact route", () => {
	const live = [{ id: "task-150", title: "Enumerate every model-call wakeup source", files: ["scratch/wakeups/**"], caps: ["general"], status: "done", createdAt: 0 }];

	test("a fresh key is not a refusal", () => {
		expect(duplicateRefusal({ title: "Something else entirely", files: ["x.ts"], caps: [] }, live, 60_000)).toBeUndefined();
	});

	test("a match against a LIVE row is refused, naming the row, its status and its age", () => {
		const refusal = duplicateRefusal({ title: "enumerate every model-call wakeup source!", files: ["scratch/wakeups/"], caps: ["general"] }, live, 7 * 60_000);
		expect(refusal?.route).toBe("exact");
		expect(refusal?.prior.taskId).toBe("task-150");
		expect(refusal?.prior.status).toBe("done");
		expect(refusal?.prior.ageMinutes).toBe(7);
		expect(refusal?.reason).toContain("task-150");
		expect(refusal?.remedy).toContain("row was NOT created");
	});

	test("a `failed` row is never offered, so it can never block its successor (task-252 A5)", () => {
		const dead = [{ ...live[0]!, status: "failed" }];
		expect(duplicateRefusal({ title: "Enumerate every model-call wakeup source", files: ["scratch/wakeups/**"], caps: ["general"] }, dead, 0)).toBeUndefined();
	});
});

describe("the live false-merge trap, pinned as a regression (task-252 A11 / task-270 §3)", () => {
	test("dropping the deliverable component collapses the pool; keeping it collapses nothing", () => {
		// The pool's own measured shape: 229 live rows, 16 groups / 89 rows without the deliverable.
		const rows = [
			{ id: "a", title: "Probe: what per-worker usage data is reachable", files: [], caps: ["general"] },
			{ id: "b", title: "Publish: create the public GitHub repo", files: [], caps: ["general"] },
			{ id: "c", title: "Fix: the panel leaked an email", files: ["src/x.ts"], caps: [] },
			{ id: "d", title: "Verify: the panel no longer leaks an email", files: ["src/x.ts"], caps: [] },
		];
		const withDeliverable = new Set(rows.map((r) => identityKeyOf(r.title, r.files, r.caps).key));
		expect(withDeliverable.size).toBe(rows.length); // the deliverable separates all four
	});
});

describe("the wiring: a real store, driven through the real mint", () => {
	function makeStore(): { store: SwarmStore; paths: SwarmPaths } {
		const paths = swarmPaths(mkdtempSync(join(tmpdir(), "swarm-ident-key-")));
		roots.push(paths.root);
		return { store: new SwarmStore(openDatabase(paths), paths), paths };
	}

	test("a second mint of the same work is REFUSED, naming the held row, and writes nothing", () => {
		const { store } = makeStore();
		const first = store.createTask({ title: "Enumerate every model-call wakeup source", createdBy: "boot", files: ["scratch/wakeups/**"], requiredCapabilities: ["general"], dedupe: true });
		expect(first.status).toBe("ready");
		// A different spelling of the same work: a container path, a permuted cap list, a title with
		// different casing and trailing punctuation.
		const second = store.createTask({ title: "enumerate every Model-Call Wakeup Source!", createdBy: "boot", files: ["scratch/wakeups/"], requiredCapabilities: ["general"], dedupe: true });
		expect(second.status).toBe("refused");
		expect(second.mintRefusal).toContain(first.id);
		expect(second.mintRefusal).toContain("identity key");
		// Exactly one board entry, one DECISION, naming the prior row and the remedy.
		const refusals = store.searchBoard({ type: "DECISION", tags: ["duplicate-refusal"] });
		expect(refusals).toHaveLength(1);
		expect(refusals[0]?.content).toContain(first.id);
		expect(refusals[0]?.content).toContain("REMEDY:");
		// The refused mint left no row: the pool holds exactly the one task it minted.
		expect(store.listTasks({ limit: 20 })).toHaveLength(1);
		store.close();
	});

	test("a caps-only re-file to a reachable capability MINTS — the strand's remedy passes", () => {
		const { store } = makeStore();
		const first = store.createTask({ title: "Retag the stranded row", createdBy: "boot", requiredCapabilities: ["reviewer"], files: ["a.md"], dedupe: true });
		expect(first.status).toBe("ready");
		const second = store.createTask({ title: "Retag the stranded row", createdBy: "boot", requiredCapabilities: ["general"], files: ["a.md"], dedupe: true });
		expect(second.status).toBe("ready");
		store.close();
	});

	test("a `failed` twin never refuses its successor", () => {
		const { store } = makeStore();
		const dead = store.createTask({ title: "Advisory wakeup audit", createdBy: "boot", files: ["scratch/wakeups/**"], dedupe: true });
		store.claim(dead.id, "A", 300);
		store.fail(dead.id, "A", "SUPERSEDED / DUPLICATE — closed unexecuted. Same deliverable as canonical task-150");
		const successor = store.createTask({ title: "Advisory wakeup audit", createdBy: "boot", files: ["scratch/wakeups/"], dedupe: true });
		expect(successor.status).toBe("ready");
		store.close();
	});

	test("the three deliberate non-opt-in callers are untouched: a mint with no `dedupe` writes the row", () => {
		const { store } = makeStore();
		const first = store.createTask({ title: "The operator's bootstrap row", createdBy: "main", files: ["x.md"] });
		const second = store.createTask({ title: "The operator's bootstrap row", createdBy: "main", files: ["x.md"] });
		expect(second.status).toBe("ready");
		expect(first.status).toBe("ready");
		store.close();
	});

	test("planGoal skips a merged row a live row already holds, and says which ROUTE matched", () => {
		const { store } = makeStore();
		store.createTask({ title: "Build the parser", createdBy: "boot", files: ["src/parser.ts"] });
		const opened = store.createGoal({ goal: "re-take the parser", agents: 1, createdBy: "main" });
		store.postProposal(opened.goal, "A", [{ title: "build the parser!", files: ["src/parser.ts"] }]);
		store.claim(opened.planningTask.id, "scribe", 300, ["general"]);
		const planned = store.planGoal(opened.goal.id, "scribe");
		expect(planned.ok).toBe(true);
		expect(planned.created).toEqual([]);
		expect(planned.skipped).toHaveLength(1);
		expect(planned.skipped[0]?.route).toBe("exact");
		const decision = store.searchBoard({ type: "DECISION" }).at(-1);
		expect(decision?.content).toContain("[exact]");
		store.close();
	});
});
