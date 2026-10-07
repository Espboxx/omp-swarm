/**
 * The dashboard's own rendering defects, asserted in the PAGE'S OWN DOM (task-109).
 *
 * Two operator-visible bugs, both fixed in `web/assets/app.js`:
 *   1. the collaboration feeds reversed the newest-first payload and then took the first `FEED_ROW_CAP`
 *      rows, so the visible window was the OLDEST rows of the newest slice — the newest board entry and
 *      an urgent message sat behind four "show more" clicks (or off the page entirely);
 *   2. a status group's header counted the ROWS the payload carried, while the counts chip counted every
 *      task, so a pool past the server's `TASK_LIMIT` read "40 已认领" beside "已认领 20".
 *
 * The fixture is deliberately 10x the operator's pool (1010 tasks), because that is the shape where the
 * second defect appears — and the canonical fix the task asks for is exactly "assert it in the page's
 * own DOM". Driving the browser uses `puppeteer-core`, which is dependency-pinned transitively by the
 * declared `@oh-my-pi/pi-coding-agent` (18.6.1) — no dependency was added for this test.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import {
	cleanupFixtureRoots,
	insertBoardEntry,
	insertMessage,
	insertTask,
	makeFixtureDb,
	type FixtureDb,
} from "../../web/lib/fixture";
import { createServer, type RunningServer } from "../../web/server";
import { TASK_LIMIT } from "../../web/snapshot";

const BROWSER_CANDIDATES = [
	process.env.CHROME_PATH ?? "",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
/** `undefined` on a machine without a Chromium-family browser: the test skips instead of failing. */
const BROWSER_PATH = BROWSER_CANDIDATES.find((path) => path !== "" && existsSync(path));

const servers: RunningServer[] = [];
const browsers: Browser[] = [];
const BASE_MS = 1_700_000_000_000;

afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
	for (const server of servers.splice(0)) server.stop();
	cleanupFixtureRoots();
});

/** 10x the operator's pool: every status exists, and the claimed rows sit past the server's row cap. */
function tenTimesFixture(): { fixture: FixtureDb; newestBoardId: number; done: number; claimed: number; ready: number; blocked: number } {
	const fixture = makeFixtureDb();
	const { db } = fixture;
	const done = 1_005;
	const claimed = 5;
	db.exec("BEGIN IMMEDIATE");
	for (let i = 0; i < done; i++) insertTask(db, { id: `task-${i + 1}`, status: "done", createdAt: BASE_MS + i, updatedAt: BASE_MS + i });
	// Created AFTER the cap-sized window, so their rows fall past `TASK_LIMIT` while `counts` still sees them.
	for (let i = 0; i < claimed; i++) insertTask(db, { id: `task-${done + i + 1}`, status: "claimed", createdAt: BASE_MS + 5_000 + i, claimedBy: "w1" });
	for (let i = 0; i < 3; i++) insertTask(db, { id: `task-${done + claimed + i + 1}`, status: "ready", createdAt: BASE_MS + 6_000 + i });
	for (let i = 0; i < 2; i++) insertTask(db, { id: `task-${done + claimed + 3 + i + 1}`, status: "blocked", createdAt: BASE_MS + 7_000 + i });
	// 30 board entries and 30 messages: more than FEED_ROW_CAP, with the newest carrying the urgent flag.
	let newestBoardId = 0;
	for (let i = 1; i <= 30; i++) {
		insertBoardEntry(db, { type: "FACT", agentId: "SwiftTiger", content: `board entry ${i}`, createdAt: BASE_MS + i * 1_000 });
		insertMessage(db, { to: "all", from: "CalmTiger", body: `message ${i}`, urgent: i === 30, createdAt: BASE_MS + i * 1_000 });
		newestBoardId = i;
	}
	db.exec("COMMIT");
	return { fixture, newestBoardId, done, claimed, ready: 3, blocked: 2 };
}

describe("dashboard rendering", () => {
	test.skipIf(BROWSER_PATH === undefined)(
		"the newest collaboration is visible without a click, and no group header contradicts its counts chip",
		async () => {
			if (BROWSER_PATH === undefined) throw new Error("unreachable: the test is skipped without a browser");
			const { fixture, newestBoardId, done, claimed, ready, blocked } = tenTimesFixture();
			const server = createServer({ dbPath: fixture.path, port: 0, quiet: true, assetsDir: join(import.meta.dir, "..", "..", "web", "assets") });
			servers.push(server);
			const browser = await puppeteer.launch({ executablePath: BROWSER_PATH, headless: true, args: ["--no-sandbox"] });
			browsers.push(browser);
			const page = await browser.newPage();
			const failures: string[] = [];
			page.on("pageerror", (error: unknown) => failures.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`));
			page.on("console", (message) => {
				if (message.type() === "error") failures.push(`console: ${message.text()}`);
			});
			await page.setViewport({ width: 1280, height: 900 });
			await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle2", timeout: 30_000 });
			// The project's tsconfig has no DOM lib, so the page is driven through puppeteer's own
			// selector API rather than an in-page callback that would reference `document`.
			await page.waitForSelector("#panel-feed .feed-item", { timeout: 15_000 });

			// (1) the board feed: the FIRST row is the newest entry, with no "show more" click.
			const firstBoardRow = await page.$eval("#panel-feed .feed-item", (row) => row.textContent ?? "");
			expect(firstBoardRow).toContain(`#${newestBoardId}`);

			// …and the messages feed: the urgent message is inside the visible window, no click either.
			await page.click("#tab-messages");
			// Rendered by the click handler synchronously; the assertion below is what the fix is about, so
			// this wait only needs to cover the tab swap (a fast failure beats a 15s timeout).
			await page.waitForSelector("#panel-feed .feed-item", { timeout: 5_000 });
			const urgentVisible = await page.$$eval("#panel-feed .feed-item.is-urgent", (rows) => rows.length);
			expect(urgentVisible).toBeGreaterThan(0);

			// (2) every group header equals its counts chip, even where the rows are a subset of the count.
			const badge = async (status: string): Promise<string> =>
				await page.$eval(`.task-group-head .badge.status-${status}`, (node) => node.textContent ?? "");
			expect(await badge("claimed")).toBe(String(claimed)); // 5 claimed tasks, ZERO of their rows in the payload
			expect(await badge("ready")).toBe(String(ready));
			expect(await badge("blocked")).toBe(String(blocked));
			// The collapsed `done` group carries its own number in the summary.
			const doneSummary = await page.$eval("details.collapsed-group summary", (node) => node.textContent ?? "");
			expect(doneSummary).toContain(`(${done})`);
			// And the page says the rows are a subset rather than pretending the list is complete.
			const notes = await page.$$eval(".group-note", (nodes) => nodes.map((node) => node.textContent ?? ""));
			expect(notes.some((note) => note.includes(String(TASK_LIMIT)) && note.includes(String(done)))).toBe(true);

			expect(failures).toEqual([]);
		},
		60_000,
	);
});
