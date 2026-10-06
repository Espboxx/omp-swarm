/**
 * End-to-end proof of multi-agent mode, driven through RPC mode like a real session.
 *
 * Boots `omp` with the extension, in a project whose `.swarm/config.json` already says
 * `auto: true`, and dispatches exactly ONE plain user task — no `/swarm on`, no
 * `/swarm start`. Everything else (roster, workers, self-stop) must happen on its own.
 *
 * `--no-ui` (default) is headless: the host emits no extension UI frames by contract, so the
 * in-process event trail is the evidence. Pass `--ui` to boot `rpc-ui` and assert the status line
 * the operator sees (`MULTI-AGENT ON`); `rpc-dump.ts --ui` checks that surface too.
 *
 * Usage: bun run tests/integration/auto-run.ts [--root DIR] [--workers N] [--timeout SECONDS] [--ui] [--installed]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import type { SwarmEvent } from "../../extension/types";
import { prepareProject, printResults, readEvents, type CheckResult, type LoggedEvent } from "./harness";
import { RpcClient } from "./rpc-client";

const EXTENSION = resolve(import.meta.dir, "..", "..", "extension", "index.ts");

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ?? fallback;
}

const has = (name: string) => process.argv.includes(`--${name}`);

const root = resolve(arg("root", join(import.meta.dir, "..", "..", "scratch", "autorun")));
const workers = Number(arg("workers", "3"));
const timeoutSeconds = Number(arg("timeout", "900"));
const uiMode = has("ui");
const TASK = "Implement parseKV in src/parser.ts with tests in src/parser.test.ts, and document it in README.md";
const TASK_WINDOW_MS = 240_000;
/** The driver gives workers up to 90s to finish before disposing them, so the retirement wait is generous. */
const STOP_WAIT_MS = 240_000;

/** `MULTI-AGENT ON · <kind>`; the live-count variants collapse to `running`. */
function statusKind(text: string): string {
	if (/\d+a r\d/.test(text)) return "running";
	return text.split(" · ")[1] ?? text;
}

/** Claim windows per task: how many times two agents held the same task at once. */
function claimOverlaps(events: LoggedEvent[]): number {
	const windows = new Map<string, { agent: string; from: number; to: number }[]>();
	for (const event of events) {
		if (!event.taskId) continue;
		const list = windows.get(event.taskId) ?? [];
		if (event.type === "task.claim") list.push({ agent: event.agentId ?? "?", from: event.createdAt, to: Number.MAX_SAFE_INTEGER });
		else if (["task.complete", "task.fail", "task.release", "task.reclaim"].includes(event.type)) {
			const open = [...list].reverse().find((w) => w.to === Number.MAX_SAFE_INTEGER);
			if (open) open.to = event.createdAt;
		}
		windows.set(event.taskId, list);
	}
	let overlaps = 0;
	for (const list of windows.values()) {
		const sorted = [...list].sort((a, b) => a.from - b.from);
		for (let i = 1; i < sorted.length; i++) if (sorted[i].from < sorted[i - 1].to && sorted[i].agent !== sorted[i - 1].agent) overlaps++;
	}
	return overlaps;
}

async function main(): Promise<void> {
	prepareProject({ root, workers, review: false, worktrees: false });
	const paths = swarmPaths(root);
	const rawConfig = JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
	writeFileSync(paths.configFile, `${JSON.stringify({ ...rawConfig, auto: true, workers }, null, 2)}\n`);
	console.log(`[bootstrap] multi-agent mode ON in ${root} (workers=${workers}); sending one plain task, no /swarm command`);

	const client = new RpcClient(
		[
			"omp",
			"--mode",
			uiMode ? "rpc-ui" : "rpc",
			...(uiMode ? [] : ["--no-ui"]),
			"--no-session",
			...(has("installed") ? [] : ["-e", EXTENSION]),
			"--no-title",
		],
		root,
	);

	const begin = Date.now();
	let frameCursor = 0;
	let sawModeStatus = false;
	let sawModeWidget = false;
	const modeStatuses = new Set<string>();
	const workersSeen = new Set<string>();
	const claimants = new Set<string>();
	let mainCreated = 0;
	let secondTaskAt: number | undefined;
	let drainAt: number | undefined;
	let drainedRows: { tasks: number; agents: number } | undefined;
	let settledRows: { tasks: number; agents: number } | undefined;

	const sample = (): { tasks: number; agents: number; counts: ReturnType<SwarmStore["counts"]> } => {
		const store = new SwarmStore(openDatabase(paths), paths);
		try {
			const tasks = store.listTasks({ limit: 200 });
			const agents = store.listAgents();
			for (const agent of agents) if (agent.id !== "main") workersSeen.add(agent.id);
			for (const t of tasks) if (t.claimedBy && t.claimedBy !== "main") claimants.add(t.claimedBy);
			mainCreated = Math.max(mainCreated, tasks.filter((t) => t.createdBy === "main").length);
			if (secondTaskAt === undefined && tasks.filter((t) => t.status !== "done" && t.status !== "failed").length >= 2) {
				secondTaskAt = Date.now() - begin;
			}
			return { tasks: tasks.length, agents: agents.length, counts: store.counts() };
		} finally {
			store.close();
		}
	};

	try {
		await client.waitForReady();
		await client.request({ type: "prompt", message: TASK }, 120_000);
		console.log(`[auto] task dispatched: ${TASK}`);

		const deadline = begin + timeoutSeconds * 1000;
		while (Date.now() < deadline) {
			for (; frameCursor < client.frames.length; frameCursor++) {
				const frame = client.frames[frameCursor] as Record<string, unknown>;
				if (frame.method === "setStatus" && typeof frame.statusText === "string" && frame.statusText.includes("MULTI-AGENT ON")) {
					sawModeStatus = true;
					modeStatuses.add(statusKind(frame.statusText));
				}
				if (
					frame.method === "setWidget" &&
					Array.isArray(frame.widgetLines) &&
					frame.widgetLines.some((line) => String(line).includes("MULTI-AGENT"))
				) {
					sawModeWidget = true;
				}
			}

			const rows = sample();
			const terminal = rows.counts.done + rows.counts.failed;
			const outstanding = rows.counts.ready + rows.counts.claimed + rows.counts.review + rows.counts.blocked;
			const elapsed = Date.now() - begin;
			if (drainAt === undefined && terminal > 0 && outstanding === 0) {
				drainAt = elapsed;
				drainedRows = { tasks: rows.tasks, agents: rows.agents };
				console.log(
					`[auto] pool drained after ${Math.round(elapsed / 1000)}s: ${rows.counts.done} done, ${rows.counts.failed} failed, ${rows.agents} agent row(s) left`,
				);
			}
			if (drainAt !== undefined && (rows.agents === 0 || elapsed >= drainAt + STOP_WAIT_MS)) {
				settledRows = { tasks: rows.tasks, agents: rows.agents };
				console.log(
					`[auto] workers retired after ${Math.round(elapsed / 1000)}s: ${rows.agents} agent row(s) left, ${rows.tasks} task(s) on the board`,
				);
				break;
			}
			await Bun.sleep(2000);
		}
	} catch (error) {
		console.log(`[auto] run aborted: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await client.close(10_000);
	}

	const events = readEvents(root);
	const trail = new Set(events.map((event) => event.type as SwarmEvent["type"]));
	const leaves = events.filter((event) => event.type === "agent.leave" && event.agentId && event.agentId !== "main");
	const leftAgents = new Set(leaves.map((event) => event.agentId));
	const lastClaim = Math.max(0, ...events.filter((event) => event.type === "task.claim").map((event) => event.createdAt));
	const lastLeave = Math.max(0, ...leaves.map((event) => event.createdAt));

	const report = {
		root,
		workers,
		task: TASK,
		uiMode,
		durationSeconds: Math.round((Date.now() - begin) / 1000),
		sawModeStatus,
		sawModeWidget,
		modeStatuses: [...modeStatuses],
		mainCreated,
		secondTaskAt,
		drainAt,
		workersSeen: [...workersSeen],
		claimants: [...claimants],
		leftAgents: [...leftAgents],
		eventCounts: events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {}),
	};

	const results: CheckResult[] = [];
	const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

	const modeTrail = trail.has("swarm.auto.idle") && trail.has("swarm.auto.planning");
	check(
		uiMode ? "multi-agent mode painted the TUI status line" : "multi-agent mode was live for the user's task",
		uiMode
			? sawModeStatus && sawModeWidget
			: modeTrail && !sawModeStatus && !sawModeWidget,
		uiMode
			? `setStatus=${sawModeStatus} setWidget=${sawModeWidget}`
			: `event trail=${modeTrail}; --no-ui emits no UI frames by contract (TUI surface: rpc-dump --ui)`,
	);
	check(
		"the main agent decomposed the task without any /swarm command",
		mainCreated >= 2,
		`${mainCreated} task(s) created by the coordinator`,
	);
	check(
		"a swarm-sized pool appeared within the task window",
		secondTaskAt !== undefined && secondTaskAt <= TASK_WINDOW_MS,
		secondTaskAt === undefined ? "never reached 2 non-terminal tasks" : `2 tasks after ${Math.round(secondTaskAt / 1000)}s`,
	);
	check("workers registered themselves", workersSeen.size >= 2, `agents seen: ${[...workersSeen].join(", ")}`);
	check(
		"at least two workers claimed distinct tasks",
		claimants.size >= 2,
		`claiming agents: ${[...claimants].join(", ")}`,
	);
	if (uiMode) {
		check(
			"the status line tracked the mode through the run",
			modeStatuses.has("planning") && modeStatuses.has("running"),
			`statuses seen: ${[...modeStatuses].join(" | ")}`,
		);
	}
	const overlaps = claimOverlaps(events);
	check("no task was held by two agents at once", overlaps === 0, `${overlaps} overlapping claim window(s)`);

	check("src/parser.ts exists", existsSync(join(root, "src", "parser.ts")), "worker-created artifact");
	check("src/parser.test.ts exists", existsSync(join(root, "src", "parser.test.ts")), "worker-created test");
	check("README.md exists", existsSync(join(root, "README.md")), "worker-created documentation");
	if (existsSync(join(root, "src", "parser.ts"))) {
		const source = readFileSync(join(root, "src", "parser.ts"), "utf8");
		check("the parser the workers wrote exports parseKV", source.includes("parseKV"), `${source.split("\n").length} lines`);
	}
	if (existsSync(join(root, "src", "parser.test.ts"))) {
		const testRun = Bun.spawnSync(["bun", "test"], { cwd: root });
		const lines = testRun.stdout.toString().trim().split("\n").filter((line) => line.trim() !== "");
		check("the swarm-written suite passes", testRun.exitCode === 0, (lines.at(-2) ?? lines.at(-1) ?? "no output").slice(0, 140));
	}

	check(
		"the swarm stopped itself after finishing",
		drainAt !== undefined,
		drainAt === undefined ? "the pool never drained within the timeout" : `drained ${Math.round(drainAt / 1000)}s in`,
	);
	check(
		"every worker retired on its own (agent.leave with no operator stop)",
		workersSeen.size >= 2 && [...workersSeen].every((id) => leftAgents.has(id)) && (settledRows?.agents ?? 9) <= 1,
		`left: ${[...leftAgents].join(", ") || "none"}; ${settledRows?.agents ?? "?"} agent row(s) at settle`,
	);
	check("no task was claimed after the last worker left", lastClaim < lastLeave, `lastClaim=${lastClaim} lastLeave=${lastLeave}`);
	check(
		"the finish notice did not start a second swarm",
		drainedRows !== undefined && settledRows !== undefined && drainedRows.tasks === settledRows.tasks && settledRows.agents <= 1,
		`at drain ${drainedRows?.tasks ?? "?"} task(s)/${drainedRows?.agents ?? "?"} agent row(s), settled ${settledRows?.tasks ?? "?"}/${settledRows?.agents ?? "?"}`,
	);

	const out = join(import.meta.dir, uiMode ? "last-run-auto-ui.json" : "last-run-auto.json");
	writeFileSync(out, `${JSON.stringify({ ...report, results }, null, 2)}\n`);
	console.log(`\n[report] wrote ${out}`);
	process.exit(printResults(results) === 0 ? 0 : 1);
}

await main();
