import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupFixtureRoots, insertAgent, insertTask, makeFixtureDb, type FixtureDb } from "../../web/lib/fixture";
import { resolveAssetTarget } from "../../web/lib/assets";
import { createServer, parseArgs, type RunningServer } from "../../web/server";

const running: RunningServer[] = [];

function startServer(fixture: FixtureDb, options: { feedLimit?: number } = {}): { server: RunningServer; base: string } {
	const assetsDir = join(fixture.root, "assets");
	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(join(assetsDir, "index.html"), "<!doctype html><title>swarm</title>\n", "utf8");
	writeFileSync(join(assetsDir, "app.js"), "export const ready = true;\n", "utf8");
	writeFileSync(join(assetsDir, "style.css"), "body { margin: 0 }\n", "utf8");
	const server = createServer({
		dbPath: fixture.path,
		port: 0,
		assetsDir,
		quiet: true,
		now: () => 1_700_000_000_000,
		feedLimit: options.feedLimit,
	});
	running.push(server);
	return { server, base: `http://127.0.0.1:${server.port}` };
}

function seededFixture(): FixtureDb {
	const fixture = makeFixtureDb();
	insertTask(fixture.db, { id: "task-1", title: "ready one", status: "ready", createdAt: 1_699_999_999_000 });
	insertTask(fixture.db, { id: "task-2", title: "claimed one", status: "claimed", createdAt: 1_699_999_998_000, claimedBy: "SwiftTiger" });
	insertAgent(fixture.db, { id: "SwiftTiger", status: "working", joinedAt: 1_699_999_000_000, heartbeatAt: 1_699_999_995_000 });
	return fixture;
}

/** The response body as `unknown`, so every read below has to pass a runtime check. */
async function getJson(url: string): Promise<{ status: number; value: unknown }> {
	const response = await fetch(url);
	const value: unknown = await response.json();
	return { status: response.status, value };
}

/** Read one field of a JSON object reply; a missing field is a failure, not a silent `undefined`. */
function field(value: unknown, name: string): unknown {
	if (value === null || typeof value !== "object" || !(name in value)) {
		throw new Error(`response is missing the field '${name}'`);
	}
	return (value as Record<string, unknown>)[name];
}

async function readClients(base: string): Promise<number> {
	const clients = field((await getJson(`${base}/api/health`)).value, "clients");
	if (typeof clients !== "number") throw new Error("health.clients is not a number");
	return clients;
}

/** An array field of a JSON reply, as `unknown[]` so every element still has to be checked. */
function arrayField(value: unknown, name: string): unknown[] {
	const items = field(value, name);
	if (!Array.isArray(items)) throw new Error(`response field '${name}' is not an array`);
	return items;
}

/** The own keys of a JSON object reply — the frozen contract's field list. */
function objectKeys(value: unknown): string[] {
	if (value === null || typeof value !== "object") throw new Error("response is not a JSON object");
	return Object.keys(value);
}

afterEach(() => {
	for (const server of running.splice(0)) server.stop();
	cleanupFixtureRoots();
});

describe("dashboard routes", () => {
	test("/api/health reports a read-only server with no clients", async () => {
		const fixture = seededFixture();
		const { server, base } = startServer(fixture);
		const { status, value } = await getJson(`${base}/api/health`);

		expect(server.hostname).toBe("127.0.0.1");
		expect(status).toBe(200);
		expect(value).toMatchObject({
			ok: true,
			readOnly: true,
			clients: 0,
			dbPath: fixture.path,
			startedAtMs: 1_700_000_000_000,
		});
		expect(typeof field(value, "dbMtimeMs")).toBe("number");
	});

	test("/api/snapshot serves the frozen shape and the SQL truth for counts", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		const { status, value } = await getJson(`${base}/api/snapshot`);
		const sql = fixture.db.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all();
		const byStatus = new Map(sql.map((row) => [row.status, row.n]));

		expect(status).toBe(200);
		// The field names are the frozen contract: the frontend is written against exactly these.
		expect(objectKeys(value).sort()).toEqual([
			"agents",
			"board",
			"counts",
			"events",
			"feed",
			"messages",
			"now",
			"reservations",
			"swarmRoot",
			"tasks",
		]);
		expect(value).toMatchObject({
			swarmRoot: fixture.root,
			now: 1_700_000_000_000,
			counts: {
				ready: byStatus.get("ready") ?? 0,
				claimed: byStatus.get("claimed") ?? 0,
				review: byStatus.get("review") ?? 0,
				blocked: byStatus.get("blocked") ?? 0,
				done: byStatus.get("done") ?? 0,
				failed: byStatus.get("failed") ?? 0,
				total: sql.reduce((sum, row) => sum + row.n, 0),
			},
			feed: { limit: 100 },
		});
		expect(field(value, "agents")).toHaveLength(1);
		// priority DESC, created_at ASC: task-2 was created first.
		expect(arrayField(value, "tasks").map((task) => field(task, "id"))).toEqual(["task-2", "task-1"]);
	});

	test("every non-GET method is 405 with Allow: GET — there is no write route", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
			for (const path of ["/api/snapshot", "/api/health", "/api/events", "/index.html"]) {
				const response = await fetch(`${base}${path}`, { method });
				expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 405`);
				expect(response.headers.get("allow")).toBe("GET");
				if (method !== "HEAD") await response.text();
			}
		}
	});

	test("an unknown api path and an unknown asset are 404, not a fallback page", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		expect((await fetch(`${base}/api/nope`)).status).toBe(404);
		expect((await fetch(`${base}/api`)).status).toBe(404);
		expect((await fetch(`${base}/missing.js`)).status).toBe(404);
	});

	test("serves web/assets at the root, at /assets/, with no-cache and a real content type", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);

		const page = await fetch(`${base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(page.headers.get("cache-control")).toBe("no-cache");
		expect((await page.text()).startsWith("<!doctype html>")).toBe(true);

		const script = await fetch(`${base}/app.js`);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		await script.text();

		const aliased = await fetch(`${base}/assets/style.css`);
		expect(aliased.status).toBe(200);
		expect(aliased.headers.get("content-type")).toBe("text/css; charset=utf-8");
		await aliased.text();
	});

	test("the asset resolver refuses to leave the root, whatever the encoding", () => {
		const fixture = makeFixtureDb();
		const assetsDir = join(fixture.root, "assets");
		mkdirSync(assetsDir, { recursive: true });

		// A hostile raw path: the guard is only reachable directly, since a URL parser normalizes
		// a literal `..` out of a request before it is ever sent.
		expect(resolveAssetTarget(assetsDir, "/%2e%2e/secret.txt")).toMatchObject({ ok: false, status: 403 });
		expect(resolveAssetTarget(assetsDir, "/..%2fsecret.txt")).toMatchObject({ ok: false, status: 403 });
		expect(resolveAssetTarget(assetsDir, "/assets/%2e%2e/secret.txt")).toMatchObject({ ok: false, status: 403 });
		expect(resolveAssetTarget(assetsDir, "/%zz")).toMatchObject({ ok: false, status: 400 });

		expect(resolveAssetTarget(assetsDir, "/app.js")).toEqual({ ok: true, target: join(assetsDir, "app.js") });
		expect(resolveAssetTarget(assetsDir, "/")).toEqual({ ok: true, target: join(assetsDir, "index.html") });
		expect(resolveAssetTarget(assetsDir, "/assets/")).toEqual({ ok: true, target: join(assetsDir, "index.html") });
	});

	test("a file outside the asset root is not served over http", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		writeFileSync(join(fixture.root, "secret.txt"), "do not serve\n", "utf8");

		const response = await fetch(`${base}/secret.txt`);
		expect(response.status).toBe(404);
		await response.text();
	});

	test("a malformed path is a 400 instead of a dead process", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		const response = await fetch(`${base}/%zz`);
		expect(response.status).toBe(400);
		await response.text();
	});
});

describe("sse stream", () => {
	test("emits an initial snapshot frame, then closes cleanly on disconnect", async () => {
		const fixture = seededFixture();
		const { base } = startServer(fixture);
		const controller = new AbortController();
		const response = await fetch(`${base}/api/events`, { signal: controller.signal });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("the SSE response has no body");
		// No timeout race here: a stream that never produces a frame fails on the test deadline.
		const read = await reader.read();
		if (read.value === undefined) throw new Error("the SSE stream produced no first frame");
		const frame = new TextDecoder().decode(read.value);
		expect(frame.startsWith("event: snapshot\ndata: ")).toBe(true);
		const summary: unknown = JSON.parse(frame.slice("event: snapshot\ndata: ".length).trim());
		expect(field(field(summary, "counts"), "ready")).toBe(1);
		expect(field(summary, "hash")).toMatch(/^[0-9a-f]{8}$/);

		controller.abort();
		await reader.closed.catch(() => undefined);
		// The server learns about a disconnect from the socket, so the reader has no event to await.
		// Bounded poll, 25ms apart, and only for the cleanup this test exists to prove.
		let clients = -1;
		for (let attempt = 0; attempt < 40 && clients !== 0; attempt++) {
			clients = await readClients(base);
			if (clients !== 0) await Bun.sleep(25);
		}
		expect(clients).toBe(0);
	});
});

describe("cli arguments", () => {
	test("defaults, overrides and --flag=value all parse; junk is refused", () => {
		expect(parseArgs(["--db", "C:/x/swarm.db"])).toEqual({ dbPath: "C:/x/swarm.db", port: 8787, feedLimit: 100 });
		expect(parseArgs(["--db=C:/y/swarm.db", "--port=9001", "--feed-limit", "5", "--offline-after=30"])).toEqual({
			dbPath: "C:/y/swarm.db",
			port: 9001,
			feedLimit: 5,
			offlineAfterSeconds: 30,
		});
		expect(parseArgs(["--port", "not-a-number"])).toContain("--port needs a number");
		expect(parseArgs(["--nope"])).toBe("unknown argument: --nope");
		expect(parseArgs(["--help"])).toContain("Usage: bun run web/server.ts");
	});
});
