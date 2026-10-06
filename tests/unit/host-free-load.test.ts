import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The extension must survive a loader that does NOT provide `@oh-my-pi/pi-tui`.
 *
 * That package is not a declared dependency: it resolves inside this repo only because Bun finds the
 * hoisted copy in `node_modules`, and inside the host only because the `omp` binary embeds it. So a
 * static value import of it is silent here and fatal everywhere else - the property regressed twice
 * on 2026-10-06 (task-65 removed one, task-71 added another, task-74 removed both) and no test in the
 * repo could see it.
 *
 * This one runs the real module through the real Bun in a tree with no `node_modules` at all, and
 * carries a negative control so a broken harness cannot masquerade as a pass.
 */

const REPO = resolve(import.meta.dir, "..", "..");
const HOST_MODULE = "@oh-my-pi/pi-tui";

interface Run {
	code: number;
	output: string;
}

let tree = "";

/** Run one script through the running Bun, with Bun's global install cache disabled. */
function runBun(script: string): Run {
	const proc = Bun.spawnSync([process.execPath, "--no-install", script], { cwd: tree, stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

beforeAll(() => {
	tree = mkdtempSync(join(tmpdir(), "omp-swarm-load-"));
	// A tree under the repo would resolve the repo's own `node_modules` and pass for the wrong reason.
	expect(tree.startsWith(REPO)).toBe(false);
	cpSync(join(REPO, "extension"), join(tree, "extension"), { recursive: true });
	writeFileSync(
		join(tree, "load-extension.ts"),
		[
			// A static specifier cannot express this check: the module under test only exists at the path
			// relative to this generated tree, and the point is to observe how the loader RESOLVES it.
			'const mod = await import("./extension/index.ts");',
			'console.log("EXTENSION LOADED", typeof mod.default);',
		].join("\n"),
	);
	writeFileSync(
		join(tree, "static-import-control.ts"),
		[`import { matchesKey } from "${HOST_MODULE}";`, 'console.log("CONTROL LOADED", typeof matchesKey);'].join("\n"),
	);
});

afterAll(() => {
	rmSync(tree, { recursive: true, force: true });
});

describe("the extension under a loader without the host module", () => {
	test("the control: a static host import genuinely fails in this tree, so a pass below means something", () => {
		const control = runBun("static-import-control.ts");
		expect(control.output).not.toContain("CONTROL LOADED");
		expect(control.code).not.toBe(0);
		expect(control.output).toMatch(/Cannot find (module|package) '@oh-my-pi\/pi-tui'/);
	});

	test("extension/index.ts loads and exports its factory", () => {
		const loaded = runBun("load-extension.ts");
		expect(loaded.output).toContain("EXTENSION LOADED function");
		expect(loaded.code).toBe(0);
	});

	test("the tree really has no node_modules of its own", () => {
		expect(existsSync(join(tree, "node_modules"))).toBe(false);
	});
});
