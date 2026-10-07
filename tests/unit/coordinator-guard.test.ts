import { describe, expect, test } from "bun:test";
import { COORDINATOR_EDIT_NOTICE, decideCoordinatorEdit, mutatesFiles, type CoordinatorEditInput } from "../../extension/guard";

/**
 * The observation is a live counterexample (a specification-shaped prompt executed by the coordinator
 * itself, 68 tool calls, no goal) — prose could not stop it, so the guard decides from what the session
 * DOES. These tests pin the decision table and the tool classification, including the cases that must
 * stay SILENT (a false notice in a reading session is the failure mode of this feature).
 */
const base: CoordinatorEditInput = {
	modeOn: true,
	sessionIsMain: true,
	goalOpen: false,
	poolRunning: false,
	mutatesFiles: true,
	notifiedThisTurn: false,
};
const decide = (overrides: Partial<CoordinatorEditInput> = {}) => decideCoordinatorEdit({ ...base, ...overrides });

describe("decideCoordinatorEdit", () => {
	test("the main session editing files with no goal and no pool is exactly the case to notify", () => {
		expect(decide()).toBe("notify");
	});

	test("a read-only tool call is silent", () => {
		expect(decide({ mutatesFiles: false })).toBe("silent");
	});

	test("a WORKER session's write is silent — the worker is supposed to write files", () => {
		expect(decide({ sessionIsMain: false })).toBe("silent");
	});

	test("a live goal is silent: the planning round is the coordinator's job, not the files", () => {
		expect(decide({ goalOpen: true })).toBe("silent");
	});

	test("a running pool is silent: the workers are already doing it", () => {
		expect(decide({ poolRunning: true })).toBe("silent");
	});

	test("multi-agent mode off is silent — there is no swarm to hand the work to", () => {
		expect(decide({ modeOn: false })).toBe("silent");
	});

	test("at most one notice per turn: the second write of the same turn is silent", () => {
		expect(decide()).toBe("notify");
		expect(decide({ notifiedThisTurn: true })).toBe("silent");
	});

	test("the notice is on the swarm's own surface and says it cannot block anything", () => {
		expect(COORDINATOR_EDIT_NOTICE.startsWith("[swarm]")).toBe(true);
		expect(COORDINATOR_EDIT_NOTICE).toContain("swarm_goal");
		expect(COORDINATOR_EDIT_NOTICE).toContain("reminder, not a gate");
	});
});

describe("mutatesFiles", () => {
	test("the writing tools always count", () => {
		for (const tool of ["edit", "write", "ast_edit"]) expect(mutatesFiles(tool, { file_path: "a.ts" })).toBe(true);
	});

	test("read-only tools never count, whatever their arguments look like", () => {
		for (const tool of ["read", "grep", "glob", "todo", "swarm_status"]) {
			expect(mutatesFiles(tool, { command: "rm -rf /", path: "a.ts" })).toBe(false);
		}
	});

	test("a bash command that writes counts", () => {
		for (const command of [
			"echo hi > out.txt",
			"cat a >> b",
			"bun test | tee log.txt",
			"sed -i 's/a/b/' file.ts",
			"rm -rf scratch/tmp",
			"mkdir -p scratch/x",
			"Set-Content -Path a.txt -Value hi",
			"git commit -m wip",
			"bun install",
		]) {
			expect(`${command} -> ${mutatesFiles("bash", { command })}`).toBe(`${command} -> true`);
		}
	});

	test("a bash command that only reads stays silent (the false-positive control)", () => {
		for (const command of ["rg -n foo src", "cat package.json", "git status --short", "bun test", "ls -l", "git log --oneline -3"]) {
			expect(`${command} -> ${mutatesFiles("bash", { command })}`).toBe(`${command} -> false`);
		}
	});

	test("a bash call with no usable command string is silent rather than guessed", () => {
		expect(mutatesFiles("bash", undefined)).toBe(false);
		expect(mutatesFiles("bash", {})).toBe(false);
		expect(mutatesFiles("bash", { command: 42 })).toBe(false);
	});
});
