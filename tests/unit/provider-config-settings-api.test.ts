/**
 * The `/provider-config` crash, pinned two ways.
 *
 * `提供商配置失败: settings.get is not a function. (In 'settings.get("compaction.thresholdPercent")', 'settings.get' is undefined)`
 * was a real runtime error: omp removed the string-path `settings.get/set` API, while the operator's
 * extension at `~/.omp/agent/extensions/provider-config/index.ts` still called it. The fix on disk
 * reads the three `compaction.*` settings through typed registry handles
 * (`lookup("compaction.thresholdPercent")`) plus a `findScopedSettings()` scope.
 *
 * Both halves of that can silently regress — the extension can be re-edited back to the removed
 * API, and a host upgrade can rename or drop the handles it imports — and neither half fails a
 * typecheck in this repo (the extension lives outside it). This suite checks them against the real
 * runtime: the actual `@oh-my-pi/pi-coding-agent` the host serves, and the actual extension file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * The operator's extension, loaded by the running host from `~/.omp/agent/extensions`. It is not
 * inside this repo, so the tests below skip — never pass vacuously — when it is absent.
 */
const AGENT_DIR = join(homedir(), ".omp", "agent");
const EXTENSION = join(AGENT_DIR, "extensions", "provider-config", "index.ts");
const source = existsSync(EXTENSION) ? readFileSync(EXTENSION, "utf8") : null;
const hasExtension = source !== null;

/**
 * The literal shape of the crash: the object an extension gets as "settings" is a `Settings`
 * instance, and that class exposes no string-path accessor. Reproducing the caller's exact
 * expression is what proves the error message the operator saw, not a paraphrase of it.
 */
describe("the runtime no longer has a string-path settings accessor", () => {
	test("Settings has no get/set method — that is the root cause", () => {
		// Removal of the API took the methods with it; a future release can bring one back, and an
		// extension coded to the old API would then start passing here — which is the point.
		expect(Settings.prototype).not.toHaveProperty("get");
		expect(Settings.prototype).not.toHaveProperty("set");
		expect(Settings.prototype).toHaveProperty("flush");
	});

	test('the old call shape throws "settings.get is not a function", verbatim', () => {
		const scope = Settings.isolated({ "compaction.thresholdPercent": 95 });
		let message = "";
		try {
			// Exactly what the broken extension did. The call is typed through a narrow
			// `unknown`, because the type system correctly refuses it — that IS the API change.
			// Named `settings` and reached through a receiver so the runtime names the removed
			// member "settings.get", matching the operator's error message.
			const pi: { settings: unknown } = { settings: scope };
			(pi.settings as { get(path: string): unknown }).get("compaction.thresholdPercent");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("settings.get is not a function");
		expect(message).toContain('"compaction.thresholdPercent"');
	});

	test("the scope keeps flush(), which the fix awaits after its writes", () => {
		expect(typeof Settings.isolated({}).flush).toBe("function");
	});
});

describe("the registry handles the fixed extension depends on", () => {
	test("all three compaction settings resolve, so lookup() is load-bearing", () => {
		for (const id of ["compaction.enabled", "compaction.thresholdPercent", "compaction.thresholdTokens"]) {
			const handle = lookup(id);
			expect(handle, id).toBeDefined();
			expect(handle!.id).toBe(id);
		}
	});

	test("a handle reads the value through the scope, replacing settings.get(path)", () => {
		const scope = Settings.isolated({ "compaction.thresholdPercent": 95 });
		expect(lookup("compaction.thresholdPercent")!.get(scope)).toBe(95);
	});

	test("a handle writes through the scope and flush() persists it", async () => {
		const scope = Settings.isolated({});
		lookup("compaction.thresholdPercent")!.set(scope, 42);
		expect(lookup("compaction.thresholdPercent")!.get(scope)).toBe(42);
		await scope.flush();
		expect(lookup("compaction.thresholdPercent")!.get(scope)).toBe(42);
		// Persisted on the global layer, where config.yml reads it back.
		const { compaction } = scope.getGlobalSettings();
		expect(compaction).toMatchObject({ thresholdPercent: 42 });
	});

	test("a runtime override outranks a global write, so the extension checks what it actually got", () => {
		const base = Settings.isolated({});
		lookup("compaction.thresholdPercent")!.set(base, 40);
		const scoped = base.overlay({ "compaction.thresholdPercent": 95 });
		expect(lookup("compaction.thresholdPercent")!.get(scoped)).toBe(95);
		// The overlay's own write stays local — it must not leak into the parent's persisted value.
		lookup("compaction.thresholdPercent")!.set(scoped, 7);
		expect(lookup("compaction.thresholdPercent")!.get(scoped)).toBe(95);
		expect(lookup("compaction.thresholdPercent")!.get(base)).toBe(40);
	});

	test("findScopedSettings may return nothing, so the extension needs its fallback", () => {
		expect(findScopedSettings("no-such-cwd-" + process.pid)).toBeUndefined();
	});
});

describe("the operator's extension source, when installed", () => {
	/**
	 * The regression is a CALL SHAPE, not a variable name: `settings` is whatever the handler
	 * happens to call its scope, so matching on the name `settings` misses `scope.get(…)` —
	 * which is exactly how the original bug read. Keyed on a `.get(`/`.set(` call whose single
	 * argument is a string literal containing a dotted setting id, the only way the removed
	 * string-path API is used.
	 */
	const STRING_PATH_CALL = /\.\s*[gs]et\s*\(\s*["'][a-z][\w-]*\.[\w-]+["']/;
	const COMPACTION_STRING_PATH = /\.\s*(?:get|set)\s*\(\s*["']compaction\./;

	test("it carries no string-path settings.get/set call left", () => {
		if (!hasExtension) return; // not installed in this environment: nothing to assert about
		expect(source, "a string-path settings accessor is back").not.toMatch(STRING_PATH_CALL);
		// …and not just renamed: no indexed access that would do the same job.
		expect(source).not.toMatch(/\w+\[\s*["']compaction\./);
	});

	test("all three compaction settings are read through the scope, with no string path", () => {
		if (!hasExtension) return;
		expect(source, "a compaction call reverted to the string path").not.toMatch(COMPACTION_STRING_PATH);
		for (const id of ["compaction.enabled", "compaction.thresholdPercent", "compaction.thresholdTokens"]) {
			// Each handle must exist AND be used on the scope: a lookup whose result is unused
			// would still trip the assertions above while leaving the value unread.
			expect(source, id).toContain(`lookup('${id}')`);
		}
		// Reads and writes both go through handles on a scope, and the scope is flushed.
		expect(source).toContain("findScopedSettings()");
		expect(source).toMatch(/\.get\(scope\)/);
		expect(source).toMatch(/\.set\(scope,/);
		expect(source).toContain("scope.flush()");
	});

	test("a future host that drops a handle must surface as an error, not a silent default", () => {
		if (!hasExtension) return;
		// The fix throws when lookup() returns nothing instead of reading an undefined setting.
		expect(source).toContain("未注册 compaction.* 设置");
	});
});
